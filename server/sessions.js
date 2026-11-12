'use strict';

// Session manager — the heart of the hub.
// Tracks sessions across machines, dispatches starts (local via lib/runner,
// remote via the agent socket), fans in output/status events, keeps a ring
// buffer per session (capped at logRingLines lines / logByteCap bytes) and
// appends every line to <dataDir>/logs/<id>.log.
//
// Events (payloads per SPEC):
//   'machine'  -> { machine }                 (running count changed)
//   'session'  -> { session }                 (meta only, no lines)
//   'output'   -> { sessionId, t, stream, line }
//   'removed'  -> { sessionId }

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const ACTIVE_STATUSES = new Set(['pending', 'running', 'stopping']);
const FINAL_STATUSES = new Set(['ended', 'stopped', 'error']);

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function makeSessionId() {
  return 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function hhmm(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/**
 * Transform one line of a `dsh --profile headless --json` event stream into a
 * human-readable phone line. Parses defensively (the event schema may drift
 * across DSH versions). Returns null to suppress the line (session metadata),
 * otherwise the display string. Captures the run's sessionId so the phone can
 * continue the same conversation later.
 */
function transformDshLine(line, session, onExternalId) {
  let obj = null;
  try { obj = JSON.parse(line); } catch (e) { return line; }
  if (!obj || typeof obj !== 'object' || typeof obj.type !== 'string') return line;
  const captureId = (o) => {
    const sid = o && typeof o.sessionId === 'string' ? o.sessionId : null;
    if (sid && session && session.externalId !== sid) {
      session.externalId = sid;
      if (onExternalId) onExternalId(sid);
    }
  };
  const pickText = (o, keys) => {
    for (const k of keys) {
      const v = o && o[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (Array.isArray(v)) {
        const parts = v.map((it) => (it && typeof it.text === 'string' ? it.text : '')).filter(Boolean);
        if (parts.length) return parts.join('\n');
      }
      if (v && typeof v === 'object' && typeof v.text === 'string' && v.text.trim()) return v.text.trim();
    }
    return null;
  };
  const short = (v, n) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > n ? s.slice(0, n) + '…' : s;
  };
  switch (obj.type) {
    case 'session':
      captureId(obj);
      return null; // metadata only — not shown on the phone
    case 'final': {
      captureId(obj);
      let reason = '';
      if (obj.reason && typeof obj.reason === 'object' && obj.reason.kind) reason = obj.reason.kind;
      const txt = pickText(obj, ['text', 'answer']);
      return '✅ done' + (reason ? ` · ${reason}` : '') + (txt ? ` · ${txt}` : '');
    }
    case 'text': {
      const t = pickText(obj, ['text', 'content', 'message']);
      return t ? `💬 ${t}` : null;
    }
    case 'thinking': {
      const t = pickText(obj, ['thinking', 'text', 'content']);
      return t ? `💭 ${t}` : null;
    }
    case 'tool_call': {
      const name = obj.name || obj.tool || (obj.function && obj.function.name) || (obj.payload && obj.payload.name) || 'tool';
      const args = obj.arguments || obj.args || obj.input || (obj.function && obj.function.arguments) || (obj.payload && obj.payload.arguments) || '';
      const a = short(args, 300);
      return `🔧 ${name}${a ? `(${a})` : ''}`;
    }
    case 'tool_result': {
      const err = obj.error ? short(obj.error, 300) : null;
      if (err) return `📦 ⚠ ${err}`;
      const out = pickText(obj, ['output']);
      const status = obj.status ? short(obj.status, 120) : null;
      return `📦 ${out ? short(out, 300) : status || 'done'}`;
    }
    case 'status': {
      const t = pickText(obj, ['status', 'phase', 'message']);
      return t ? `⋯ ${t}` : null;
    }
    case 'error': {
      const t = pickText(obj, ['message', 'error']);
      return `⚠️ ${t || 'error'}`;
    }
    default:
      return '📄 ' + short(JSON.stringify(obj), 400);
  }
}

/**
 * Resolve a prompt into the line that will be written to stdin.
 * With jsonInput: jsonInput with {prompt} replaced by the JSON-string-escaped
 * prompt text (JSON.stringify(prompt).slice(1, -1)).
 */
function resolvePromptLine(jsonInput, prompt) {
  if (!jsonInput) return prompt;
  const escaped = JSON.stringify(prompt).slice(1, -1);
  return String(jsonInput).split('{prompt}').join(escaped);
}

class Sessions extends EventEmitter {
  constructor(config, machines, store) {
    super();
    this.config = config;
    this.machines = machines;
    this.store = store;
    this.runner = null;
    this.byId = new Map();
    this._logRoot = path.join(config.dataDir, 'logs');
    this._root = path.join(__dirname, '..');
    try { fs.mkdirSync(this._logRoot, { recursive: true }); } catch (e) { /* store creates it */ }
  }

  setRunner(runner) { this.runner = runner; }

  // ------------------------------------------------------------- queries

  all() {
    return Array.from(this.byId.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((s) => this._public(s, true));
  }

  get(id) {
    const s = this.byId.get(id);
    return s ? this._public(s, true) : null;
  }

  meta(id) {
    const s = this.byId.get(id);
    return s ? this._public(s, false) : null;
  }

  lines(id) {
    const s = this.byId.get(id);
    return s ? s.lines.slice(-50) : null;
  }

  // ------------------------------------------------------------- creation

  /**
   * Create a session. Validates machine/workspace/template per SPEC, records
   * the session as 'pending', then dispatches (local runner / remote agent).
   */
  async create({ machineId, workspace, template, prompt, label, resumeId }) {
    const machine = this.machines.get(machineId);
    if (!machine) throw httpError(404, 'machine-unknown', `unknown machine: ${machineId}`);
    if (machine.status !== 'connected') throw httpError(409, 'machine-offline', `machine "${machineId}" is offline`);

    const cap = Number(this.config.maxSessionsPerMachine) > 0 ? Number(this.config.maxSessionsPerMachine) : 8;
    if (this._activeCount(machineId) >= cap) {
      throw httpError(409, 'too-many-sessions', `machine "${machineId}" is at its session limit (${cap})`);
    }

    const tpl = this.config.templates && this.config.templates[template];
    if (!tpl) throw httpError(400, 'template-unknown', `unknown template: ${template}`);
    if (tpl.type !== 'oneshot' && tpl.type !== 'interactive') {
      throw httpError(400, 'template-unknown', `template "${template}" has an invalid type`);
    }

    let resolvedWorkspace;
    try {
      resolvedWorkspace = this.machines.resolvePath(machineId, workspace).resolved;
    } catch (err) {
      if (err && err.status === 403) {
        throw httpError(400, 'workspace-outside-roots', 'workspace is outside the machine\'s allowed roots');
      }
      if (err && err.status === 404) {
        throw httpError(400, 'workspace-missing', 'workspace directory does not exist');
      }
      throw err;
    }

    if (tpl.type === 'oneshot' && (typeof prompt !== 'string' || prompt.trim() === '')) {
      throw httpError(400, 'prompt-required', 'one-shot templates require a non-empty prompt');
    }

    const command = this._resolveCommand(tpl, machine.os);
    // {resumeArg} placeholder: continues a previous conversation (e.g. dsh
    // --session-id). Empty unless a validated resumeId was supplied.
    let resumeArg = '';
    if (typeof resumeId === 'string' && resumeId.trim()) {
      const rid = resumeId.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(rid)) {
        throw httpError(400, 'bad-resume-id', 'resumeId contains invalid characters');
      }
      resumeArg = ` --session-id "${rid}"`;
    }
    const resolvedCommand = command.split('{resumeArg}').join(resumeArg);
    const now = Date.now();
    const id = makeSessionId();
    const session = {
      id,
      machineId,
      workspace: resolvedWorkspace,
      template,
      type: tpl.type,
      label: (typeof label === 'string' && label.trim()) ? label.trim() : `${template} · ${hhmm(now)}`,
      status: 'pending',
      createdAt: now,
      startedAt: null,
      endedAt: null,
      exitCode: null,
      error: null,
      command: resolvedCommand,
      externalId: null, // e.g. the dsh session id, extracted from output
      _transform: tpl.outputTransform === 'dsh-json' ? 'dsh-json' : null,
      lines: [],
      lineBytes: 0,
      logFile: null,
      _logStream: null,
      _absLog: path.join(this._logRoot, id + '.log')
    };
    session.logFile = this._displayLog(session._absLog);
    this.byId.set(id, session);
    this._emitSession(id);
    this._countChanged(machineId);
    this.save();

    const env = {
      SESSIONHUB_SESSION_ID: id,
      SESSIONHUB_WORKSPACE: resolvedWorkspace
    };
    let initialPrompt = null;
    if (typeof prompt === 'string' && prompt.length > 0) {
      env.SESSIONHUB_PROMPT = prompt;
      if (tpl.type === 'interactive') initialPrompt = resolvePromptLine(tpl.jsonInput, prompt);
    }
    const initialDelayMs = typeof tpl.initialDelayMs === 'number' ? tpl.initialDelayMs : 800;

    if (machine.local) {
      if (!this.runner) {
        this._finalize(session, { status: 'error', error: 'runner is not available' });
        return this.get(id);
      }
      this.runner.start({ id, cwd: resolvedWorkspace, command: resolvedCommand, env, initialPrompt, initialDelayMs })
        .then(() => {
          // A stop() that arrived before the child spawned finalized the
          // session as 'stopped' — the child exists now, so kill it for real.
          const s = this.byId.get(id);
          if (s && s.status === 'stopped') {
            this.runner.stop(id).catch(() => {});
          }
        })
        .catch((err) => {
          const s = this.byId.get(id);
          if (s && s.status !== 'stopped') {
            this._finalize(s, { status: 'error', error: (err && err.message) || 'failed to start' });
          }
        });
    } else {
      const sent = this.machines.sendTo(machineId, {
        type: 'session.start',
        id,
        cwd: resolvedWorkspace,
        command: resolvedCommand,
        env,
        initialPrompt,
        initialDelayMs
      });
      if (!sent) this._finalize(session, { status: 'error', error: 'machine went offline during dispatch' });
    }
    return this.get(id);
  }

  _resolveCommand(tpl, targetOs) {
    const cmd = tpl.command;
    if (typeof cmd === 'string') return cmd;
    if (cmd && typeof cmd === 'object') {
      if (typeof cmd[targetOs] === 'string') return cmd[targetOs];
      throw httpError(400, 'template-unsupported', `template is not supported on ${targetOs}`);
    }
    throw httpError(400, 'template-unknown', 'template has no command');
  }

  // ------------------------------------------------------------- actions

  /** Send a prompt line to a running interactive session. */
  async prompt(id, text) {
    const s = this.byId.get(id);
    if (!s) throw httpError(404, 'session-not-found', 'unknown session');
    if (typeof text !== 'string' || text.trim() === '') {
      throw httpError(400, 'bad-request', 'text must be a non-empty string');
    }
    if (s.type !== 'interactive') throw httpError(409, 'not-interactive', 'session is not interactive');
    if (s.status !== 'running' && s.status !== 'stopping') throw httpError(409, 'not-running', 'session is not running');

    const tpl = this.config.templates[s.template] || {};
    const line = resolvePromptLine(tpl.jsonInput, text);
    const machine = this.machines.get(s.machineId);
    if (!machine) throw httpError(409, 'machine-offline', 'machine is gone');

    if (machine.local) {
      if (!this.runner) throw httpError(409, 'not-running', 'runner is not available');
      try {
        await this.runner.sendStdin(id, line);
      } catch (err) {
        throw httpError(409, 'not-running', (err && err.message) || 'stdin unavailable');
      }
    } else {
      if (machine.status !== 'connected') throw httpError(409, 'machine-offline', 'machine is offline');
      const sent = this.machines.sendTo(machine.id, { type: 'session.stdin', id, data: line });
      if (!sent) throw httpError(409, 'machine-offline', 'machine went offline');
    }
    return { ok: true };
  }

  /** Stop a session. Idempotent: already-final sessions return ok.
   * Watched sessions are read-only monitoring — nothing to stop. */
  async stop(id) {
    const s = this.byId.get(id);
    if (!s) throw httpError(404, 'session-not-found', 'unknown session');
    if (s._watched) return { ok: true };
    if (FINAL_STATUSES.has(s.status) || s.status === 'stopping') return { ok: true };
    if (s.status === 'disconnected') {
      // Child state is unknown while the agent is away; the reconnect
      // reconciliation (or a force-remove) will settle it.
      console.log(`[sessionhub] stop(${id}): session is disconnected — nothing to stop locally`);
      return { ok: true };
    }

    s.status = 'stopping';
    s.error = null;
    this._emitSession(id);
    this._countChanged(s.machineId);

    const machine = this.machines.get(s.machineId);
    if (machine && machine.local) {
      const rs = this.runner ? this.runner.status(id) : null;
      if (rs && rs.pid != null) {
        this.runner.stop(id).catch((err) => {
          const cur = this.byId.get(id);
          if (cur && cur.status === 'stopping') {
            this._finalize(cur, { status: 'error', error: 'stop failed: ' + ((err && err.message) || err) });
          }
        });
      } else {
        // The child has not spawned yet (runner entry exists but pid is null).
        // Finalize as stopped now; the start() continuation will kill the
        // child as soon as it spawns.
        this._finalize(s, { status: 'stopped' });
      }
    } else if (machine) {
      this.machines.sendTo(machine.id, { type: 'session.stop', id });
    } else {
      this._finalize(s, { status: 'error', error: 'machine is gone' });
    }
    this.save();
    return { ok: true };
  }

  /** Remove a session; needs !running or force (force stops first).
   * Watched sessions can be removed without force (nothing to stop). */
  async remove(id, force) {
    const s = this.byId.get(id);
    if (!s) throw httpError(404, 'session-not-found', 'unknown session');
    const active = ACTIVE_STATUSES.has(s.status) || (s._watched && (s.status === 'running' || s.status === 'idle'));
    if (active && !force && !s._watched) {
      throw httpError(409, 'session-running', 'session is still running (use force=1 to remove it)');
    }
    if (active && force && !s._watched) {
      await this.stop(id);
    }
    this.byId.delete(id);
    await this._closeLog(s);
    if (s._absLog) {
      try { await fs.promises.unlink(s._absLog); } catch (e) { /* already gone */ }
    }
    this.emit('removed', { sessionId: id });
    this._countChanged(s.machineId);
    this.save();
    return { ok: true };
  }

  // ------------------------------------------------------------- events in

  /** Output line from a child (runner onLine or agent session.output).
   * Watched sessions receive lines through this path too (from remote agents),
   * but never write a log file. */
  handleOutput(id, stream, line) {
    const s = this.byId.get(id);
    if (!s) return;
    if (s._transform === 'dsh-json') {
      const transformed = transformDshLine(line, s, () => { this._emitSession(s.id); });
      if (transformed === null) return; // suppressed metadata event
      line = transformed;
    }
    const entry = this._appendRing(s, stream, line);
    if (!s._watched) {
      const logStream = this._logStream(s);
      if (logStream) {
        try { logStream.write(new Date(entry.t).toISOString() + '\t' + entry.stream + '\t' + entry.line + '\n'); } catch (e) { /* ignore */ }
      }
    }
    this.emit('output', { sessionId: id, t: entry.t, stream: entry.stream, line: entry.line });
  }

  /** Append a line to a session's ring buffer (shared caps: logRingLines lines /
   * logByteCap bytes). Returns the stored entry. */
  _appendRing(s, stream, line) {
    if (typeof line !== 'string') line = String(line);
    if (line.length > 20000) line = line.slice(0, 20000) + '…[truncated]';
    if (stream !== 'stderr') stream = 'stdout';
    const entry = { t: Date.now(), stream, line };
    s.lines.push(entry);
    s.lineBytes += line.length;
    while (s.lines.length > this.config.logRingLines || s.lineBytes > this.config.logByteCap) {
      const dropped = s.lines.shift();
      s.lineBytes -= dropped.line.length;
    }
    return entry;
  }

  // ------------------------------------------------------- watched sessions

  /**
   * Event from the local CodexWatcher (config.codexWatch.enabled).
   * Watched sessions are memory-only: no log file, no store persistence.
   */
  handleWatchedEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.kind === 'session') {
      const id = typeof ev.id === 'string' ? ev.id : null;
      if (!id) return;
      let s = this.byId.get(id);
      if (!s) {
        s = this._createWatchedRecord(id, this.machines.localId, ev.workspace, ev.label);
        this.byId.set(id, s);
        this._emitSession(id);
      } else if (!s._watched) {
        return; // id collision with a hub-spawned session — ignore
      } else {
        if (typeof ev.workspace === 'string' && ev.workspace) s.workspace = ev.workspace;
        if (typeof ev.label === 'string' && ev.label) s.label = ev.label;
        this._emitSession(id);
      }
    } else if (ev.kind === 'line') {
      // Lines may arrive before the 'session' event on first discovery (the
      // watcher reads appended bytes before announcing the file) — accept them
      // into a placeholder record that the session event fills in.
      this.acceptWatchedLine(ev.id, this.machines.localId, ev.text);
    } else if (ev.kind === 'status') {
      const s = this.byId.get(ev.id);
      if (!s || !s._watched) return;
      this._applyWatchedStatus(s, ev.status);
    }
  }

  /**
   * Append a watched line for (possibly) an unknown watched session id.
   * Used for both the local watcher (lines-before-session ordering) and remote
   * agents sending session.output for watched ids the hub has not seen yet.
   * Creates a placeholder record (workspace/label filled in by the following
   * session/status event); never writes a log file, never persists.
   */
  acceptWatchedLine(id, machineId, text) {
    let s = this.byId.get(id);
    if (!s) {
      if (typeof id !== 'string' || !id) return;
      s = this._createWatchedRecord(id, machineId, '', '');
      this.byId.set(id, s);
      this._emitSession(id);
    } else if (!s._watched) {
      return;
    }
    const entry = this._appendRing(s, 'stdout', text);
    this.emit('output', { sessionId: s.id, t: entry.t, stream: 'stdout', line: entry.line });
  }

  /**
   * Agent-side watcher statuses arrive via the normal session.status path with
   * `meta = {type:'watched', workspace, label}`. Creates the watched record when
   * the id is unknown (the machine that sent it owns it) and never persists it.
   */
  _handleWatchedStatus(id, info, fromMachineId, meta) {
    let s = this.byId.get(id);
    if (!s) {
      if (!fromMachineId) return;
      s = this._createWatchedRecord(id, fromMachineId, meta && meta.workspace, meta && meta.label);
      this.byId.set(id, s);
      this._emitSession(id);
    } else if (!s._watched) {
      return; // id collision with a hub-spawned session — ignore
    } else {
      if (meta && typeof meta.workspace === 'string' && meta.workspace) s.workspace = meta.workspace;
      if (meta && typeof meta.label === 'string' && meta.label) s.label = meta.label;
    }
    this._applyWatchedStatus(s, info && info.status);
  }

  _applyWatchedStatus(s, status) {
    if (status !== 'running' && status !== 'idle' && status !== 'ended') return;
    if (s.status === status) return;
    s.status = status;
    if (status === 'ended') s.endedAt = Date.now();
    this._emitSession(s.id);
  }

  _createWatchedRecord(id, machineId, workspace, label) {
    const now = Date.now();
    return {
      id,
      machineId,
      type: 'watched',
      template: 'codex-watch',
      status: 'running',
      workspace: typeof workspace === 'string' ? workspace : '',
      label: (typeof label === 'string' && label) ? label : 'codex session',
      command: '',
      lines: [],
      lineBytes: 0,
      createdAt: now,
      startedAt: now,
      endedAt: null,
      exitCode: null,
      error: null,
      logFile: null,
      _watched: true,
      _logStream: null,
      _absLog: null
    };
  }

  /**
   * Status update (runner onStatus or agent session.status).
   * `fromMachineId` guards against spoofed/foreign status messages.
   * `meta` (optional) carries watched-session metadata from remote agents:
   * when meta.type === 'watched' the status routes to the watched-session path
   * (creating the record for the sending machine when the id is unknown).
   */
  handleStatus(id, info, fromMachineId, meta) {
    const s = this.byId.get(id);
    if (meta && meta.type === 'watched') {
      this._handleWatchedStatus(id, info, fromMachineId, meta);
      return;
    }
    if (!s || !info || typeof info !== 'object') return;
    if (fromMachineId && s.machineId !== fromMachineId) {
      console.warn(`[sessionhub] ignoring session.status for ${id} from machine ${fromMachineId}`);
      return;
    }
    if (info.status === 'running') {
      if (FINAL_STATUSES.has(s.status)) return;
      s.status = 'running';
      if (info.pid != null) s.pid = info.pid;
      if (!s.startedAt) {
        s.startedAt = (typeof info.startedAt === 'number' && info.startedAt) ? info.startedAt : Date.now();
      }
      s.error = null;
      this._emitSession(id);
      this._countChanged(s.machineId);
    } else if (info.status === 'stopped' || info.status === 'ended' || info.status === 'error') {
      this._finalize(s, info);
    }
    this.save();
  }

  /** Mark all running/pending/stopping sessions of a machine 'disconnected'
   * (its agent WS dropped). Watched sessions (running/idle) follow too — they
   * are stale while the agent is away — but are never finalized as
   * 'agent restarted' by endUnreconciled. */
  markDisconnected(machineId) {
    let changed = false;
    for (const s of this.byId.values()) {
      if (s.machineId !== machineId) continue;
      const active = ACTIVE_STATUSES.has(s.status) || (s._watched && (s.status === 'running' || s.status === 'idle'));
      if (!active) continue;
      s.status = 'disconnected';
      s.error = null;
      if (!s._watched) this._closeLog(s);
      this._emitSession(s.id);
      changed = true;
    }
    if (changed) {
      this._countChanged(machineId);
      this.save();
    }
  }

  /** Apply the statuses an agent re-sent after helloAck (reconnect reconcile). */
  reconcileRunning(machineId, liveStatuses) {
    if (!Array.isArray(liveStatuses)) return;
    for (const st of liveStatuses) {
      if (st && typeof st.id === 'string') this.handleStatus(st.id, st, machineId);
    }
  }

  /** Called ~5 s after a helloAck: sessions that never got a re-sent status did
   * not survive the agent restart -> ended with "agent restarted". Watched
   * sessions are skipped (they stay 'disconnected' until the agent's watcher
   * re-reports them). */
  endUnreconciled(machineId) {
    let changed = false;
    for (const s of this.byId.values()) {
      if (s.machineId !== machineId || s.status !== 'disconnected' || s._watched) continue;
      s.status = 'ended';
      s.endedAt = Date.now();
      s.exitCode = null;
      s.error = 'agent restarted';
      this._closeLog(s);
      this._emitSession(s.id);
      changed = true;
    }
    if (changed) {
      this._countChanged(machineId);
      this.save();
    }
  }

  // ------------------------------------------------------------- persistence

  save() {
    this.store.queue(() => ({ version: 1, savedAt: Date.now(), sessions: this.toStored() }));
  }

  toStored() {
    const out = [];
    for (const s of this.byId.values()) {
      if (s._watched) continue; // memory-only: never persisted
      out.push(this._public(s, false));
    }
    return out;
  }

  /** Restore sessions from the store on boot. Sessions that were running are
   * shown as 'disconnected' until agents reconnect. */
  rehydrate(stored) {
    if (!Array.isArray(stored)) return;
    let restored = 0;
    for (const meta of stored) {
      if (!meta || typeof meta.id !== 'string' || typeof meta.machineId !== 'string') continue;
      const s = Object.assign({}, meta, {
        lines: [],
        lineBytes: 0,
        _logStream: null,
        _absLog: path.join(this._logRoot, meta.id + '.log')
      });
      if (s.type !== 'oneshot' && s.type !== 'interactive') s.type = 'oneshot';
      if (ACTIVE_STATUSES.has(s.status)) {
        s.status = 'disconnected';
        s.error = null;
      }
      if (!FINAL_STATUSES.has(s.status) && s.status !== 'disconnected') s.status = 'disconnected';
      if (typeof s.label !== 'string' || !s.label) s.label = s.template;
      if (typeof s.logFile !== 'string' || !s.logFile) s.logFile = this._displayLog(s._absLog);
      this.byId.set(s.id, s);
      restored += 1;
    }
    if (restored > 0) console.log(`[sessionhub] restored ${restored} session(s) from state`);
  }

  // ------------------------------------------------------------- internals

  _activeCount(machineId) {
    let count = 0;
    for (const s of this.byId.values()) {
      // Watched sessions are monitoring-only: they neither count toward the
      // machine's running counter nor consume the per-machine session limit.
      if (s.machineId === machineId && ACTIVE_STATUSES.has(s.status) && !s._watched) count += 1;
    }
    return count;
  }

  _countChanged(machineId) {
    const m = this.machines.refreshRunning(machineId, this._activeCount(machineId));
    if (m) this.emit('machine', { machine: this.machines.publicRecord(m) });
  }

  _emitSession(id) {
    const s = this.byId.get(id);
    if (s) this.emit('session', { session: this._public(s, false) });
  }

  _finalize(s, info) {
    if (FINAL_STATUSES.has(s.status)) return;
    s.status = info.status;
    s.endedAt = (typeof info.endedAt === 'number' && info.endedAt) ? info.endedAt : Date.now();
    s.exitCode = info.exitCode != null ? info.exitCode : null;
    if (info.signal != null) s.signal = info.signal;
    s.error = info.error ? String(info.error) : null;
    this._closeLog(s);
    this._emitSession(s.id);
    this._countChanged(s.machineId);
  }

  /** Wire-safe session record. `withLines` adds the last <=50 ring lines. */
  _public(s, withLines) {
    const out = {
      id: s.id,
      machineId: s.machineId,
      workspace: s.workspace,
      template: s.template,
      type: s.type,
      label: s.label,
      status: s.status,
      createdAt: s.createdAt,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      exitCode: s.exitCode,
      error: s.error,
      command: s.command,
      externalId: s.externalId || null,
      logFile: s.logFile
    };
    if (withLines) out.lines = s.lines.slice(-50);
    return out;
  }

  _displayLog(absPath) {
    const rel = path.relative(this._root, absPath);
    const display = rel.startsWith('..') ? absPath : rel;
    return display.split(path.sep).join('/');
  }

  _logStream(s) {
    if (s._logStream && !s._logStream.destroyed) return s._logStream;
    try {
      const stream = fs.createWriteStream(s._absLog, { flags: 'a' });
      stream.on('error', () => { /* ignore log write errors */ });
      s._logStream = stream;
      return stream;
    } catch (e) {
      s._logStream = null;
      return null;
    }
  }

  _closeLog(s) {
    const stream = s._logStream;
    s._logStream = null;
    if (!stream || stream.destroyed) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => resolve();
      try {
        stream.once('close', done);
        stream.end();
      } catch (e) {
        done();
      }
      // Safety valve: never hang callers on a stuck stream.
      const guard = setTimeout(done, 2000);
      if (guard.unref) guard.unref();
    });
  }
}

module.exports = { Sessions, makeSessionId, resolvePromptLine };

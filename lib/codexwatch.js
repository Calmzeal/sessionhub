'use strict';
// CodexWatcher: tails Codex VSCode rollout transcript files
// (docs/SPEC.md "Codex VSCode session watching (v1.1)").
//
// API:
//   const { CodexWatcher } = require('../lib/codexwatch');
//   const watcher = new CodexWatcher({ dir, pollMs = 2000, idleMs = 600000, onEvent });
//   watcher.start();  watcher.stop();
//
// Events (delivered to onEvent AND emitted as 'event'):
//   { kind:'session', id, file, workspace, label }
//   { kind:'line', id, text }   // text already prefixed: user › / agent › / tool › / info ›
//   { kind:'status', id, status: 'running' | 'idle' | 'ended' }
//
// Mechanics: poll every pollMs; recursive scan for *.jsonl (skip history.jsonl);
// track per-file size; read appended bytes only via a persistent fd (reopen on
// shrink/rename); parse complete lines as JSON defensively. Workspace is sticky
// per file. id = 'w-' + sha1(fileAbsPath).slice(0,10).

const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const TEXT_CAP = 4000; // cap every emitted text
const TOOL_ARGS_CAP = 200; // function_call arguments JSON
const TOOL_OUTPUT_CAP = 400; // function_call_output first line
const FALLBACK_CAP = 400; // compact JSON fallback
const PENDING_MAX = 4 * 1024 * 1024; // defensive: drop runaway partial lines
const MAX_DEPTH = 16;

const PREFIX = {
  user: 'user › ',
  agent: 'agent › ',
  tool: 'tool › ',
  info: 'info › '
};

function expandHome(dir) {
  const s = String(dir || '');
  if (s === '~') {
    return process.platform === 'win32'
      ? (process.env.USERPROFILE || '')
      : (process.env.HOME || '');
  }
  if (s.startsWith('~/') || s.startsWith('~\\')) {
    const home = process.platform === 'win32'
      ? (process.env.USERPROFILE || '')
      : (process.env.HOME || '');
    if (!home) return s;
    return path.join(home, s.slice(2));
  }
  return s;
}

function sha1hex(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

function cap(s, n) {
  if (typeof s !== 'string') s = String(s);
  return s.length > n ? s.slice(0, n) : s;
}

// Workspace (sticky per file): first found of the candidate paths.
function extractWorkspace(line) {
  try {
    if (!line || typeof line !== 'object') return '';
    const p = line.payload && typeof line.payload === 'object' ? line.payload : null;
    const s = p && p.session && typeof p.session === 'object' ? p.session : null;
    const candidates = [
      line.cwd,
      p ? p.cwd : undefined,
      s ? s.cwd : undefined,
      p ? p.working_directory : undefined
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c;
    }
  } catch (e) { /* defensive */ }
  return '';
}

// Join the first present key of each content item, newline-separated.
function joinContent(content, keys) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    for (const k of keys) {
      const v = item[k];
      if (v !== undefined && v !== null && String(v) !== '') {
        parts.push(String(v));
        break;
      }
    }
  }
  return parts.join('\n');
}

// Map one JSONL line to [{key, text}, ...] per the SPEC extraction rules.
// Defensive against schema drift; every payload path is optional.
function extractTexts(line) {
  const out = [];
  try {
    const type = line && line.type;
    const payload = line && line.payload && typeof line.payload === 'object' ? line.payload : null;
    if (type === 'message' && payload && payload.role === 'user') {
      const t = joinContent(payload.content, ['input_text', 'text', 'output_text']);
      if (t) out.push({ key: 'user', text: t });
    } else if (type === 'response_item' && payload && payload.type === 'message' && payload.role === 'assistant') {
      const t = joinContent(payload.content, ['output_text', 'text']);
      if (t) out.push({ key: 'agent', text: t });
    } else if (type === 'response_item' && payload && payload.type === 'function_call') {
      const name = String(payload.name || 'function');
      let args = '';
      try {
        const a = typeof payload.arguments === 'string' ? JSON.parse(payload.arguments) : payload.arguments;
        args = a === undefined || a === null ? String(payload.arguments || '') : JSON.stringify(a);
      } catch (e) {
        args = String(payload.arguments || '');
      }
      out.push({ key: 'tool', text: name + '(' + cap(args, TOOL_ARGS_CAP) + ')' });
    } else if (type === 'response_item' && payload && payload.type === 'function_call_output') {
      const raw = String(payload.output || '');
      const firstLine = raw.split(/\r?\n/)[0];
      if (firstLine) out.push({ key: 'tool', text: cap(firstLine, TOOL_OUTPUT_CAP) });
    } else if (type === 'event_msg' && payload && (payload.type === 'agent_message' || payload.type === 'user_message')) {
      if (payload.message) out.push({ key: 'info', text: String(payload.message) });
    } else if (type !== 'session_meta') {
      // Fallback: compact JSON. session_meta is metadata (its cwd feeds the
      // sticky workspace only) and is not surfaced as a log line.
      let compact = '';
      try { compact = JSON.stringify(line); } catch (e) { compact = String(line || ''); }
      if (compact) out.push({ key: 'info', text: cap(compact, FALLBACK_CAP) });
    }
  } catch (e) {
    let compact = '';
    try { compact = JSON.stringify(line); } catch (e2) { compact = String(line || ''); }
    if (compact) out.push({ key: 'info', text: cap(compact, FALLBACK_CAP) });
  }
  return out;
}

class CodexWatcher extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.dir = expandHome(opts && opts.dir);
    this.pollMs = Math.max(50, Number(opts && opts.pollMs) > 0 ? Number(opts.pollMs) : 2000);
    this.idleMs = Math.max(50, Number(opts && opts.idleMs) > 0 ? Number(opts.idleMs) : 600000);
    this._onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
    this._files = new Map(); // absPath → entry
    this._timer = null;
    this._running = false;
    this._scanning = false;
  }

  _emitEvent(ev) {
    try {
      this.emit('event', ev);
    } catch (e) {
      // Listener exceptions must not kill the poll loop.
    }
    if (this._onEvent) {
      try {
        this._onEvent(ev);
      } catch (e) {
        // Consumer exceptions must not kill the poll loop.
      }
    }
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._timer = setInterval(() => { this._poll().catch(() => { /* guard */ }); }, this.pollMs);
    this._poll().catch(() => { /* guard */ });
  }

  stop() {
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    for (const entry of this._files.values()) {
      try {
        if (entry.fd !== null && entry.fd !== undefined) fs.closeSync(entry.fd);
      } catch (e) { /* guard */ }
    }
    this._files.clear();
  }

  // The configured dir may be ~/.codex (auto-narrow to its sessions subdir
  // when present) or a direct sessions dir.
  _sessionsRoot() {
    try {
      if (!this.dir) return null;
      const st = fs.statSync(this.dir);
      if (!st.isDirectory()) return null;
      const sessions = path.join(this.dir, 'sessions');
      try {
        if (fs.statSync(sessions).isDirectory()) return sessions;
      } catch (e) { /* no sessions subdir */ }
      return this.dir;
    } catch (e) {
      return null;
    }
  }

  async _poll() {
    if (!this._running || this._scanning) return;
    this._scanning = true;
    try {
      const root = this._sessionsRoot();
      if (!root) return;
      const now = Date.now();
      const seen = new Set();
      await this._scanDir(root, seen, 0);
      for (const [file, entry] of this._files) {
        if (seen.has(file)) {
          if (entry.status === 'running' && now - entry.lastGrowthAt >= this.idleMs) {
            entry.status = 'idle';
            this._emitEvent({ kind: 'status', id: entry.id, status: 'idle' });
          }
        } else if (!fs.existsSync(file)) {
          this._files.delete(file);
          try {
            if (entry.fd !== null && entry.fd !== undefined) fs.closeSync(entry.fd);
          } catch (e) { /* guard */ }
          entry.status = 'ended';
          this._emitEvent({ kind: 'status', id: entry.id, status: 'ended' });
        }
        // else: seen-missed (transient readdir error) — leave as-is; next poll re-checks.
      }
    } finally {
      this._scanning = false;
    }
  }

  async _scanDir(dir, seen, depth) {
    if (depth > MAX_DEPTH) return;
    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      return; // transient/denied — retry next poll
    }
    for (const d of dirents) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        await this._scanDir(full, seen, depth + 1);
      } else if (d.isFile() && d.name.endsWith('.jsonl') && d.name !== 'history.jsonl') {
        seen.add(full);
        await this._trackFile(full);
      }
    }
  }

  _labelFor(entry) {
    const ws = entry.workspace || '';
    if (!ws) return path.basename(entry.file);
    let base = '';
    try { base = path.basename(ws); } catch (e) { base = ''; }
    return path.basename(entry.file) + ' · ' + base;
  }

  async _trackFile(file) {
    let entry = this._files.get(file);
    if (!entry) {
      entry = {
        id: 'w-' + sha1hex(file).slice(0, 10),
        file,
        size: 0,
        fd: null,
        pending: '',
        lastGrowthAt: Date.now(),
        status: 'running',
        workspace: '',
        reported: false,
        reportedWorkspace: false
      };
      this._files.set(file, entry);
    }
    await this._readAppended(entry);
    if (!entry.reported) {
      entry.reported = true;
      this._emitEvent({
        kind: 'session',
        id: entry.id,
        file,
        workspace: entry.workspace,
        label: this._labelFor(entry)
      });
    } else if (!entry.reportedWorkspace && entry.workspace) {
      // Workspace discovered after the initial session event: re-emit so the
      // hub can update the record (SPEC: session event = create/update).
      entry.reportedWorkspace = true;
      this._emitEvent({
        kind: 'session',
        id: entry.id,
        file,
        workspace: entry.workspace,
        label: this._labelFor(entry)
      });
    }
  }

  async _readAppended(entry) {
    if (entry.fd === null || entry.fd === undefined) {
      try {
        entry.fd = fs.openSync(entry.file, 'r');
      } catch (e) {
        return; // retry next poll
      }
    }
    let st;
    try {
      st = fs.fstatSync(entry.fd);
    } catch (e) {
      return;
    }
    let fresh;
    try {
      fresh = fs.statSync(entry.file);
    } catch (e) {
      return; // deleted mid-poll — next poll reports 'ended'
    }
    // Reopen on shrink/rename (file replaced at the same path).
    const renamed = !!(fresh.ino && st.ino && (fresh.dev !== st.dev || fresh.ino !== st.ino));
    if (fresh.size < entry.size || renamed) {
      try { fs.closeSync(entry.fd); } catch (e) { /* guard */ }
      entry.fd = null;
      try {
        entry.fd = fs.openSync(entry.file, 'r');
      } catch (e) {
        entry.fd = null;
        return;
      }
      try {
        st = fs.fstatSync(entry.fd);
      } catch (e) {
        return;
      }
      entry.size = 0;
      entry.pending = '';
    }
    if (st.size <= entry.size) return;
    const toRead = st.size - entry.size;
    const buf = Buffer.alloc(toRead);
    let off = 0;
    try {
      while (off < toRead) {
        const n = fs.readSync(entry.fd, buf, off, toRead - off, entry.size + off);
        if (n <= 0) break;
        off += n;
      }
    } catch (e) {
      return; // read error — retry next poll
    }
    if (off <= 0) return;
    entry.size += off;
    entry.lastGrowthAt = Date.now();
    this._processBytes(entry, buf.subarray(0, off).toString('utf8'));
    if (entry.status !== 'running') {
      entry.status = 'running';
      this._emitEvent({ kind: 'status', id: entry.id, status: 'running' });
    }
  }

  _processBytes(entry, text) {
    entry.pending += text;
    let pos = 0;
    for (;;) {
      const idx = entry.pending.indexOf('\n', pos);
      if (idx === -1) break;
      this._processLine(entry, entry.pending.slice(pos, idx));
      pos = idx + 1;
    }
    entry.pending = entry.pending.slice(pos);
    if (entry.pending.length > PENDING_MAX) entry.pending = ''; // defensive drop
  }

  _processLine(entry, raw) {
    const lineText = raw.length > 0 && raw.charCodeAt(raw.length - 1) === 13
      ? raw.slice(0, -1)
      : raw;
    if (!lineText.trim()) return;
    let obj = null;
    try {
      obj = JSON.parse(lineText);
    } catch (e) {
      return; // defensive per-line parse: skip malformed lines
    }
    if (!obj || typeof obj !== 'object') return;
    const ws = extractWorkspace(obj);
    if (ws && !entry.workspace) entry.workspace = ws; // sticky per file
    for (const t of extractTexts(obj)) {
      this._emitEvent({
        kind: 'line',
        id: entry.id,
        text: cap(PREFIX[t.key] + t.text, TEXT_CAP)
      });
    }
  }
}

module.exports = { CodexWatcher };

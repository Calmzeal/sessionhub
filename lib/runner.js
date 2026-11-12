'use strict';
// SessionHub shared process runner (docs/SPEC.md "Shared libs").
// Manages child sessions: line-buffered output streaming, stdin writes,
// process-group termination (graceful then forced), status tracking.
//
// Exact API:
//   const { Runner, stripAnsi } = require('../lib/runner');
//   const runner = new Runner({ maxSessions, onLine, onStatus });
//   await runner.start({ id, cwd, command, env, initialPrompt, initialDelayMs })
//     // → Promise<{pid, startedAt}>; rejects on spawn failure (no onStatus emitted)
//   await runner.sendStdin(id, data)  // rejects {message:'not-running'} / {message:'stdin-closed'}
//   await runner.stop(id)             // → Promise<info>
//   await runner.stopAll()
//   runner.status(id)                 // → {status, pid, startedAt} | null
//   runner.ids()                      // → [id, ...]
//   stripAnsi(s)                      // → string (CSI + OSC sequences removed)

const { spawn } = require('child_process');

const LINE_MAX = 20000;
const TRUNC_SUFFIX = '\u2026[truncated]'; // "…[truncated]"

// Simplified, fast ANSI matchers: CSI and OSC sequences.
const CSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const OSC_RE = /[\u001b\u009b\]][^\u0007]*(?:\u0007|\u001b\\)/g;

function stripAnsi(s) {
  if (typeof s !== 'string') s = String(s);
  if (s.indexOf('\u001b') === -1 && s.indexOf('\u009b') === -1) return s;
  return s.replace(CSI_RE, '').replace(OSC_RE, '');
}

// Decode one output line's bytes: strict UTF-8 first, then the Windows
// console codepage (GBK on Chinese systems — cmd.exe writes GBK, and
// decoding it as UTF-8 produced mojibake). Node's official builds ship
// full ICU, so TextDecoder('gbk') is available.
function decodeLine(buf) {
  if (!buf || !buf.length) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch (e2) {
      return new TextDecoder('utf-8').decode(buf); // last resort: replacement chars
    }
  }
}

function errWithCode(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

class Runner {
  constructor(opts = {}) {
    const max = Number(opts && opts.maxSessions);
    this.maxSessions = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 8;
    this.onLine = typeof opts.onLine === 'function' ? opts.onLine : null;
    this.onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : null;
    this._map = new Map(); // id → {child, pid, startedAt, status, stopInitiated, buffers, ended, ...}
  }

  _runningCount() {
    let n = 0;
    for (const entry of this._map.values()) {
      if (entry.status === 'running') n += 1;
    }
    return n;
  }

  _emitStatus(id, info) {
    if (this.onStatus) {
      try {
        this.onStatus(id, info);
      } catch (e) {
        // User callbacks must never throw back into the runner.
      }
    }
  }

  _emitLine(entry, stream, raw) {
    try {
      let line = raw;
      // One trailing \r per line (lines are split on \n; /\r?\n/ semantics).
      if (line.length > 0 && line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
      line = stripAnsi(line);
      if (line.length > LINE_MAX) line = line.slice(0, LINE_MAX) + TRUNC_SUFFIX;
      if (this.onLine) {
        try {
          this.onLine(entry.id, stream, line);
        } catch (e) {
          // User callbacks must never throw back into the runner.
        }
      }
    } catch (e) {
      // Guard: never throw from stream handlers.
    }
  }

  _handleData(entry, stream, chunk) {
    try {
      const combined = Buffer.concat([entry.buffers[stream], Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')]);
      let pos = 0;
      for (;;) {
        const idx = combined.indexOf(0x0a, pos); // \n as a byte
        if (idx === -1) break;
        this._emitLine(entry, stream, decodeLine(combined.subarray(pos, idx)));
        pos = idx + 1;
      }
      entry.buffers[stream] = combined.subarray(pos);
    } catch (e) {
      // Guard: never throw from stream handlers.
    }
  }

  _finalizeStatus(entry, code, signal) {
    if (entry.statusFinal || entry.ended) return;
    entry.statusFinal = true;
    try {
      if (entry.initialPromptTimer) clearTimeout(entry.initialPromptTimer);
    } catch (e) { /* guard */ }
    entry.status = entry.stopInitiated ? 'stopped' : 'ended';
    entry.exitCode = code !== undefined && code !== null ? code : null;
    entry.signal = signal || null;
    entry.endedAt = Date.now();
    this._emitStatus(entry.id, {
      status: entry.status,
      pid: entry.pid,
      startedAt: entry.startedAt,
      exitCode: entry.exitCode,
      signal: entry.signal,
      endedAt: entry.endedAt
    });
  }

  _finalizeClose(entry, code, signal) {
    if (entry.closed) return;
    entry.closed = true;
    // 'exit' normally finalizes first; keep this defensive in case it never fired.
    if (!entry.statusFinal && !entry.ended) this._finalizeStatus(entry, code, signal);
    try {
      const out = entry.buffers.stdout;
      if (out && out.length) this._emitLine(entry, 'stdout', decodeLine(out));
      const errOut = entry.buffers.stderr;
      if (errOut && errOut.length) this._emitLine(entry, 'stderr', decodeLine(errOut));
    } catch (e) { /* guard */ }
    entry.buffers = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    try { entry.child = null; } catch (e) { /* guard */ }
    const waiters = entry.waitClose;
    entry.waitClose = [];
    for (const fn of waiters) {
      try { fn(); } catch (e) { /* guard */ }
    }
  }

  _writeStdin(entry, data) {
    try {
      if (!entry || entry.status !== 'running') return false;
      const child = entry.child;
      if (!child || !child.stdin || child.stdin.destroyed || !child.stdin.writable) return false;
      const line = data === undefined || data === null ? '' : String(data);
      child.stdin.write(line.replace(/\r?\n$/, '') + '\n');
      return true;
    } catch (e) {
      return false;
    }
  }

  start(opts) {
    return new Promise((resolve, reject) => {
      opts = opts || {};
      const id = String(opts.id);
      const command = opts.command;
      const cwd = opts.cwd;
      const env = opts.env || {};
      const initialPrompt = opts.initialPrompt;
      const initialDelayMs = Math.max(0, Number(opts.initialDelayMs) || 0);

      const existing = this._map.get(id);
      if (existing && existing.status === 'running') {
        reject(errWithCode('already running', 'already-running'));
        return;
      }
      if (this._runningCount() >= this.maxSessions) {
        reject(errWithCode('max sessions reached', 'max-sessions'));
        return;
      }

      let child;
      try {
        child = spawn(command, {
          cwd,
          env: { ...process.env, ...env },
          shell: true,
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch (err) {
        reject(err);
        return;
      }

      const entry = {
        id,
        child,
        pid: null,
        startedAt: Date.now(),
        status: 'running',
        stopInitiated: false,
        buffers: { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
        ended: false,
        spawned: false,
        statusFinal: false,
        closed: false,
        exitCode: null,
        signal: null,
        endedAt: null,
        error: null,
        initialPromptTimer: null,
        waitClose: []
      };
      this._map.set(id, entry);

      child.once('error', (err) => {
        // Spawn failure: reject, do NOT emit onStatus, remove the entry.
        if (entry.spawned || entry.ended) return;
        entry.ended = true;
        this._map.delete(id);
        reject(err);
      });

      child.once('spawn', () => {
        if (entry.ended) return;
        entry.spawned = true;
        entry.pid = child.pid;
        // NOTE: no setEncoding here — data chunks must stay raw Buffers so
        // decodeLine can pick UTF-8 vs the Windows console codepage (GBK).
        try {
          child.stdout.on('data', (chunk) => this._handleData(entry, 'stdout', chunk));
          child.stderr.on('data', (chunk) => this._handleData(entry, 'stderr', chunk));
        } catch (e) { /* guard */ }
        child.once('exit', (code, signal) => this._finalizeStatus(entry, code, signal));
        child.once('close', (code, signal) => this._finalizeClose(entry, code, signal));

        this._emitStatus(id, { status: 'running', pid: entry.pid, startedAt: entry.startedAt });

        if (initialPrompt !== undefined && initialPrompt !== null && initialPrompt !== '') {
          entry.initialPromptTimer = setTimeout(() => {
            try {
              this._writeStdin(entry, initialPrompt);
            } catch (e) { /* guard */ }
          }, initialDelayMs);
        }

        resolve({ pid: entry.pid, startedAt: entry.startedAt });
      });
    });
  }

  sendStdin(id, data) {
    return new Promise((resolve, reject) => {
      const entry = this._map.get(String(id));
      if (!entry || entry.status !== 'running') {
        reject(errWithCode('not-running', 'not-running'));
        return;
      }
      let stdin = null;
      try {
        stdin = entry.child ? entry.child.stdin : null;
      } catch (e) {
        stdin = null;
      }
      if (!stdin || stdin.destroyed || !stdin.writable) {
        reject(errWithCode('stdin-closed', 'stdin-closed'));
        return;
      }
      const line = data === undefined || data === null ? '' : String(data);
      try {
        stdin.write(line.replace(/\r?\n$/, '') + '\n', (err) => {
          if (err) {
            reject(errWithCode('stdin-closed', 'stdin-closed'));
          } else {
            resolve();
          }
        });
      } catch (err) {
        reject(errWithCode('stdin-closed', 'stdin-closed'));
      }
    });
  }

  _killTree(entry, force) {
    try {
      const pid = entry.pid;
      if (!pid) return;
      if (process.platform === 'win32') {
        // Windows: taskkill /T /F kills the whole tree. Don't await its stdout.
        const t = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        });
        t.on('error', () => { /* ignore: process may already be gone */ });
      } else if (force) {
        try { process.kill(-pid, 'SIGKILL'); } catch (e) { /* already gone */ }
      } else {
        try { process.kill(-pid, 'SIGTERM'); } catch (e) { /* already gone */ }
      }
    } catch (e) { /* guard */ }
  }

  _info(entry) {
    return {
      status: entry.status,
      pid: entry.pid,
      startedAt: entry.startedAt,
      exitCode: entry.exitCode,
      signal: entry.signal,
      error: entry.error,
      endedAt: entry.endedAt
    };
  }

  stop(id) {
    return new Promise((resolve) => {
      const entry = this._map.get(String(id));
      if (!entry) {
        resolve(null);
        return;
      }
      if (entry.status !== 'running') {
        resolve(this._info(entry));
        return;
      }
      entry.stopInitiated = true;
      this._killTree(entry, false);

      const forceTimer = setTimeout(() => {
        try {
          if (entry.status === 'running') this._killTree(entry, true);
        } catch (e) { /* guard */ }
      }, 3000);

      let done = false;
      let guardTimer = null;
      const finish = () => {
        if (done) return;
        done = true;
        try { clearTimeout(forceTimer); } catch (e) { /* guard */ }
        if (guardTimer) { try { clearTimeout(guardTimer); } catch (e) { /* guard */ } }
        resolve(this._info(entry));
      };
      guardTimer = setTimeout(finish, 8000);
      entry.waitClose.push(finish);
    });
  }

  stopAll() {
    const ids = this.ids();
    return Promise.all(ids.map((id) => this.stop(id).catch(() => null)));
  }

  status(id) {
    const entry = this._map.get(String(id));
    if (!entry) return null;
    return { status: entry.status, pid: entry.pid, startedAt: entry.startedAt };
  }

  ids() {
    return Array.from(this._map.keys());
  }
}

module.exports = { Runner, stripAnsi };

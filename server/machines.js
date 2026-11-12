'use strict';

// Machine registry + remote FS proxy.
// - The hub's own machine is registered as `local: true` (always connected).
// - Remote agents register via `registerRemote(ws, hello)`.
// - FS operations are routed through lib/fsutil for local machines and proxied
//   over the agent WebSocket (reqId promise map with a 20 s timeout) for remote ones.

const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { WebSocket } = require('ws');
const { resolveWithin, listDir, readFile, readChunk } = require('../lib/fsutil');

const REQUEST_TIMEOUT_MS = 20000;

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/**
 * Sanitize a machine name per SPEC:
 * lowercase, chars outside [a-z0-9_-] become '-', trimmed;
 * empty result becomes 'machine-<rand6>'.
 */
function sanitizeName(name) {
  let s = String(name == null ? '' : name).toLowerCase().replace(/[^a-z0-9_-]/g, '-').trim();
  s = s.replace(/^-+|-+$/g, '');
  if (!s) s = 'machine-' + Math.random().toString(36).slice(2, 8);
  return s;
}

class Machines extends EventEmitter {
  constructor(config) {
    super();
    const rawName = (typeof config.machineName === 'string' && config.machineName.trim())
      ? config.machineName.trim()
      : os.hostname();
    const id = sanitizeName(rawName);
    this._local = {
      id,
      name: rawName,
      host: os.hostname(),
      os: process.platform,
      arch: process.arch,
      status: 'connected',
      lastSeenAt: Date.now(),
      allowedRoots: Array.isArray(config.allowedRoots) ? config.allowedRoots.slice() : [],
      local: true,
      running: 0
    };
    this.byId = new Map([[id, this._local]]);
  }

  get localId() { return this._local.id; }
  get localName() { return this._local.name; }

  /** Public (wire-safe) record: no agent socket / pending map / reqSeq. */
  publicRecord(m) {
    return {
      id: m.id,
      name: m.name,
      host: m.host,
      os: m.os,
      arch: m.arch,
      status: m.status,
      lastSeenAt: m.lastSeenAt,
      allowedRoots: m.allowedRoots,
      local: m.local,
      running: m.running
    };
  }

  get(id) { return this.byId.get(id); }

  all() { return Array.from(this.byId.values()).map((m) => this.publicRecord(m)); }

  /**
   * Register a remote agent connection.
   * - Name collision with an already-connected remote machine: close the OLD
   *   socket with code 4002 (this is a reconnect) and take over.
   * - Name collision with the hub's local machine: throws {closeCode: 4002} so
   *   the caller can close the NEW socket.
   * Returns the machine record (with the agent socket attached).
   */
  registerRemote(ws, hello) {
    const id = sanitizeName(hello && hello.name);
    const existing = this.byId.get(id);
    if (existing && existing.local) {
      const err = httpError(409, 'name-conflict', `agent name "${id}" conflicts with the hub's own machine`);
      err.closeCode = 4002;
      throw err;
    }
    if (
      existing && existing.status === 'connected' &&
      existing.agent && existing.agent !== ws &&
      existing.agent.readyState === WebSocket.OPEN
    ) {
      try { existing.agent.close(4002, 'replaced by reconnect'); } catch (e) { /* ignore */ }
      this._rejectPending(existing, httpError(409, 'machine-offline', 'agent connection replaced'));
    }
    const machine = existing || { id, name: id, local: false, running: 0 };
    machine.host = typeof hello.hostname === 'string' ? hello.hostname : '';
    machine.os = typeof hello.os === 'string' ? hello.os : 'unknown';
    machine.arch = typeof hello.arch === 'string' ? hello.arch : '';
    machine.allowedRoots = Array.isArray(hello.allowedRoots) ? hello.allowedRoots : [];
    machine.maxSessions = (typeof hello.maxSessions === 'number' && hello.maxSessions > 0) ? hello.maxSessions : null;
    machine.status = 'connected';
    machine.lastSeenAt = Date.now();
    machine.agent = ws;
    machine.reqSeq = 0;
    machine.pending = new Map();
    this.byId.set(id, machine);
    this.emit('machine', { machine: this.publicRecord(machine) });
    return machine;
  }

  /**
   * Mark a remote machine disconnected because its socket closed.
   * Only applies when `ws` is still the owning socket (a newer connection may
   * have taken over). Returns true when the machine was actually disconnected.
   */
  unregister(id, ws) {
    const m = this.byId.get(id);
    if (!m || m.local || !m.agent || m.agent !== ws) return false;
    m.status = 'disconnected';
    m.lastSeenAt = Date.now();
    m.agent = null;
    this._rejectPending(m, httpError(409, 'machine-offline', 'machine is offline'));
    this.emit('machine', { machine: this.publicRecord(m) });
    return true;
  }

  /** Update the running-session counter; returns the record when it changed. */
  refreshRunning(id, count) {
    const m = this.byId.get(id);
    if (!m || m.running === count) return null;
    m.running = count;
    return m;
  }

  /** Send a JSON object to a machine's agent. Returns false when not connected. */
  sendTo(id, obj) {
    const m = this.byId.get(id);
    if (!m || !m.agent || m.agent.readyState !== WebSocket.OPEN) return false;
    try {
      m.agent.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      return false;
    }
  }

  // ------------------------------------------------------------------ FS layer

  /**
   * Validate an absolute path against the machine's allowedRoots and return the
   * resolved path + matching root. Throws {status:403} outside the roots and
   * {status:404} when under a root but missing.
   */
  resolvePath(id, absPath) {
    const m = this.byId.get(id);
    if (!m) throw httpError(404, 'machine-unknown', 'unknown machine');
    if (typeof absPath !== 'string' || absPath.length === 0) {
      throw httpError(400, 'bad-path', 'path must be an absolute path');
    }
    const platform = m.os === 'win32' ? 'win32' : 'posix';
    const isAbs = platform === 'win32' ? path.win32.isAbsolute(absPath) : path.posix.isAbsolute(absPath);
    if (!isAbs) throw httpError(400, 'bad-path', 'path must be an absolute path');
    const roots = Array.isArray(m.allowedRoots) ? m.allowedRoots : [];
    if (!roots.length) throw httpError(403, 'forbidden', 'machine has no allowed roots');
    let last404 = null;
    let last403 = null;
    for (const root of roots) {
      try {
        const resolved = resolveWithin([root], absPath, platform);
        return { root, resolved };
      } catch (err) {
        if (err && err.status === 404) last404 = err;
        else if (!last403) last403 = err;
      }
    }
    if (last404) throw last404;
    if (last403) throw last403;
    throw httpError(403, 'forbidden', 'path is outside the machine\'s allowed roots');
  }

  async fsList(id, absPath) {
    const m = this.byId.get(id);
    if (!m) throw httpError(404, 'machine-unknown', 'unknown machine');
    if (m.local) {
      const { root, resolved } = this.resolvePath(id, absPath);
      return listDir(root, resolved);
    }
    if (m.status !== 'connected') throw httpError(409, 'machine-offline', 'machine is offline');
    return this._request(m, 'fs.list', { path: absPath });
  }

  async fsRead(id, absPath, mode, maxBytes) {
    const m = this.byId.get(id);
    if (!m) throw httpError(404, 'machine-unknown', 'unknown machine');
    if (m.local) {
      const { resolved } = this.resolvePath(id, absPath);
      return readFile(resolved, { mode, maxBytes });
    }
    if (m.status !== 'connected') throw httpError(409, 'machine-offline', 'machine is offline');
    return this._request(m, 'fs.read', { path: absPath, mode, maxBytes });
  }

  async fsChunk(id, absPath, offset, length) {
    const m = this.byId.get(id);
    if (!m) throw httpError(404, 'machine-unknown', 'unknown machine');
    if (m.local) {
      const { resolved } = this.resolvePath(id, absPath);
      return readChunk(resolved, offset, length);
    }
    if (m.status !== 'connected') throw httpError(409, 'machine-offline', 'machine is offline');
    return this._request(m, 'fs.chunk', { path: absPath, offset, length });
  }

  /** Send an fs.* request to a remote agent; resolves on fs.result, rejects on
   * error or after a 20 s timeout (504 'agent-timeout'). */
  _request(machine, type, payload) {
    return new Promise((resolve, reject) => {
      const reqId = ++machine.reqSeq;
      const timer = setTimeout(() => {
        machine.pending.delete(reqId);
        reject(httpError(504, 'agent-timeout', 'agent did not answer in time'));
      }, REQUEST_TIMEOUT_MS);
      if (timer.unref) timer.unref();
      machine.pending.set(reqId, { resolve, reject, timer });
      if (!this.sendTo(machine.id, Object.assign({ type, reqId }, payload))) {
        clearTimeout(timer);
        machine.pending.delete(reqId);
        reject(httpError(409, 'machine-offline', 'machine went offline during the request'));
      }
    });
  }

  /** Resolve a pending fs request from an agent's fs.result message. */
  resolveReq(machineId, reqId, ok, payload, error) {
    const m = this.byId.get(machineId);
    if (!m || !m.pending) return;
    const entry = m.pending.get(reqId);
    if (!entry) return;
    m.pending.delete(reqId);
    clearTimeout(entry.timer);
    if (ok) {
      entry.resolve(payload);
      return;
    }
    if (error && typeof error === 'object' && typeof error.status === 'number') {
      entry.reject(httpError(error.status, error.code || 'agent-error', error.message || 'agent error'));
      return;
    }
    const msg = typeof error === 'string' ? error : (error && error.message) || 'agent error';
    entry.reject(httpError(500, 'agent-error', msg));
  }

  _rejectPending(machine, err) {
    if (!machine.pending) return;
    for (const entry of machine.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    machine.pending.clear();
  }
}

module.exports = { Machines, sanitizeName };

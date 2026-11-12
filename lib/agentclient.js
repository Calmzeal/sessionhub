'use strict';
// SessionHub outbound agent client (docs/SPEC.md v1.3 "Hub peers").
// Extracted from agent/agent.js: everything a remote agent does over the hub
// WebSocket — hello/helloAck handshake, session.start/stdin/stop dispatch to
// lib/runner, fs.list/read/chunk/mkdir, codex session watching (v1.1),
// reconnect with backoff, ping/pong heartbeat, and graceful stop.
//
// Used by:
//   - agent/agent.js (standalone agent process): thin wrapper that maps
//     onFatal to console.error + process.exit(1).
//   - server/ (hub `peers`): a peer client runs in-process and must NOT call
//     process.exit — onFatal logs and stops instead.
//
// API:
//   const { createAgentClient } = require('../lib/agentclient');
//   const client = createAgentClient({
//     hubUrl, token, name, allowedRoots, maxSessions, codexWatch,
//     logPrefix,        // optional, default '[sessionhub-agent] '
//     onFatal           // optional (message) => void — auth failure (4001)
//                       // or name conflict (4002) before helloAck; the client
//                       // stops reconnecting afterwards. Never calls process.exit.
//   });
//   await client.stop();  // close WS + stop codex watcher + runner.stopAll();
//                         // resolves when done; idempotent.

const WebSocket = require('ws');
const os = require('os');
const fs = require('fs');
const { Runner } = require('./runner');
const { CodexWatcher } = require('./codexwatch');
const fsutil = require('./fsutil');

function createAgentClient(opts) {
  opts = opts || {};
  const hubUrl = String(opts.hubUrl || '');
  const token = String(opts.token || '');
  const name = String(opts.name || '');
  const allowedRoots = Array.isArray(opts.allowedRoots) ? opts.allowedRoots : [];
  const maxSessions = Number(opts.maxSessions) > 0 ? Math.floor(Number(opts.maxSessions)) : 4;
  const codexWatch = (opts.codexWatch && typeof opts.codexWatch === 'object')
    ? opts.codexWatch
    : { enabled: false };
  const logPrefix = typeof opts.logPrefix === 'string' && opts.logPrefix
    ? opts.logPrefix
    : '[sessionhub-agent] ';
  const onFatal = typeof opts.onFatal === 'function' ? opts.onFatal : null;

  const log = (msg) => console.log(logPrefix + msg);
  const errLog = (msg) => console.error(logPrefix + msg);

  let ws = null;
  let helloAcked = false;
  let helloTimer = null;
  let reconnectTimer = null;
  let reconnectDelay = 2000;
  let lastPongAt = Date.now();
  let shuttingDown = false;

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(obj));
      } catch (e) { /* guard */ }
    }
  }

  const runner = new Runner({
    maxSessions,
    onLine: (id, stream, line) => {
      send({ type: 'session.output', id, stream, line });
    },
    onStatus: (id, info) => {
      log('session ' + id + ' ' + info.status +
        (info.exitCode === undefined || info.exitCode === null ? '' : ' exit=' + info.exitCode));
      send({
        type: 'session.status',
        id,
        status: info.status,
        pid: info.pid === undefined || info.pid === null ? null : info.pid,
        startedAt: info.startedAt === undefined || info.startedAt === null ? 0 : info.startedAt,
        exitCode: info.exitCode === undefined || info.exitCode === null ? null : info.exitCode,
        signal: info.signal || null,
        error: info.error || null,
        endedAt: info.endedAt === undefined || info.endedAt === null ? 0 : info.endedAt
      });
    }
  });

  function errObj(err) {
    return {
      status: err && typeof err.status === 'number' ? err.status : 500,
      message: (err && err.message) || String(err)
    };
  }

  // Codex VSCode session watching (v1.1): optional read-only watcher whose
  // events are forwarded to the hub as watched-session status/output.
  const watchedSessions = new Map(); // id → {workspace, label, status, startedAt}
  let codexWatcher = null;
  let codexWatcherStarted = false;
  if (codexWatch.enabled) {
    codexWatcher = new CodexWatcher({
      dir: codexWatch.sessionsDir,
      pollMs: codexWatch.pollMs,
      idleMs: codexWatch.idleMs,
      onEvent: (ev) => {
        try {
          if (ev.kind === 'session') {
            const prev = watchedSessions.get(ev.id);
            const info = {
              workspace: ev.workspace || '',
              label: ev.label || '',
              status: 'running',
              startedAt: prev ? prev.startedAt : Date.now()
            };
            watchedSessions.set(ev.id, info);
            send({
              type: 'session.status', id: ev.id, status: 'running',
              pid: null, startedAt: info.startedAt, exitCode: null, signal: null, error: null, endedAt: 0,
              meta: { type: 'watched', workspace: info.workspace, label: info.label }
            });
          } else if (ev.kind === 'line') {
            send({ type: 'session.output', id: ev.id, stream: 'stdout', line: ev.text });
          } else if (ev.kind === 'status') {
            if (ev.status === 'ended') {
              watchedSessions.delete(ev.id);
            } else {
              const info = watchedSessions.get(ev.id);
              if (info) info.status = ev.status;
            }
            send({
              type: 'session.status', id: ev.id, status: ev.status,
              pid: null, startedAt: 0, exitCode: null, signal: null, error: null,
              endedAt: ev.status === 'ended' ? Date.now() : 0,
              meta: { type: 'watched' }
            });
          }
        } catch (e) { /* guard */ }
      }
    });
    // Started lazily on first successful socket open (connect readiness), so
    // initial transcript events are not dropped while the WS is still dialing.
    log('codex watch enabled: dir=' + codexWatch.sessionsDir +
      ' pollMs=' + codexWatch.pollMs + ' idleMs=' + codexWatch.idleMs);
  }

  // Resolve a path against the allowed roots; returns {resolved, root} for the
  // first root that accepts it. Prefers a 404 over a 403 when one was seen.
  function resolveWithRoot(p) {
    const target = String(p || '');
    if (!allowedRoots.length) throw { status: 403, message: 'outside allowed roots' };
    let firstErr = null;
    for (const root of allowedRoots) {
      try {
        return { resolved: fsutil.resolveWithin([root], target, process.platform), root };
      } catch (err) {
        if (!firstErr || (err && err.status === 404 && firstErr.status === 403)) firstErr = err;
      }
    }
    throw firstErr || { status: 403, message: 'outside allowed roots' };
  }

  function resolvePathAny(p) {
    if (!p) {
      if (!allowedRoots.length) throw { status: 403, message: 'outside allowed roots' };
      return fsutil.resolveWithin([allowedRoots[0]], allowedRoots[0], process.platform);
    }
    return resolveWithRoot(p).resolved;
  }

  function handleStart(msg) {
    const id = String(msg && msg.id ? msg.id : '');
    if (!id || !msg.command) {
      send({
        type: 'session.status', id, status: 'error', pid: null, startedAt: 0,
        exitCode: null, signal: null, error: 'invalid session.start', endedAt: Date.now()
      });
      return;
    }
    let cwd;
    try {
      cwd = resolvePathAny(msg.cwd);
      let st;
      try {
        st = fs.statSync(cwd);
      } catch (e) {
        throw { status: 404, message: 'cwd not found' };
      }
      if (!st.isDirectory()) throw { status: 400, message: 'cwd is not a directory' };
    } catch (err) {
      errLog('session ' + id + ' start rejected: ' + (err && err.message));
      send({
        type: 'session.status', id, status: 'error', pid: null, startedAt: 0,
        exitCode: null, signal: null, error: (err && err.message) || String(err), endedAt: Date.now()
      });
      return;
    }
    runner.start({
      id,
      cwd,
      command: String(msg.command),
      env: msg.env && typeof msg.env === 'object' && !Array.isArray(msg.env) ? msg.env : {},
      initialPrompt: msg.initialPrompt,
      initialDelayMs: msg.initialDelayMs
    }).then((info) => {
      log('session ' + id + ' started pid=' + info.pid + ' in ' + cwd);
    }).catch((err) => {
      errLog('session ' + id + ' start failed: ' + (err && err.message));
      send({
        type: 'session.status', id, status: 'error', pid: null, startedAt: 0,
        exitCode: null, signal: null, error: (err && err.message) || String(err), endedAt: Date.now()
      });
    });
  }

  function handleStdin(msg) {
    const id = String(msg && msg.id ? msg.id : '');
    runner.sendStdin(id, msg && msg.data).then(() => {
      send({ type: 'session.stdinResult', id, ok: true, error: null });
    }).catch((err) => {
      send({ type: 'session.stdinResult', id, ok: false, error: (err && err.message) || String(err) });
    });
  }

  function handleFsList(msg) {
    try {
      const { resolved, root } = resolveWithRoot(msg && msg.path);
      const payload = fsutil.listDir(root, resolved);
      send({ type: 'fs.result', reqId: msg && msg.reqId, ok: true, payload, error: null });
    } catch (err) {
      send({ type: 'fs.result', reqId: msg && msg.reqId, ok: false, payload: null, error: errObj(err) });
    }
  }

  function handleFsRead(msg) {
    try {
      const resolved = resolvePathAny(msg && msg.path);
      const mode = msg && msg.mode === 'meta' ? 'meta' : 'text';
      const payload = fsutil.readFile(resolved, { mode, maxBytes: msg && msg.maxBytes });
      send({ type: 'fs.result', reqId: msg && msg.reqId, ok: true, payload, error: null });
    } catch (err) {
      send({ type: 'fs.result', reqId: msg && msg.reqId, ok: false, payload: null, error: errObj(err) });
    }
  }

  function handleFsChunk(msg) {
    try {
      const resolved = resolvePathAny(msg && msg.path);
      const payload = fsutil.readChunk(resolved, msg && msg.offset, msg && msg.length);
      send({ type: 'fs.result', reqId: msg && msg.reqId, ok: true, payload, error: null });
    } catch (err) {
      send({ type: 'fs.result', reqId: msg && msg.reqId, ok: false, payload: null, error: errObj(err) });
    }
  }

  function handleFsMkdir(msg) {
    try {
      const resolved = fsutil.mkdirWithin(allowedRoots, msg && msg.path, process.platform);
      send({ type: 'fs.result', reqId: msg && msg.reqId, ok: true, payload: { path: resolved }, error: null });
    } catch (err) {
      send({ type: 'fs.result', reqId: msg && msg.reqId, ok: false, payload: null, error: errObj(err) });
    }
  }

  function handleMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch (e) {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'helloAck':
        helloAcked = true;
        try { clearTimeout(helloTimer); } catch (e) { /* guard */ }
        reconnectDelay = 2000;
        log('connected as ' + name + ' to ' + hubUrl);
        // Reconcile: report every live child still running.
        for (const id of runner.ids()) {
          const st = runner.status(id);
          if (st && st.status === 'running') {
            send({
              type: 'session.status', id, status: 'running',
              pid: st.pid === undefined || st.pid === null ? null : st.pid,
              startedAt: st.startedAt === undefined || st.startedAt === null ? 0 : st.startedAt,
              exitCode: null, signal: null, error: null, endedAt: 0
            });
          }
        }
        // Reconcile watched (v1.1 Codex) sessions too.
        for (const [id, info] of watchedSessions) {
          if (info.status === 'ended') continue;
          send({
            type: 'session.status', id, status: 'running',
            pid: null, startedAt: info.startedAt, exitCode: null, signal: null, error: null, endedAt: 0,
            meta: { type: 'watched', workspace: info.workspace, label: info.label }
          });
        }
        break;
      case 'session.start':
        handleStart(msg);
        break;
      case 'session.stdin':
        handleStdin(msg);
        break;
      case 'session.stop':
        runner.stop(String(msg && msg.id)).then((info) => {
          log('session ' + msg.id + ' stop complete' + (info && info.status ? ' (' + info.status + ')' : ''));
        }).catch((err) => {
          errLog('session ' + msg.id + ' stop error: ' + (err && err.message));
        });
        break;
      case 'fs.list':
        handleFsList(msg);
        break;
      case 'fs.read':
        handleFsRead(msg);
        break;
      case 'fs.chunk':
        handleFsChunk(msg);
        break;
      case 'fs.mkdir':
        handleFsMkdir(msg);
        break;
      case 'ping':
        send({ type: 'pong', t: msg.t });
        break;
      default:
        break;
    }
  }

  function connect() {
    helloAcked = false;
    const sep = hubUrl.indexOf('?') !== -1 ? '&' : '?';
    const url = hubUrl + sep + 'token=' + encodeURIComponent(token);
    const sock = new WebSocket(url);
    ws = sock;

    sock.on('open', () => {
      if (shuttingDown) return;
      if (codexWatcher && !codexWatcherStarted) {
        codexWatcherStarted = true;
        try { codexWatcher.start(); } catch (e) { /* guard */ }
      }
      send({
        type: 'hello',
        v: 1,
        name,
        hostname: os.hostname(),
        os: process.platform,
        arch: process.arch,
        allowedRoots,
        maxSessions
      });
      helloTimer = setTimeout(() => {
        if (!helloAcked) {
          errLog('hello ack timeout');
          try { sock.close(4000, 'hello timeout'); } catch (e) { /* guard */ }
        }
      }, 5000);
    });

    sock.on('message', (data) => {
      try {
        handleMessage(data);
      } catch (err) {
        errLog('message handling error: ' + ((err && err.stack) || err));
      }
    });

    sock.on('pong', () => {
      lastPongAt = Date.now();
    });

    sock.on('error', (err) => {
      errLog('connection error: ' + (err && err.message));
    });

    sock.on('close', (code) => {
      if (ws === sock) ws = null;
      try { clearTimeout(helloTimer); } catch (e) { /* guard */ }
      if (shuttingDown) return;
      const wasAcked = helloAcked;
      helloAcked = false;
      if (!wasAcked) {
        if (code === 4001) {
          if (onFatal) onFatal('auth failed');
          else errLog('auth failed');
          return;
        }
        if (code === 4002) {
          if (onFatal) onFatal('name conflict');
          else errLog('name conflict');
          return;
        }
      }
      const delay = wasAcked ? 2000 : Math.min(reconnectDelay, 30000);
      if (!wasAcked) reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      log('reconnecting in ' + (delay / 1000) + 's' + (code ? ' (code ' + code + ')' : ''));
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!shuttingDown) connect();
      }, delay);
    });
  }

  // Heartbeat: ping the hub every 30s; terminate + reconnect if no pong in 60s.
  // (Hub-side ws-protocol pings are auto-ponged by the ws library.)
  const heartbeatInterval = setInterval(() => {
    if (shuttingDown) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (Date.now() - lastPongAt > 60000) {
        errLog('no pong from hub for 60s, terminating connection');
        try { ws.terminate(); } catch (e) { /* guard */ }
        return;
      }
      try { ws.ping(); } catch (e) { /* guard */ }
    }
  }, 30000);

  let stopPromise = null;
  function stop() {
    if (stopPromise) return stopPromise;
    shuttingDown = true;
    log('shutting down');
    try { clearTimeout(helloTimer); } catch (e) { /* guard */ }
    if (reconnectTimer) {
      try { clearTimeout(reconnectTimer); } catch (e) { /* guard */ }
      reconnectTimer = null;
    }
    try { clearInterval(heartbeatInterval); } catch (e) { /* guard */ }
    try {
      if (codexWatcher) codexWatcher.stop();
    } catch (e) { /* guard */ }
    stopPromise = runner.stopAll().then(() => {
      if (ws) {
        try { ws.removeAllListeners('close'); } catch (e) { /* guard */ }
        try { ws.close(1000, 'shutdown'); } catch (e) { /* guard */ }
      }
      return undefined;
    });
    return stopPromise;
  }

  connect();
  return { stop };
}

module.exports = { createAgentClient };

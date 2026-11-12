'use strict';
// SessionHub remote agent (docs/SPEC.md "Agent WebSocket").
// Outbound WebSocket client to the hub: runs sessions on this machine and
// proxies file browsing. Children survive WS drops; only agent process death
// kills them.

const WebSocket = require('ws');
const os = require('os');
const fs = require('fs');
const { Runner } = require('../lib/runner');
const { CodexWatcher } = require('../lib/codexwatch');
const fsutil = require('../lib/fsutil');
const { loadConfig } = require('./config');

const config = loadConfig(process.argv.slice(2));

const log = (msg) => console.log('[sessionhub-agent] ' + msg);
const errLog = (msg) => console.error('[sessionhub-agent] ' + msg);

let ws = null;
let helloAcked = false;
let helloTimer = null;
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
  maxSessions: config.maxSessions,
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
if (config.codexWatch && config.codexWatch.enabled) {
  codexWatcher = new CodexWatcher({
    dir: config.codexWatch.sessionsDir,
    pollMs: config.codexWatch.pollMs,
    idleMs: config.codexWatch.idleMs,
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
  log('codex watch enabled: dir=' + config.codexWatch.sessionsDir +
    ' pollMs=' + config.codexWatch.pollMs + ' idleMs=' + config.codexWatch.idleMs);
}

// Resolve a path against the allowed roots; returns {resolved, root} for the
// first root that accepts it. Prefers a 404 over a 403 when one was seen.
function resolveWithRoot(p) {
  const target = String(p || '');
  if (!config.allowedRoots.length) throw { status: 403, message: 'outside allowed roots' };
  let firstErr = null;
  for (const root of config.allowedRoots) {
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
    if (!config.allowedRoots.length) throw { status: 403, message: 'outside allowed roots' };
    return fsutil.resolveWithin([config.allowedRoots[0]], config.allowedRoots[0], process.platform);
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
      log('connected as ' + config.name + ' to ' + config.hubUrl);
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
    case 'ping':
      send({ type: 'pong', t: msg.t });
      break;
    default:
      break;
  }
}

function connect() {
  helloAcked = false;
  const sep = config.hubUrl.indexOf('?') !== -1 ? '&' : '?';
  const url = config.hubUrl + sep + 'token=' + encodeURIComponent(config.token);
  const sock = new WebSocket(url);
  ws = sock;

  sock.on('open', () => {
    if (codexWatcher && !codexWatcherStarted) {
      codexWatcherStarted = true;
      try { codexWatcher.start(); } catch (e) { /* guard */ }
    }
    send({
      type: 'hello',
      v: 1,
      name: config.name,
      hostname: os.hostname(),
      os: process.platform,
      arch: process.arch,
      allowedRoots: config.allowedRoots,
      maxSessions: config.maxSessions
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
        errLog('auth failed');
        process.exit(1);
        return;
      }
      if (code === 4002) {
        errLog('name conflict');
        process.exit(1);
        return;
      }
    }
    const delay = wasAcked ? 2000 : Math.min(reconnectDelay, 30000);
    if (!wasAcked) reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    log('reconnecting in ' + (delay / 1000) + 's' + (code ? ' (code ' + code + ')' : ''));
    setTimeout(() => {
      if (!shuttingDown) connect();
    }, delay);
  });
}

// Heartbeat: ping the hub every 30s; terminate + reconnect if no pong in 60s.
// (Hub-side ws-protocol pings are auto-ponged by the ws library.)
setInterval(() => {
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

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down');
  try { clearTimeout(helloTimer); } catch (e) { /* guard */ }
  try {
    if (codexWatcher) codexWatcher.stop();
  } catch (e) { /* guard */ }
  runner.stopAll().then(() => {
    if (ws) {
      try { ws.removeAllListeners('close'); } catch (e) { /* guard */ }
      try { ws.close(1000, 'shutdown'); } catch (e) { /* guard */ }
    }
    process.exit(0);
  }).catch(() => {
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  errLog('uncaught exception: ' + ((err && err.stack) || err));
  process.exit(1);
});

log('agent starting: name=' + config.name + ' hub=' + config.hubUrl +
  ' maxSessions=' + config.maxSessions + ' roots=' + config.allowedRoots.length);
connect();

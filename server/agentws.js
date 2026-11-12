'use strict';

// Agent WebSocket endpoint — path '/agent', query '?token=<token>'.
// One outbound connection per remote machine; everything (session starts,
// output, fs proxying) rides on it.
//
// Messages agent -> hub: hello, session.status, session.output,
// session.stdinResult, fs.result, pong (all per SPEC).
//
// Bad token: connection is accepted and immediately closed with code 4001 so
// the agent receives the close code the SPEC promises. (Note: ws's verifyClient
// can only reject with an HTTP status, which never delivers a WS close code —
// the post-upgrade close is what actually carries 4001 to the agent.)

const { WebSocketServer } = require('ws');

const HEARTBEAT_INTERVAL_MS = 30000;
const RECONCILE_GRACE_MS = 5000;

function queryToken(req) {
  try {
    return new URL(req.url, 'http://sessionhub.local').searchParams.get('token');
  } catch (e) {
    return null;
  }
}

function pathnameOf(req) {
  try {
    return new URL(req.url, 'http://sessionhub.local').pathname;
  } catch (e) {
    return String(req.url || '').split('?')[0];
  }
}

function attachAgentWs(server, { config, machines, sessions }) {
  // noServer + one shared upgrade dispatcher per path: ws >= 8.18 aborts
  // upgrades whose path does not match `options.path` with HTTP 400 (and a
  // second {server, path} WSS would double-handle), so two WSS instances on
  // one HTTP server must dispatch upgrades manually.
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (pathnameOf(req) !== '/agent') return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    if (queryToken(req) !== config.authToken) {
      ws.close(4001, 'bad token');
      return;
    }
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => { /* handled via close */ });

    ws.on('message', (data) => {
      let msg = null;
      try { msg = JSON.parse(String(data)); } catch (e) { return; }
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'hello':
          handleHello(ws, msg);
          break;
        case 'session.status':
          // meta (e.g. {type:'watched', workspace, label}) is threaded through
          // so the sessions manager can create watched records for this machine.
          sessions.handleStatus(msg.id, msg, ws._machineId, msg.meta);
          break;
        case 'session.output': {
          // Only accept output for sessions this machine actually owns.
          const meta = sessions.meta(msg.id);
          if (meta && meta.machineId === ws._machineId) {
            sessions.handleOutput(msg.id, msg.stream, msg.line);
          } else if (!meta && ws._machineId && typeof msg.id === 'string' && /^w-[0-9a-f]{10}$/.test(msg.id)) {
            // Watched-session lines can arrive before the session.status that
            // announces the file (the agent's watcher reads appended bytes
            // before reporting the session) — park them on a placeholder.
            sessions.acceptWatchedLine(msg.id, ws._machineId, msg.line);
          }
          break;
        }
        case 'session.stdinResult':
          if (!msg.ok) console.warn(`[sessionhub] stdin failed for session ${msg.id}: ${msg.error}`);
          break;
        case 'fs.result':
          machines.resolveReq(ws._machineId, msg.reqId, msg.ok === true, msg.payload, msg.error);
          break;
        case 'pong':
          ws.isAlive = true;
          break;
        default:
          break;
      }
    });

    ws.on('close', () => {
      if (!ws._machineId) return;
      // Only the owning socket may disconnect the machine (a replaced/replaced-by
      // reconnect must not clobber the fresh connection).
      const unregistered = machines.unregister(ws._machineId, ws);
      if (unregistered) sessions.markDisconnected(ws._machineId);
    });
  });

  function handleHello(ws, msg) {
    if (ws._machineId) return; // hello already processed on this socket
    if (msg.v !== 1) {
      ws.close(4000, 'unsupported protocol version');
      return;
    }
    if (typeof msg.name !== 'string' || !String(msg.name).trim()) {
      ws.close(4000, 'missing machine name');
      return;
    }
    let machine;
    try {
      machine = machines.registerRemote(ws, msg);
    } catch (err) {
      ws.close(err.closeCode || 4002, err.message || 'registration failed');
      return;
    }
    ws._machineId = machine.id;
    try { ws.send(JSON.stringify({ type: 'helloAck', v: 1 })); } catch (e) { /* ignore */ }
    console.log(`[sessionhub] agent "${machine.id}" connected (${machine.host}, ${machine.os}/${machine.arch})`);

    // Children that do not report back within 5 s did not survive the restart.
    // Statuses that DO arrive flip the sessions out of 'disconnected', so
    // endUnreconciled only finalizes the leftovers.
    const timer = setTimeout(() => { sessions.endUnreconciled(machine.id); }, RECONCILE_GRACE_MS);
    if (timer.unref) timer.unref();
  }

  // Heartbeat: ws-protocol ping every 30 s; terminate when the last pong is
  // stale (unresponsive for >30-60 s) so the agent's reconnect kicks in.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) { /* ignore */ }
    }
  }, HEARTBEAT_INTERVAL_MS);
  if (heartbeat.unref) heartbeat.unref();

  return wss;
}

module.exports = { attachAgentWs };

'use strict';

// Phone WebSocket endpoint — path '/ws', query '?token=<token>'.
// Sends a snapshot on connect and fans out live events per SPEC:
//   {type:'snapshot'}, {type:'machine'}, {type:'session'} (meta only),
//   {type:'output'}, {type:'sessionRemoved'}.
// Client -> hub: none (actions go via REST). Idle/dead sockets are pinged and
// terminated (browsers auto-pong).

const { WebSocketServer, WebSocket } = require('ws');

const HEARTBEAT_INTERVAL_MS = 30000;

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

function attachPhoneWs(server, { config, machines, sessions }) {
  // noServer + one shared upgrade dispatcher per path (ws >= 8.18 aborts
  // mismatched paths with HTTP 400 and double-handles otherwise — see agentws).
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (pathnameOf(req) !== '/ws') return;
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

    const send = (obj) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try { ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
    };

    send({ type: 'snapshot', machines: machines.all(), sessions: sessions.all() });

    const onMachine = (payload) => send({ type: 'machine', machine: payload.machine });
    const onSession = (payload) => send({ type: 'session', session: payload.session });
    const onOutput = (payload) => send({
      type: 'output',
      sessionId: payload.sessionId,
      t: payload.t,
      stream: payload.stream,
      line: payload.line
    });
    const onRemoved = (payload) => send({ type: 'sessionRemoved', sessionId: payload.sessionId });

    // 'machine' events can come from the registry (connect/disconnect) and from
    // the sessions manager (running counts); each change is emitted exactly once.
    machines.on('machine', onMachine);
    sessions.on('machine', onMachine);
    sessions.on('session', onSession);
    sessions.on('output', onOutput);
    sessions.on('removed', onRemoved);

    ws.on('close', () => {
      machines.removeListener('machine', onMachine);
      sessions.removeListener('machine', onMachine);
      sessions.removeListener('session', onSession);
      sessions.removeListener('output', onOutput);
      sessions.removeListener('removed', onRemoved);
    });
  });

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

module.exports = { attachPhoneWs };

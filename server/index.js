'use strict';

// SessionHub hub server entry point.
// Loads config, wires store/runner/sessions/machines, serves the REST API +
// agent/phone WebSockets (HTTP or optional HTTPS), and shuts down gracefully.

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const pkg = require('../package.json');
const { loadConfig } = require('./config');
const { Store } = require('./store');
const { Machines } = require('./machines');
const { Sessions } = require('./sessions');
const { Runner } = require('../lib/runner');
const { createApp } = require('./api');
const { attachAgentWs } = require('./agentws');
const { attachPhoneWs } = require('./phonews');

function main() {
  const config = loadConfig(path.join(__dirname, '..'));

  const store = new Store(config.dataDir);
  const machines = new Machines(config);
  const sessions = new Sessions(config, machines, store);

  const runner = new Runner({
    maxSessions: config.maxSessionsPerMachine,
    onLine: (id, stream, line) => sessions.handleOutput(id, stream, line),
    onStatus: (id, info) => sessions.handleStatus(id, info)
  });
  sessions.setRunner(runner);
  sessions.rehydrate(store.load());

  const app = createApp({ config, machines, sessions, version: pkg.version });

  const tls = config.tls || {};
  const useTls = Boolean(tls.certFile && tls.keyFile);
  let server;
  if (useTls) {
    server = https.createServer({
      cert: fs.readFileSync(tls.certFile),
      key: fs.readFileSync(tls.keyFile)
    }, app);
  } else {
    server = http.createServer(app);
  }

  const agentWss = attachAgentWs(server, { config, machines, sessions });
  const phoneWss = attachPhoneWs(server, { config, machines, sessions });

  // Codex VSCode session watching (v1.1): optional local watcher fed into the
  // sessions manager as watched (memory-only, read-only) records.
  let codexWatcher = null;
  if (config.codexWatch && config.codexWatch.enabled) {
    try {
      const { CodexWatcher } = require('../lib/codexwatch');
      codexWatcher = new CodexWatcher({
        dir: config.codexWatch.sessionsDir,
        pollMs: config.codexWatch.pollMs,
        idleMs: config.codexWatch.idleMs,
        onEvent: (ev) => sessions.handleWatchedEvent(ev)
      });
      codexWatcher.start();
      console.log(`[sessionhub] codex watch on ${config.codexWatch.sessionsDir}`);
    } catch (err) {
      console.warn(`[sessionhub] could not start codex watcher: ${err && err.message}`);
    }
  }

  // Hub peers (v1.3): hub-as-agent outbound clients — this hub's local machine
  // appears as a remote machine on each peer hub. Peer failures are logged and
  // ignored (a broken lib or a rejected peer must never take the hub down).
  const peerClients = [];
  let createAgentClient = null;
  try {
    createAgentClient = require('../lib/agentclient').createAgentClient;
  } catch (err) {
    if (config.peers.length) {
      console.warn(`[sessionhub] lib/agentclient unavailable — peers disabled: ${err && err.message}`);
    }
  }
  if (createAgentClient) {
    for (const peer of config.peers) {
      try {
        const client = createAgentClient({
          hubUrl: peer.hubUrl,
          token: peer.token,
          name: peer.machineName,
          allowedRoots: peer.allowedRoots,
          maxSessions: peer.maxSessions,
          codexWatch: peer.codexWatch,
          logPrefix: '[sessionhub-peer] ',
          onFatal: (err) => {
            // Fatal peer errors (e.g. close codes 4001/4002) are log-only here —
            // this is a hub, it keeps serving its own machine regardless.
            console.warn(`[sessionhub] peer ${peer.machineName} fatal: ${(err && err.message) || err}`);
          }
        });
        peerClients.push(client);
        console.log(`[sessionhub] peer ${peer.machineName} -> ${peer.hubUrl}`);
      } catch (err) {
        console.warn(`[sessionhub] could not start peer ${peer.machineName}: ${(err && err.message) || err}`);
      }
    }
  }

  server.on('error', (err) => {
    console.error(`[sessionhub] server error: ${err.message}`);
    if (err.code === 'EADDRINUSE') {
      console.error(`[sessionhub] port ${config.port} is already in use`);
      process.exit(1);
    }
  });

  server.listen(config.port, config.host, () => {
    const scheme = useTls ? 'https' : 'http';
    const reachable = (config.host === '0.0.0.0' || config.host === '::') ? '127.0.0.1' : config.host;
    console.log(`[sessionhub] hub listening on ${scheme}://${reachable}:${config.port} (bind ${config.host})`);
    console.log(`[sessionhub] local machine "${machines.localName}" (id ${machines.localId})`);
    console.log('[sessionhub] agents connect to ws(s)://<this host>:' + config.port + '/agent?token=<token>');
  });

  // Graceful shutdown on SIGINT/SIGTERM (guarded against double invocation).
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[sessionhub] ${signal} received — shutting down`);
    const hardExit = setTimeout(() => {
      console.warn('[sessionhub] shutdown timed out, exiting forcefully');
      process.exit(1);
    }, 5000);
    if (hardExit.unref) hardExit.unref();

    Promise.resolve()
      .then(() => {
        // Shutdown order: peer clients first (peer hubs see us disconnect
        // promptly), then the codex watcher, then local children last.
        for (const client of peerClients) {
          try { client.stop(); } catch (err) { /* ignore */ }
        }
      })
      .then(() => {
        if (codexWatcher) {
          try { codexWatcher.stop(); } catch (err) { /* ignore */ }
        }
      })
      .then(() => runner.stopAll())
      .catch((err) => console.warn(`[sessionhub] stopAll failed: ${err && err.message}`))
      .then(() => {
        for (const wss of [agentWss, phoneWss]) {
          try {
            for (const ws of wss.clients) {
              try { ws.terminate(); } catch (e) { /* ignore */ }
            }
            wss.close();
          } catch (e) { /* ignore */ }
        }
      })
      .then(() => {
        try { store.flush(); } catch (err) {
          console.warn(`[sessionhub] state save failed: ${err.message}`);
        }
      })
      .then(() => {
        console.log('[sessionhub] bye');
        process.exit(0);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    console.warn('[sessionhub] unhandled rejection:', reason);
  });
}

main();

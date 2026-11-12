'use strict';
// SessionHub remote agent entry (docs/SPEC.md "Agent WebSocket").
// Thin wrapper over lib/agentclient.js: load config, start the client, map
// fatal errors to process exit, map SIGINT/SIGTERM to client.stop().
//
// All client behavior lives in ../lib/agentclient (createAgentClient) so the
// hub server can reuse it for its `peers` (hub-as-agent, v1.3) without
// forking a process.

const { loadConfig } = require('./config');
const { createAgentClient } = require('../lib/agentclient');

const config = loadConfig(process.argv.slice(2));

const log = (msg) => console.log('[sessionhub-agent] ' + msg);
const errLog = (msg) => console.error('[sessionhub-agent] ' + msg);

log('agent starting: name=' + config.name + ' hub=' + config.hubUrl +
  ' maxSessions=' + config.maxSessions + ' roots=' + config.allowedRoots.length);

const client = createAgentClient({
  hubUrl: config.hubUrl,
  token: config.token,
  name: config.name,
  allowedRoots: config.allowedRoots,
  maxSessions: config.maxSessions,
  codexWatch: config.codexWatch,
  logPrefix: '[sessionhub-agent] ',
  onFatal: (msg) => {
    errLog(msg);
    process.exit(1);
  }
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  client.stop().then(() => {
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

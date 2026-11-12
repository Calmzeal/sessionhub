'use strict';
// SessionHub agent config loader (docs/SPEC.md "Agent config").
// Config file: <repo>/agent.config.json, or --config <path> argument.
// Env overrides: SESSIONHUB_HUB_URL, SESSIONHUB_TOKEN, SESSIONHUB_NAME,
// SESSIONHUB_ROOTS (';'- or ','-separated), SESSIONHUB_MAX_SESSIONS.

const fs = require('fs');
const path = require('path');

function fail(message) {
  console.error('[sessionhub-agent] config error: ' + message);
  process.exit(1);
}

// Machine id sanitize rules: lowercase; non [a-z0-9_-] → '-'; trim '-';
// empty → 'machine-<6 base36>'.
function sanitizeName(raw) {
  let name = String(raw === undefined || raw === null ? '' : raw).toLowerCase();
  name = name.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!name) name = 'machine-' + Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  return name;
}

// Trim trailing separators but keep drive roots ('C:\', 'C:/') and '/' intact.
function trimTrailingSep(p) {
  if (p === '') return p;
  if (/^[a-zA-Z]:[\\/]$/.test(p)) return p;
  if (p.length <= 1) return p;
  return p.replace(/[\\/]+$/, '');
}

function toMaxSessions(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : 4;
}

function toPositiveInt(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

// Accept boolean true, number 1, or the strings '1'/'true' (case-insensitive).
function isEnabledFlag(value) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v === '1' || v === 'true';
  }
  return false;
}

function loadConfig(argv) {
  const args = Array.isArray(argv) ? argv : [];
  let configPath = null;
  let explicitConfig = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--config' && i + 1 < args.length) {
      configPath = args[i + 1];
      explicitConfig = true;
      i += 1;
    } else if (typeof args[i] === 'string' && args[i].startsWith('--config=')) {
      configPath = args[i].slice('--config='.length);
      explicitConfig = true;
    }
  }
  if (!configPath) configPath = path.join(__dirname, '..', 'agent.config.json');

  let fileConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fileConfig = parsed;
    } catch (err) {
      fail('cannot parse config file ' + configPath + ': ' + err.message);
    }
  } else if (explicitConfig) {
    fail('config file not found: ' + configPath);
  }

  const env = process.env;
  const cfg = {
    hubUrl: typeof env.SESSIONHUB_HUB_URL === 'string' && env.SESSIONHUB_HUB_URL.trim() !== ''
      ? env.SESSIONHUB_HUB_URL.trim()
      : (typeof fileConfig.hubUrl === 'string' ? fileConfig.hubUrl.trim() : ''),
    token: typeof env.SESSIONHUB_TOKEN === 'string' && env.SESSIONHUB_TOKEN.trim() !== ''
      ? env.SESSIONHUB_TOKEN.trim()
      : (typeof fileConfig.token === 'string' ? fileConfig.token.trim() : ''),
    name: sanitizeName(env.SESSIONHUB_NAME || fileConfig.name),
    maxSessions: toMaxSessions(
      env.SESSIONHUB_MAX_SESSIONS !== undefined && env.SESSIONHUB_MAX_SESSIONS !== ''
        ? env.SESSIONHUB_MAX_SESSIONS
        : fileConfig.maxSessions
    ),
    allowedRoots: [],
    configPath
  };

  let roots = fileConfig.allowedRoots;
  if (typeof env.SESSIONHUB_ROOTS === 'string' && env.SESSIONHUB_ROOTS.trim() !== '') {
    roots = env.SESSIONHUB_ROOTS.split(/[;,]+/).map((s) => s.trim()).filter(Boolean);
  }
  if (typeof roots === 'string') roots = [roots];
  if (!Array.isArray(roots)) roots = [];
  cfg.allowedRoots = roots
    .map((r) => trimTrailingSep(path.resolve(String(r))))
    .filter((r) => r && r.length > 0);

  // codexWatch: v1.1 watched VSCode/Codex sessions (SPEC "Codex VSCode session
  // watching"). File key `codexWatch`; env: SESSIONHUB_WATCH_DIR (string —
  // enables watching with that dir), SESSIONHUB_WATCH_ENABLED ('1'/'true' —
  // enables watching with the configured dir).
  const fileWatch = fileConfig.codexWatch && typeof fileConfig.codexWatch === 'object' && !Array.isArray(fileConfig.codexWatch)
    ? fileConfig.codexWatch
    : {};
  const watchDirEnv = typeof env.SESSIONHUB_WATCH_DIR === 'string' && env.SESSIONHUB_WATCH_DIR.trim() !== ''
    ? env.SESSIONHUB_WATCH_DIR.trim()
    : null;
  cfg.codexWatch = {
    enabled: !!(watchDirEnv || isEnabledFlag(env.SESSIONHUB_WATCH_ENABLED) || isEnabledFlag(fileWatch.enabled)),
    sessionsDir: watchDirEnv ||
      (typeof fileWatch.sessionsDir === 'string' && fileWatch.sessionsDir.trim() !== ''
        ? fileWatch.sessionsDir.trim()
        : '~/.codex'),
    pollMs: toPositiveInt(fileWatch.pollMs, 2000),
    idleMs: toPositiveInt(fileWatch.idleMs, 600000)
  };

  if (!cfg.hubUrl || !(cfg.hubUrl.startsWith('ws://') || cfg.hubUrl.startsWith('wss://'))) {
    fail('hubUrl must start with ws:// or wss:// (config file or SESSIONHUB_HUB_URL)');
  }
  if (!cfg.token) {
    fail('token is required (config file or SESSIONHUB_TOKEN)');
  }

  // Normalize: a pathless hubUrl (e.g. ws://host:8742) targets the hub's /agent endpoint.
  try {
    const u = new URL(cfg.hubUrl);
    if (u.pathname === '' || u.pathname === '/') {
      u.pathname = '/agent';
      cfg.hubUrl = u.toString().replace(/\/$/, '');
    }
  } catch (e) {
    fail('hubUrl is not a valid ws URL: ' + cfg.hubUrl);
  }

  return cfg;
}

module.exports = { loadConfig, sanitizeName };

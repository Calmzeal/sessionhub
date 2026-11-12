'use strict';

// Hub configuration loader.
// - Loads <repo>/config.json or the file named by $SESSIONHUB_CONFIG.
// - Applies env overrides (SESSIONHUB_PORT, SESSIONHUB_TOKEN, SESSIONHUB_NAME,
//   SESSIONHUB_ROOTS (';'-separated), SESSIONHUB_DATA_DIR, SESSIONHUB_TLS_CERT,
//   SESSIONHUB_TLS_KEY).
// - Merges the built-in templates under any user templates (user wins).
// - If no authToken is configured, generates one and warns the value once so the
//   user can copy it into agent configs / the phone.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Built-in default templates (SPEC "Config" section). User config overrides per name.
const BUILTIN_TEMPLATES = {
  shell: {
    type: 'oneshot',
    description: 'Run a shell command in the workspace',
    command: {
      win32: '%SESSIONHUB_PROMPT%',
      darwin: '"$SESSIONHUB_PROMPT"',
      linux: '"$SESSIONHUB_PROMPT"'
    }
  },
  'codex-exec': {
    type: 'oneshot',
    description: 'OpenAI Codex one-shot run (stream-json output)',
    command: {
      win32: 'codex exec --full-auto -o stream-json "%SESSIONHUB_PROMPT%"',
      darwin: 'codex exec --full-auto -o stream-json "$SESSIONHUB_PROMPT"',
      linux: 'codex exec --full-auto -o stream-json "$SESSIONHUB_PROMPT"'
    }
  },
  'claude-stream': {
    type: 'interactive',
    description: 'Claude Code via stream-json stdin',
    command: 'claude --input-format stream-json --output-format stream-json --verbose',
    jsonInput: '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"{prompt}"}]}}',
    initialDelayMs: 1000
  }
};

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Load and resolve the hub configuration.
 * @param {string} [repoRoot] project root used to resolve relative dataDir/tls paths.
 * @returns {object} resolved config
 */
function loadConfig(repoRoot) {
  repoRoot = repoRoot || path.join(__dirname, '..');
  const env = process.env;

  let raw = {};
  const file = env.SESSIONHUB_CONFIG
    ? path.resolve(process.cwd(), env.SESSIONHUB_CONFIG)
    : path.join(repoRoot, 'config.json');
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`[sessionhub] failed to parse config file ${file}: ${err.message}`);
    }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`[sessionhub] config file ${file} must contain a JSON object`);
  }

  const resolveDir = (p) => {
    if (!p) return null;
    return path.isAbsolute(p) ? p : path.resolve(repoRoot, p);
  };

  const rawTls = (raw && typeof raw.tls === 'object' && raw.tls) || {};
  const rawWatch = (raw && typeof raw.codexWatch === 'object' && raw.codexWatch) || {};
  const port = Number(env.SESSIONHUB_PORT !== undefined ? env.SESSIONHUB_PORT : raw.port);

  const config = {
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 8742,
    host: typeof raw.host === 'string' && raw.host ? raw.host : '0.0.0.0',
    authToken: env.SESSIONHUB_TOKEN || raw.authToken || null,
    machineName: env.SESSIONHUB_NAME || raw.machineName || os.hostname(),
    allowedRoots: env.SESSIONHUB_ROOTS
      ? String(env.SESSIONHUB_ROOTS).split(';').map((s) => s.trim()).filter(Boolean)
      : (Array.isArray(raw.allowedRoots) ? raw.allowedRoots.filter((r) => typeof r === 'string') : []),
    dataDir: resolveDir(env.SESSIONHUB_DATA_DIR || raw.dataDir || './data'),
    maxSessionsPerMachine: positiveInt(raw.maxSessionsPerMachine, 8),
    logRingLines: positiveInt(raw.logRingLines, 2000),
    logByteCap: positiveInt(raw.logByteCap, 4194304),
    tls: {
      certFile: resolveDir(env.SESSIONHUB_TLS_CERT || rawTls.certFile || null),
      keyFile: resolveDir(env.SESSIONHUB_TLS_KEY || rawTls.keyFile || null)
    },
    codexWatch: {
      enabled: rawWatch.enabled === true,
      sessionsDir: (typeof rawWatch.sessionsDir === 'string' && rawWatch.sessionsDir) ? rawWatch.sessionsDir : '~/.codex',
      pollMs: positiveInt(rawWatch.pollMs, 2000),
      idleMs: positiveInt(rawWatch.idleMs, 600000)
    },
    templates: Object.assign(
      {},
      BUILTIN_TEMPLATES,
      (raw.templates && typeof raw.templates === 'object' && !Array.isArray(raw.templates)) ? raw.templates : {}
    )
  };

  if (!config.authToken) {
    config.authToken = crypto.randomBytes(24).toString('hex');
    // Logged once so the user can copy it for agents and the phone.
    console.warn(`[sessionhub] no authToken configured — generated one for this run (copy it to agents and the phone): ${config.authToken}`);
  }
  config.authToken = String(config.authToken);

  return config;
}

module.exports = { loadConfig, BUILTIN_TEMPLATES };

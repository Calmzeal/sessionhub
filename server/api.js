'use strict';

// Express 4 REST API for the hub. Auth on everything under /api except
// /api/health (header `Authorization: Bearer <t>` or query `token=`).
// Errors: JSON {error:{code,message}} via the httpError helper.
// Static: express.static(web/) with Cache-Control: no-cache for index.html + sw.js.

const fs = require('fs');
const path = require('path');
const express = require('express');

const CHUNK_SIZE = 1024 * 1024; // 1 MiB chunks for remote raw downloads

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function codeForStatus(status) {
  switch (status) {
    case 400: return 'bad-request';
    case 401: return 'auth-required';
    case 403: return 'forbidden';
    case 404: return 'not-found';
    case 409: return 'conflict';
    case 504: return 'agent-timeout';
    default: return 'server';
  }
}

function contentDisposition(name) {
  const fallback = String(name).replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(String(name))}`;
}

function createApp({ config, machines, sessions, version }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // CORS: the UI is normally same-origin, but the phone may store a server URL
  // on a different origin (LAN IP vs Tailscale IP). Everything sensitive still
  // requires the bearer token, so a permissive origin list is safe here.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Request log (personal tool, low volume) — helps diagnose remote access.
  app.use((req, res, next) => {
    res.on('finish', () => {
      console.log(`[sessionhub] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${req.socket.remoteAddress || ''})`);
    });
    next();
  });

  // Static web assets (no auth).
  const webDir = path.join(__dirname, '..', 'web');
  app.use(express.static(webDir, {
    setHeaders(res, filePath) {
      const base = path.basename(filePath);
      if (base === 'index.html' || base === 'sw.js') {
        res.setHeader('Cache-Control', 'no-cache');
      }
    }
  }));

  // Auth guard for everything under /api except health + telemetry.
  app.use('/api', (req, res, next) => {
    if (req.path === '/health' || req.path === '/health/' || req.path === '/telemetry') return next();
    const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    let token = match ? match[1].trim() : null;
    if (!token && typeof req.query.token === 'string' && req.query.token) token = req.query.token;
    if (token && token === config.authToken) return next();
    return next(httpError(401, 'auth-required', 'missing or invalid token'));
  });

  // Wrap async handlers so rejections reach the error middleware.
  const wrap = (fn) => (req, res, next) => { Promise.resolve(fn(req, res, next)).catch(next); };

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      app: 'sessionhub',
      version,
      machineId: machines.localId,
      machineName: machines.localName,
      time: Date.now()
    });
  });

  // Client-side error beacon (auth-exempt, log-only).
  app.post('/api/telemetry', (req, res) => {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    console.log(`[sessionhub] telemetry ${JSON.stringify(body)}`);
    res.json({ ok: true });
  });

  app.get('/api/state', (req, res) => {
    res.json({ machines: machines.all(), sessions: sessions.all() });
  });

  // Never expose command strings.
  app.get('/api/templates', (req, res) => {
    const templates = Object.keys(config.templates || {}).map((name) => {
      const t = config.templates[name] || {};
      return { name, type: t.type || 'oneshot', description: t.description || '' };
    });
    res.json({ templates });
  });

  app.post('/api/sessions', wrap(async (req, res) => {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    if (typeof body.machineId !== 'string' || !body.machineId) {
      throw httpError(400, 'bad-request', 'machineId is required');
    }
    if (typeof body.workspace !== 'string' || !body.workspace) {
      throw httpError(400, 'bad-request', 'workspace is required');
    }
    if (typeof body.template !== 'string' || !body.template) {
      throw httpError(400, 'bad-request', 'template is required');
    }
    const session = await sessions.create({
      machineId: body.machineId,
      workspace: body.workspace,
      template: body.template,
      prompt: typeof body.prompt === 'string' ? body.prompt : null,
      label: typeof body.label === 'string' ? body.label : null
    });
    res.status(201).json(session);
  }));

  app.get('/api/sessions/:id', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) throw httpError(404, 'session-not-found', 'unknown session');
    res.json(session);
  });

  app.post('/api/sessions/:id/prompt', wrap(async (req, res) => {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    res.json(await sessions.prompt(req.params.id, typeof body.text === 'string' ? body.text : ''));
  }));

  app.post('/api/sessions/:id/stop', wrap(async (req, res) => {
    res.json(await sessions.stop(req.params.id));
  }));

  app.delete('/api/sessions/:id', wrap(async (req, res) => {
    const force = req.query.force === '1' || req.query.force === 'true';
    res.json(await sessions.remove(req.params.id, force));
  }));

  app.get('/api/machines/:id/roots', (req, res) => {
    const machine = machines.get(req.params.id);
    if (!machine) throw httpError(404, 'machine-not-found', 'unknown machine');
    res.json({ roots: machine.allowedRoots || [] });
  });

  app.get('/api/machines/:id/fs', wrap(async (req, res) => {
    const machine = machines.get(req.params.id);
    if (!machine) throw httpError(404, 'machine-not-found', 'unknown machine');
    let p = typeof req.query.path === 'string' ? req.query.path : '';
    if (!p) {
      const roots = machine.allowedRoots || [];
      if (!roots.length) throw httpError(400, 'no-roots', 'machine has no allowed roots');
      p = roots[0];
    }
    res.json(await machines.fsList(req.params.id, p));
  }));

  app.get('/api/machines/:id/fs/file', wrap(async (req, res) => {
    const mode = (typeof req.query.mode === 'string' && req.query.mode) ? req.query.mode : 'text';
    if (mode !== 'text' && mode !== 'meta' && mode !== 'raw') {
      throw httpError(400, 'bad-mode', 'mode must be text, meta or raw');
    }
    const p = typeof req.query.path === 'string' ? req.query.path : '';
    if (!p) throw httpError(400, 'bad-path', 'missing path');
    if (mode === 'raw') return sendRaw(req, res, p);
    res.json(await machines.fsRead(req.params.id, p, mode, mode === 'text' ? 262144 : undefined));
  }));

  async function sendRaw(req, res, p) {
    const machine = machines.get(req.params.id);
    if (!machine) throw httpError(404, 'machine-not-found', 'unknown machine');
    if (!machine.local && machine.status !== 'connected') {
      throw httpError(409, 'machine-offline', 'machine is offline');
    }
    const name = path.basename(String(p).replace(/[\\/]+$/, '')) || 'download';

    if (machine.local) {
      const { resolved } = machines.resolvePath(machine.id, p);
      const info = await machines.fsRead(machine.id, p, 'meta');
      res.setHeader('Content-Type', info.mime || 'application/octet-stream');
      res.setHeader('Content-Disposition', contentDisposition(name));
      if (typeof info.size === 'number') res.setHeader('Content-Length', info.size);
      const stream = fs.createReadStream(resolved);
      stream.on('error', (err) => { res.destroy(err); });
      stream.pipe(res);
      return;
    }

    // Remote: get metadata for Content-Type, then loop fs.chunk (1 MiB).
    const info = await machines.fsRead(machine.id, p, 'meta');
    res.setHeader('Content-Type', info.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDisposition(name));
    let offset = 0;
    for (;;) {
      const chunk = await machines.fsChunk(machine.id, p, offset, CHUNK_SIZE);
      const buf = Buffer.from(chunk.data || '', 'base64');
      offset += buf.length;
      if (buf.length > 0 && !res.write(buf)) {
        await Promise.race([
          new Promise((resolve) => res.once('drain', resolve)),
          new Promise((resolve) => res.once('close', resolve))
        ]);
      }
      if (chunk.eof || !buf.length || res.destroyed || res.writableEnded) break;
    }
    res.end();
  }

  // 404s: JSON for API paths, JSON for everything else too (the web app is a
  // single page; anything unknown is simply "not found").
  app.use('/api', (req, res) => {
    res.status(404).json({ error: { code: 'not-found', message: 'not found' } });
  });
  app.use((req, res) => {
    res.status(404).json({ error: { code: 'not-found', message: 'not found' } });
  });

  // Error middleware: {status, code, message} objects thrown by handlers (and
  // lib/fsutil's {status, message} errors) become {error:{code,message}}.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err && typeof err.status === 'number' ? err.status : 500;
    const code = (err && err.code) || codeForStatus(status);
    if (status >= 500) console.error('[sessionhub] api error:', err);
    res.status(status).json({ error: { code, message: (err && err.message) || 'internal server error' } });
  });

  return app;
}

module.exports = { createApp, httpError };

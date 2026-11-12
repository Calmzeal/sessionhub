'use strict';

// SessionHub end-to-end smoke test (SPEC "Smoke test", steps 1-11).
// Spawns a hub + a remote agent as children, drives the REST API, the phone
// WebSocket and the agent protocol, asserts every step, cleans up and exits
// 0 (SMOKE OK) or 1 (SMOKE FAILED).
//
// Usage: node scripts/smoke-test.js

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const WORKSPACE = path.resolve(ROOT, 'test', 'fixtures', 'workspace');
const CODEX_CWD = 'C:\\Users\\me\\dev\\sample-workspace'; // cwd embedded in the codex fixture
const TMP = path.join(ROOT, 'data', 'tmp-smoke');
const PORT = 8799;
const TOKEN = 'test-token-123';
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeout = 10000, interval = 150, label = 'condition') {
  const start = Date.now();
  let lastErr = null;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() - start >= timeout) {
      throw new Error(`timed out waiting for ${label}${lastErr ? ` (last error: ${lastErr.message})` : ''}`);
    }
    await sleep(interval);
  }
}

async function api(pathName, opts = {}) {
  const headers = Object.assign({}, opts.headers);
  if (opts.auth !== false) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(BASE + pathName, Object.assign({}, opts, { headers }));
  let body = null;
  try { body = await res.json(); } catch (e) { /* non-JSON body */ }
  return { status: res.status, body };
}

async function apiText(pathName) {
  const res = await fetch(BASE + pathName, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: res.status, text: await res.text() };
}

function createSession(machineId, extra = {}) {
  return api('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ machineId, workspace: WORKSPACE, template: 'echo' }, extra))
  });
}

function promptSession(id, text) {
  return api(`/api/sessions/${id}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });
}

function getSession(id) {
  return api(`/api/sessions/${id}`);
}

function spawnChild(args, envExtra, label) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: Object.assign({}, process.env, envExtra),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  const info = { child, label, stdout: '', stderr: '' };
  child.stdout.on('data', (d) => { info.stdout += d.toString(); });
  child.stderr.on('data', (d) => { info.stderr += d.toString(); });
  return info;
}

async function killChild(info) {
  if (!info || !info.child) return;
  const child = info.child;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => {
    child.once('exit', () => resolve(true));
    setTimeout(() => resolve(false), 5000);
  });
  try { child.kill(); } catch (e) { /* ignore */ }
  const graceful = await exited;
  if (!graceful) {
    console.warn(`[smoke] ${info.label} did not exit within 5s — killing tree`);
    if (process.platform === 'win32') {
      try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ }
    } else {
      try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
    }
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(3000)]);
  }
}

async function main() {
  let hub = null;
  let agent = null;
  let wsClient = null;
  let printId = null;
  let echoMacId = null;
  let codexLocalFile = null;
  const steps = [];
  const step = async (name, fn) => {
    try {
      await fn();
      steps.push({ name, ok: true });
      console.log(`[PASS] ${name}`);
    } catch (err) {
      steps.push({ name, ok: false, error: err });
      console.log(`[FAIL] ${name}: ${err.message}`);
    }
  };

  try {
    // ---- Step 1: temp configs -------------------------------------------
    await step('write temp hub/agent configs', async () => {
      fs.rmSync(TMP, { recursive: true, force: true });
      fs.mkdirSync(TMP, { recursive: true });
      const fwd = (p) => p.split(path.sep).join('/');
      // Use the same node binary that runs this test (absolute path) so the
      // fixtures spawn even when `node` is not on PATH for the hub's shell.
      const nodeExe = fwd(process.execPath);

      // Codex watcher fixtures: one watched dir for the hub-local watcher, one
      // for the agent-side watcher. Fresh rollout files are copies of the
      // shared fixture (lead wrote test/fixtures/codex-session/rollout-sample.jsonl).
      const codexFixture = path.join(ROOT, 'test', 'fixtures', 'codex-session', 'rollout-sample.jsonl');
      const codexLocalDir = path.join(TMP, 'codex-local');
      const codexAgentDir = path.join(TMP, 'codex-agent');
      fs.mkdirSync(codexLocalDir, { recursive: true });
      fs.mkdirSync(codexAgentDir, { recursive: true });
      codexLocalFile = path.join(codexLocalDir, 'rollout-local.jsonl'); // outer var, used by the watcher test
      const codexAgentFile = path.join(codexAgentDir, 'rollout-agent.jsonl');
      fs.copyFileSync(codexFixture, codexLocalFile);
      fs.copyFileSync(codexFixture, codexAgentFile);

      const hubCfg = {
        port: PORT,
        host: '127.0.0.1',
        authToken: TOKEN,
        machineName: 'win-local',
        allowedRoots: [WORKSPACE],
        dataDir: TMP,
        maxSessionsPerMachine: 8,
        codexWatch: { enabled: true, sessionsDir: codexLocalDir, pollMs: 300, idleMs: 1500 },
        templates: {
          print: {
            type: 'oneshot',
            description: 'print fixture',
            command: `"${nodeExe}" "${fwd(path.join(ROOT, 'test', 'fixtures', 'print-lines.js'))}"`
          },
          echo: {
            type: 'interactive',
            description: 'echo fixture',
            command: `"${nodeExe}" "${fwd(path.join(ROOT, 'test', 'fixtures', 'echo-agent.js'))}"`,
            initialDelayMs: 300
          },
          shell: {
            type: 'oneshot',
            description: 'shell',
            command: {
              win32: '%SESSIONHUB_PROMPT%',
              darwin: '"$SESSIONHUB_PROMPT"',
              linux: '"$SESSIONHUB_PROMPT"'
            }
          }
        }
      };
      fs.writeFileSync(path.join(TMP, 'hub.json'), JSON.stringify(hubCfg, null, 2));
      const agentCfg = {
        hubUrl: `ws://127.0.0.1:${PORT}/agent`,
        token: TOKEN,
        name: 'mac-sim',
        allowedRoots: [WORKSPACE],
        maxSessions: 4,
        codexWatch: { enabled: true, sessionsDir: codexAgentDir, pollMs: 300, idleMs: 1500 }
      };
      fs.writeFileSync(path.join(TMP, 'agent.json'), JSON.stringify(agentCfg, null, 2));
    });

    // ---- Step 2: hub up ---------------------------------------------------
    await step('hub starts and serves /api/health', async () => {
      hub = spawnChild(
        [path.join(ROOT, 'server', 'index.js')],
        { SESSIONHUB_CONFIG: path.join(TMP, 'hub.json') },
        'hub'
      );
      await waitFor(async () => {
        try {
          const res = await fetch(BASE + '/api/health');
          if (res.status !== 200) return false;
          const j = await res.json();
          return !!(j && j.ok === true && j.app === 'sessionhub');
        } catch (e) {
          return false;
        }
      }, 10000, 200, 'hub /api/health');
    });

    // ---- Step 3: agent connects -------------------------------------------
    await step('agent mac-sim connects', async () => {
      agent = spawnChild(
        [path.join(ROOT, 'agent', 'agent.js'), '--config', path.join(TMP, 'agent.json')],
        {},
        'agent'
      );
      await waitFor(async () => {
        const { body } = await api('/api/state');
        return body && Array.isArray(body.machines) &&
          body.machines.some((m) => m.id === 'mac-sim' && m.status === 'connected');
      }, 10000, 200, 'mac-sim to appear connected');
    });

    // ---- Step 4: oneshot print on win-local --------------------------------
    await step('oneshot print on win-local ends 0 with LINE-1/2/3', async () => {
      const created = await api('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineId: 'win-local', workspace: WORKSPACE, template: 'print', prompt: 'run', label: 'print-test' })
      });
      if (created.status !== 201) {
        throw new Error(`create returned ${created.status}: ${JSON.stringify(created.body)}`);
      }
      printId = created.body.id;
      const final = await waitFor(async () => {
        const { body: s } = await getSession(printId);
        if (!s) return null;
        if (s.status === 'error') throw new Error(`print session errored: ${s.error}`);
        return (s.status === 'ended' || s.status === 'stopped') ? s : null;
      }, 10000, 150, 'print session to finish');
      if (final.status !== 'ended') throw new Error(`expected ended, got ${final.status}`);
      if (final.exitCode !== 0) throw new Error(`expected exitCode 0, got ${final.exitCode}`);
      await waitFor(async () => {
        const { body: s } = await getSession(printId);
        const lines = (s && s.lines) ? s.lines.map((l) => l.line) : [];
        return ['LINE-1', 'LINE-2', 'LINE-3'].every((l) => lines.includes(l));
      }, 3000, 150, 'LINE-1/2/3 to be present');
    });

    // ---- Step 5: interactive echo on mac-sim -------------------------------
    await step('interactive echo on mac-sim: READY, ECHO, STOP', async () => {
      const created = await api('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineId: 'mac-sim', workspace: WORKSPACE, template: 'echo', label: 'echo-mac' })
      });
      if (created.status !== 201) {
        throw new Error(`create returned ${created.status}: ${JSON.stringify(created.body)}`);
      }
      echoMacId = created.body.id;
      await waitFor(async () => {
        const { body: s } = await getSession(echoMacId);
        if (!s) return null;
        if (s.status === 'error') throw new Error(`echo errored: ${s.error}`);
        return (s.status === 'running' && (s.lines || []).some((l) => l.line === 'READY')) ? s : null;
      }, 10000, 150, 'echo running + READY');

      let r = await promptSession(echoMacId, 'hello phone');
      if (r.status !== 200) throw new Error(`prompt returned ${r.status}: ${JSON.stringify(r.body)}`);
      await waitFor(async () => {
        const { body: s } = await getSession(echoMacId);
        return s && (s.lines || []).some((l) => l.line === 'ECHO: hello phone');
      }, 10000, 150, 'ECHO: hello phone');

      r = await promptSession(echoMacId, 'STOP');
      if (r.status !== 200) throw new Error(`STOP prompt returned ${r.status}: ${JSON.stringify(r.body)}`);
      const final = await waitFor(async () => {
        const { body: s } = await getSession(echoMacId);
        return s && s.status === 'ended' ? s : null;
      }, 10000, 150, 'echo to end');
      if (final.exitCode !== 0) throw new Error(`expected exitCode 0, got ${final.exitCode}`);
    });

    // ---- Step 6: echo on win-local, stop it ---------------------------------
    await step('stop a local echo session', async () => {
      const created = await api('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineId: 'win-local', workspace: WORKSPACE, template: 'echo', label: 'echo-local' })
      });
      if (created.status !== 201) {
        throw new Error(`create returned ${created.status}: ${JSON.stringify(created.body)}`);
      }
      const id = created.body.id;
      await waitFor(async () => {
        const { body: s } = await getSession(id);
        return s && s.status === 'running' ? s : null;
      }, 10000, 150, 'local echo running');
      const stopped = await api(`/api/sessions/${id}/stop`, { method: 'POST' });
      if (stopped.status !== 200) {
        throw new Error(`stop returned ${stopped.status}: ${JSON.stringify(stopped.body)}`);
      }
      const final = await waitFor(async () => {
        const { body: s } = await getSession(id);
        return s && s.status === 'stopped' ? s : null;
      }, 10000, 150, 'local echo stopped');
      if (final.status !== 'stopped') throw new Error(`expected stopped, got ${final.status}`);
    });

    // ---- Step 7: FS browsing on mac-sim -------------------------------------
    await step('remote FS on mac-sim (list/read/meta/raw/traversal/missing)', async () => {
      const encFile = (name) => encodeURIComponent(path.join(WORKSPACE, name));
      const encRoot = encodeURIComponent(WORKSPACE);

      const list = await api(`/api/machines/mac-sim/fs?path=${encRoot}`);
      if (list.status !== 200) throw new Error(`list returned ${list.status}: ${JSON.stringify(list.body)}`);
      const names = ((list.body && list.body.entries) || []).map((e) => e.name);
      if (!names.includes('notes.md')) throw new Error('notes.md missing from listing');
      if (!names.includes('sub')) throw new Error('sub missing from listing');

      const notes = await api(`/api/machines/mac-sim/fs/file?path=${encFile('notes.md')}&mode=text`);
      if (notes.status !== 200 || !notes.body || typeof notes.body.content !== 'string' || !notes.body.content.includes('SessionHub')) {
        throw new Error(`notes.md text mismatch: ${JSON.stringify(notes.body)}`);
      }

      const meta = await api(`/api/machines/mac-sim/fs/file?path=${encFile('logo.png')}&mode=meta`);
      if (meta.status !== 200 || !meta.body || meta.body.isBinary !== true) {
        throw new Error(`logo.png meta mismatch: ${JSON.stringify(meta.body)}`);
      }

      const dataJson = await api(`/api/machines/mac-sim/fs/file?path=${encFile('data.json')}&mode=text`);
      let parsed = null;
      try { parsed = JSON.parse(dataJson.body.content); } catch (e) { parsed = null; }
      if (!parsed || parsed.app !== 'SessionHub') throw new Error('data.json did not parse as expected');

      const raw = await apiText(`/api/machines/mac-sim/fs/file?path=${encFile('notes.md')}&mode=raw`);
      const expected = fs.readFileSync(path.join(WORKSPACE, 'notes.md'), 'utf8');
      if (raw.status !== 200 || raw.text !== expected) {
        throw new Error(`raw download mismatch (status ${raw.status})`);
      }

      const traversal = await api(`/api/machines/mac-sim/fs/file?path=${encodeURIComponent(path.join(WORKSPACE, '..', 'outside.txt'))}&mode=text`);
      if (traversal.status !== 403) throw new Error(`traversal expected 403, got ${traversal.status}`);

      const missing = await api(`/api/machines/mac-sim/fs/file?path=${encFile('no-such-file.txt')}&mode=text`);
      if (missing.status !== 404) throw new Error(`missing file expected 404, got ${missing.status}`);
    });

    // ---- Step 8: phone WS ----------------------------------------------------
    await step('phone WS: snapshot + live output/session events', async () => {
      const messages = [];
      wsClient = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
      wsClient.on('message', (data) => {
        try { messages.push(JSON.parse(data.toString())); } catch (e) { /* ignore */ }
      });
      wsClient.on('error', () => { /* handled via open timeout */ });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ws connect timeout')), 5000);
        wsClient.once('open', () => { clearTimeout(timer); resolve(); });
      });

      const snap = await waitFor(() => messages.find((m) => m.type === 'snapshot'), 5000, 100, 'snapshot message');
      if (!Array.isArray(snap.machines) || snap.machines.length < 2) {
        throw new Error(`expected >=2 machines in snapshot, got ${snap.machines ? snap.machines.length : 'none'}`);
      }
      if (!Array.isArray(snap.sessions) || snap.sessions.length < 1) {
        throw new Error('expected >=1 session in snapshot');
      }

      const created = await api('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineId: 'mac-sim', workspace: WORKSPACE, template: 'echo', label: 'ws-echo' })
      });
      if (created.status !== 201) throw new Error(`create returned ${created.status}`);
      const id = created.body.id;

      await waitFor(
        () => messages.find((m) => m.type === 'output' && m.sessionId === id && m.line === 'READY'),
        10000, 150, 'WS output event with READY'
      );
      await waitFor(
        () => messages.find((m) => m.type === 'session' && m.session && m.session.id === id && m.session.status === 'running'),
        10000, 150, 'WS session event with status running'
      );
    });

    // ---- Step 9: negatives ----------------------------------------------------
    await step('API negatives (409/400/404/401)', async () => {
      let r = await promptSession(printId, 'nope');
      if (r.status !== 409) throw new Error(`prompt on oneshot/ended: expected 409, got ${r.status}`);

      r = await promptSession(echoMacId, 'nope');
      if (r.status !== 409) throw new Error(`prompt on ended: expected 409, got ${r.status}`);

      r = await createSession('mac-sim', { workspace: ROOT });
      if (r.status !== 400) throw new Error(`workspace outside roots: expected 400, got ${r.status}`);

      r = await createSession('mac-sim', { template: 'nope' });
      if (r.status !== 400) throw new Error(`unknown template: expected 400, got ${r.status}`);

      r = await createSession('ghost');
      if (r.status !== 404) throw new Error(`unknown machine: expected 404, got ${r.status}`);

      r = await api('/api/state', { auth: false });
      if (r.status !== 401) throw new Error(`no token: expected 401, got ${r.status}`);
    });

    // ---- Step 10 (v1.1): codex watcher, hub-local ----------------------------
    await step('codex watcher (hub-local): watched session streams + idle + ended', async () => {
      const findWatched = async (machineId) => {
        const { body } = await api('/api/state');
        if (!body) return null;
        return (body.sessions || []).find(
          (s) => s.type === 'watched' && s.machineId === machineId && s.workspace === CODEX_CWD
        ) || null;
      };
      const watched = await waitFor(() => findWatched('win-local'), 10000, 200, 'watched session on win-local');
      const wid = watched.id;
      await waitFor(async () => {
        const { body: s } = await getSession(wid);
        const lines = (s && s.lines) ? s.lines.map((l) => l.line) : [];
        return lines.some((l) => l.includes('Fix the login bug')) &&
          lines.some((l) => l.startsWith('tool › bash')) &&
          lines.some((l) => l.includes('Editing src/auth.ts'));
      }, 10000, 200, 'watched lines (user / tool › bash / info)');

      // Append one more user-message JSONL line -> must stream into the session.
      fs.appendFileSync(
        codexLocalFile,
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: 'message',
          payload: { role: 'user', content: [{ type: 'input_text', text: 'Also add a test' }] }
        }) + '\n'
      );
      await waitFor(async () => {
        const { body: s } = await getSession(wid);
        return s && (s.lines || []).some((l) => l.line.includes('Also add a test'));
      }, 10000, 200, 'appended line streams');

      // No growth for > idleMs (1500) -> status becomes 'idle'.
      await waitFor(async () => {
        const { body: s } = await getSession(wid);
        return s && s.status === 'idle' ? s : null;
      }, 8000, 250, 'watched session idle');

      // Deleting the rollout file -> status becomes 'ended'.
      fs.unlinkSync(codexLocalFile);
      await waitFor(async () => {
        const { body: s } = await getSession(wid);
        return s && s.status === 'ended' ? s : null;
      }, 8000, 250, 'watched session ended');
    });

    // ---- Step 11 (v1.1): codex watcher, agent-side ---------------------------
    await step('codex watcher (agent-side): watched session under mac-sim', async () => {
      const findAgentWatched = async () => {
        const { body } = await api('/api/state');
        if (!body) return null;
        return (body.sessions || []).find(
          (s) => s.type === 'watched' && s.machineId === 'mac-sim' && s.workspace === CODEX_CWD
        ) || null;
      };
      const watched = await waitFor(findAgentWatched, 10000, 200, 'watched session on mac-sim');
      await waitFor(async () => {
        const { body: s } = await getSession(watched.id);
        return s && Array.isArray(s.lines) && s.lines.some((l) => l.line.includes('Fix the login bug'));
      }, 10000, 200, 'watched line on mac-sim');
    });

    // ---- Step 12: agent kill -> disconnected ----------------------------------
    await step('agent kill -> machine + session disconnected', async () => {
      const created = await createSession('mac-sim', { label: 'kill-me' });
      if (created.status !== 201) throw new Error(`create returned ${created.status}`);
      const id = created.body.id;
      await waitFor(async () => {
        const { body: s } = await getSession(id);
        return s && s.status === 'running' ? s : null;
      }, 10000, 150, 'kill-me session running');
      if (!agent || !agent.child) throw new Error('agent child missing');
      try { agent.child.kill(); } catch (e) { /* ignore */ }
      await waitFor(async () => {
        const { body } = await api('/api/state');
        if (!body) return null;
        const m = (body.machines || []).find((x) => x.id === 'mac-sim');
        const s = (body.sessions || []).find((x) => x.id === id);
        return m && m.status === 'disconnected' && s && s.status === 'disconnected';
      }, 15000, 250, 'mac-sim disconnected + session disconnected');
    });
  } finally {
    // ---- Step 11: cleanup ------------------------------------------------------
    try { if (wsClient) wsClient.close(); } catch (e) { /* ignore */ }
    await killChild(agent);
    await killChild(hub);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  const failed = steps.filter((s) => !s.ok);
  if (failed.length > 0) {
    console.log('\n--- hub stdout ---\n' + (hub ? hub.stdout : '(not started)'));
    console.log('--- hub stderr ---\n' + (hub ? hub.stderr : '(not started)'));
    console.log('--- agent stdout ---\n' + (agent ? agent.stdout : '(not started)'));
    console.log('--- agent stderr ---\n' + (agent ? agent.stderr : '(not started)'));
    console.log(`\nSMOKE FAILED (${failed.length} step(s) failed)`);
    process.exitCode = 1;
  } else {
    console.log('\nSMOKE OK');
    process.exitCode = 0;
  }
}

main().catch((err) => {
  console.error('smoke test crashed:', err && err.stack ? err.stack : err);
  console.error('SMOKE FAILED');
  process.exitCode = 1;
});

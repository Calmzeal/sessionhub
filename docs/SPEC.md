# SessionHub — Technical Specification (v1)

Mobile-accessible manager for AI agent sessions across machines.
The user's phone (Oppo Find X10, Android browser) opens the hub's web UI.
Machines run AI CLIs (Codex, Claude Code, shells) inside workspaces.
A remote **agent** process on each machine connects OUTBOUND (WebSocket) to the **hub**, so
no inbound ports are needed on the Mac/WSL machines.

## Topology

```
[Phone browser] ──HTTP/WS──▶ [Hub server]  (Windows machine, port 8742)
                                 │  ◀──WS (outbound)── [Agent: Mac work laptop]
                                 │  ◀──WS (outbound)── [Agent: WSL on Windows machine]
                                 └─ local machine = the hub host itself (runs sessions directly)
```

- The hub ALSO acts as the agent for its own machine (no separate process needed there).
- Agents make a single outbound WebSocket connection to `hubUrl`. Everything (session
  commands, output streaming, file browsing) rides on that connection.
- Auth: one shared bearer token (`authToken` in hub config, `token` in agent config).
  Required on every REST call (header `Authorization: Bearer <token>`) and every WS
  connection (query `?token=<token>`), except `GET /api/health` and static web assets.

## Tech constraints

- Node.js >= 18, CommonJS (`require`), NO TypeScript, NO build step.
- Dependencies: ONLY `express` (^4.21) and `ws` (^8.18). Everything else uses Node builtins.
- Web UI: vanilla HTML/CSS/JS, no framework, no bundler. Mobile-first, dark theme default.
- Project root = repo root. Server code in `server/`, agent entry in `agent/`, shared code in
  `lib/`, web assets in `web/`, scripts in `scripts/`, fixtures in `test/fixtures/`.

## File layout & ownership

| Path | Owner | Contents |
|---|---|---|
| package.json, config.example.json | lead | pinned deps, scripts, hub config template |
| docs/SPEC.md | lead | this file |
| lib/runner.js, lib/fsutil.js | agent scope | shared process runner + safe fs browsing |
| agent/agent.js, agent/config.js, agent.config.example.json | agent scope | remote agent entry |
| scripts/start-hub.*, start-agent.*, gen-token.js | agent scope | launchers |
| test/fixtures/** | lead | deterministic test CLIs + sample workspace |
| server/** | server scope | hub: config, store, sessions, machines, agentlinks, api, ws |
| scripts/smoke-test.js | server scope | end-to-end test |
| web/** (index.html, app.js, style.css, manifest, sw.js, icons/) | web scope | mobile UI |
| README.md | lead (after integration) | docs |

Do NOT modify files outside your assigned scope. If you need a cross-scope change, note it in
your final report instead of editing the other scope's files.

## Config

### Hub config — `config.json` (optional; env vars fall back to defaults)
Location: `<repo>/config.json` or `$SESSIONHUB_CONFIG`. All keys optional except authToken
(if absent a random token is generated and logged once — user copies it for agents/phone).

```json
{
  "port": 8742,
  "host": "0.0.0.0",
  "authToken": "hex-token",
  "machineName": "win-desktop",
  "allowedRoots": ["C:\\Users\\me\\Projects"],
  "dataDir": "./data",
  "maxSessionsPerMachine": 8,
  "logRingLines": 2000,
  "logByteCap": 4194304,
  "tls": { "certFile": null, "keyFile": null },
  "templates": { "<name>": { ... } }
}
```
Env overrides: `SESSIONHUB_CONFIG`, `SESSIONHUB_PORT`, `SESSIONHUB_TOKEN`, `SESSIONHUB_NAME`,
`SESSIONHUB_ROOTS` (separator `;`), `SESSIONHUB_DATA_DIR`, `SESSIONHUB_TLS_CERT`,
`SESSIONHUB_TLS_KEY`. If `tls.certFile`+`tls.keyFile` set → serve HTTPS.

Built-in default templates (merged under user templates; user config wins):
```json
{
  "shell":        { "type": "oneshot", "description": "Run a shell command in the workspace",
                    "command": { "win32": "%SESSIONHUB_PROMPT%", "darwin": "\"$SESSIONHUB_PROMPT\"", "linux": "\"$SESSIONHUB_PROMPT\"" } },
  "codex-exec":   { "type": "oneshot", "description": "OpenAI Codex one-shot run (stream-json output)",
                    "command": { "win32": "codex exec --full-auto -o stream-json \"%SESSIONHUB_PROMPT%\"",
                                 "darwin": "codex exec --full-auto -o stream-json \"$SESSIONHUB_PROMPT\"",
                                 "linux": "codex exec --full-auto -o stream-json \"$SESSIONHUB_PROMPT\"" } },
  "claude-stream":{ "type": "interactive", "description": "Claude Code via stream-json stdin",
                    "command": "claude --input-format stream-json --output-format stream-json --verbose",
                    "jsonInput": "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"{prompt}\"}]}}",
                    "initialDelayMs": 1000 }
}
```
Template object: `type` = `oneshot` | `interactive`.
- `command`: string OR `{win32, darwin, linux}` map (pick by the TARGET machine's os; missing
  key → error 400 "template not supported on <os>").
- oneshot: the prompt travels via env var `SESSIONHUB_PROMPT` (safe on every platform);
  `{prompt}` placeholder in command is NOT supported for oneshot.
- interactive: long-lived process; prompts written to stdin, one line each. If `jsonInput`
  is set, each prompt line = jsonInput with `{prompt}` replaced by the JSON-string-escaped
  prompt text. Otherwise the raw prompt text is the line.
- `initialDelayMs` (default 800) — delay before writing the initial prompt to stdin.

### Agent config — `agent.config.json` (next to agent.js, or `--config <path>` arg)
```json
{
  "hubUrl": "ws://192.168.1.50:8742",
  "token": "same-token-as-hub",
  "name": "mac-work",
  "allowedRoots": ["/Users/me/dev"],
  "maxSessions": 4
}
```
Env overrides: `SESSIONHUB_HUB_URL`, `SESSIONHUB_TOKEN`, `SESSIONHUB_NAME`, `SESSIONHUB_ROOTS`
(`;`-separated), `SESSIONHUB_MAX_SESSIONS`.

## Shared libs (exact APIs)

### lib/runner.js
```js
const { Runner, stripAnsi } = require('../lib/runner');
const runner = new Runner({
  maxSessions,          // number, default 8
  onLine,               // (id, stream /*'stdout'|'stderr'*/, line) => void  — line is ANSI-stripped, \r removed, length-capped at 20000 chars (then "…[truncated]")
  onStatus              // (id, info) => void, info = {status:'running'|'stopped'|'ended'|'error', pid?, startedAt?, exitCode?, signal?, error?, endedAt?}
});
await runner.start({ id, cwd, command, env, initialPrompt, initialDelayMs }) // → Promise<{pid, startedAt}>; rejects on spawn failure (ENOENT etc.) — do NOT also emit onStatus 'error' if start() rejects
await runner.sendStdin(id, data)  // writes data + '\n'; rejects {message:'not-running'} / {message:'stdin-closed'}
await runner.stop(id)             // graceful stop then force; resolves info (final status is 'stopped')
await runner.stopAll()            // stop all; resolves when done
runner.status(id)                 // → {status, pid, startedAt} | null
runner.ids()                      // → [id,...]
```
Rules:
- Spawn: `spawn(command, { cwd, env: {...process.env, ...env}, shell: true, windowsHide: true,
  detached: process.platform !== 'win32', stdio: ['pipe','pipe','pipe'] })`.
- POSIX kill tree: `process.kill(-pid, 'SIGTERM')`, after 3s `SIGKILL`. Windows kill tree:
  `spawn('taskkill', ['/pid', String(pid), '/T', '/F'])`.
- Line splitting: buffer per stream, split on `/\r?\n/`, flush remaining partial line on close.
- Strip ANSI CSI/OSC codes before onLine. `stripAnsi(s)` exported for reuse.
- Natural exit (any exit code) → status 'ended' with exitCode/signal; stop()-initiated exit →
  status 'stopped'. Spawn error → start() rejects.
- Never write to stdin after process exit; sendStdin checks `status === 'running'`.

### lib/fsutil.js
```js
const { resolveWithin, listDir, readFile, readChunk, mkdirWithin, MIME } = require('../lib/fsutil');
resolveWithin(roots, absPath, platform) // → absolute resolved path (realpath-verified inside a root); throws {status:403,message} outside roots, {status:404,message} missing
listDir(root, absPath)   // → {path, root, entries:[{name, path, type:'dir'|'file', size, mtimeMs}]}  dirs-first, name-sorted (case-insensitive); throws same as resolveWithin
readFile(path, { mode:'text'|'meta', maxBytes? }) 
  // text: {size, mtimeMs, mime, isBinary, content?, truncated?}  (content omitted if isBinary; maxBytes default 262144)
  // meta: {size, mtimeMs, mime, isBinary}
readChunk(path, offset, length) // → {data: base64, eof}  (length cap 1 MiB enforced by caller AND here)
mkdirWithin(roots, absPath, platform) // → creates a single-level dir, returns resolved path; throws 403/404/409/500
```
- `resolveWithin` must defeat `..` traversal AND symlink escapes (realpath of the nearest
  existing ancestor must be inside realpath of the matched root). Windows: compare paths
  case-insensitively with `\` normalized to `/`-free compare via `path.win32` functions when
  `platform === 'win32'`.
- `isBinary`: first 8 KiB contains a NUL byte → binary (unless known text extension). MIME by
  extension from a small map (md→text/markdown; txt/json/js/ts/py/sh/log/css/html/xml/yaml→text/plain;
  png/jpg/jpeg/gif/webp/svg→image/*; pdf/zip/bin→application/*; default application/octet-stream).
- Text decode: `utf8` with replacement chars (lossy OK).

## Session & machine data shapes (exact JSON)

Machine:
```json
{ "id": "mac-work", "name": "mac-work", "host": "hostname", "os": "darwin", "arch": "arm64",
  "status": "connected", "lastSeenAt": 1731430000000, "allowedRoots": ["/Users/me/dev"],
  "local": false, "running": 2 }
```
`status`: `connected` | `disconnected`. `local` true only for the hub's own machine. Machine id =
sanitized agent name (lowercase, non `[a-z0-9_-]` → `-`, trimmed; empty → `machine-<rand6>`).

Session:
```json
{ "id": "s-m4x1abc2def3", "machineId": "mac-work", "workspace": "/Users/me/dev/proj",
  "template": "codex-exec", "type": "oneshot", "label": "Fix the login bug",
  "status": "running", "createdAt": 1731430000000, "startedAt": 1731430000500,
  "endedAt": null, "exitCode": null, "error": null, "command": "codex exec ...",
  "lines": [ { "t": 1731430000600, "stream": "stdout", "line": "..." } ],
  "logFile": "data/logs/s-m4x1abc2def3.log" }
```
`status`: `pending` → `running` → (`ended` | `stopped` | `error` | `disconnected`).
`disconnected` = agent WS dropped while running. `lines` = up to the 50 most recent (ring
buffer) — included in `/api/state`, `GET /api/sessions/:id`, and the phone WS snapshot, but
NOT in incremental `session` push events (clients append `output` events instead).
`error` = human string (spawn failure, agent restart, …). `id` format: `'s-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8)`.
`label`: user-supplied or default `"<template> · <HH:MM>"`.
Log file: append per line `ISO\t<stream>\t<line>\n` while running.

## REST API (hub, all under `/api`; auth header required)

Errors: `{ "error": { "code": "...", "message": "..." } }` with HTTP status
400 bad-request / 401 auth-required / 403 forbidden / 404 not-found / 409 conflict / 500 server.
Code is a short slug like `machine-offline`, `template-unknown`, `not-running`.

| Method/Path | Body → Response |
|---|---|
| GET /api/health | (no auth) `{ok:true, app:'sessionhub', version, machineId, machineName, time}` |
| GET /api/state | `{machines:[Machine], sessions:[Session]}` sessions newest-first |
| GET /api/templates | `{templates:[{name, type, description}]}` (never expose command strings) |
| POST /api/sessions | `{machineId, workspace, template, prompt?, label?}` → 201 Session. 409 if machine offline. 400 if workspace not under a machine root / template unknown / prompt empty for oneshot. Interactive: prompt optional (sent as initial line after initialDelayMs). |
| GET /api/sessions/:id | Session (with lines) |
| POST /api/sessions/:id/prompt | `{text}` → `{ok:true}`. 409 `not-interactive` if type oneshot; 409 `not-running` if not running/stopping. |
| POST /api/sessions/:id/stop | → `{ok:true}` idempotent (already ended → ok). Sets status `stopping`. |
| DELETE /api/sessions/:id | query `force=1` allowed. → `{ok:true}`. 409 if running & !force. Removes log file + ring buffer. |
| GET /api/machines/:id/roots | `{roots:[...]}` |
| GET /api/machines/:id/fs?path=<abs> | `{path, root, entries:[...]}` (defaults to first root if path empty) |
| GET /api/machines/:id/fs/file?path=<abs>&mode=text|meta | FileInfo (text: `{size,mtimeMs,mime,isBinary,content?,truncated?}`) |
| GET /api/machines/:id/fs/file?path=<abs>&mode=raw | binary stream, `Content-Type` mime, `Content-Disposition: attachment; filename="<name>"`; streams chunked for remote machines |
| POST /api/machines/:id/fs/mkdir | `{path}` (absolute path of the NEW single-level directory) → `{ok:true, path}`. 403 outside roots, 404 parent missing, 409 exists (dir or file), 504 agent timeout, 409 machine-offline. |

Hub-side validation on create: machine exists + connected; workspace absolute, under one of
`machine.allowedRoots` (light check via fsutil with the TARGET machine's platform; the agent
re-validates authoritatively). Resolve template → pick command per target os → env additions:
`SESSIONHUB_SESSION_ID`, `SESSIONHUB_WORKSPACE` (workspace), `SESSIONHUB_PROMPT` (oneshot:
the prompt; interactive: initial prompt). For interactive with jsonInput: resolved initial
line = jsonInput with `{prompt}` replaced by JSON-escaped text (JSON.stringify(prompt).slice(1,-1)).

## Phone WebSocket — path `/ws`, query `?token=`

Hub → client messages:
```json
{ "type": "snapshot", "machines": [...], "sessions": [...] }
{ "type": "machine", "machine": {...} }
{ "type": "session", "session": {...} }            // meta only, no lines
{ "type": "output", "sessionId": "...", "t": 0, "stream": "stdout", "line": "..." }
{ "type": "sessionRemoved", "sessionId": "..." }
```
Sent on: connect (snapshot), machine status/hello changes (machine), session status/meta
changes (session), each output line (output), deletion (sessionRemoved). Client → hub: none
(actions go via REST). Hub may ping/terminate dead sockets (browser auto-pongs).

## Agent WebSocket — path `/agent`, query `?token=<token>`

Agent → hub:
```json
{ "type": "hello", "v": 1, "name": "mac-work", "hostname": "...", "os": "darwin",
  "arch": "arm64", "allowedRoots": ["/Users/me/dev"], "maxSessions": 4 }
{ "type": "session.status", "id": "...", "status": "running|stopped|ended|error",
  "pid": 123, "startedAt": 0, "exitCode": null, "signal": null, "error": null, "endedAt": 0 }
{ "type": "session.output", "id": "...", "stream": "stdout", "line": "..." }
{ "type": "session.stdinResult", "id": "...", "ok": true, "error": null }
{ "type": "fs.result", "reqId": 7, "ok": true, "payload": {...}, "error": null }
{ "type": "pong", "t": 0 }
```
Hub → agent:
```json
{ "type": "helloAck", "v": 1 }
{ "type": "session.start", "id": "...", "cwd": "...", "command": "...", "env": {...},
  "initialPrompt": "line or null", "initialDelayMs": 800 }
{ "type": "session.stdin", "id": "...", "data": "fully-resolved line" }
{ "type": "session.stop", "id": "..." }
{ "type": "fs.list", "reqId": 7, "path": "/abs" }
{ "type": "fs.read", "reqId": 7, "path": "/abs", "mode": "text|meta", "maxBytes": 262144 }
{ "type": "fs.chunk", "reqId": 7, "path": "/abs", "offset": 0, "length": 262144 }
{ "type": "fs.mkdir", "reqId": 7, "path": "/abs/new-dir" }
{ "type": "ping", "t": 0 }
```
Agent behavior:
- On connect: send `hello`; wait `helloAck` (5s timeout → close+retry). Auth/name failures:
  hub closes with code 4001 (bad token, don't retry, exit 1) / 4002 (name conflict, exit 1).
  Any other close → reconnect with backoff 2s, 4s, 8s … capped 30s. Log reconnects.
- After helloAck: send `session.status` (running) for every live child (reconnect reconcile).
- `session.start`: validate cwd within allowedRoots (fsutil) → runner.start → status
  events stream out. Reject (unknown limit/bad cwd) via `session.status {status:'error', error}`.
  Enforce maxSessions.
- `session.stdin`: runner.sendStdin → `session.stdinResult`.
- `session.stop`: runner.stop.
- fs.* : validate path within allowedRoots; answer `fs.result` with payload
  (list → listDir result; read → readFile result; chunk → readChunk result;
  mkdir → mkdirWithin result `{path}`) or `{ok:false, error}`.
- `ping` → `pong`. ws-protocol pings auto-answered by the ws library; also terminate
  unresponsive sockets (isAlive pattern, 60s) so reconnect kicks in.
- On SIGINT/SIGTERM: runner.stopAll() then exit 0. (Children die with the agent — documented.)
- Children DO survive WS drops (only agent process death kills them).

## Hub behavior details (server scope)

- Local machine: id/name from config.machineName, `local:true`, status always connected,
  allowedRoots from config, sessions run via lib/runner directly.
- Remote agent hello: register machine; if the name is already connected → close OLD socket
  with 4002 (this is a reconnect). Update lastSeenAt. Reconcile: for every session of that
  machine still `running`/`disconnected` → set `disconnected`; then apply the agent's
  re-sent `session.status` events (running → running with new pid; ended/stopped/error →
  final). Sessions still `disconnected` 5s after helloAck → mark `ended`, error
  "agent restarted" (children did not survive). Timer per reconnect; cancel if status arrived.
- Agent WS drop: machine.status = disconnected, lastSeenAt now; its running sessions →
  `disconnected`. FS/proxy requests to offline machine → 409 `machine-offline`.
- Heartbeat: ws-protocol `ping()` every 30s; terminate if no pong in 60s (isAlive pattern).
- Output fan-in: every `session.output` → ring buffer (cap logRingLines / logByteCap) + log
  file append + phone WS `output` event.
- Remote FS proxy: reqId map with 20s timeout; timeout → 504-ish `{error}`. `mode=raw` on a
  remote machine: loop `fs.chunk` (1 MiB per chunk) piping base64 → Buffer → response.
- Graceful shutdown (SIGINT/SIGTERM): stop local sessions (runner.stopAll), close agent
  sockets, save store, exit. Note Windows Ctrl+C in the same console.
- Persistence: `dataDir/hub-state.json` — sessions (meta incl. logFile, NO lines). Debounced
  save (500ms), atomic write (tmp + rename). Reloaded on boot (sessions that were running are
  shown as `disconnected` until agents reconnect). Log files at `dataDir/logs/<id>.log`.
- Auth middleware: header `Authorization: Bearer <token>` OR query `token=` (query needed for
  WS and convenience downloads). `/api/health` and static files exempt.
- Static: `express.static(web/)` at `/`, `Cache-Control: no-cache` for index.html + sw.js.
- Express 4, `express.json({limit:'1mb'})`, `app.set('x-powered-by', false)`.
- All timestamps epoch ms.

## Web UI (web scope) — screens & behavior

Single-page vanilla JS. Files: index.html, style.css, app.js, manifest.webmanifest, sw.js,
icons/icon-192.png, icons/icon-512.png, icons/favicon-32.png, icons/icon.svg (icons are
already generated by lead — do not regenerate, just reference).

Screens (state-driven, no router lib):
1. **Connect** (shown when no token in localStorage): server URL (default `location.origin`),
   token input, Connect button. On submit: save to localStorage, call `/api/health` with
   header; on 401 show error + stay.
2. **Machines** (tab 1): list of machine cards: name, host, os, status dot (green/red),
   "last seen", running count; buttons per card: Sessions, Files, New Session (disabled when
   disconnected). Auto-refresh via WS events.
3. **Sessions** (per machine): newest-first list; each row: label, template, workspace,
   status chip (colored), started/ended time (relative), last line preview (from lines tail).
   Tap → detail. "+ New" button top.
4. **Session detail**: header (label, machine, workspace — tap opens Files at that workspace,
   template, command, status chip, exit code). Actions: Stop (running/stopping), Delete
   (with confirm; force when running). Log pane: monospace, auto-scroll pinned to bottom
   unless user scrolled up (then show "N new lines ↓" chip). Input bar at bottom: textarea
   (auto-grow 2-6 lines) + Send. If type is oneshot: input hidden, hint "One-shot session —
   create a new session to run another prompt." If ended: input hidden. Send → POST prompt.
5. **New session**: machine select (connected only), workspace (text input + "Browse…" opens
   folder picker modal over the fs API), template select (from /api/templates; shows
   description), label (optional), prompt textarea. Create → navigate to detail. Oneshot
   requires prompt (validate client-side).
6. **Files**: machine + root selector (when >1 root), breadcrumb path bar (tappable segments),
   entry list (dir/file icon, name, size, mtime). Tap dir → descend; tap file → preview sheet:
   image (fetch raw → blob URL → <img>), text/markdown (<pre>, cap note if truncated),
   binary → size + Download button (fetch raw with auth header → blob → object URL download).
   "Open in session" not needed. 403/404 → inline error toast.
7. **Settings** (tab 2): server URL + token (edit, Save & reconnect), theme toggle
   (dark/light via `<html data-theme>`), app version + hub health, "Add to home screen"
   instructions, "disconnect" (clear token).
8. **Toasts** for all API errors (auto-dismiss 4s). Connection status chip in header
   (WS connected/reconnecting).

Common infra in app.js: `api(path, opts)` fetch wrapper (JSON + auth header + error toast),
`wsUrl()` derive ws(s):// from server URL, WS client with auto-reconnect (2s backoff) +
snapshot/event application to state, `fmtTime`/`fmtRel`, state store `{machines, sessions}`,
view renderer functions. `escapeHtml` everywhere user data is rendered. No inline `onclick`
with unescaped strings.

Styling: system font stack; dark theme default (`prefers-color-scheme` respected); big touch
targets (≥44px); sticky bottom bars (nav + session input); safe-area insets
(`env(safe-area-inset-bottom)`); status colors: running=#22c55e, stopped/ended=#94a3b8,
error=#ef4444, disconnected=#f59e0b, stopping=#f59e0b. Max content width 800px centered.

PWA: manifest (name SessionHub, display standalone, theme #0f172a, icons 192/512 + maskable
same images, start_url "/"), sw.js: register only when `location.protocol === 'https:' ||
location.hostname === 'localhost'`; cache shell (/, app.js, style.css, icons) on install,
cache-first + network update, skipWaiting + clients.claim.

## Smoke test (scripts/smoke-test.js, server scope)

Self-contained; run with `node scripts/smoke-test.js`. Uses global fetch + `ws`. Steps:
1. Write a temp config (in `data/tmp-smoke/`) with port 8799, token `test-token-123`,
   machineName `win-local`, allowedRoots `[test/fixtures/workspace]`, templates:
   `print` (oneshot: platform map running `node <abs>/test/fixtures/print-lines.js`),
   `echo` (interactive: platform map running `node <abs>/test/fixtures/echo-agent.js`,
   no jsonInput, initialDelayMs 300), plus `shell`.
   Wait — hub spawns with `shell:true` so the command can be a bare `node path` string on all
   platforms. `print-lines.js` prints `LINE-1`, `LINE-2`, `LINE-3` (80ms apart) then exits 0.
   `echo-agent.js` prints `READY` then per stdin line prints `ECHO: <line>`; on line `STOP`
   prints `BYE` and exits 0. Both fixtures exist (lead wrote them).
2. Spawn hub child (`process.execPath server/index.js` with SESSIONHUB_CONFIG=temp config),
   poll `GET /api/health` until ok (50 × 200ms).
3. Spawn agent child (agent/agent.js with `--config` temp agent config: name `mac-sim`,
   token, hubUrl `ws://127.0.0.1:8799`, allowedRoots `[<workspace>]`); poll `/api/state`
   until machine `mac-sim` appears with status connected (50 × 200ms).
4. Create oneshot `print` session on `win-local` → poll until `ended` (10s max) → assert
   exitCode 0, lines include LINE-1/2/3.
5. Create interactive `echo` session on `mac-sim` → assert running + READY line arrives
   (poll). POST prompt `hello phone` → poll until `ECHO: hello phone` appears. POST prompt
   `STOP` → poll until ended, exitCode 0.
6. Create `echo` on `win-local`, POST /stop → poll until status `stopped`.
7. FS on mac-sim: list workspace root → entries include `notes.md` and `sub`; read
   `notes.md` text contains `SessionHub`; meta of `logo.png` → isBinary true; read
   `data.json` parses; raw download `notes.md` matches; traversal `path=<workspace>/../outside.txt`
   → expect 403; missing file → 404.
8. Phone WS: connect `ws://127.0.0.1:8799/ws?token=...` → expect `snapshot` (machines ≥ 2,
   sessions ≥ 1). Create `echo` session → expect `output` event with `READY`. Expect a
   `session` event with status running.
9. Negative: prompt to a oneshot/ended session → 409; create session with workspace outside
   roots → 400; create with unknown template → 400; create on unknown machine → 404;
   API without token → 401.
10. Kill agent child → poll `/api/state` until mac-sim disconnected and its running session
    (start one before killing) shows `disconnected`. (Windows: child.kill() is a hard kill.)
11. Cleanup: kill hub child, wait exits (5s) then fallback taskkill; remove temp dir. Print
    per-step PASS/FAIL lines and final `SMOKE OK` / `SMOKE FAILED`; exit 0/1.

## Codex VSCode session watching (v1.1)

Goal: monitor AI sessions running inside the VSCode **Codex extension** (which embeds the
Codex CLI and writes session transcripts as JSONL rollout files under
`~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`). The watcher tails those files and
streams human-readable lines to the hub so the phone can watch progress/returns. Read-only:
prompt/stop apply only to hub-spawned sessions.

### lib/codexwatch.js — exports `class CodexWatcher extends EventEmitter`
- `new CodexWatcher({ dir, pollMs = 2000, idleMs = 600000, onEvent })`
  `dir` may be `~/.codex` (auto-narrows to its `sessions` subdir when present) or a direct
  sessions dir. `start()` / `stop()`.
- `onEvent(ev)` events:
  - `{ kind:'session', id, file, workspace, label }` — new/rediscovered rollout file
  - `{ kind:'line', id, text }` — text already prefixed (`user › `, `agent › `, `tool › `, `info › `)
  - `{ kind:'status', id, status:'running'|'idle'|'ended' }` — running↔idle on growth
    transitions (no growth for idleMs → idle; growth again → running); file deleted → ended.
- Mechanics: poll every `pollMs`; recursive scan for `*.jsonl` (skip `history.jsonl`);
  track per-file size; read appended bytes only (`fs.open`/`fstat`/`read` with a persistent
  fd, reopen on shrink/rename); parse complete lines as JSON defensively (per-line try/catch).
- Line extraction (defensive against schema drift; all payload paths optional):
  - workspace (sticky per file) = first found of `line.cwd`, `line.payload.cwd`,
    `line.payload.session.cwd`, `line.payload.working_directory`
  - user text: `type==='message' && payload.role==='user'` → join `payload.content` items'
    `input_text`/`text`/`output_text` strings
  - assistant text: `type==='response_item' && payload.type==='message' && payload.role==='assistant'`
    → join content items' `output_text`/`text`
  - tool call: `type==='response_item' && payload.type==='function_call'` →
    `name(` + `arguments` JSON compacted, ≤200 chars + `)`
  - tool output: `type==='response_item' && payload.type==='function_call_output'` →
    first line of `payload.output`, ≤400 chars
  - info: `type==='event_msg'` with `payload.type` `agent_message`/`user_message` →
    `payload.message`
  - fallback: compact JSON of the line ≤400 chars
  - cap every emitted text ≤4000 chars. `id = 'w-' + sha1(fileAbsPath).slice(0,10)`,
    `label = <filename> + ' · ' + <basename(workspace)>`.

### Hub (server) wiring
- `config.codexWatch` = `{ enabled:false, sessionsDir:'~/.codex', pollMs:2000, idleMs:600000 }`.
  When enabled, `index.js` starts a CodexWatcher for the LOCAL machine and feeds
  `sessions.handleWatchedEvent(ev)`:
  - `session` → create/update watched record `{ type:'watched', template:'codex-watch',
    status:'running', workspace, label, command:'', machineId: localId, lines:[] }`
  - `line` → ring buffer + phone WS `output` (stream `'stdout'`) — NO log file, NOT persisted
    to the store (memory-only, recreated after hub restart)
  - `status` → set record status (`idle`, `ended`, `running`)
- Watched sessions can be removed without `force` (nothing to stop).
- Remote agents: agent config `codexWatch` (same shape; env `SESSIONHUB_WATCH_DIR`) starts the
  same watcher; events → hub as `session.status {id, status:'running', meta:{type:'watched',
  workspace, label}}` (hub creates the watched record when id is unknown) + `session.output
  {id, stream:'stdout', line}`.

### Web UI
Sessions of `type==='watched'`: badge `👁 watched` in list rows; detail view hides the prompt
input and Stop button, Delete allowed, hint: "Watched VSCode/Codex session — read-only
monitoring. Create a session from this workspace to control an agent from your phone."
`status==='idle'` renders like `disconnected` (amber).

### Smoke test additions (scripts/smoke-test.js)
- Fixture: `test/fixtures/codex-session/rollout-sample.jsonl` (lead writes it; contains a cwd
  line, a user message, assistant text, a `function_call` bash, an `agent_message`, and a
  `function_call_output`).
- Test 1 (hub-local watcher): temp codex dir; copy fixture in as a fresh rollout file; hub temp
  config enables `codexWatch {enabled:true, sessionsDir:<temp>, pollMs:300, idleMs:1500}`;
  poll `/api/state` until a `watched` session appears for `win-local` with workspace =
  the fixture's embedded cwd (`CODEX_CWD` constant, currently `C:\Users\me\dev\sample-workspace`);
  assert its lines include the user text, the `tool › bash` line and
  the info line; append one more user-message line to the file → assert it streams; wait >
  idleMs → assert status becomes `idle`; delete the file → assert status `ended`.
- Test 2 (agent watcher): second temp dir + fixture copy; agent `mac-sim` config gets the same
  `codexWatch` block; assert a watched session appears under machine `mac-sim`.

## DSH dialogue templates (v1.2)

- Template keys: `outputTransform: 'dsh-json'` converts a `dsh --profile headless
  --json` NDJSON stream into phone-readable lines (`⋯ status`, `💭 thinking`,
  `💬 text`, `🔧 tool_call`, `📦 tool_result`, `✅ done · reason · answer`); the run's
  `sessionId` is captured into the session record's `externalId`.
- `{resumeArg}` placeholder in `command` → replaced by ` --session-id "<id>"` when the
  create request carries a validated `resumeId` (`/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/`),
  else removed — enables multi-turn dialogues from the phone.
- The web UI shows a **↻ Continue** button on finished sessions with `externalId`,
  prefilling a new session (same machine/workspace/template + resumeId chip).
- Child output encoding: the runner keeps raw byte buffers per stream and decodes each
  line strict-UTF-8 first, falling back to the Windows console codepage (GBK) — no
  `setEncoding` on child streams.

## Uniform token, hub peers, multi-server phone UI (v1.3)

- **Uniform token**: `authToken` is a plain shared secret — use the SAME value in every
  hub `config.json` and every agent `agent.config.json`. No code required.
- **Hub peers** (hub-as-agent): hub config `peers: [ { hubUrl, token, machineName?,
  allowedRoots?, maxSessions?, codexWatch? } ]` (default `[]`). Each entry starts an
  OUTBOUND agent client (lib/agentclient.js), so THIS hub's local machine appears as a
  remote machine on the peer hub. Defaults: `machineName` = this hub's machineName,
  `allowedRoots` = this hub's allowedRoots, `maxSessions` = this hub's maxSessionsPerMachine,
  `codexWatch` = this hub's codexWatch. Peer clients log
  `[sessionhub] peer <name> -> <hubUrl>` and are stopped on shutdown. Peers do not change
  this hub's own machine record.
- **lib/agentclient.js** — exports `createAgentClient(opts)` → `{ stop() }`, opts:
  `{ hubUrl, token, name, allowedRoots, maxSessions, codexWatch, logPrefix }`.
  ALL of the current agent/agent.js behavior moves here unchanged (WS handshake with
  hello/helloAck + close codes 4001/4002, session.start/stdin/stop dispatch to lib/runner,
  fs.list/read/chunk/mkdir, codex watching, reconnect/backoff, ping/pong, graceful stop).
  `agent/agent.js` becomes a thin wrapper (load config, createAgentClient, SIGINT/SIGTERM
  → stop). Zero behavior change — the existing smoke tests must stay green.
- **Web UI multi-server**: localStorage `sessionhub.servers` = array of
  `{id, name, url, token}` + `sessionhub.serverId` (active). Legacy keys
  `sessionhub.url` / `sessionhub.token` migrate into one default server on first boot.
  `api()` / `wsUrl()` / health all use the ACTIVE server. The header shows the active
  server name; tapping opens a switcher popup (server list, tap to switch, add new).
  Settings manages the list (add / remove / switch / edit). Switching closes the WS,
  clears loaded state, and reconnects to the new server.
- **Smoke test addition**: start a second hub on port 8800 (same token, machineName
  `hub-b`, `peers:[{hubUrl:'ws://127.0.0.1:8799/agent', token}]`); assert hub A's
  `/api/state` gains machine `hub-b` (connected, allowedRoots = hub B's); stop hub B →
  assert hub A marks `hub-b` disconnected.

## Conventions

- CommonJS everywhere. `'use strict';` at top of files.
- Logging: hub/agent log `[sessionhub] <message>` to console. No log library.
- Errors surfaced to API: `{status, code, message}` objects thrown; api.js converts to
  `{error:{code,message}}` responses. Use a tiny `httpError(status, code, message)` helper.
- All user-provided strings rendered with HTML escaping. WS payloads JSON only.
- Windows paths, spaces, non-ASCII: always pass paths as UTF-8 strings; never shell-escape
  paths manually (env vars for prompts; spawn array args for taskkill).
- Session ids: `s-<base36 ts>-<6 base36 rand>`. reqIds: monotonic int per connection.
- Version: read package.json version for /api/health.

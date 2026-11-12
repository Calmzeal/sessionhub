# SessionHub

Manage AI agent sessions on multiple machines from your phone.

One small hub server on your Windows machine + one lightweight "agent" process on each other
machine (company Mac, WSL). Your phone opens a mobile web UI served by the hub and can:

- 👀 **watch** live progress of AI sessions (Codex, Claude Code, any CLI) on any machine
- 💬 **send prompts** to running interactive sessions, and **stop** them
- ✨ **create new sessions** in a workspace with one tap
- 📂 **browse the file system** results agents produce (preview text, images, download files)

```
[Phone browser] ── HTTP/WS ──▶ [Hub :8742]  (Windows machine)
                                  ▲  ▲
                    WS (outbound) │  │  WS (outbound)
                        [Mac agent]   [WSL agent]
```

Agents make a single **outbound** WebSocket connection to the hub — no inbound ports, no
admin rights, nothing listening on the Mac. The hub itself also runs sessions on its own
machine, so the Windows box needs no separate agent process.

## Requirements

- **Node.js ≥ 18** on the hub machine (Windows) and on every machine that runs an agent.
  Windows: `winget install OpenJS.NodeJS.LTS`. macOS: `brew install node`.
- The phone reaches the hub over the same network (LAN) or via **Tailscale** (recommended —
  works from anywhere, traffic is encrypted).

## 1. Hub setup (Windows machine)

```bat
cd sessionhub
npm install
npm run gen-token            :: prints a random token — copy it
copy config.example.json config.json
```

Edit `config.json`:

- `authToken` — paste the generated token (used by phone UI and by all agents)
- `machineName` — display id of this Windows machine, e.g. `win-desktop`
- `allowedRoots` — workspaces the phone may see/create sessions in, e.g.
  `["C:\\Users\\you\\Projects"]`
- `templates` — the AI commands the phone can start (see [Templates](#templates))

Start the hub:

```bat
npm start
```

> Windows Firewall will ask to allow Node — allow it (private networks), or skip this
> entirely by using Tailscale (below).

## 2. Phone setup (Oppo Find X10 / any phone)

1. Open `http://<hub-ip>:8742` in Chrome (with Tailscale: `http://<tailscale-ip-or-name>:8742`).
2. On the Connect screen: keep the server URL, paste the token. Done.
3. Chrome menu → **Add to Home screen** → SessionHub opens like an app.

## 3. Agent setup (company Mac)

```bash
cd sessionhub
npm install
cp agent.config.example.json agent.config.json
```

Edit `agent.config.json`:

- `hubUrl` — `ws://<hub-ip>:8742` (Tailscale IP recommended)
- `token` — same token as the hub
- `name` — `mac-work`
- `allowedRoots` — e.g. `["/Users/you/dev"]`
- `maxSessions` — concurrent session cap for this machine

```bash
npm run agent          # or: ./scripts/start-agent.sh
```

Company-machine notes: the agent **only opens an outbound WebSocket** to your hub, runs with
your normal user account (no admin), and only touches directories listed in `allowedRoots`.
Sessions stop if the agent process stops. As with any third-party tool, check your company's
software policy before installing.

## 4. Agent setup (WSL on the Windows machine)

Same as the Mac, with WSL paths in `allowedRoots` (e.g. `/home/you/projects`).

For `hubUrl`, WSL reaches the Windows host via the default-gateway IP:

```bash
ip route show default   # e.g. 172.28.64.1
# then: ws://172.28.64.1:8742
```

(If your WSL uses *mirrored* networking, `ws://127.0.0.1:8742` also works.)

## 5. Tailscale (recommended for phone access anywhere)

1. Install Tailscale on Windows, Mac, and the phone (all from tailscale.com).
2. Use the hub machine's tailnet IP or MagicDNS name (`http://win-desktop:8742`) as the
   server URL in the phone UI, and as `hubUrl` on agents.
3. Optional HTTPS (enables full PWA install + service worker): run
   `tailscale cert <hub-name>` to get cert files, then set `tls.certFile`/`tls.keyFile` in
   `config.json` and use `https://...` in the phone.

Without Tailscale, plain LAN HTTP works too — the bearer token still protects the API, but
anyone on the LAN can intercept it, so prefer Tailscale (WireGuard-encrypted) or TLS.

## Templates — which AI commands the phone can start

Templates live in `config.json` (`templates`). The phone can only start these — never
arbitrary commands. Built-in defaults:

| Template | Type | What it does |
|---|---|---|
| `codex-exec` | oneshot | Runs `codex exec --full-auto -o stream-json "<prompt>"` in the workspace. One prompt per session — create a new session for the next prompt. |
| `claude-stream` | interactive | Long-lived `claude` with `--input-format stream-json`; every prompt you type on the phone goes to its stdin. |
| `shell` | oneshot | Runs the prompt as a shell command in the workspace (handy for builds/tests). |

Notes:

- **oneshot** sessions run one prompt to completion. The prompt is passed to the command via
  the `SESSIONHUB_PROMPT` environment variable (safe for any shell/quoting).
- **interactive** sessions stay alive; prompts are written to stdin line by line. They work
  with CLIs that read piped stdin (Claude Code with `stream-json`). TUI-only CLIs (like plain
  `codex` without `exec`) need a TTY and won't accept piped stdin — use their oneshot/exec
  mode instead.
- Codex flags vary by version — check `codex exec --help` on the Mac and adjust the template
  if needed (e.g. drop `--full-auto` if you want edit approvals).
- Add your own templates freely; `command` may be a string or a `{win32, darwin, linux}`
  map so one template works across OSes.

## Session lifecycle (know this)

- Sessions are children of the **agent process**. Restarting/stopping an agent ends its
  running sessions (the hub marks them `disconnected`, then `ended: agent restarted`).
- Hub restarts keep history: past sessions and their log files survive in `data/`.
- Stopping from the phone kills the whole process tree (shell + CLI), not just the wrapper.
- The phone's Stop is graceful: SIGTERM first, force-kill after 3 seconds.

## Security model

- One shared bearer token for the phone UI and all agents; API + WebSockets reject anything
  else (`/api/health` and the web page itself are public).
- File browsing is **read-only** and confined to each machine's `allowedRoots` (path
  traversal and symlink escapes are blocked).
- The phone can start only configured **templates**, never raw commands.
- Agents open outbound connections only; nothing listens on agent machines.
- Optional TLS via `tls.certFile`/`tls.keyFile` (e.g. `tailscale cert`).

## Running the hub on macOS (Mac as a second hub)

Your Mac can run its own hub so the phone manages **Codex sessions on the Mac**:

```bash
brew install node            # Node.js >= 18
brew install --cask tailscale   # optional but recommended (or use the App Store)
git clone <this-repo-url> sessionhub && cd sessionhub
npm install
npm run gen-token            # a NEW token for the Mac hub
cp config.example.json config.json
# edit config.json: authToken (paste new token), machineName "mac-work",
# allowedRoots ["/Users/you/dev"], and enable codexWatch (below)
npm start
```

- **Firewall**: macOS will ask to allow Node incoming connections — allow it (or rely on
  Tailscale-only access).
- **Phone**: on the Connect screen (or Settings), change the Server URL to the Mac's address
  (`http://<mac-tailscale-ip>:8742` or the LAN IP) and paste the Mac's token.
- **Auto-start**: see `scripts/com.sessionhub.hub.plist.example` for a launchd template.

### Watching VSCode Codex sessions (read-only monitoring)

The VSCode **Codex extension** writes its session transcripts as JSONL rollout files under
`~/.codex/sessions/`. SessionHub tails those files and streams the conversation (prompts,
assistant replies, tool calls, agent status messages) to your phone in real time.

Enable it in `config.json`:

```json
"codexWatch": { "enabled": true, "sessionsDir": "~/.codex", "pollMs": 2000, "idleMs": 600000 }
```

Watched sessions appear on the phone with a **👁 watched** badge, grouped under the machine,
showing the workspace they're attached to. They are **read-only** — the phone can't inject
prompts into a VSCode session or stop it (the extension owns that process). To *control* an
agent from the phone, start a session from the phone's "New Session" screen instead
(e.g. the `codex-exec` template) — and watch its results in Files.

> Note: if the Codex extension stores its transcripts elsewhere on your setup, point
> `sessionsDir` at that directory instead. Remote agents support the same `codexWatch`
> config key (or `SESSIONHUB_WATCH_DIR`).

## Keeping a machine's details out of the repo

`config.json`, `agent.config.json`, `data/`, and logs are gitignored — tokens, machine
names, and session history never leave the machine. Keep it that way: only commit
`*.example.json` placeholders.

## One token, many machines

`authToken` is a plain shared secret — put the **same value** in every `config.json`
(hub) and every `agent.config.json` (agent). Then one token unlocks every machine.

Two ways to see all machines from the phone:

1. **One hub + agents** (simplest): run the hub on one always-on machine (e.g. your
   Windows PC) and run `npm run agent` on the others. The phone connects to that one
   hub and sees every machine in a single list.
2. **Hub peers**: a hub can ALSO connect to another hub as an agent. In `config.json`
   add `"peers": [{ "hubUrl": "ws://other-hub:8742/agent", "token": "<same token>" }]`
   — this machine then appears on the other hub. Set peers symmetrically and both hubs
   show all machines; the phone's server switcher hops between hubs without re-typing.

The phone UI stores a list of servers (URL + token) — tap the server name in the header
to switch, add, or remove servers. With one uniform token, adding a server is just its URL.

## Project layout

```
server/    hub: REST API, WebSocket servers, session/agent management
agent/     remote agent daemon (Mac/WSL entry point)
lib/       shared process runner + safe file-system browsing
web/       mobile web UI (no build step) + PWA manifest/icons
scripts/   launchers, gen-token, smoke-test
test/      fixtures used by the smoke test
docs/      full technical spec
```

## Troubleshooting

- **Phone says "server unreachable"** — hub not running, wrong IP, or Windows Firewall
  blocking port 8742 (allow Node on private networks, or use Tailscale).
- **Machine shows disconnected** — agent process stopped, wrong `hubUrl`/token, or network
  drop. The agent reconnects automatically; check its console log.
- **`codex: command not found`** — agent's PATH lacks it (common when starting from a GUI
  terminal profile). Start the agent from a shell where `codex` works, or use absolute paths
  in the template command.
- **Wrong token** — agents exit with `auth failed`, phone shows 401. Regenerate with
  `npm run gen-token` and update everywhere.
- **Sessions die when I close the agent window** — by design (children belong to the agent).
  Run the agent in a tmux/screen session or via `nohup` if you want it detached from a
  terminal, and don't kill the agent while a session is running.

## Development / testing

```bash
npm run smoke   # full end-to-end test (hub + simulated remote agent + UI API surface)
```

See [docs/SPEC.md](docs/SPEC.md) for the complete API/protocol contract.

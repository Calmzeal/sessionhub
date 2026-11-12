'use strict';

/* ============================================================
   SessionHub — mobile web UI
   Vanilla ES2020+, no dependencies. State-driven single page app.
   API contract: docs/SPEC.md (REST API + "Phone WebSocket").
   ============================================================ */

const APP_VERSION = '1.0.0';
const LOG_CAP_LINES = 2000;

const LS = {
  url: 'sessionhub.url',
  token: 'sessionhub.token',
  theme: 'sessionhub.theme',
  filesMachine: 'sessionhub.filesMachine',
  fsRoot: 'sessionhub.fsroot.',
};

/* ---------- global state ---------- */
const state = {
  view: 'connect',
  machines: [],
  sessions: [],
  templates: [],
  loaded: false,               // at least one successful state load
  health: null,
  connectError: '',
  wsState: 'off',              // 'off' | 'connecting' | 'connected'
  sessionsMachineId: null,     // sessions view: which machine
  sessionId: null,             // session detail view
  newMachineId: null,          // new-session form: preselected machine
  resume: null,                // new-session form: continue-a-conversation info
  previews: new Map(),         // sessionId -> last output line (list preview)
  files: emptyFilesState(),
  picker: null,                // folder picker modal state
  preview: null,               // file preview sheet state
  overlayOpen: false,          // a history entry was pushed for an open overlay
  detail: null,                // session detail log state (see openSessionDetail)
};

function emptyFilesState() {
  return { machineId: null, roots: [], root: null, path: null, entries: null, loading: false, error: null, returnTo: { view: 'machines' } };
}

/* ============================================================
   Small helpers
   ============================================================ */

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function escapeHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
const esc = escapeHtml;

function fmtBytes(n) {
  if (n == null || Number.isNaN(n)) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

function fmtRel(ts) {
  if (!ts) return 'never';
  let d = Date.now() - ts;
  if (d < 0) d = 0;
  const s = Math.floor(d / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const days = Math.floor(h / 24);
  if (days < 7) return days + 'd ago';
  return fmtDateTime(ts);
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

function fmtClock(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function fmtLogLine(m) {
  return '[' + fmtClock(m.t) + '] ' + (m.line == null ? '' : m.line);
}

function debounce(fn, ms) {
  let t = null;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

/* ---------- storage ---------- */

function getUrl() {
  const u = localStorage.getItem(LS.url);
  return String(u || location.origin).replace(/\/+$/, '');
}
function setUrl(u) { localStorage.setItem(LS.url, String(u).replace(/\/+$/, '')); }
function getToken() { return localStorage.getItem(LS.token) || ''; }
function setToken(t) { localStorage.setItem(LS.token, t); }
function clearToken() { localStorage.removeItem(LS.token); }

function normalizeServerUrl(u) {
  u = String(u || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  return u.replace(/\/+$/, '');
}

/* ---------- api ---------- */

function apiUrl(path) {
  return getUrl() + (String(path).startsWith('/') ? '' : '/') + path;
}

function wsUrl() {
  try {
    const u = new URL(getUrl());
    u.protocol = (u.protocol === 'https:') ? 'wss:' : 'ws:';
    return u.toString().replace(/\/$/, '');
  } catch (e) {
    return '';
  }
}

/**
 * fetch wrapper: JSON, Bearer auth, 401 → back to connect (clear token),
 * other errors → {error:{code,message}} (+ optional toast).
 */
async function api(path, opts = {}) {
  const method = opts.method || 'GET';
  const doToast = opts.toast !== false;
  const headers = {};
  if (getToken()) headers['Authorization'] = 'Bearer ' + getToken();
  const init = { method, headers };
  if (opts.body !== undefined && opts.body !== null) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  let res;
  try {
    res = await fetch(apiUrl(path), init);
  } catch (err) {
    const e = { error: { code: 'network', message: 'Network error — hub unreachable' } };
    if (doToast) showToast(e.error.message, 'error');
    return e;
  }
  if (res.status === 401) {
    handleAuthFailure();
    return { error: { code: 'auth-required', message: 'Invalid token' } };
  }
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) {
    const err = (data && data.error) ? data.error
      : { code: 'http-' + res.status, message: 'Request failed (HTTP ' + res.status + ')' };
    if (doToast) showToast(err.message || ('HTTP ' + res.status), 'error');
    return { error: err };
  }
  return data;
}

/** Raw (binary) fetch with auth. Resolves to Blob or null on failure. */
async function rawFetch(path) {
  try {
    const res = await fetch(apiUrl(path), {
      headers: getToken() ? { Authorization: 'Bearer ' + getToken() } : {},
    });
    if (res.status === 401) { handleAuthFailure(); return null; }
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try {
        const d = await res.json();
        if (d && d.error && d.error.message) msg = d.error.message;
      } catch (e) { /* not JSON */ }
      showToast('File error: ' + msg, 'error');
      return null;
    }
    return await res.blob();
  } catch (err) {
    showToast('Network error — hub unreachable', 'error');
    return null;
  }
}

function handleAuthFailure() {
  clearToken();           // keep the server URL so the user can retry
  teardownWs();
  state.wsState = 'off';
  state.connectError = 'The server rejected this token (401). Check the token and try again.';
  showView('connect');
  showToast('Token rejected — disconnected', 'error');
}

/* ---------- toasts ---------- */

function showToast(message, kind) {
  const box = $('#toasts');
  if (!box) return;
  while (box.children.length >= 3) box.firstElementChild.remove();
  const t = document.createElement('div');
  t.className = 'toast' + (kind === 'error' ? ' error' : '');
  t.textContent = String(message);           // textContent: messages are never HTML
  box.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 250);
  }, 4000);
}

/* ============================================================
   WebSocket client (path /ws?token=…, events per SPEC)
   ============================================================ */

let ws = null;
let wsTimer = null;
let wsGen = 0;

function connectWS() {
  const token = getToken();
  if (!token) return;
  wsGen += 1;
  const gen = wsGen;
  if (ws) {
    try { ws.onclose = null; ws.onmessage = null; ws.onerror = null; ws.close(1000); } catch (e) { /* ignore */ }
    ws = null;
  }
  clearTimeout(wsTimer);           // reconnect timer cleared (re-armed only by onclose)
  wsTimer = null;
  if (state.view !== 'connect') setWsState('connecting');
  let sock;
  try {
    sock = new WebSocket(wsUrl() + '/ws?token=' + encodeURIComponent(token));
  } catch (err) {
    scheduleReconnect();
    return;
  }
  ws = sock;
  sock.onopen = () => {
    if (gen !== wsGen) { try { sock.close(); } catch (e) { /* ignore */ } return; }
    setWsState('connected');
  };
  sock.onmessage = (ev) => {
    if (gen !== wsGen) return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    handleWsMessage(msg);
  };
  sock.onclose = () => {
    if (gen !== wsGen) return;
    ws = null;
    if (getToken()) scheduleReconnect();
  };
  sock.onerror = () => { try { sock.close(); } catch (e) { /* ignore */ } };
}

function scheduleReconnect() {
  if (wsTimer || !getToken()) return;
  if (state.view !== 'connect') setWsState('connecting');
  wsTimer = setTimeout(() => { wsTimer = null; connectWS(); }, 2000);  // 2s backoff
}

function teardownWs() {
  wsGen += 1;
  clearTimeout(wsTimer);
  wsTimer = null;
  if (ws) {
    try { ws.onclose = null; ws.onmessage = null; ws.onerror = null; ws.close(1000); } catch (e) { /* ignore */ }
    ws = null;
  }
}

function setWsState(st) {
  state.wsState = st;
  updateWsChip();
}

function updateWsChip() {
  const label = state.wsState === 'connected' ? 'Live'
    : state.wsState === 'connecting' ? 'Reconnecting…' : 'Offline';
  $$('.ws-chip').forEach((chip) => {
    chip.hidden = !getToken();
    chip.dataset.st = state.wsState;
    const l = chip.querySelector('.ws-label');
    if (l) l.textContent = label;
  });
}

/* ---------- WS event application ---------- */

function handleWsMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'snapshot':
      state.machines = Array.isArray(msg.machines) ? msg.machines : [];
      state.sessions = Array.isArray(msg.sessions) ? msg.sessions : [];
      state.loaded = true;
      seedPreviews();
      renderCurrent();
      break;
    case 'machine':
      if (msg.machine && msg.machine.id) {
        upsertMachine(msg.machine);
        if (state.view === 'machines') renderMachines();
      }
      break;
    case 'session':
      if (msg.session && msg.session.id) {
        upsertSession(msg.session);
        if (state.view === 'sessions') renderSessions();
        else if (state.view === 'machines') renderMachines();
        else if (state.view === 'session' && state.sessionId === msg.session.id && state.detail) {
          renderDetailMeta();
          renderDetailInput();
        }
      }
      break;
    case 'output':
      if (msg.sessionId) handleOutput(msg);
      break;
    case 'sessionRemoved':
      if (msg.sessionId) handleRemoved(msg.sessionId);
      break;
    default:
      break; // ignore unknown event types
  }
}

function handleOutput(msg) {
  const s = findSession(msg.sessionId);
  if (s) {
    state.previews.set(msg.sessionId, msg.line);
    if (state.view === 'sessions') updateRowPreview(msg.sessionId, msg.line);
  }
  // live log: only when this session's detail view is open
  if (state.view === 'session' && state.sessionId === msg.sessionId && state.detail) {
    appendLogLine(msg);
  }
}

function handleRemoved(id) {
  const s = findSession(id);
  removeSessionLocal(id);
  if (state.view === 'session' && state.sessionId === id) {
    showToast('Session was deleted');
    showView('sessions', { sessionsMachineId: s ? s.machineId : state.sessionsMachineId });
  } else {
    renderCurrent();
  }
}

/* ---------- state helpers ---------- */

function findSession(id) {
  return state.sessions.find((s) => s.id === id) || null;
}
function findMachine(id) {
  return state.machines.find((m) => m.id === id) || null;
}
function machineConnected(id) {
  const m = findMachine(id);
  return !!m && m.status === 'connected';
}

function upsertMachine(m) {
  const i = state.machines.findIndex((x) => x.id === m.id);
  if (i >= 0) state.machines[i] = { ...state.machines[i], ...m };
  else state.machines.push(m);
}

function upsertSession(s) {
  const i = state.sessions.findIndex((x) => x.id === s.id);
  const prev = i >= 0 ? state.sessions[i] : null;
  const merged = {
    ...(prev || {}),
    ...s,
    lines: s.lines != null ? s.lines : (prev ? prev.lines : []),
  };
  if (i >= 0) state.sessions[i] = merged;
  else state.sessions.push(merged);
  if (merged.lines && merged.lines.length) {
    state.previews.set(s.id, merged.lines[merged.lines.length - 1].line);
  }
  return merged;
}

function removeSessionLocal(id) {
  state.sessions = state.sessions.filter((x) => x.id !== id);
  state.previews.delete(id);
}

function seedPreviews() {
  for (const s of state.sessions) {
    if (s.lines && s.lines.length) state.previews.set(s.id, s.lines[s.lines.length - 1].line);
  }
}

function lastLineOf(s) {
  const l = s.lines;
  return (l && l.length) ? String(l[l.length - 1].line || '') : '';
}

const STATUS_META = {
  running: { label: 'running', cls: 'st-running' },
  pending: { label: 'pending', cls: 'st-pending' },
  stopping: { label: 'stopping', cls: 'st-stopping' },
  disconnected: { label: 'disconnected', cls: 'st-off' },
  idle: { label: 'idle', cls: 'st-off' },        // v1.1 watched: amber, same as disconnected
  ended: { label: 'ended', cls: 'st-ended' },
  stopped: { label: 'stopped', cls: 'st-ended' },
  error: { label: 'error', cls: 'st-error' },
};

function statusChip(status) {
  const m = STATUS_META[status] || { label: status || 'unknown', cls: 'st-ended' };
  return '<span class="chip st ' + m.cls + '"><span class="dot"></span>' + esc(m.label) + '</span>';
}

function statusRelText(s) {
  if (s.status === 'running' || s.status === 'pending' || s.status === 'stopping') {
    return 'started ' + fmtRel(s.startedAt || s.createdAt);
  }
  if (s.status === 'ended' || s.status === 'stopped' || s.status === 'error') {
    return 'ended ' + fmtRel(s.endedAt || s.createdAt);
  }
  if (s.status === 'disconnected') return 'created ' + fmtRel(s.createdAt);
  if (s.status === 'idle') return 'idle · created ' + fmtRel(s.createdAt);  // v1.1 watched
  return fmtRel(s.createdAt);
}

/* ============================================================
   View switching
   ============================================================ */

function showView(name, params = {}, opts = {}) {
  const push = opts.push !== false;
  state.view = name;
  if (name === 'session') {
    state.sessionId = params.sessionId;
    state.detail = null;               // force a fresh history load
    if (params.sessionsMachineId !== undefined) state.sessionsMachineId = params.sessionsMachineId;
  }
  if (name === 'sessions' && params.sessionsMachineId !== undefined) {
    state.sessionsMachineId = params.sessionsMachineId;
  }
  if (name === 'new-session' && params.newMachineId !== undefined) {
    state.newMachineId = params.newMachineId;
  }
  if (name === 'new-session' && params.resume !== undefined) {
    state.resume = params.resume;
  }
  if (push) {
    try { history.pushState({ view: name, params }, ''); } catch (e) { /* ignore */ }
  }
  renderCurrent();
  window.scrollTo(0, 0);
}

function renderCurrent() {
  // Activate exactly the view section matching the current state (CSS hides
  // all `section[data-view]` by default, so this is what makes pages visible).
  $$('section[data-view]').forEach((s) => s.classList.toggle('active', s.dataset.view === state.view));
  switch (state.view) {
    case 'connect': renderConnect(); break;
    case 'machines': renderMachines(); break;
    case 'sessions': renderSessions(); break;
    case 'session':
      if (!state.detail || state.detail.sessionId !== state.sessionId) renderSessionDetail();
      else { renderDetailMeta(); renderDetailInput(); }
      break;
    case 'new-session': renderNewSession(); break;
    case 'files': renderFiles(); break;
    case 'settings': renderSettings(); break;
    default: break;
  }
  updateTabbar();
  updateWsChip();
}

function updateTabbar() {
  const bar = $('#tabbar');
  if (!bar) return;
  const visible = !!getToken() &&
    (state.view === 'machines' || state.view === 'sessions' || state.view === 'settings');
  bar.hidden = !visible;
  $$('#tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  document.body.classList.toggle('tabbar-visible', visible);
}

/* ============================================================
   CONNECT view
   ============================================================ */

function renderConnect() {
  const urlEl = $('#connect-url');
  if (urlEl) urlEl.value = localStorage.getItem(LS.url) || location.origin;
  const tokEl = $('#connect-token');
  if (tokEl) tokEl.value = getToken();
  const err = $('#connect-error');
  if (err) {
    if (state.connectError) { err.textContent = state.connectError; err.hidden = false; }
    else err.hidden = true;
  }
}

async function submitConnect(e) {
  e.preventDefault();
  const btn = $('#connect-submit');
  const errEl = $('#connect-error');
  const url = normalizeServerUrl($('#connect-url').value || location.origin);
  const token = $('#connect-token').value.trim();
  if (!url) {
    errEl.textContent = 'Enter a valid server URL (e.g. http://192.168.1.50:8742).';
    errEl.hidden = false;
    return;
  }
  if (!token) {
    errEl.textContent = 'Enter the hub token (it is printed when the hub starts).';
    errEl.hidden = false;
    return;
  }
  btn.disabled = true;
  const oldLabel = btn.textContent;
  btn.textContent = 'Connecting…';
  errEl.hidden = true;
  setUrl(url);
  setToken(token);

  // 1) Health probe with the Authorization header (health itself is auth-exempt per SPEC).
  let healthRes = null;
  try {
    healthRes = await fetch(url + '/api/health', { headers: { Authorization: 'Bearer ' + token } });
  } catch (err) {
    btn.disabled = false; btn.textContent = oldLabel;
    state.connectError = 'Could not reach the hub at ' + url + '. Check the address and that the server is running.';
    renderConnect();
    return;
  }
  if (healthRes.status === 401) {
    clearToken();
    btn.disabled = false; btn.textContent = oldLabel;
    state.connectError = 'The server rejected this token (401). Check the token and try again.';
    renderConnect();
    return;
  }
  if (!healthRes.ok) {
    btn.disabled = false; btn.textContent = oldLabel;
    state.connectError = 'The hub at ' + url + ' answered HTTP ' + healthRes.status + '.';
    renderConnect();
    return;
  }
  try { state.health = await healthRes.json(); } catch (e) { state.health = null; }

  // 2) Health is auth-exempt, so verify the token by loading state.
  const st = await api('/api/state', { toast: false });
  btn.disabled = false;
  btn.textContent = oldLabel;
  if (st.error) {
    if (st.error.code === 'auth-required') {
      state.connectError = 'The server rejected this token (401). Check the token and try again.';
      renderConnect();
      return;
    }
    state.connectError = 'Connected, but could not load state: ' + (st.error.message || st.error.code) + '.';
    renderConnect();
    return;
  }
  state.connectError = '';
  state.machines = st.machines || [];
  state.sessions = st.sessions || [];
  state.loaded = true;
  seedPreviews();
  showView('machines');
  connectWS();
  loadTemplates({ quiet: true });
  fetchHealth();
}

/* ============================================================
   MACHINES view
   ============================================================ */

function renderMachines() {
  const list = $('#machines-list');
  if (!list) return;
  if (!state.loaded && !state.machines.length) {
    list.innerHTML = '<div class="empty"><span class="spin big"></span><br>Loading…</div>';
    return;
  }
  if (!state.machines.length) {
    list.innerHTML = '<div class="empty"><div class="big">🖥️</div>No machines yet.<br>' +
      '<span class="small">Start an agent on a machine — it will appear here.</span><br>' +
      '<button class="btn ghost" data-action="refresh-state">Refresh</button></div>';
    return;
  }
  list.innerHTML = state.machines.map((m) => {
    const on = m.status === 'connected';
    const running = typeof m.running === 'number' ? m.running : 0;
    return '<article class="card machine-card">' +
      '<div class="machine-title">' +
      '<span class="dot ' + (on ? 'dot-on' : 'dot-off') + '"></span>' +
      '<h2>' + esc(m.name || m.id) + '</h2>' +
      (m.local ? '<span class="tag">local</span>' : '') +
      '</div>' +
      '<div class="machine-sub muted">' + esc(m.host || '') + ' · ' + esc(m.os || '') +
      (m.arch ? ' · ' + esc(m.arch) : '') + '</div>' +
      '<div class="machine-meta">' +
      '<span class="muted">last seen ' + esc(fmtRel(m.lastSeenAt)) + '</span>' +
      '<span class="run-badge">' + running + ' running</span>' +
      '</div>' +
      '<div class="machine-actions">' +
      '<button class="btn ghost" data-action="machine-sessions" data-id="' + esc(m.id) + '" ' + (on ? '' : 'disabled') + '>Sessions</button>' +
      '<button class="btn ghost" data-action="machine-files" data-id="' + esc(m.id) + '" ' + (on ? '' : 'disabled') + '>Files</button>' +
      '<button class="btn" data-action="new-session" data-id="' + esc(m.id) + '" ' + (on ? '' : 'disabled') + '>New Session</button>' +
      '</div></article>';
  }).join('');
}

/* ============================================================
   SESSIONS view
   ============================================================ */

function renderSessions() {
  const mid = state.sessionsMachineId;
  const machine = findMachine(mid);
  const title = $('#sessions-title');
  if (title) title.textContent = machine ? (machine.name + ' — Sessions') : 'Sessions';
  const topBtn = $('#ns-top');
  if (topBtn) {
    if (mid) topBtn.dataset.id = mid;
    else delete topBtn.dataset.id;
    topBtn.disabled = !machine || machine.status !== 'connected';
  }
  const list = $('#sessions-list');
  if (!list) return;
  if (!machine) {
    list.innerHTML = '<div class="empty">Machine not found.</div>';
    return;
  }
  const sessions = state.sessions
    .filter((s) => s.machineId === mid)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));   // newest first
  if (!sessions.length) {
    list.innerHTML = '<div class="empty"><div class="big">🧪</div>No sessions yet — create one.</div>';
    return;
  }
  list.innerHTML = sessions.map((s) => {
    const preview = state.previews.get(s.id) || lastLineOf(s);
    return '<article class="card session-row" data-action="open-session" data-id="' + esc(s.id) + '">' +
      '<div class="row1">' +
      '<span class="row-label">' + esc(s.label || s.template || s.id) + '</span>' +
      (s.type === 'watched' ? '<span class="badge-watch">👁 watched</span>' : '') +
      statusChip(s.status) +
      '</div>' +
      '<div class="row2">' + esc(s.template || '') +
      (s.workspace ? '<span class="sep">·</span>' + esc(s.workspace) : '') + '</div>' +
      '<div class="row3">' +
      '<span class="rel muted">' + esc(statusRelText(s)) + '</span>' +
      (preview ? '<span class="preview" data-preview-id="' + esc(s.id) + '">' + esc(preview) + '</span>' : '') +
      '</div></article>';
  }).join('');
}

function updateRowPreview(id, line) {
  let sel = id;
  try { sel = (window.CSS && CSS.escape) ? CSS.escape(id) : id.replace(/"/g, '\\"'); } catch (e) { /* keep raw */ }
  const el = document.querySelector('[data-preview-id="' + sel + '"]');
  if (el) el.textContent = line;
}

/* ============================================================
   SESSION DETAIL view
   ============================================================ */

async function renderSessionDetail() {
  const id = state.sessionId;
  const s = findSession(id);
  const el = $('#view-session');
  if (!el) return;
  if (!s) {
    el.innerHTML = '<div class="empty">Session not found.</div>';
    return;
  }
  state.detail = {
    sessionId: id,
    loading: true,
    maxT: 0,          // highest log timestamp already rendered (dedupe)
    pinned: true,     // auto-scroll to bottom
    newCount: 0,      // unread lines while scrolled up
    textNodes: [],    // one text node per line, for cheap trimming at cap
    pending: [],      // output events arriving while history loads
  };
  el.innerHTML =
    '<header class="view-head">' +
    '<div class="head-row">' +
    '<button class="btn ghost sm" data-action="nav" data-view="sessions" data-machine-id="' + esc(s.machineId || '') + '" aria-label="Back">←</button>' +
    '<div class="head-title grow">' +
    '<h1 id="detail-title">' + esc(s.label || s.template || 'Session') + '</h1>' +
    '<div id="detail-sub" class="muted small"></div>' +
    '</div>' +
    '</div>' +
    '</header>' +
    '<div id="detail-meta" class="detail-meta"></div>' +
    '<div class="log-wrap">' +
    '<div id="log-loading" class="log-loading muted small">Loading history…</div>' +
    '<pre id="log-pre" tabindex="0"></pre>' +
    '<button id="log-pin" class="new-chip" hidden>0 new ↓</button>' +
    '</div>' +
    '<div id="detail-input"></div>';

  const pre = $('#log-pre');
  pre.addEventListener('scroll', onLogScroll);
  $('#log-pin').addEventListener('click', pinToBottom);

  renderDetailMeta();
  renderDetailInput();

  const data = await api('/api/sessions/' + encodeURIComponent(id), { toast: true });
  if (state.view !== 'session' || state.sessionId !== id) return;   // navigated away
  const d = state.detail;
  if (!d || d.sessionId !== id) return;
  d.loading = false;
  const loadingEl = $('#log-loading');
  if (loadingEl) loadingEl.remove();
  if (data.error) {
    const p = $('#log-pre');
    if (p) p.textContent = 'Could not load history: ' + (data.error.message || data.error.code || 'unknown error');
    return;
  }
  upsertSession(data);
  const lines = Array.isArray(data.lines) ? data.lines : [];
  for (const ln of lines) {
    appendLogLine({ sessionId: id, t: ln.t, stream: ln.stream, line: ln.line });
  }
  // flush output events that streamed in while history was loading
  const pending = d.pending;
  d.pending = [];
  for (const m of pending) appendLogLine(m);
  renderDetailMeta();
  renderDetailInput();
}

function renderDetailMeta() {
  const id = state.sessionId;
  const s = findSession(id);
  const meta = $('#detail-meta');
  if (!meta || !s) return;
  const machine = findMachine(s.machineId);
  const title = $('#detail-title');
  if (title) title.textContent = s.label || s.template || 'Session';
  const sub = $('#detail-sub');
  if (sub) sub.textContent = statusRelText(s);
  const exitText = (s.status === 'ended' && s.exitCode != null)
    ? '<span class="muted">exit ' + esc(s.exitCode) + '</span>' : '';
  meta.innerHTML =
    '<div class="meta-grid">' +
    '<div class="meta-item"><span class="muted">Machine</span>' +
    '<button class="link" data-action="machine-sessions" data-id="' + esc(s.machineId) + '">' +
    esc(machine ? machine.name : s.machineId) + '</button></div>' +
    '<div class="meta-item"><span class="muted">Workspace</span>' +
    '<button class="link" data-action="open-workspace" data-id="' + esc(s.machineId) + '" data-path="' + esc(s.workspace || '') + '">' +
    esc(s.workspace || '—') + '</button></div>' +
    '<div class="meta-item"><span class="muted">Template</span><span>' + esc(s.template || '—') + '</span></div>' +
    '<div class="meta-item"><span class="muted">Status</span><span class="row-inline">' + statusChip(s.status) + exitText + '</span></div>' +
    '</div>' +
    (s.command ? '<div class="cmd-line"><code>' + esc(s.command) + '</code></div>' : '') +
    (s.status === 'error' && s.error ? '<div class="form-error">' + esc(s.error) + '</div>' : '') +
    '<div class="actions-row">' +
    ((s.status === 'running' || s.status === 'stopping') && s.type !== 'watched'
      ? '<button class="btn ghost" data-action="session-stop" data-id="' + esc(s.id) + '">■ Stop</button>'
      : '') +
    (s.externalId && !['running', 'stopping', 'pending', 'disconnected'].includes(s.status)
      ? '<button class="btn primary ghost" data-action="dsh-continue" data-id="' + esc(s.id) + '">↻ Continue</button>'
      : '') +
    '<button class="btn danger ghost" data-action="session-delete" data-id="' + esc(s.id) + '">🗑 Delete</button>' +
    '</div>';
}

function sessionInputHint(s) {
  if (s.type === 'watched') {
    // v1.1: read-only monitoring of VSCode/Codex sessions
    return 'Watched VSCode/Codex session — read-only monitoring. Create a session from this workspace to control an agent from your phone.';
  }
  if (s.type === 'oneshot') return 'One-shot session — create a new session to run another prompt.';
  if (s.status === 'disconnected') return 'Session disconnected — input is unavailable.';
  return 'Session ended.';
}

function renderDetailInput() {
  const s = findSession(state.sessionId);
  const wrap = $('#detail-input');
  if (!wrap || !s) return;
  const showBar = s.type === 'interactive' && (s.status === 'running' || s.status === 'stopping');
  const currentTa = $('#prompt-input');
  if (showBar && currentTa) return;      // already the right shape — never rebuild while typing
  if (!showBar && !currentTa) {
    // hint-only state: just refresh the text if it changed
    const hint = sessionInputHint(s);
    const el = wrap.querySelector('.hint');
    if (el && el.textContent !== hint) el.textContent = hint;
    return;
  }
  const ta = currentTa;
  const prevVal = ta ? ta.value : '';
  const prevFocused = ta && document.activeElement === ta;
  if (showBar) {
    wrap.innerHTML =
      '<div class="input-bar">' +
      '<textarea id="prompt-input" rows="1" placeholder="Send a prompt…" enterkeyhint="send"></textarea>' +
      '<button id="send-btn" class="btn primary send-btn">Send</button>' +
      '</div>';
    const nta = $('#prompt-input');
    nta.addEventListener('input', () => autoGrow(nta));
    nta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendPrompt(); }
    });
    $('#send-btn').addEventListener('click', sendPrompt);
    if (prevVal || prevFocused) {
      nta.value = prevVal;
      autoGrow(nta);
      if (prevFocused) nta.focus();
    }
  } else {
    wrap.innerHTML = '<div class="hint">' + esc(sessionInputHint(s)) + '</div>';
  }
}

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 132) + 'px';
}

async function sendPrompt() {
  const ta = $('#prompt-input');
  if (!ta) return;
  const text = ta.value.trim();
  if (!text) return;
  const btn = $('#send-btn');
  if (btn) btn.disabled = true;
  const res = await api('/api/sessions/' + encodeURIComponent(state.sessionId) + '/prompt', {
    method: 'POST',
    body: { text },
  });
  if (btn) btn.disabled = false;
  if (!res.error) {
    const t2 = $('#prompt-input');
    if (t2) { t2.value = ''; autoGrow(t2); t2.focus(); }
  }
  // errors (e.g. 409 not-interactive / not-running) are toasted by api() with the server message
}

/* --- live log (incremental, never rebuilt while streaming) --- */

function appendLogLine(msg) {
  const d = state.detail;
  if (!d || d.sessionId !== msg.sessionId) return;
  if (d.loading) { d.pending.push(msg); return; }
  if (msg.t != null && msg.t <= d.maxT) return;      // already in history
  const pre = $('#log-pre');
  if (!pre) return;
  d.maxT = (msg.t != null) ? Math.max(d.maxT, msg.t) : d.maxT + 1;
  const node = document.createTextNode(fmtLogLine(msg) + '\n');
  pre.appendChild(node);
  d.textNodes.push(node);
  if (d.textNodes.length > LOG_CAP_LINES) {           // keep ≤2000 in-memory lines
    const drop = d.textNodes.length - LOG_CAP_LINES;
    for (let i = 0; i < drop; i++) { if (d.textNodes[i]) d.textNodes[i].remove(); }
    d.textNodes.splice(0, drop);
  }
  if (d.pinned) {
    pre.scrollTop = pre.scrollHeight;
  } else {
    d.newCount += 1;
    updatePinChip();
  }
}

function onLogScroll(e) {
  const pre = e.currentTarget;
  const d = state.detail;
  if (!d) return;
  const pinned = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 32;
  d.pinned = pinned;
  if (pinned && d.newCount) { d.newCount = 0; updatePinChip(); }
}

function updatePinChip() {
  const d = state.detail;
  const chip = $('#log-pin');
  if (!chip) return;
  if (d && !d.pinned && d.newCount > 0) {
    chip.hidden = false;
    chip.textContent = d.newCount + ' new ↓';
  } else {
    chip.hidden = true;
  }
}

function pinToBottom() {
  const d = state.detail;
  const pre = $('#log-pre');
  if (!d || !pre) return;
  d.pinned = true;
  d.newCount = 0;
  updatePinChip();
  pre.scrollTop = pre.scrollHeight;
}

/* ---------- detail actions ---------- */

async function stopSession(id) {
  const res = await api('/api/sessions/' + encodeURIComponent(id) + '/stop', { method: 'POST' });
  if (!res.error) {
    const s = findSession(id);
    if (s) {
      s.status = 'stopping';      // optimistic; WS 'session' event confirms
      if (state.view === 'session' && state.sessionId === id) { renderDetailMeta(); renderDetailInput(); }
    }
  }
}

async function deleteSession(id) {
  const s = findSession(id);
  if (!s) return;
  const watched = s.type === 'watched';              // v1.1: server removes watched without force
  const running = !watched && (s.status === 'running' || s.status === 'stopping');
  const label = s.label || s.template || id;
  const ok = window.confirm('Delete session "' + label + '"?' +
    (running ? '\nIt is still running and will be stopped first.' : ''));
  if (!ok) return;
  const res = await api('/api/sessions/' + encodeURIComponent(id) + (running ? '?force=1' : ''), {
    method: 'DELETE',
  });
  if (res.error) return;
  removeSessionLocal(id);
  if (state.view === 'session' && state.sessionId === id) {
    showView('sessions', { sessionsMachineId: s.machineId });
  } else {
    renderCurrent();
  }
}

/* ============================================================
   NEW SESSION view
   ============================================================ */

function currentTemplate() {
  const sel = $('#ns-template');
  if (!sel) return null;
  return state.templates.find((t) => t.name === sel.value) || null;
}

function renderNewSession() {
  const backBtn = $('#ns-back');
  if (backBtn) {
    if (state.sessionsMachineId) {
      backBtn.dataset.view = 'sessions';
      backBtn.dataset.machineId = state.sessionsMachineId;
    } else {
      backBtn.dataset.view = 'machines';
      delete backBtn.dataset.machineId;
    }
  }
  const connected = state.machines.filter((m) => m.status === 'connected');
  // keep the chosen machine when it is still connected
  if (state.resume && state.resume.machineId && connected.some((m) => m.id === state.resume.machineId)) {
    state.newMachineId = state.resume.machineId;
  } else if (!state.newMachineId || !connected.some((m) => m.id === state.newMachineId)) {
    state.newMachineId = connected.length ? connected[0].id : '';
  }
  const msel = $('#ns-machine');
  if (msel) {
    msel.innerHTML = connected.length
      ? connected.map((m) =>
        '<option value="' + esc(m.id) + '"' + (m.id === state.newMachineId ? ' selected' : '') + '>' +
        esc(m.name) + (m.host ? ' · ' + esc(m.host) : '') + '</option>').join('')
      : '<option value="">— no connected machines —</option>';
  }
  if (!state.templates.length) loadTemplates({ quiet: true });
  const tsel = $('#ns-template');
  if (tsel) {
    const prev = tsel.value;
    tsel.innerHTML = state.templates.length
      ? state.templates.map((t) =>
        '<option value="' + esc(t.name) + '"' + (t.name === prev ? ' selected' : '') + '>' +
        esc(t.name) + '</option>').join('')
      : '<option value="">— no templates —</option>';
    if (state.resume && state.resume.template && state.templates.some((t) => t.name === state.resume.template)) {
      tsel.value = state.resume.template;
    }
  }
  if (state.resume && state.resume.workspace) {
    const ws = $('#ns-workspace');
    if (ws) { ws.value = state.resume.workspace; ws.classList.remove('invalid'); }
  }
  const chip = $('#ns-resume');
  if (chip) {
    if (state.resume && state.resume.sessionId) {
      chip.hidden = false;
      const txt = $('#ns-resume-text');
      if (txt) txt.textContent = 'Continuing: ' + state.resume.sessionId;
    } else {
      chip.hidden = true;
    }
  }
  const submit = $('#ns-submit');
  if (submit) submit.disabled = !connected.length || !state.templates.length;
  updatePromptHints();
}

function updatePromptHints() {
  const tpl = currentTemplate();
  const desc = $('#ns-template-desc');
  if (desc) desc.textContent = tpl ? (tpl.description || '') : '';
  const lbl = $('#ns-prompt-label');
  const hint = $('#ns-hint');
  const ph = $('#ns-prompt');
  if (ph) {
    if (!tpl) ph.placeholder = 'What should the agent do?';
    else if (tpl.name === 'shell') ph.placeholder = 'Shell command — e.g. dir, git status, npm test (runs as a command, not AI chat)';
    else if (tpl.name === 'dsh') ph.placeholder = 'Ask anything — runs a DSH AI dialogue in the workspace';
    else if (tpl.name === 'codex-exec') ph.placeholder = 'Your task for Codex, e.g. "fix the login bug"';
    else if (tpl.name === 'claude-stream') ph.placeholder = 'Your message to Claude';
    else if (tpl.type === 'interactive') ph.placeholder = 'First prompt (optional)';
    else ph.placeholder = 'Task or command (see template description)';
  }
  if (lbl && hint) {
    if (tpl && tpl.name === 'shell') {
      lbl.textContent = 'Prompt (required)';
      hint.textContent = '⚠️ Runs your prompt as a SHELL COMMAND, not AI chat. For an AI dialogue use the dsh (or codex) template.';
    } else if (tpl && tpl.name === 'dsh') {
      lbl.textContent = 'Prompt (required)';
      hint.textContent = 'Runs one DSH headless AI dialogue — watch reasoning/tools live, then Continue from its detail page to keep chatting.';
    } else if (tpl && tpl.type === 'interactive') {
      lbl.textContent = 'Prompt (optional)';
      hint.textContent = 'Sent as the first prompt line to the interactive session.';
    } else if (tpl && tpl.type === 'oneshot') {
      lbl.textContent = 'Prompt (required)';
      hint.textContent = 'Required for one-shot templates.';
    } else {
      lbl.textContent = 'Prompt';
      hint.textContent = '';
    }
  }
}

async function submitNewSession(e) {
  e.preventDefault();
  const machineId = $('#ns-machine').value;
  const workspace = $('#ns-workspace').value.trim();
  const template = $('#ns-template').value;
  const label = $('#ns-label').value.trim();
  const prompt = $('#ns-prompt').value;
  const tpl = state.templates.find((t) => t.name === template) || null;
  let ok = true;
  const bad = (sel, cond) => {
    const el = $(sel);
    if (el && cond) { el.classList.add('invalid'); ok = false; }
  };
  bad('#ns-machine', !machineId || !machineConnected(machineId));
  bad('#ns-workspace', !workspace);
  bad('#ns-template', !template);
  bad('#ns-prompt', tpl && tpl.type === 'oneshot' && !prompt.trim());
  if (!ok) {
    if (!machineId || !machineConnected(machineId)) showToast('Choose a connected machine', 'error');
    else if (!workspace) showToast('Workspace is required', 'error');
    else if (!template) showToast('Choose a template', 'error');
    else showToast('One-shot templates require a prompt', 'error');
    return;
  }
  const btn = $('#ns-submit');
  const oldLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Creating…';
  const body = { machineId, workspace, template };
  if (prompt.trim()) body.prompt = prompt;
  if (label) body.label = label;
  if (state.resume && state.resume.sessionId) body.resumeId = state.resume.sessionId;
  const res = await api('/api/sessions', { method: 'POST', body });
  btn.disabled = false;
  btn.textContent = oldLabel;
  if (res.error) return;                 // api() toasted the server message
  state.resume = null;
  upsertSession(res);
  showView('session', { sessionId: res.id, sessionsMachineId: res.machineId });
}

/* ============================================================
   FOLDER PICKER modal (reuses the fs listing)
   ============================================================ */

function openPicker() {
  const msel = $('#ns-machine');
  const mid = (msel && msel.value) ||
    ((state.machines.find((m) => m.status === 'connected')) || {}).id || '';
  if (!mid) {
    showToast('No connected machines to browse', 'error');
    return;
  }
  state.picker = { machineId: mid, roots: [], root: null, path: null, entries: null, loading: false, error: null, mkdirOpen: false };
  $('#picker').hidden = false;
  pushOverlay();
  renderPicker();
  pickerLoadMachine(mid);
}

function closePicker() {
  $('#picker').hidden = true;
  state.picker = null;
}

/** Push a history entry so Android's back button closes overlays instead of leaving the app. */
function pushOverlay() {
  if (state.overlayOpen) return;
  state.overlayOpen = true;
  try { history.pushState({ overlay: true }, ''); } catch (e) { /* ignore */ }
}

/** Close an overlay; pops the overlay history entry when one exists. */
function closeOverlay(kind) {
  if (state.overlayOpen) {
    state.overlayOpen = false;
    try { history.back(); } catch (e) { if (kind === 'preview') closePreview(); else closePicker(); }
  } else {
    if (kind === 'preview') closePreview();
    else closePicker();
  }
}

async function pickerLoadMachine(mid) {
  const p = state.picker;
  if (!p) return;
  p.machineId = mid;
  p.loading = true;
  p.error = null;
  p.mkdirOpen = false;
  p.roots = []; p.root = null; p.path = null; p.entries = null;
  renderPicker();
  const res = await api('/api/machines/' + encodeURIComponent(mid) + '/roots');
  if (!state.picker || state.picker.machineId !== mid) return;
  p.loading = false;
  if (res.error) { p.error = res.error.message; renderPicker(); return; }
  p.roots = res.roots || [];
  if (!p.roots.length) { p.error = 'No accessible folders configured for this machine.'; renderPicker(); return; }
  p.root = p.roots[0];
  renderPicker();
  pickerLoadDir(mid, p.root);
}

async function pickerLoadDir(mid, path) {
  const p = state.picker;
  if (!p || p.machineId !== mid) return;
  p.loading = true;
  p.error = null;
  p.mkdirOpen = false;
  p.path = path;
  renderPicker();
  const res = await api('/api/machines/' + encodeURIComponent(mid) + '/fs?path=' + encodeURIComponent(path));
  if (!state.picker || state.picker.machineId !== mid) return;
  p.loading = false;
  if (res.error) { p.error = res.error.message; renderPicker(); return; }
  p.path = res.path;
  p.root = res.root;
  p.entries = res.entries || [];
  renderPicker();
}

function choosePickerFolder() {
  const p = state.picker;
  const ws = $('#ns-workspace');
  if (p && ws && p.path) {
    ws.value = p.path;
    ws.classList.remove('invalid');
  }
}

/** Create a folder inside the currently browsed picker directory. */
async function createPickerFolder() {
  const p = state.picker;
  if (!p || !p.path) return;
  const inp = $('#picker-mkdir-name');
  const name = inp ? inp.value.trim() : '';
  if (!name) { showToast('Enter a folder name', 'error'); return; }
  if (/[\\/]/.test(name) || name === '.' || name === '..') {
    showToast('Invalid folder name', 'error');
    return;
  }
  const full = p.path.replace(/[\\/]+$/, '') + '/' + name;
  const res = await api('/api/machines/' + encodeURIComponent(p.machineId) + '/fs/mkdir', {
    method: 'POST', body: { path: full }
  });
  if (res.error) {
    showToast('Create failed: ' + (res.error.message || 'error'), 'error');
    return;
  }
  p.mkdirOpen = false;
  showToast('Folder created', 'ok');
  pickerLoadDir(p.machineId, (res && res.path) || full);
}

function renderPicker() {
  const p = state.picker;
  if (!p) return;
  const connected = state.machines.filter((m) => m.status === 'connected');
  const msel = $('#picker-machine');
  msel.innerHTML = connected.length
    ? connected.map((m) =>
      '<option value="' + esc(m.id) + '"' + (m.id === p.machineId ? ' selected' : '') + '>' +
      esc(m.name) + '</option>').join('')
    : '<option value="">— no connected machines —</option>';
  const rootsEl = $('#picker-roots');
  rootsEl.hidden = !(p.roots && p.roots.length > 1);
  if (!rootsEl.hidden) {
    rootsEl.innerHTML = p.roots.map((r) =>
      '<button class="seg' + (r === p.root ? ' active' : '') + '" data-action="picker-root" data-path="' + esc(r) + '">' +
      esc(rootLabel(r)) + '</button>').join('');
  }
  $('#picker-crumbs').innerHTML = p.path ? crumbsHTML(p.path, 'picker') : '';
  const mkdirRow = $('#picker-mkdir');
  if (mkdirRow) mkdirRow.hidden = !p.mkdirOpen;
  const list = $('#picker-list');
  if (p.loading) list.innerHTML = '<div class="empty"><span class="spin big"></span></div>';
  else if (p.error) list.innerHTML = '<div class="empty">⚠️ ' + esc(p.error) + '</div>';
  else if (!p.entries) list.innerHTML = '';
  else if (!p.entries.length) list.innerHTML = '<div class="empty">📂 Empty folder</div>';
  else list.innerHTML = p.entries.map((en) => entryRowHTML(en, 'picker')).join('');
  const crumbs = $('#picker-crumbs');
  if (crumbs) crumbs.scrollLeft = crumbs.scrollWidth;
}

/* ============================================================
   FILES view (shared listing helpers with the picker)
   ============================================================ */

function openFiles(machineId) {
  const mid = machineId || localStorage.getItem(LS.filesMachine) ||
    ((state.machines.find((m) => m.status === 'connected')) || state.machines[0] || {}).id || '';
  localStorage.setItem(LS.filesMachine, mid);
  state.files = emptyFilesState();
  state.files.machineId = mid;
  state.files.returnTo = { view: 'machines' };
  showView('files');
  loadRoots();
}

function openFilesAt(machineId, path) {
  const mid = machineId || ((state.machines[0] || {}).id || '');
  localStorage.setItem(LS.filesMachine, mid);
  state.files = emptyFilesState();
  state.files.machineId = mid;
  state.files.returnTo = { view: 'session', sessionId: state.sessionId, sessionsMachineId: state.sessionsMachineId };
  showView('files');
  loadDir(mid, path, { fallbackToRoot: true });
}

async function loadRoots() {
  const f = state.files;
  if (!f.machineId) return;
  f.loading = true;
  f.error = null;
  renderFiles();
  const res = await api('/api/machines/' + encodeURIComponent(f.machineId) + '/roots');
  if (state.view !== 'files' || f !== state.files) return;
  f.loading = false;
  if (res.error) { f.error = res.error.message; renderFiles(); return; }
  f.roots = res.roots || [];
  if (!f.roots.length) { f.error = 'No accessible folders configured for this machine.'; renderFiles(); return; }
  const saved = localStorage.getItem(LS.fsRoot + f.machineId);
  f.root = (saved && f.roots.includes(saved)) ? saved : f.roots[0];
  renderFiles();
  loadDir(f.machineId, f.root);
}

async function loadDir(mid, path, opts = {}) {
  const f = state.files;
  if (mid !== f.machineId) return;
  f.loading = true;
  f.error = null;
  f.path = path;
  renderFiles();
  const res = await api('/api/machines/' + encodeURIComponent(mid) + '/fs?path=' + encodeURIComponent(path));
  if (state.view !== 'files' || mid !== state.files.machineId || f !== state.files) return;
  f.loading = false;
  if (res.error) {
    if (opts.fallbackToRoot) { loadRoots(); return; }
    f.error = res.error.message;
    renderFiles();
    return;
  }
  f.path = res.path;
  f.root = res.root;
  f.entries = res.entries || [];
  if (f.root && f.roots.includes(f.root)) localStorage.setItem(LS.fsRoot + mid, f.root);
  renderFiles();
}

function renderFiles() {
  const f = state.files;
  if (!f.machineId) {
    // e.g. restored via browser back with no file state — pick a machine and load
    f.machineId = localStorage.getItem(LS.filesMachine) ||
      ((state.machines.find((m) => m.status === 'connected')) || state.machines[0] || {}).id || '';
    if (f.machineId) loadRoots();
  }
  const back = $('#files-back');
  if (back) {
    if (f.returnTo && f.returnTo.view === 'session') {
      back.dataset.view = 'session';
      back.dataset.id = f.returnTo.sessionId || '';
      back.dataset.machineId = f.returnTo.sessionsMachineId || '';
    } else {
      back.dataset.view = 'machines';
      delete back.dataset.id;
      delete back.dataset.machineId;
    }
  }
  const msel = $('#fs-machine');
  if (msel) {
    msel.innerHTML = state.machines.map((m) =>
      '<option value="' + esc(m.id) + '"' + (m.id === f.machineId ? ' selected' : '') +
      (m.status !== 'connected' ? ' disabled' : '') + '>' +
      esc(m.name) + (m.status !== 'connected' ? ' (offline)' : '') + '</option>').join('');
  }
  if (!state.machines.length) {
    $('#fs-roots').hidden = true;
    $('#fs-crumbs').innerHTML = '';
    $('#fs-list').innerHTML = '<div class="empty">No machines — start an agent first.</div>';
    return;
  }
  const rootsEl = $('#fs-roots');
  rootsEl.hidden = !(f.roots && f.roots.length > 1);
  if (!rootsEl.hidden) {
    rootsEl.innerHTML = f.roots.map((r) =>
      '<button class="seg' + (r === f.root ? ' active' : '') + '" data-action="fs-root" data-path="' + esc(r) + '">' +
      esc(rootLabel(r)) + '</button>').join('');
  }
  const crumbsEl = $('#fs-crumbs');
  crumbsEl.innerHTML = f.path ? crumbsHTML(f.path, 'fs') : '';
  const list = $('#fs-list');
  if (f.loading) {
    list.innerHTML = '<div class="empty"><span class="spin big"></span><br>Loading…</div>';
  } else if (f.error) {
    list.innerHTML = '<div class="empty">⚠️ ' + esc(f.error) +
      '<br><button class="btn ghost" data-action="fs-retry">Retry</button></div>';
  } else if (!f.entries) {
    list.innerHTML = '<div class="empty"><span class="spin big"></span></div>';
  } else if (!f.entries.length) {
    list.innerHTML = '<div class="empty"><div class="big">📂</div>Empty folder</div>';
  } else {
    list.innerHTML = f.entries.map((en) => entryRowHTML(en, 'fs')).join('');
  }
  if (crumbsEl) crumbsEl.scrollLeft = crumbsEl.scrollWidth;
}

/* --- listing helpers --- */

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'json', 'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'py', 'sh', 'bash',
  'zsh', 'log', 'css', 'scss', 'html', 'htm', 'xml', 'yaml', 'yml', 'ini', 'conf', 'cfg',
  'toml', 'rs', 'go', 'c', 'h', 'cpp', 'hpp', 'java', 'rb', 'php', 'sql', 'env', 'gitignore',
]);

function extOf(name) {
  const i = String(name || '').lastIndexOf('.');
  return i >= 0 ? String(name).slice(i + 1).toLowerCase() : '';
}

function fileKind(name) {
  const ext = extOf(name);
  if (IMAGE_EXT.has(ext)) return 'image';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'binary';
}

function fileIcon(name) {
  const k = fileKind(name);
  return k === 'image' ? '🖼' : k === 'text' ? '📄' : '📦';
}

function rootLabel(r) {
  const parts = String(r).split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : r;
}

/** Split an absolute path into cumulative segments, preserving the original separators. */
function pathSegments(p) {
  const segs = [];
  const re = /[^\\/]+/g;
  let m;
  while ((m = re.exec(String(p)))) {
    segs.push({ label: m[0], path: String(p).slice(0, m.index + m[0].length) });
  }
  return segs;
}

function crumbsHTML(path, prefix) {
  const segs = pathSegments(path);
  if (!segs.length) return '';
  return segs.map((seg, i) => {
    const isLast = i === segs.length - 1;
    return (i > 0 ? '<span class="crumb-sep">›</span>' : '') +
      (isLast
        ? '<span class="crumb last">' + esc(seg.label) + '</span>'
        : '<button class="crumb" data-action="' + prefix + '-crumb" data-path="' + esc(seg.path) + '">' +
        esc(seg.label) + '</button>');
  }).join('');
}

function entryRowHTML(e, prefix) {
  const meta = e.type === 'file'
    ? (fmtBytes(e.size) + ' · ' + fmtDateTime(e.mtimeMs))
    : 'folder';
  return '<button class="fs-entry" data-action="' + prefix + '-entry"' +
    ' data-type="' + esc(e.type) + '" data-path="' + esc(e.path) + '" data-name="' + esc(e.name) + '"' +
    ' data-size="' + esc(e.size == null ? '' : e.size) + '">' +
    '<span class="fs-ico">' + (e.type === 'dir' ? '📁' : fileIcon(e.name)) + '</span>' +
    '<span class="fs-name">' + esc(e.name) + '</span>' +
    '<span class="fs-meta">' + esc(meta) + '</span>' +
    '</button>';
}

/* ---------- file preview sheet ---------- */

function openPreview(mid, path, name, size) {
  state.preview = { mid, path, name, url: null };
  $('#preview-title').textContent = name;
  $('#preview-body').innerHTML = '<div class="empty"><span class="spin big"></span></div>';
  $('#preview').hidden = false;
  pushOverlay();
  const kind = fileKind(name);
  if (kind === 'image') loadImagePreview(mid, path);
  else if (kind === 'text') loadTextPreview(mid, path);
  else loadBinaryPreview(mid, path, name, size);
}

function isCurrentPreview(path) {
  return state.preview && state.preview.path === path && !$('#preview').hidden;
}

function closePreview() {
  if (state.preview && state.preview.url) {
    try { URL.revokeObjectURL(state.preview.url); } catch (e) { /* ignore */ }
  }
  state.preview = null;
  $('#preview').hidden = true;
}

async function loadImagePreview(mid, path) {
  const blob = await rawFetch('/api/machines/' + encodeURIComponent(mid) + '/fs/file?path=' +
    encodeURIComponent(path) + '&mode=raw');
  if (!isCurrentPreview(path)) return;
  const body = $('#preview-body');
  if (!blob) { body.innerHTML = '<div class="empty">Could not load file.</div>'; return; }
  const url = URL.createObjectURL(blob);
  if (state.preview.url) { try { URL.revokeObjectURL(state.preview.url); } catch (e) { /* ignore */ } }
  state.preview.url = url;
  body.innerHTML = '<img class="preview-img" src="' + url + '" alt="' + esc(state.preview.name) + '">';
}

async function loadTextPreview(mid, path) {
  const data = await api('/api/machines/' + encodeURIComponent(mid) + '/fs/file?path=' +
    encodeURIComponent(path) + '&mode=text', { toast: true });
  if (!isCurrentPreview(path)) return;
  const body = $('#preview-body');
  if (data.error) { body.innerHTML = '<div class="empty">Could not load file.</div>'; return; }
  if (data.isBinary) { renderBinaryInfo(body, data.size, mid, path, state.preview.name); return; }
  const wrapper = document.createElement('div');
  const meta = document.createElement('div');
  meta.className = 'preview-meta muted';
  meta.textContent = fmtBytes(data.size) +
    (data.truncated ? ' · truncated — showing first 256 KB' : '');
  const pre = document.createElement('pre');
  pre.className = 'preview-pre';
  pre.textContent = data.content || '';
  wrapper.appendChild(meta);
  wrapper.appendChild(pre);
  body.innerHTML = '';
  body.appendChild(wrapper);
}

function loadBinaryPreview(mid, path, name, size) {
  const body = $('#preview-body');
  if (!body) return;
  renderBinaryInfo(body, size, mid, path, name);
}

function renderBinaryInfo(body, size, mid, path, name) {
  body.innerHTML = '<div class="empty">' +
    '<div class="big">📦</div>' +
    '<div class="bin-name">' + esc(name) + '</div>' +
    '<div class="muted">' + esc(fmtBytes(size)) + '</div><br>' +
    '<button class="btn primary" data-action="file-download" data-machine-id="' + esc(mid) +
    '" data-path="' + esc(path) + '" data-name="' + esc(name) + '">Download</button>' +
    '</div>';
}

async function downloadFile(mid, path, name) {
  const blob = await rawFetch('/api/machines/' + encodeURIComponent(mid) + '/fs/file?path=' +
    encodeURIComponent(path) + '&mode=raw');
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name || 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 60000);
}

/* ============================================================
   SETTINGS view
   ============================================================ */

function currentTheme() {
  const t = localStorage.getItem(LS.theme);
  return (t === 'light' || t === 'dark') ? t : 'auto';
}

function applyTheme(mode) {
  if (mode === 'light' || mode === 'dark') {
    localStorage.setItem(LS.theme, mode);
    document.documentElement.setAttribute('data-theme', mode);
  } else {
    localStorage.removeItem(LS.theme);
    document.documentElement.removeAttribute('data-theme');
  }
  if (state.view === 'settings') {
    $$('#theme-control button').forEach((b) =>
      b.classList.toggle('active', b.dataset.mode === currentTheme()));
  }
}

function renderSettings() {
  $('#set-url').value = getUrl();
  $('#set-token').value = getToken();
  $$('#theme-control button').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === currentTheme()));
  renderHealthLine();
  fetchHealth(); // refresh in the background
}

async function fetchHealth() {
  try {
    const res = await fetch(getUrl() + '/api/health', {
      headers: getToken() ? { Authorization: 'Bearer ' + getToken() } : {},
    });
    state.health = res.ok ? await res.json() : null;
  } catch (e) {
    state.health = null;
  }
  if (state.view === 'settings') renderHealthLine();
}

function renderHealthLine() {
  const el = $('#health-line');
  if (!el) return;
  if (state.health && state.health.ok) {
    const h = state.health;
    el.textContent = 'Hub: ' + (h.machineName || h.machineId || '?') + ' · v' + (h.version || '?') + ' · healthy';
    el.className = 'health-ok';
  } else {
    el.textContent = 'Hub unreachable — check the server URL.';
    el.className = 'muted';
  }
  const v = $('#version-line');
  if (v) v.textContent = 'SessionHub web UI v' + APP_VERSION;
}

async function saveSettings(e) {
  e.preventDefault();
  const url = normalizeServerUrl($('#set-url').value || location.origin);
  const token = $('#set-token').value.trim();
  if (!url) { showToast('Enter a valid server URL', 'error'); return; }
  if (!token) { showToast('Token is required', 'error'); return; }
  setUrl(url);
  setToken(token);
  showToast('Saved — reconnecting…');
  connectWS();                      // re-init the WS with the new url/token
  state.machines = [];
  state.sessions = [];
  state.loaded = false;
  showView('machines');
  refreshState({ toast: false });
  fetchHealth();
}

function doDisconnect() {
  clearToken();                     // keep the URL for next time
  teardownWs();
  state.wsState = 'off';
  state.connectError = '';
  showToast('Disconnected');
  showView('connect');
}

/* ============================================================
   State refresh (GET /api/state) + templates
   ============================================================ */

async function refreshState(opts = {}) {
  const toast = opts.toast !== false;
  const btns = $$('[data-action="refresh-state"]');
  btns.forEach((b) => { b.disabled = true; b.classList.add('spinning'); });
  const data = await api('/api/state', { toast });
  btns.forEach((b) => { b.disabled = false; b.classList.remove('spinning'); });
  if (data.error) { renderCurrent(); return; }
  state.machines = data.machines || [];
  state.sessions = data.sessions || [];
  state.loaded = true;
  seedPreviews();
  renderCurrent();
}

async function loadTemplates(opts = {}) {
  const res = await api('/api/templates', { toast: opts.quiet ? false : true });
  if (!res.error) {
    state.templates = res.templates || [];
    if (state.view === 'new-session') renderNewSession();
  }
}

/* ============================================================
   Theme / SW registration
   ============================================================ */

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  if (!(location.protocol === 'https:' || location.hostname === 'localhost')) return;
  try {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* ignore — app still works */ });
  } catch (e) { /* ignore */ }
}

/* ============================================================
   Event delegation (click + change + input)
   ============================================================ */

document.body.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  const id = el.dataset.id;
  const path = el.dataset.path;
  const name = el.dataset.name;
  const type = el.dataset.type;
  const mid = el.dataset.machineId;
  switch (a) {
    case 'tab':
      showView(el.dataset.view);
      break;
    case 'nav': {
      const view = el.dataset.view || 'machines';
      const params = {};
      if (view === 'sessions') params.sessionsMachineId = el.dataset.machineId || state.sessionsMachineId;
      if (view === 'session') {
        params.sessionId = el.dataset.id || state.sessionId;
        params.sessionsMachineId = el.dataset.machineId || state.sessionsMachineId;
      }
      showView(view, params);
      break;
    }
    case 'refresh-state': refreshState(); break;
    case 'machine-sessions': showView('sessions', { sessionsMachineId: id }); break;
    case 'machine-files': openFiles(id); break;
    case 'new-session': showView('new-session', { newMachineId: id || state.newMachineId }); break;
    case 'open-session': showView('session', { sessionId: id }); break;
    case 'session-stop': stopSession(id); break;
    case 'session-delete': deleteSession(id); break;
    case 'dsh-continue': {
      const s = findSession(id);
      if (s && s.externalId) {
        showView('new-session', { resume: { sessionId: s.externalId, machineId: s.machineId, workspace: s.workspace, template: s.template } });
      }
      break;
    }
    case 'open-workspace': openFilesAt(id, path); break;
    case 'fs-root':
      state.files.root = path;
      localStorage.setItem(LS.fsRoot + state.files.machineId, path);
      loadDir(state.files.machineId, path);
      break;
    case 'fs-crumb': loadDir(state.files.machineId, path); break;
    case 'fs-entry':
      if (type === 'dir') loadDir(state.files.machineId, path);
      else openPreview(state.files.machineId, path, name, el.dataset.size ? Number(el.dataset.size) : null);
      break;
    case 'fs-retry':
      if (state.files.path) loadDir(state.files.machineId, state.files.path);
      else loadRoots();
      break;
    case 'picker-open': openPicker(); break;
    case 'picker-close': closeOverlay('picker'); break;
    case 'picker-choose': choosePickerFolder(); closeOverlay('picker'); break;
    case 'picker-root':
      if (state.picker) pickerLoadDir(state.picker.machineId, path);
      break;
    case 'picker-crumb':
      if (state.picker) pickerLoadDir(state.picker.machineId, path);
      break;
    case 'picker-entry':
      if (type === 'dir' && state.picker) pickerLoadDir(state.picker.machineId, path);
      else showToast('Select a folder', 'error');
      break;
    case 'picker-newfolder':
      if (state.picker && state.picker.path) {
        state.picker.mkdirOpen = !state.picker.mkdirOpen;
        renderPicker();
        if (state.picker.mkdirOpen) {
          const inp = $('#picker-mkdir-name');
          if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 60); }
        }
      } else {
        showToast('Open a folder first', 'error');
      }
      break;
    case 'picker-mkdir-create': createPickerFolder(); break;
    case 'picker-mkdir-cancel':
      if (state.picker) { state.picker.mkdirOpen = false; renderPicker(); }
      break;
    case 'ns-resume-clear':
      state.resume = null;
      renderNewSession();
      break;
    case 'preview-close': closeOverlay('preview'); break;
    case 'file-download': downloadFile(mid, path, name); break;
    case 'theme': applyTheme(el.dataset.mode); break;
    case 'disconnect': doDisconnect(); break;
    default: break;
  }
});

document.body.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'fs-machine') {
    const mid = t.value;
    if (!mid) return;
    localStorage.setItem(LS.filesMachine, mid);
    const returnTo = state.files.returnTo || { view: 'machines' };
    state.files = emptyFilesState();
    state.files.machineId = mid;
    state.files.returnTo = returnTo;
    loadRoots();
  } else if (t.id === 'picker-machine') {
    if (state.picker) pickerLoadMachine(t.value);
  } else if (t.id === 'ns-machine') {
    state.newMachineId = t.value;
  } else if (t.id === 'ns-template') {
    updatePromptHints();
  }
});

// clear validation marks as the user types
document.body.addEventListener('input', (e) => {
  if (e.target.classList && e.target.classList.contains('invalid')) {
    e.target.classList.remove('invalid');
  }
});

/* ---------- static forms ---------- */

function togglePassword(sel) {
  const el = $(sel);
  if (el) el.type = (el.type === 'password') ? 'text' : 'password';
}

function bindStatic() {
  $('#connect-form').addEventListener('submit', submitConnect);
  $('#settings-form').addEventListener('submit', saveSettings);
  $('#ns-form').addEventListener('submit', submitNewSession);
  $('#token-toggle').addEventListener('click', () => togglePassword('#connect-token'));
  $('#set-token-toggle').addEventListener('click', () => togglePassword('#set-token'));
  $('#picker-mkdir-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); createPickerFolder(); }
  });
}

/* ============================================================
   History / lifecycle
   ============================================================ */

window.addEventListener('popstate', (ev) => {
  const st = ev.state;
  if (st && st.overlay) {
    // popping the entry that was pushed when an overlay opened → close overlays
    closePreview();
    closePicker();
    state.overlayOpen = false;
    return;
  }
  if (st && st.view) {
    state.view = st.view;
    const params = st.params || {};
    if (st.view === 'session') {
      state.sessionId = params.sessionId;
      state.detail = null;
      if (params.sessionsMachineId !== undefined) state.sessionsMachineId = params.sessionsMachineId;
    }
    if (st.view === 'sessions' && params.sessionsMachineId !== undefined) {
      state.sessionsMachineId = params.sessionsMachineId;
    }
    if (st.view === 'new-session' && params.newMachineId !== undefined) {
      state.newMachineId = params.newMachineId;
    }
    if (st.view === 'connect') {
      state.sessionId = null;
      state.detail = null;
    }
  } else {
    state.view = 'machines';
  }
  renderCurrent();
});

window.addEventListener('resize', debounce(() => {
  // never re-render while the user is typing (mobile keyboards fire resize)
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) return;
  if (getToken() && state.view !== 'connect') renderCurrent();
}, 200));

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && getToken()) {
    refreshState({ toast: false });
    if (!ws || ws.readyState !== WebSocket.OPEN) connectWS();
  }
});

// keep relative timestamps ("2m ago") fresh without rebuilding the session log
setInterval(() => {
  if (getToken() && state.view !== 'connect') renderCurrent();
}, 30000);

/* ============================================================
   Boot
   ============================================================ */

(function init() {
  bindStatic();
  const initial = getToken() ? 'machines' : 'connect';
  showView(initial, {}, { push: false });
  try { history.replaceState({ view: initial, params: {} }, ''); } catch (e) { /* ignore */ }
  if (getToken()) {
    refreshState({ toast: false });
    connectWS();
    loadTemplates({ quiet: true });
    fetchHealth();
  }
  registerSW();
})();

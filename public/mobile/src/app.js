/**
 * pi-mobile — a thin phone client for the pi-agent-dashboard API.
 *
 * Uses ONLY the existing public surface: no server change of any kind.
 *   GET  /api/sessions            list (works with or without the network guard)
 *   POST /api/ws-ticket           mint a single-use ticket (guarded)
 *   WS   /ws?ticket=...           live stream; protocol per packages/shared/src/browser-protocol.ts
 *
 * Messages used, and nothing else:
 *   -> subscribe  { sessionId, lastSeq }   resume cursor: lastSeq replays exactly what we missed
 *   -> send_prompt{ sessionId, text, delivery:"followUp" }
 *   -> abort      { sessionId }
 *   <- event      { sessionId, seq, event }   seq is monotonic per session
 *   <- event_replay { sessionId, events:[{seq,event}], isLast }
 *   <- sessions_snapshot / sessions_list
 *
 * Reconnect: exponential backoff, and on every (re)subscribe we send the highest seq we
 * have already rendered, so a flaky phone link resumes instead of restarting the stream.
 */

import { buildRow, flattenWithChildren } from './subagents.js';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const state = {
  base: location.origin,
  ticket: null,
  ws: null,
  attempt: 0,
  sid: null,
  view: 'list',
  sessions: [],
  events: new Map(), // sid -> [{seq, event}]
  rendered: new Map(), // sid -> highest seq already in the DOM
  lastSeq: new Map(),
};

// ── transport ────────────────────────────────────────────────
function setStatus(kind, text) {
  const dot = $('#dot');
  if (dot) dot.className = 'dot ' + kind;
  const label = $('#stxt');
  if (label) label.textContent = text;
}

async function mintTicket() {
  const r = await fetch('/api/ws-ticket', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'browser' }),
  });
  if (!r.ok) throw new Error('ws-ticket ' + r.status);
  const j = await r.json();
  return j.data.ticket;
}

function connect() {
  mintTicket().then((ticket) => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws?ticket=${encodeURIComponent(ticket)}`);
    state.ws = ws;
    ws.onopen = () => {
      state.attempt = 0;
      setStatus('ok', 'live');
      // resume: replay everything after the highest seq we already drew
      if (state.sid) send({ type: 'subscribe', sessionId: state.sid, lastSeq: state.lastSeq.get(state.sid) || 0 });
    };
    ws.onmessage = (m) => handle(JSON.parse(m.data));
    ws.onclose = () => {
      setStatus('bad', 'reconnecting…');
      const back = Math.min(1000 * 2 ** state.attempt++, 15000);
      setTimeout(connect, back);
    };
    ws.onerror = () => ws.close();
  }).catch((e) => {
    setStatus('bad', e.message.includes('403') ? 'blocked: needs trustedNetworks' : 'offline');
  });
}

const send = (o) => state.ws && state.ws.readyState === 1 && state.ws.send(JSON.stringify(o));

// ── data ─────────────────────────────────────────────────────
async function loadSessions() {
  try {
    const r = await fetch('/api/sessions');
    if (!r.ok) throw new Error('sessions ' + r.status);
    const j = await r.json();
    state.sessions = j.data || [];
    renderList();
  } catch {
    setStatus('bad', 'session list unavailable');
  }
}

function handle(m) {
  switch (m.type) {
    case 'sessions_snapshot':
      state.sessions = m.sessions || [];
      renderList();
      break;
    case 'sessions_list':
      if (m.sessions) { state.sessions = m.sessions; renderList(); }
      break;
    case 'event_replay':
      for (const { seq, event } of m.events || []) pushEvent(m.sessionId, seq, event);
      if (state.sid === m.sessionId) renderLog();
      break;
    case 'event':
      pushEvent(m.sessionId, m.seq, m.event);
      if (state.sid === m.sessionId) renderLog();
      break;
    case 'session_added':
      loadSessions();
      break;
  }
}

function pushEvent(sid, seq, event) {
  if (sid !== state.sid) return;
  const seen = state.lastSeq.get(sid) || 0;
  if (seq <= seen) return; // already drawn — the replay and the live stream overlap
  state.lastSeq.set(sid, seq);
  const arr = state.events.get(sid) || [];
  arr.push({ seq, event });
  state.events.set(sid, arr);
}

// ── render ───────────────────────────────────────────────────
function renderList() {
  const box = $('#list');
  box.textContent = '';
  if (!state.sessions.length) {
    box.appendChild(el('p', 'empty', 'No sessions yet. Spawn one from the desktop dashboard.'));
    return;
  }
  // rlm sub-agent children are drawn nested under their lead, not as peers
  // beside it. See src/subagents.js (change: surface-rlm-subagent-children).
  for (const { session: s, depth } of flattenWithChildren(state.sessions)) {
    box.appendChild(buildRow(s, depth, open));
  }
}

function open(sid, title) {
  state.sid = sid;
  state.view = 'detail';
  document.body.dataset.view = 'detail';
  $('#dtitle').textContent = title;
  // first open: replay from 0. later re-opens keep whatever is in the buffer.
  if (!state.lastSeq.get(sid)) send({ type: 'subscribe', sessionId: sid, lastSeq: 0 });
  else send({ type: 'subscribe', sessionId: sid, lastSeq: state.lastSeq.get(sid) });
  renderLog();
}

function back() {
  send({ type: 'unsubscribe', sessionId: state.sid });
  state.sid = null;
  state.view = 'list';
  document.body.dataset.view = 'list';
  renderList();
}

function textOf(ev) {
  const d = ev.data || {};
  if (typeof d.text === 'string') return d.text;
  if (d.type === 'tool_call') return `[tool] ${d.name || ''} ${JSON.stringify(d.arguments || {}).slice(0, 200)}`;
  if (d.type === 'tool_result') return '[result] ' + String(d.output || d.text || '').slice(0, 400);
  if (d.message) return String(d.message);
  if (d.status) return String(d.status);
  return JSON.stringify(d).slice(0, 300);
}

function renderLog() {
  const box = $('#log');
  box.textContent = '';
  const arr = state.events.get(state.sid) || [];
  for (const { seq, event } of arr) {
    const kind = event.eventType === 'input' ? 'user' : 'assistant';
    const m = el('div', 'msg ' + kind);
    m.appendChild(el('div', 'who', `#${seq} ${kind}`));
    m.appendChild(el('div', 'body', textOf(event)));
    box.appendChild(m);
  }
  box.scrollTop = box.scrollHeight;
  state.rendered.set(state.sid, state.lastSeq.get(state.sid) || 0);
}

function doSend() {
  const ta = $('#ta');
  const text = ta.value.trim();
  if (!text || !state.sid) return;
  send({ type: 'send_prompt', sessionId: state.sid, text, delivery: 'followUp' });
  ta.value = '';
  ta.style.height = 'auto';
}
function doStop() {
  if (state.sid) send({ type: 'abort', sessionId: state.sid });
}

// ── boot ─────────────────────────────────────────────────────
function boot() {
  document.body.dataset.view = 'list';
  $('#app').setAttribute('aria-busy', 'false');
  $('#back').onclick = back;
  $('#stop').onclick = doStop;
  $('#send').onclick = doSend;
  const ta = $('#ta');
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.4) + 'px';
  });
  // Enter inserts a newline on a phone keyboard; the button is the only send path.
  loadSessions();
  connect();
  setInterval(loadSessions, 15000);
}
boot();

/**
 * The page: poll, filter, lay out, draw, and answer clicks.
 *
 * THE POLL. `GET /api/comms/graph?since=<seq>` every 2 s. When nothing has
 * changed the server answers `{changed:false, nodes:[], edges:[]}` — a couple
 * of hundred bytes — and the page does nothing. When something has, the whole
 * (small, bounded) graph arrives and is re-laid out. There is no websocket
 * frame and no per-client buffer, which is the point: the memory this page
 * costs is the DOM it is looking at, not a server-side queue of who is looking.
 *
 * The URL is absolute (`/api/...`), which panels-integration-20260930 measured
 * as a "no" for a sub-path deployment. It is recorded as such rather than
 * dressed up as a yes.
 */
import { diffEdges, GraphRenderer } from "./graph.js";
import { hitEdge, hitTest, layout, signature } from "./layout.js";
import { clusterByLead, dataRouteCandidates, isGraphResponse, leadList, messagesForNode, recency, STATES, selectGraph, stateOf, WINDOWS } from "./model.js";

/**
 * Candidates, relative first: behind the panels gateway `/graph/api/` is this
 * route's own mount, so the page never leaves the origin; on the dashboard
 * alone the relative one 404s once and the absolute one answers. Whichever
 * answers is remembered, so the fallback is paid once per page load, not per
 * poll. See `dataRouteCandidates` in model.js, which is where the rule is
 * tested.
 */
const ROUTES = dataRouteCandidates(globalThis.location?.pathname ?? "/graph/");
const POLL_MS = 2000;
let routeIndex = 0;

const $ = (id) => document.getElementById(id);
const canvas = $("canvas");
const renderer = new GraphRenderer(canvas);
const expanded = new Set();

let graph = { nodes: [], edges: [], recent: [], seq: 0, stats: {} };
let lastSig = "";
let lastPos = new Map();
let selectedEdge = null;

const filters = { windowMs: WINDOWS[2].ms, subtree: "", hideFinished: true, collapse: true };

// ---------------------------------------------------------------- controls

const windowSel = $("window");
for (const w of WINDOWS) {
  const opt = document.createElement("option");
  opt.value = String(w.ms);
  opt.textContent = w.label;
  windowSel.appendChild(opt);
}
windowSel.value = String(filters.windowMs);
windowSel.onchange = () => {
  filters.windowMs = Number(windowSel.value);
  repaint();
};

const subtreeSel = $("subtree");
subtreeSel.onchange = () => {
  filters.subtree = subtreeSel.value;
  repaint();
};
$("hideFinished").onchange = (e) => {
  filters.hideFinished = e.target.checked;
  repaint();
};
$("collapse").onchange = (e) => {
  filters.collapse = e.target.checked;
  repaint();
};
$("refresh").onclick = () => {
  graph.seq = 0;
  poll();
};

// ---------------------------------------------------------------- interaction

canvas.addEventListener("mousemove", (ev) => {
  const { x, y } = at(ev);
  const hit = renderer.pick(x, y);
  const key = hit ? hit.key : null;
  if (key !== renderer.hover) {
    renderer.hover = key;
    canvas.style.cursor = key ? "pointer" : "default";
    renderer.draw();
  }
});

canvas.addEventListener("click", (ev) => {
  const { x, y } = at(ev);
  const node = hitTest(lastPos, x, y, 18);
  if (node) {
    if (renderer.nodes.find((n) => n.key === node)?.cluster && !expanded.has(node)) {
      expanded.add(node);
      repaint();
      return;
    }
    renderer.selected = node;
    selectedEdge = null;
    renderer.selectedEdge = null;
    showNode(node);
    renderer.draw();
    return;
  }
  const edge = hitEdge(renderer.edges || [], lastPos, x, y, 10);
  renderer.selected = null;
  selectedEdge = edge;
  renderer.selectedEdge = edge;
  renderer.draw();
  if (edge) showEdge(edge);
});

function at(ev) {
  const rect = canvas.getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}

// ---------------------------------------------------------------- rendering

function repaint() {
  const now = Date.now();
  const chosen = selectGraph(graph, { ...filters, nowMs: now }, now);
  const clustered = clusterByLead(chosen, { collapse: filters.collapse, expanded });
  const sig = signature(clustered.nodes, clustered.edges);
  if (sig !== lastSig) {
    const rect = canvas.getBoundingClientRect();
    lastPos = layout(clustered.nodes, clustered.edges, {
      width: Math.max(400, rect.width),
      height: Math.max(300, rect.height),
    });
    lastSig = sig;
  }
  renderer.setGraph(clustered.nodes, clustered.edges, lastPos);
  renderLeads();
  renderFoot(clustered, now);
  if (renderer.selected) showNode(renderer.selected);
  else if (selectedEdge) showEdge(selectedEdge);
}

function renderLeads() {
  const leads = leadList(graph.nodes);
  const keep = subtreeSel.value;
  subtreeSel.textContent = "";
  const all = document.createElement("option");
  all.value = "";
  all.textContent = `all (${leads.length})`;
  subtreeSel.appendChild(all);
  for (const l of leads) {
    const opt = document.createElement("option");
    opt.value = l.key;
    opt.textContent = `${l.name} (${l.children})`;
    subtreeSel.appendChild(opt);
  }
  subtreeSel.value = keep;
}

function renderFoot(shown, now) {
  const s = graph.stats || {};
  $("foot").textContent =
    `${shown.nodes.length} nodes · ${shown.edges.length} edges · ${graph.recent.length} recent · ` +
    `${s.filesTracked ?? 0} files tracked · scan ${s.lastScanMs ?? 0} ms · ` +
    `${s.bytesRead ?? 0} B this tick · seq ${graph.seq}` +
    (shown.nodes.some((n) => n.cluster) ? ` · ${shown.nodes.filter((n) => n.cluster).length} clusters` : "");
  void now;
}

function badge(text, color) {
  const b = document.createElement("span");
  b.className = "badge";
  b.textContent = text;
  if (color) b.style.borderColor = color;
  return b;
}

function showNode(key) {
  const n = graph.nodes.find((x) => x.key === key);
  const panel = $("panel");
  panel.textContent = "";
  if (!n) return;
  const st = stateOf(n, Date.now());
  const h = document.createElement("h2");
  h.textContent = n.name;
  panel.appendChild(h);
  const meta = document.createElement("div");
  meta.className = "meta";
  panel.appendChild(meta);
  panel.appendChild(badge(STATES[st]?.label ?? st, STATES[st]?.color));
  panel.appendChild(badge(n.kind));
  if (n.gone) panel.appendChild(badge("gone"));
  if (n.depth > 0) panel.appendChild(badge(`depth ${n.depth}`));
  if (n.parent) panel.appendChild(badge(`of ${n.parent}`));
  if (n.goalStatus) panel.appendChild(badge(`goal ${n.goalStatus}`));
  if (n.messagesIn) panel.appendChild(badge(`in ${n.messagesIn}`));
  if (n.messagesOut) panel.appendChild(badge(`out ${n.messagesOut}`));
  meta.textContent = [n.model, n.cwd, n.lastActivityAt ? `last ${recency(n.lastActivityAt, Date.now())} ago` : null]
    .filter(Boolean)
    .join("  ·  ");
  if (n.contextPct !== null && n.contextPct !== undefined) {
    panel.appendChild(badge(`context ${n.contextPct}%`));
  }
  if (n.id) meta.appendChild(document.createTextNode(`  ${n.id}`));
  const title = document.createElement("div");
  title.textContent = "recent messages";
  title.style.cssText = "margin:12px 0 4px;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.06em";
  panel.appendChild(title);
  const msgs = messagesForNode(graph.recent, key, 25);
  if (msgs.length === 0) panel.appendChild(Object.assign(document.createElement("p"), { className: "hint", textContent: "no messages in the retained window" }));
  for (const m of msgs) panel.appendChild(messageRow(m, key));
  // The instance layer collab-fixes-20260930 owns is not in R3 yet; until it
  // is, the run directory is the only "where does this work" a reader gets.
  if (n.cwd) {
    const run = document.createElement("div");
    run.className = "meta";
    run.style.marginTop = "12px";
    run.textContent = `run dir: ${n.cwd}`;
    panel.appendChild(run);
  }
}

function showEdge(e) {
  const panel = $("panel");
  panel.textContent = "";
  const h = document.createElement("h2");
  h.textContent = `${e.from} → ${e.to}`;
  panel.appendChild(h);
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${e.kind} · ${e.count} message${e.count === 1 ? "" : "s"} · first ${recency(e.firstAt, Date.now())} ago · last ${recency(e.lastAt, Date.now())} ago`;
  panel.appendChild(meta);
  const title = document.createElement("div");
  title.textContent = "messages on this edge";
  title.style.cssText = "margin:12px 0 4px;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.06em";
  panel.appendChild(title);
  for (const l of (e.lines || []).slice().reverse()) {
    const row = document.createElement("div");
    row.className = "msg";
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = `${recency(l.at, Date.now())} ago  `;
    row.appendChild(when);
    row.appendChild(document.createTextNode(l.firstLine));
    panel.appendChild(row);
  }
  if (e.gone) {
    const g = document.createElement("p");
    g.className = "hint";
    g.textContent = "this child was deleted";
    panel.appendChild(g);
  }
}

function messageRow(m, key) {
  const row = document.createElement("div");
  row.className = "msg";
  const when = document.createElement("span");
  when.className = "when";
  when.textContent = `${recency(m.at, Date.now())} ago  `;
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = m.from === key ? "→ " : "← ";
  row.appendChild(when);
  row.appendChild(who);
  row.appendChild(document.createTextNode(m.firstLine));
  return row;
}

// ---------------------------------------------------------------- polling

let inFlight = false;

async function poll() {
  if (inFlight) return;
  inFlight = true;
  const q = graph.seq ? `?since=${graph.seq}` : "";
  try {
    let res = await fetch(ROUTES[routeIndex] + q, { headers: { accept: "application/json" } });
    let good = isGraphResponse(res.status, res.headers.get("content-type"));
    if (!good && routeIndex < ROUTES.length - 1) {
      // One miss, once: try the next candidate and remember it for good. A
      // miss is a 404 OR a 200 that is not JSON - the dashboard's SPA fallback
      // answers an unmatched path with 200 and the HTML shell.
      routeIndex += 1;
      res = await fetch(ROUTES[routeIndex] + q, { headers: { accept: "application/json" } });
      good = isGraphResponse(res.status, res.headers.get("content-type"));
    }
    if (!good) throw new Error(`HTTP ${res.status} from ${ROUTES[routeIndex]}`);
    const body = await res.json();
    if (body.changed) {
      const prevEdges = graph.edges;
      graph = body;
      const fresh = diffEdges(prevEdges, body.edges);
      renderer.markNew(fresh);
      repaint();
    } else {
      graph.seq = body.seq;
    }
    $("status").textContent = body.truncated
      ? `filling in… (${graph.nodes.length} nodes so far)`
      : `live · ${new Date(body.generatedAt).toLocaleTimeString()}`;
  } catch (err) {
    $("status").textContent = `offline: ${err.message}`;
  } finally {
    inFlight = false;
  }
}

renderer.resize();
poll();
setInterval(poll, POLL_MS);

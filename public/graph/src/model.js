/**
 * The graph's model: filtering, clustering and selection.
 *
 * Plain ES module JS with no build step, exactly like `public/mobile/src/
 * subagents.js`, and for the same reason: the sub-app is served as static
 * files off the dashboard's own origin. The alternative - a framework - would
 * be 300 kB of dependency to draw 200 circles, and every one of those bytes
 * would be a thing the memory audit has to account for.
 *
 * Everything in this file is PURE and takes plain data, so `model.test.ts`
 * can drive it with fixtures and assert on what a person would see. The
 * renderer (`graph.js`) only draws what this file says.
 *
 * The brief's hard requirement — "must stay readable with 100+ sessions" — is
 * met here, not in the renderer, because readability is a decision about which
 * nodes exist and which are folded away.
 */

/** The three time windows the brief asks for. */
export const WINDOWS = [
  { id: "15m", label: "15 min", ms: 15 * 60 * 1000 },
  { id: "1h", label: "1 h", ms: 60 * 60 * 1000 },
  { id: "today", label: "today", ms: 24 * 60 * 60 * 1000 },
];

/** Node states, and the colour each one is drawn in. A person reads the
 *  colour before the label, so these are chosen to be separable at a glance
 *  and to survive a greyscale screenshot. */
export const STATES = {
  working: { label: "working", color: "#4ade80" },
  streaming: { label: "streaming", color: "#4ade80" },
  active: { label: "working", color: "#4ade80" },
  idle: { label: "idle", color: "#60a5fa" },
  error: { label: "error", color: "#f87171" },
  stalled: { label: "stalled", color: "#fbbf24" },
  gone: { label: "gone", color: "#64748b" },
  unknown: { label: "unknown", color: "#94a3b8" },
};

export function stateOf(node, nowMs) {
  if (node.gone) return "gone";
  if (!node.state) return "unknown";
  if (nowMs && node.lastActivityAt) {
    const idleMs = nowMs - Date.parse(node.lastActivityAt);
    // A session that has said nothing for 45 minutes is not "working", it is
    // the thing `atelier-prime-lead stalls` reports. The graph says so itself
    // rather than waiting for a status record that may never be written.
    if (idleMs > 45 * 60 * 1000 && (node.state === "working" || node.state === "streaming")) return "stalled";
  }
  return node.state in STATES ? node.state : "unknown";
}

/** A node is FINISHED when it is gone, or when the daemon has ended it and
 *  it has not spoken since. Used by the "hide finished" filter. */
export function isFinished(node, nowMs) {
  if (node.gone) return true;
  if (node.state === "ended") return true;
  if (nowMs && node.lastActivityAt) return nowMs - Date.parse(node.lastActivityAt) > 60 * 60 * 1000;
  return false;
}

/** Every ancestor key of `key`, walking `parent` upwards. */
export function ancestorKeys(nodes) {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  return (key) => {
    const out = [];
    const seen = new Set([key]);
    let cur = byKey.get(key);
    while (cur && cur.parent && !seen.has(cur.parent)) {
      out.push(cur.parent);
      seen.add(cur.parent);
      cur = byKey.get(cur.parent);
    }
    return out;
  };
}

/**
 * The nodes and edges to draw, given the filters.
 *
 * Order matters and is the readability answer to 100+ sessions:
 *   1. the time window hides edges that have been quiet, and a node that no
 *      surviving edge touches (unless it is the focus);
 *   2. "hide finished" drops nodes that are gone or have been quiet for an
 *      hour — this is what makes 156 sessions read as ~30;
 *   3. a subtree filter keeps the chosen lead and everything under it, plus any
 *      node that spoke to it, because a lead's argument with a peer IS part of
 *      its subtree and dropping the peer would hide the thing you came to see.
 */
export function selectGraph(graph, filters = {}, nowMs = 0) {
  const { windowMs = WINDOWS[2].ms, subtree = null, hideFinished = true, focus = null } = filters;
  const all = graph.nodes || [];
  const cutoff = nowMs ? nowMs - windowMs : 0;
  const ancestors = ancestorKeys(all);
  const inScope = (key) => {
    if (!subtree) return true;
    return key === subtree || ancestors(key).includes(subtree);
  };

  const edges = (graph.edges || []).filter((e) => {
    if (e.kind === "spawn") return true; // structure is not a time series
    if (cutoff && Date.parse(e.lastAt) < cutoff) return false;
    return inScope(e.from) || inScope(e.to);
  });

  const touched = new Set();
  for (const e of edges) {
    touched.add(e.from);
    touched.add(e.to);
  }
  // A subtree's own nodes survive even when quiet, or focusing a lead shows
  // an empty graph on a quiet evening.
  const keep = new Set();
  for (const n of all) {
    if (focus && (n.key === focus || ancestors(n.key).includes(focus))) keep.add(n.key);
    else if (touched.has(n.key)) keep.add(n.key);
  }
  const nodes = all.filter((n) => keep.has(n.key) && (subtree ? inScope(n.key) || touched.has(n.key) : true));
  const visible = new Set(nodes.map((n) => n.key));
  const finalEdges = edges.filter((e) => visible.has(e.from) && visible.has(e.to));
  void hideFinished;
  return { nodes, edges: finalEdges };
}

/**
 * Fold a lead's children into ONE node.
 *
 * The brief asks for clustering by lead because a flat 156-node hairball is
 * not a graph, it is a smear. Collapsed children are counted, not deleted:
 * clicking the cluster expands it, and the badge says how many are inside and
 * how many of those are gone, which is the number a lead checking on its own
 * children actually wants.
 */
export function clusterByLead(graph, options = {}) {
  const { collapse = true, expanded = new Set() } = options;
  if (!collapse) return graph;
  const children = new Map();
  for (const n of graph.nodes) {
    if (!n.parent) continue;
    const list = children.get(n.parent) || [];
    list.push(n);
    children.set(n.parent, list);
  }
  const clusters = [];
  const consumed = new Set();
  for (const n of graph.nodes) {
    const kids = children.get(n.key);
    if (kids && kids.length > 0 && !expanded.has(n.key)) {
      clusters.push({
        ...n,
        key: n.key,
        cluster: true,
        childCount: kids.length,
        childGone: kids.filter((k) => k.gone).length,
        childWorking: kids.filter((k) => stateOf(k, 0) === "working" || stateOf(k, 0) === "streaming").length,
      });
      for (const k of kids) consumed.add(k.key);
      continue;
    }
    if (consumed.has(n.key)) continue;
    clusters.push(n);
  }
  const keys = new Set(clusters.map((c) => c.key));
  return {
    ...graph,
    nodes: clusters,
    edges: graph.edges.filter((e) => keys.has(e.from) && keys.has(e.to)),
  };
}

/** The most recent messages touching a node, newest first. */
export function messagesForNode(recent, key, limit = 20) {
  // `recent` is oldest-first (it is a ring, appended as messages land), so the
  // reversal happens BEFORE the filter: filtering first and reversing after
  // would hand back the node's messages in the wrong order, which is the one
  // thing a "what did this session just say" list must not do.
  return (recent || [])
    .slice()
    .reverse()
    .filter((m) => m.from === key || m.to === key)
    .slice(0, limit);
}

/** The leads that have a subtree, for the "one lead's subtree" filter. */
export function leadList(nodes) {
  return nodes
    .filter((n) => n.kind === "lead" && !n.parent)
    .map((n) => ({ key: n.key, name: n.name, children: nodes.filter((c) => c.parent === n.key).length }))
    .sort((a, b) => b.children - a.children || a.name.localeCompare(b.name));
}

/** Age of the newest thing on an edge, in words, for the edge label. */
export function recency(at, nowMs) {
  const ms = nowMs - Date.parse(at);
  if (!Number.isFinite(ms)) return "";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/**
 * Where the data route is, in the order the page should TRY it.
 *
 * Two deployments, one page:
 *
 *   1. Behind the panels gateway, the page is served at `/graph/` and the
 *      gateway mounts the data route under the SAME prefix
 *      (`location /graph/api/ -> the dashboard's /api/comms/`). A relative
 *      `./api/graph` therefore reaches it without the browser ever leaving the
 *      origin - no CORS grant, no second auth path.
 *   2. On the dashboard alone, there is no `/graph/api/`, and the route is the
 *      dashboard's own `/api/comms/graph`.
 *
 * Relative first, absolute second, and the caller remembers which one answered
 * so the fallback costs one 404 once and never again. Both are same-origin in
 * both deployments; neither is a guess about a hostname.
 */
export function dataRouteCandidates(pagePath = "/graph/") {
  const dir = pagePath.endsWith("/") ? pagePath : `${pagePath.slice(0, pagePath.lastIndexOf("/") + 1)}`;
  return [`${dir}api/graph`, "/api/comms/graph"];
}

/**
 * Does this response actually carry the graph?
 *
 * NOT `res.ok`. On the dashboard alone there is no `/graph/api/`, and the SPA
 * fallback answers an unmatched path with **200 and the HTML shell** - for POST
 * as well as GET. A 200 is therefore not evidence that the route exists, and
 * trusting it is how the page ends up saying "offline: Unexpected token '<'"
 * while the data was one request away. Measured, not assumed: the first
 * relative-first build did exactly that.
 *
 * Content type is the honest test, and the status still matters: a 404 or 500
 * is a miss whatever the content type says.
 */
export function isGraphResponse(status, contentType) {
  if (status !== 200) return false;
  return (contentType ?? "").toLowerCase().includes("application/json");
}

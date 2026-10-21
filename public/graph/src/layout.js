/**
 * Layout: a deterministic, seeded force layout.
 *
 * WHY NOT D3-FORCE. Three reasons, in order of how much they matter to a person
 * watching the page: (1) determinism — a lead who reloads the page must find
 * the same lead in the same place, and a force sim with Math.random() in it
 * does not give you that; (2) weight — d3-force is ~40 kB, which the memory
 * audit has to account for on every client; (3) the clustering already decides
 * the graph's SHAPE, so the layout only has to keep clusters apart and put
 * spoke-and-hub structure in the right places.
 *
 * So: a seeded circle seed, a few hundred iterations of repulsion + spring +
 * centring, run ONCE per graph (not per tick). The result is memoised on the
 * node/edge key signature, so a 2-second poll that changed nothing does not
 * re-run the simulation and the picture does not twitch.
 *
 * Pure and exported so `layout.test.ts` can assert determinism and separation
 * without a canvas.
 */

/** A small deterministic PRNG (mulberry32). Seeded from a string, so the same
 *  graph always lays out the same way. */
export function seedFrom(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable signature for "is this the same graph?". */
export function signature(nodes, edges) {
  const parts = [];
  for (const n of nodes) parts.push(n.key);
  for (const e of edges) parts.push(`${e.kind}:${e.from}>${e.to}:${e.count}`);
  return parts.join("|");
}

/**
 * Lay out `nodes` and `edges` inside a width x height box.
 *
 * Returns a Map key -> {x, y, vx, vy}. Deterministic for a given signature.
 */
export function layout(nodes, edges, opts = {}) {
  const { width = 1200, height = 800, iterations = 300, seed = "comms-graph" } = opts;
  const rnd = mulberry32(seedFrom(`${seed}:${signature(nodes, edges)}`));
  const n = nodes.length;
  const pos = new Map();
  // Seed on a golden-angle spiral: even spread, deterministic, and it starts
  // the sim near the answer instead of in a pile.
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const r = 40 + (i / Math.max(1, n)) * Math.min(width, height) * 0.42;
    const a = i * golden;
    pos.set(nodes[i].key, {
      x: width / 2 + Math.cos(a) * r * (0.8 + rnd() * 0.4),
      y: height / 2 + Math.sin(a) * r * (0.8 + rnd() * 0.4),
      vx: 0,
      vy: 0,
    });
  }
  if (n <= 1) return pos;

  const index = new Map(nodes.map((node, i) => [node.key, i]));
  // Parent/child and relay edges pull harder than message edges: structure is
  // what a reader navigates by, traffic is a hint.
  const springOf = (e) => (e.kind === "message" ? 0.02 : 0.08);
  const idealOf = (e) => (e.kind === "message" ? 90 + Math.min(160, (e.count || 1) * 8) : 70);

  for (let it = 0; it < iterations; it++) {
    const cool = 1 - it / iterations;
    // Repulsion, O(n^2) but n is the CLUSTERED count (tens), not 156.
    for (let i = 0; i < n; i++) {
      const a = pos.get(nodes[i].key);
      for (let j = i + 1; j < n; j++) {
        const b = pos.get(nodes[j].key);
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          dx = (rnd() - 0.5) * 2;
          dy = (rnd() - 0.5) * 2;
          d2 = dx * dx + dy * dy + 0.01;
        }
        const f = 2400 / d2;
        const d = Math.sqrt(d2);
        a.vx += (dx / d) * f;
        a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f;
        b.vy -= (dy / d) * f;
      }
    }
    for (const e of edges) {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const f = (d - idealOf(e)) * springOf(e);
      a.vx += (dx / d) * f;
      a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f;
      b.vy -= (dy / d) * f;
    }
    for (let i = 0; i < n; i++) {
      const p = pos.get(nodes[i].key);
      // Weak centring, so a disconnected component does not drift off-canvas.
      p.vx += (width / 2 - p.x) * 0.006;
      p.vy += (height / 2 - p.y) * 0.006;
      p.x += p.vx * cool;
      p.y += p.vy * cool;
      p.vx *= 0.82;
      p.vy *= 0.82;
    }
  }
  void index;
  return pos;
}

/** Which node is under a point, if any. Topmost (last drawn) wins, which is
 *  how the renderer decides z-order too — one rule, used twice. */
export function hitTest(pos, x, y, radius = 18) {
  let best = null;
  for (const [key, p] of pos) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= radius && (!best || p.z >= best.z)) best = { key, p, d };
  }
  return best ? best.key : null;
}

/** The edge nearest a point, for "click an edge for the messages on it". */
export function hitEdge(edges, pos, x, y, tolerance = 8) {
  let best = null;
  for (const e of edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1) continue;
    let t = ((x - a.x) * dx + (y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + t * dx;
    const py = a.y + t * dy;
    const d = Math.hypot(px - x, py - y);
    if (d <= tolerance && (!best || d < best.d)) best = { edge: e, d };
  }
  return best ? best.edge : null;
}

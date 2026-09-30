/**
 * The canvas renderer.
 *
 * A canvas, not SVG and not DOM nodes, for one reason that matters: 100+
 * sessions is 100+ circles and possibly 2 000 edges, and a DOM node per shape
 * is 2 000 layout-and-paint objects the browser re-styles on every tick. One
 * canvas redraws in a few milliseconds and allocates nothing per frame beyond
 * the buffer it already owns.
 *
 * The animation the brief asks for — "a new message animates or flashes its
 * edge within seconds" — is a FLASH, and it is deliberately not physics: a
 * bright stroke that decays over ~1.5 s along the edge that just carried a
 * message. It is driven from a diff of the previous snapshot against the new
 * one (see `diffEdges` below), so a message that arrives while the tab is in
 * the background is still shown when it comes back, and one that is merely
 * still present in the ring is not re-flashed every poll.
 */
import { recency, STATES, stateOf } from "./model.js";

const BG = "#0b0d12";
const EDGE = "#334155";
const EDGE_DIM = "#1e293b";
const TEXT = "#e2e8f0";
const TEXT_DIM = "#94a3b8";

export const FLASH_MS = 1500;

/** Edges that gained messages since the last snapshot. */
export function diffEdges(prev, next) {
  const before = new Map((prev || []).map((e) => [`${e.kind}|${e.from}|${e.to}`, e]));
  const fresh = [];
  for (const e of next || []) {
    const key = `${e.kind}|${e.from}|${e.to}`;
    const old = before.get(key);
    if (!old) {
      // A brand-new edge is a flash, but a structural one (spawn/relay) is
      // not a conversation and must not steal the eye.
      if (e.kind === "message") fresh.push({ edge: e, at: Date.parse(e.lastAt) || Date.now() });
      continue;
    }
    if (e.lastAt !== old.lastAt) fresh.push({ edge: e, at: Date.parse(e.lastAt) || Date.now() });
  }
  return fresh;
}

export class GraphRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.pos = new Map();
    this.flashes = [];
    this.hover = null;
    this.selected = null;
    this.raf = null;
    this._resize = () => this.resize();
    window.addEventListener("resize", this._resize);
  }

  destroy() {
    window.removeEventListener("resize", this._resize);
    if (this.raf) cancelAnimationFrame(this.raf);
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = rect.width;
    this.h = rect.height;
  }

  /** Queue a flash for every edge that just carried something. */
  markNew(fresh) {
    const now = Date.now();
    for (const f of fresh) {
      this.flashes.push({ edge: f.edge, start: Math.min(now, f.at || now) });
    }
    // Bounded: a tab left open over a busy hour must not accumulate flashes.
    if (this.flashes.length > 60) this.flashes.splice(0, this.flashes.length - 60);
    this.start();
  }

  start() {
    if (this.raf) return;
    const loop = () => {
      this.raf = null;
      this.draw();
      if (this.flashes.length) this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  draw() {
    const { ctx } = this;
    if (!this.w) this.resize();
    const now = Date.now();
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, this.w, this.h);

    // Edges first, so nodes sit on top and a click always hits a node when
    // the two overlap.
    for (const e of this.edges || []) {
      const a = this.pos.get(e.from);
      const b = this.pos.get(e.to);
      if (!a || !b) continue;
      const isSel = this.selectedEdge && edgeKey(this.selectedEdge) === edgeKey(e);
      ctx.strokeStyle = isSel ? "#f8fafc" : e.kind === "message" ? EDGE : e.kind === "relay" ? "#a78bfa" : EDGE_DIM;
      ctx.lineWidth = Math.min(4, 0.6 + Math.log2(1 + (e.count || 1)) * 0.7);
      ctx.globalAlpha = e.kind === "message" ? 0.75 : 0.5;
      drawArrow(ctx, a, b, e);
      ctx.globalAlpha = 1;
      if (e.count > 1 && isSel) {
        ctx.fillStyle = TEXT_DIM;
        ctx.font = "11px ui-monospace, monospace";
        ctx.fillText(`${e.count}`, (a.x + b.x) / 2 + 6, (a.y + b.y) / 2 - 4);
      }
    }

    // Flashes on top of the static edges.
    this.flashes = this.flashes.filter((f) => now - f.start < FLASH_MS);
    for (const f of this.flashes) {
      const a = this.pos.get(f.edge.from);
      const b = this.pos.get(f.edge.to);
      if (!a || !b) continue;
      const t = 1 - (now - f.start) / FLASH_MS;
      ctx.save();
      ctx.strokeStyle = "#fbbf24";
      ctx.globalAlpha = t;
      ctx.lineWidth = 2 + 6 * t;
      ctx.shadowColor = "#fbbf24";
      ctx.shadowBlur = 18 * t;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
      this.start();
    }

    // WHICH NODES GET A LABEL, and this is the readability requirement.
    //
    // The first version labelled every node. At 234 nodes that is not a graph,
    // it is a wall of overlapping text: the screenshot proved it, and the brief
    // asks for readability at 100+ sessions. So labels are rationed:
    //
    //   - a node is labelled if it is hovered or selected, always;
    //   - otherwise the top `labelBudget` by "how much happened here", which is
    //     the same measure the eye should use: a lead with 16 messages matters
    //     more than a node that received one message hours ago.
    //
    // The budget scales down as the graph grows, so the count of labels on
    // screen stays roughly constant instead of growing with the corpus.
    const labelled = this.labelSet();
    for (const n of this.nodes || []) {
      const p = this.pos.get(n.key);
      if (!p) continue;
      const st = stateOf(n, now);
      const r = n.cluster ? 15 : 9;
      const isSel = this.selected === n.key;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = (STATES[st] || STATES.unknown).color;
      ctx.globalAlpha = st === "gone" ? 0.35 : 1;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (isSel || this.hover === n.key) {
        ctx.strokeStyle = "#f8fafc";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      if (!labelled.has(n.key)) continue;
      ctx.fillStyle = isSel || this.hover === n.key ? TEXT : TEXT_DIM;
      ctx.font = `${isSel ? "600 " : ""}11px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillText(labelFor(n), p.x + r + 4, p.y + 4);
      if (n.cluster) {
        ctx.fillStyle = TEXT;
        ctx.font = "10px ui-monospace, monospace";
        ctx.fillText(`${n.childWorking || 0}/${n.childCount - (n.childGone || 0)}`, p.x - 12, p.y + r + 12);
      }
    }
  }

  /**
   * The set of node keys that get a label this frame.
   *
   * Exported behaviour, not a private detail: `graph.test.ts` asserts the count
   * stays bounded as the node count grows, because "we drew a label for every
   * node" is precisely the bug the first screenshot caught.
   */
  labelSet(budget) {
    const nodes = this.nodes || [];
    const cap = budget ?? Math.max(12, Math.round(46 / Math.max(1, Math.sqrt(nodes.length / 40))));
    const score = (n) => (n.cluster ? 1000 + n.childCount : 0) + (n.messagesIn || 0) + (n.messagesOut || 0);
    const sorted = [...nodes].sort((a, b) => score(b) - score(a));
    const keep = new Set();
    for (const n of sorted) {
      if (keep.size >= cap) break;
      keep.add(n.key);
    }
    for (const k of [this.selected, this.hover]) if (k) keep.add(k);
    return keep;
  }

  setGraph(nodes, edges, pos) {
    this.nodes = nodes;
    this.edges = edges;
    this.pos = pos;
    this.draw();
  }

  /** The node or edge under the pointer, node first. */
  pick(x, y) {
    let bestNode = null;
    let bestD = Infinity;
    for (const n of this.nodes || []) {
      const p = this.pos.get(n.key);
      if (!p) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d <= 18 && d < bestD) {
        bestD = d;
        bestNode = n.key;
      }
    }
    if (bestNode) return { kind: "node", key: bestNode };
    return null;
  }
}

function edgeKey(e) {
  return `${e.kind}|${e.from}|${e.to}`;
}

function labelFor(n) {
  if (n.cluster) return `${n.name} +${n.childCount}`;
  return n.name.length > 22 ? `${n.name.slice(0, 21)}…` : n.name;
}

function drawArrow(ctx, a, b, e) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.max(1, Math.hypot(dx, dy));
  const ux = dx / d;
  const uy = dy / d;
  const endGap = 12;
  const ex = b.x - ux * endGap;
  const ey = b.y - uy * endGap;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(ex, ey);
  ctx.stroke();
  // An arrowhead, so direction is a shape and not only a colour.
  const size = 7;
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ex - ux * size - uy * size * 0.6, ey - uy * size + ux * size * 0.6);
  ctx.lineTo(ex - ux * size + uy * size * 0.6, ey - uy * size - ux * size * 0.6);
  ctx.closePath();
  ctx.fillStyle = ctx.strokeStyle;
  ctx.fill();
  void e;
  void recency;
}

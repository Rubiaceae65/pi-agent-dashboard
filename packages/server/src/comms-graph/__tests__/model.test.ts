/**
 * The client model, on fixtures — the failing-first half of the sub-app.
 *
 * `public/mobile/src/subagents.js` is tested from the server package by
 * importing the static ES module directly (`mobile-subagents.test.ts`). This
 * file does the same for `public/graph/src/model.js`: the sub-app has no build
 * step, so its module IS the unit, and a test that only looked at pixels would
 * be testing the canvas, not the decisions.
 *
 * What is asserted here is the decisions a person reads: which nodes exist,
 * which are folded, which messages a click shows, and that the folding is what
 * makes 100+ sessions legible.
 */
import { describe, expect, it } from "vitest";
import {
  ancestorKeys,
  clusterByLead,
  isFinished,
  leadList,
  messagesForNode,
  recency,
  selectGraph,
  stateOf,
  WINDOWS,
} from "../../../../../public/graph/src/model.js";

const NOW = Date.parse("2026-09-30T15:00:00.000Z");
const ago = (mins) => new Date(NOW - mins * 60_000).toISOString();

function node(key, over = {}) {
  return {
    key,
    name: key,
    kind: "lead",
    parent: null,
    depth: 0,
    state: "idle",
    lastActivityAt: ago(1),
    gone: false,
    ...over,
  };
}

describe("stateOf — what colour a node is drawn in", () => {
  it("lets gone win over any recorded state", () => {
    expect(stateOf(node("a", { gone: true, state: "working" }), NOW)).toBe("gone");
  });
  it("calls a quiet worker STALLED rather than working", () => {
    // 45 minutes is the threshold `atelier-prime-lead stalls` uses.
    const quiet = node("a", { state: "streaming", lastActivityAt: ago(50) });
    expect(stateOf(quiet, NOW)).toBe("stalled");
    const fresh = node("a", { state: "streaming", lastActivityAt: ago(2) });
    expect(stateOf(fresh, NOW)).toBe("streaming");
  });
  it("does not invent a state it does not have", () => {
    expect(stateOf(node("a", { state: null }), NOW)).toBe("unknown");
  });
});

describe("the time windows", () => {
  const g = {
    nodes: [node("a"), node("b")],
    edges: [
      { kind: "message", from: "a", to: "b", count: 5, firstAt: ago(200), lastAt: ago(200), lines: [] },
      { kind: "message", from: "a", to: "b", count: 1, firstAt: ago(5), lastAt: ago(5), lines: [] },
    ],
    recent: [],
  };
  it("offers exactly the three the brief asks for", () => {
    expect(WINDOWS.map((w) => w.id)).toEqual(["15m", "1h", "today"]);
  });
  it("a 15 minute window drops the edge that last spoke 200 minutes ago", () => {
    const s = selectGraph(g, { windowMs: WINDOWS[0].ms }, NOW);
    expect(s.edges).toHaveLength(1);
    expect(s.edges[0].count).toBe(1);
  });
});

describe("subtree filtering keeps the conversation, not just the family", () => {
  const g = {
    nodes: [node("leadA"), node("kid", { parent: "leadA", kind: "child" }), node("peer")],
    edges: [
      { kind: "message", from: "leadA", to: "kid", count: 1, firstAt: ago(1), lastAt: ago(1), lines: [] },
      { kind: "message", from: "leadA", to: "peer", count: 1, firstAt: ago(1), lastAt: ago(1), lines: [] },
    ],
    recent: [],
  };
  it("walks up the parent chain", () => {
    expect(ancestorKeys(g.nodes)("kid")).toEqual(["leadA"]);
  });
  it("keeps a lead's peer, because that exchange is why you are here", () => {
    const s = selectGraph(g, { subtree: "leadA" }, NOW);
    expect(s.nodes.map((n) => n.key).sort()).toEqual(["kid", "leadA", "peer"]);
  });
});

describe("clustering is what makes 100+ sessions readable", () => {
  function big() {
    const nodes = [node("lead1")];
    for (let i = 0; i < 40; i++) {
      nodes.push(node(`kid${i}`, { parent: "lead1", kind: "child", gone: i % 3 === 0 }));
    }
    return { nodes, edges: [], recent: [] };
  }
  it("folds a lead's children into the lead, keeping the count", () => {
    const c = clusterByLead(big(), { collapse: true });
    expect(c.nodes).toHaveLength(1);
    expect(c.nodes[0].cluster).toBe(true);
    expect(c.nodes[0].childCount).toBe(40);
    expect(c.nodes[0].childGone).toBe(14);
  });
  it("expands one lead on click without touching the others", () => {
    const many = { nodes: [node("lead1"), node("kid", { parent: "lead1", kind: "child" }), node("lead2"), node("kid2", { parent: "lead2", kind: "child" })], edges: [], recent: [] };
    const c = clusterByLead(many, { collapse: true, expanded: new Set(["lead1"]) });
    expect(c.nodes.map((n) => n.key).sort()).toEqual(["kid", "lead1", "lead2"]);
  });
  it("is a no-op when collapse is off", () => {
    const g = big();
    expect(clusterByLead(g, { collapse: false }).nodes).toHaveLength(41);
  });
});

describe("clicking a node", () => {
  // Oldest first, exactly as the indexer appends it (file order). Getting this
  // fixture backwards is how a "recent messages" panel ends up showing them in
  // reverse, so the order is part of the contract and not an accident.
  const recent = [
    { at: ago(3), firstLine: "three", from: "c", to: "d" },
    { at: ago(2), firstLine: "two", from: "b", to: "a" },
    { at: ago(1), firstLine: "one", from: "a", to: "b" },
  ];
  it("shows its messages, newest first, and only its own", () => {
    const m = messagesForNode(recent, "a");
    expect(m.map((x) => x.firstLine)).toEqual(["one", "two"]);
  });
  it("lists the leads that have a subtree, for the filter", () => {
    const list = leadList([node("leadA"), node("kid", { parent: "leadA", kind: "child" }), node("leadB")]);
    expect(list[0].key).toBe("leadA");
    expect(list[0].children).toBe(1);
  });
});

describe("isFinished — what the hide-finished filter removes", () => {
  it("is true for gone and for ended", () => {
    expect(isFinished(node("a", { gone: true }), NOW)).toBe(true);
    expect(isFinished(node("a", { state: "ended" }), NOW)).toBe(true);
    expect(isFinished(node("a"), NOW)).toBe(false);
  });
  it("is true for a node quiet for over an hour", () => {
    expect(isFinished(node("a", { lastActivityAt: ago(90) }), NOW)).toBe(true);
  });
});

describe("recency reads as words", () => {
  it("renders seconds, minutes, hours, days", () => {
    expect(recency(ago(0.5), NOW)).toBe("30s");
    expect(recency(ago(5), NOW)).toBe("5m");
    expect(recency(ago(180), NOW)).toBe("3h");
    expect(recency(ago(60 * 24), NOW)).toBe("1d");
    expect(recency(ago(180 * 24), NOW)).toBe("3d");
  });
});

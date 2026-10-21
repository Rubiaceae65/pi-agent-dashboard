/**
 * The phone client must nest an rlm sub-agent under its lead, exactly as the
 * desktop list does.
 *
 * `public/mobile/src/subagents.js` is plain ES module JS served as a static
 * file with no build step, so it has no TypeScript to lean on and no component
 * wrapper to catch a regression. These tests are the only thing standing
 * between it and the wire, and they run against the RECORDED payload of lead
 * `release-packaging-20260930` with its three children and one grandchild (see
 * `packages/server/src/__tests__/fixtures/rlm-subagents/`).
 *
 * The file is loaded through a dynamic import with an explicit `.js` suffix, so
 * the same relative path works whether the runner is ESM or CJS.
 *
 * See change: surface-rlm-subagent-children.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

type MobileSession = {
  id: string;
  name?: string;
  cwd?: string;
  status?: string;
  parentSessionId?: string;
  rlmDepth?: number;
};
type Row = { session: MobileSession; depth: number };

const mod = () => import("../../../../public/mobile/src/subagents.js") as Promise<any>;

const LEAD = "01a0f18d-643d-759e-969e-e29ad64012f6";
const RESEARCH = "01a0f18f-7d8d-760c-881d-efcb0b8db6f1";
const MAP = "01a0f18f-8ffc-75b9-841b-052732d446f4";
const INV = "01a0f18f-6154-709b-92d4-766431b6067d";
const SURVEY = "01a0f190-132d-7169-9f31-63bdea399a5f";

function child(id: string, parentId: string, over: Partial<MobileSession> = {}): MobileSession {
  return { id, name: id.slice(0, 8), cwd: "/projects/release-packaging-20260930", status: "ended", parentSessionId: parentId, rlmDepth: 1, ...over };
}
const LISTING: MobileSession[] = [
  child(RESEARCH, LEAD, { name: "research-prior-art", status: "active" }),
  child(MAP, LEAD, { name: "map-review" }),
  child(INV, LEAD, { name: "inv-components" }),
  child(SURVEY, INV, { name: "survey-planner", rlmDepth: 2 }),
  { id: LEAD, name: "release-packaging-20260930", cwd: "/projects/release-packaging-20260930", status: "active" },
];

describe("pi-mobile sub-agent nesting", () => {
  let m: any;
  beforeAll(async () => { m = await mod(); });

  it("keeps the lead at depth 0 and puts each child directly beneath its parent", () => {
    const rows: Row[] = m.flattenWithChildren(LISTING);
    const byId = new Map(rows.map((r) => [r.session.id, r.depth]));
    expect(byId.get(LEAD)).toBe(0);
    expect(byId.get(RESEARCH)).toBe(1);
    expect(byId.get(MAP)).toBe(1);
    expect(byId.get(INV)).toBe(1);
    expect(byId.get(SURVEY)).toBe(2);
  });

  it("emits every session exactly once — a child is never a peer of its lead", () => {
    const rows: Row[] = m.flattenWithChildren(LISTING);
    expect(rows.map((r) => r.session.id)).toHaveLength(LISTING.length);
    expect(new Set(rows.map((r) => r.session.id)).size).toBe(LISTING.length);
  });

  it("draws a child flat, not dropped, when its lead is absent from the poll", () => {
    // Real case: /api/sessions is paginated and a lead can be outside the
    // page. Losing the child would be a silent loss of real work.
    const rows: Row[] = m.flattenWithChildren([child(INV, LEAD, { status: "active" })]);
    expect(rows.map((r) => r.session.id)).toEqual([INV]);
    expect(rows[0].depth).toBe(0);
  });

  it("terminates on a cycle and still emits the members once", () => {
    const a = child("aaaaaaaa-0000-0000-0000-000000000000", "bbbbbbbb-0000-0000-0000-000000000000");
    const b = child("bbbbbbbb-0000-0000-0000-000000000000", "aaaaaaaa-0000-0000-0000-000000000000");
    const rows: Row[] = m.flattenWithChildren([a, b]);
    expect(rows.map((r) => r.session.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("marks a child row with its immediate parent and depth, and leaves a lead unmarked", () => {
    // Needs a DOM; jsdom is the client project's environment, so this one runs
    // against a minimal hand-rolled element rather than a browser.
    const made: any[] = [];
    (globalThis as any).document = {
      createElement: () => {
        const node: any = { className: "", textContent: "", dataset: {}, children: [] as any[] };
        node.appendChild = (c: any) => { node.children.push(c); return c; };
        made.push(node);
        return node;
      },
    };
    try {
      const leadRow = m.buildRow(LISTING[4], 0, () => {});
      expect(leadRow.dataset.subagentOf).toBeUndefined();
      expect(leadRow.className).toBe("row");

      const childRow = m.buildRow(LISTING[2], 1, () => {});
      expect(childRow.dataset.subagentOf).toBe(LEAD);
      expect(childRow.dataset.subagentDepth).toBe("1");
      expect(childRow.className).toContain("subagent");
      // The depth is capped for a 320px phone, never allowed to grow unbounded.
      const deep = m.buildRow(LISTING[3], 9, () => {});
      expect(deep.className).toContain("d4");
    } finally {
      delete (globalThis as any).document;
    }
  });
});

/**
 * A literal `null` in `/api/sessions` must not take the whole list down.
 *
 * Found from the phone view by the verifier (checks-11): one null element in the
 * payload makes `flattenWithChildren` throw on `s.parentSessionId`, so the page
 * renders NOTHING - not a degraded list, not an error row: no list at all. One
 * malformed row from one writer costs the reader the entire view.
 *
 * Two separate obligations, and both are tested:
 *   - the helpers are TOTAL: they answer a question about any input, including
 *     `null`, `undefined` and non-objects;
 *   - the RENDERED list drops the junk row rather than carrying it, because a
 *     row whose session is null cannot be drawn by anything downstream.
 */
describe("a malformed row cannot take the phone view down", () => {
  let m: any;
  beforeAll(async () => { m = await mod(); });

  it("isRlmChild answers for null, undefined and non-objects", () => {
    for (const junk of [null, undefined, 42, "session", [], true]) {
      expect(m.isRlmChild(junk)).toBe(false);
    }
  });

  it("indexChildrenByParent and topLevelRows survive a null element", () => {
    const withJunk = [null, ...LISTING];
    expect(() => m.indexChildrenByParent(withJunk)).not.toThrow();
    expect(() => m.topLevelRows(withJunk)).not.toThrow();
  });

  it("flattenWithChildren renders every good row and drops the junk", () => {
    const rows: Row[] = m.flattenWithChildren([null, ...LISTING, undefined]);
    expect(rows.map((r) => r.session.id).sort()).toEqual([LEAD, RESEARCH, MAP, INV, SURVEY].sort());
    expect(rows.every((r) => r.session != null)).toBe(true);
  });

  it("an ALL-junk payload is empty, not an exception", () => {
    expect(m.flattenWithChildren([null, null])).toEqual([]);
    expect(m.flattenWithChildren([])).toEqual([]);
  });
});

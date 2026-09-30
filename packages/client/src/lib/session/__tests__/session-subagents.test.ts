/**
 * The nesting rule for rlm children, on the RECORDED payload from the Atelier
 * Brain (2026-09-30, lead `release-packaging-20260930` = 01a0f18d-643d-…, with
 * children `inv-components`, `research-prior-art`, `map-review`, and
 * `survey-planner` under `inv-components`).
 *
 * The rows below are the exact shapes `GET /api/sessions` returned for those
 * four children and their lead — see
 * `packages/server/src/__tests__/fixtures/rlm-subagents/` for the raw payloads
 * the server test asserts on. The desktop list is grouped by DIRECTORY, so this
 * is the pass that stops a child reading as a peer of the agent that spawned it.
 *
 * See change: surface-rlm-subagent-children.
 */
import { describe, it, expect } from "vitest";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import {
  childrenOf,
  countDescendants,
  descendantsOf,
  indexChildrenByParent,
  isRlmChild,
  relativeDepths,
  planNesting,
  topLevelRows,
} from "../session-subagents.js";

const LEAD = "01a0f18d-643d-759e-969e-e29ad64012f6";

function lead(over: Partial<DashboardSession> = {}): DashboardSession {
  return {
    id: LEAD,
    cwd: "/projects/release-packaging-20260930",
    name: "release-packaging-20260930",
    source: "tui",
    status: "idle",
    startedAt: 1_790_759_100_000,
    ...over,
  };
}
function child(id: string, parentId: string, over: Partial<DashboardSession> = {}): DashboardSession {
  return {
    id,
    cwd: "/projects/release-packaging-20260930",
    name: id,
    source: "unknown",
    status: "ended",
    startedAt: 1_790_759_200_000,
    parentSessionId: parentId,
    rlmDepth: 1,
    rlmChildId: `sub-${id.slice(0, 8)}`,
    ...over,
  };
}

const INV = "01a0f18f-6154-709b-92d4-766431b6067d";
const RESEARCH = "01a0f18f-7d8d-760c-881d-efcb0b8db6f1";
const MAP = "01a0f18f-8ffc-75b9-841b-052732d446f4";
const SURVEY = "01a0f190-132d-7169-9f31-63bdea399a5f";

/** The real listing order the server produces: newest first, all five rows. */
const LISTING = [
  child(RESEARCH, LEAD, { name: "research-prior-art", status: "active" }),
  child(MAP, LEAD, { name: "map-review" }),
  child(INV, LEAD, { name: "inv-components" }),
  child(SURVEY, INV, { name: "survey-planner", rlmDepth: 2 }),
  lead(),
];

describe("isRlmChild", () => {
  it("is exactly the server's marker, so a legacy row is never mistaken for one", () => {
    expect(isRlmChild(lead())).toBe(false);
    expect(isRlmChild(child(INV, LEAD))).toBe(true);
    // An empty string is not a link. Treating it as one would file an unrelated
    // session under a nameless parent.
    expect(isRlmChild(lead({ parentSessionId: "" }))).toBe(false);
  });
});

describe("indexChildrenByParent / childrenOf", () => {
  it("files the three depth-1 children under the lead and the grandchild under its own parent", () => {
    const index = indexChildrenByParent(LISTING);
    expect(childrenOf(index, LEAD).map((c) => c.id).sort()).toEqual([INV, RESEARCH, MAP].sort());
    expect(childrenOf(index, INV).map((c) => c.id)).toEqual([SURVEY]);
    expect(childrenOf(index, SURVEY)).toEqual([]);
  });

  it("preserves the incoming order within a parent, so the list needs no re-sort", () => {
    const index = indexChildrenByParent(LISTING);
    expect(childrenOf(index, LEAD).map((c) => c.id)).toEqual([RESEARCH, MAP, INV]);
  });
});

describe("descendantsOf", () => {
  it("returns depth-first with a parent before its own children", () => {
    const index = indexChildrenByParent(LISTING);
    expect(descendantsOf(index, LEAD).map((c) => c.id)).toEqual([RESEARCH, MAP, INV, SURVEY]);
  });

  it("counts the whole subtree, not just direct children", () => {
    // 3 direct + 1 grandchild. A direct-only count would put "3" on a lead that
    // is actually running four children.
    const index = indexChildrenByParent(LISTING);
    expect(countDescendants(index, LEAD)).toBe(4);
    expect(countDescendants(index, INV)).toBe(1);
    expect(countDescendants(index, SURVEY)).toBe(0);
  });
});

describe("topLevelRows", () => {
  it("leaves the lead as the only top-level row — every child is reachable from it", () => {
    expect(topLevelRows(LISTING).map((s) => s.id)).toEqual([LEAD]);
  });

  it("keeps an unrelated session as a top-level row", () => {
    const other = lead({ id: "some-other-session", name: "other" });
    expect(topLevelRows([...LISTING, other]).map((s) => s.id).sort()).toEqual([LEAD, "some-other-session"].sort());
  });

  it("drops a child from the top level even when its parent is NOT in the list", () => {
    // The orphan case. It must not become a peer card here — but see the orphan
    // test below: the CALLER renders it, because a filter must not lose a child.
    const orphan = child(SURVEY, "a-parent-that-is-not-listed", { rlmDepth: 1 });
    expect(topLevelRows([orphan]).map((s) => s.id)).toEqual([]);
  });

  it("does not hang on a cycle, and does not emit a row twice", () => {
    const a = child("aaaaaaaa-0000-0000-0000-000000000000", "bbbbbbbb-0000-0000-0000-000000000000");
    const b = child("bbbbbbbb-0000-0000-0000-000000000000", "aaaaaaaa-0000-0000-0000-000000000000");
    const self = child("cccccccc-0000-0000-0000-000000000000", "cccccccc-0000-0000-0000-000000000000");
    // None of these hang, and none are rendered twice.
    expect(topLevelRows([a, b, self, lead()]).map((s) => s.id)).toEqual([LEAD]);
  });
});

describe("relativeDepths", () => {
  it("indents the grandchild two levels under the lead", () => {
    const index = indexChildrenByParent(LISTING);
    const depths = relativeDepths(index, LEAD);
    expect(depths.get(INV)).toBe(1);
    expect(depths.get(SURVEY)).toBe(2);
  });

  it("omits a child whose parent chain does not reach the root, rather than guessing a depth", () => {
    const index = indexChildrenByParent([child(SURVEY, "not-listed")]);
    expect(relativeDepths(index, LEAD).size).toBe(0);
  });

  it("terminates on a cycle instead of recursing forever", () => {
    const a = child("aaaaaaaa-0000-0000-0000-000000000000", "bbbbbbbb-0000-0000-0000-000000000000");
    const b = child("bbbbbbbb-0000-0000-0000-000000000000", "aaaaaaaa-0000-0000-0000-000000000000");
    const index = indexChildrenByParent([a, b]);
    expect(() => relativeDepths(index, "aaaaaaaa-0000-0000-0000-000000000000")).not.toThrow();
  });
});

describe("planNesting", () => {
  it("nests the three children under the lead and the grandchild under its own parent", () => {
    const plan = planNesting(LISTING);
    expect(plan.topLevel.map((s) => s.id)).toEqual([LEAD]);
    expect(plan.nested.get(LEAD)?.map((c) => c.id)).toEqual([RESEARCH, MAP, INV, SURVEY]);
    // `nested` holds top-level -> FLAT depth-first descendants, not a tree, so
    // the grandchild is reachable from the lead. The render pass gets its
    // indentation from relativeDepths(root) rather than re-walking.
    expect(plan.nested.size).toBe(1);
    const index = indexChildrenByParent(LISTING);
    expect(relativeDepths(index, LEAD).get(SURVEY)).toBe(2);
    expect(plan.orphans).toEqual([]);
  });

  it("adds no key for a row with no children, so an idle lead renders plainly", () => {
    const plan = planNesting([lead()]);
    expect(plan.nested.size).toBe(0);
    expect(plan.orphans).toEqual([]);
  });

  it("returns a child as an orphan rather than dropping it when the parent is filtered out", () => {
    // What a search for an unrelated string leaves behind. Losing the child
    // here would be a silent loss of real work.
    const plan = planNesting([child(INV, LEAD)]);
    expect(plan.topLevel).toEqual([]);
    expect(plan.orphans.map((s) => s.id)).toEqual([INV]);
  });

  it("places a child by PARENT, not by cwd — a cross-folder child still nests", () => {
    // The list is grouped by cwd BEFORE this pass runs, so in practice a
    // child whose parent is in another folder group arrives here without its
    // parent and is orphaned (the test above). This pins the rule that
    // grouping is the caller's job and this pass is cwd-agnostic: it never
    // relocates a child into, or out of, a folder.
    const crossFolder = child(INV, LEAD, { cwd: "/projects/other-lead-20260930" });
    const plan = planNesting([lead(), crossFolder]);
    expect(plan.nested.get(LEAD)?.map((c) => c.id)).toEqual([INV]);
    expect(plan.orphans).toEqual([]);
  });

  it("terminates on a cycle and returns the cycle as orphans instead of hanging", () => {
    const a = child("aaaaaaaa-0000-0000-0000-000000000000", "bbbbbbbb-0000-0000-0000-000000000000");
    const b = child("bbbbbbbb-0000-0000-0000-000000000000", "aaaaaaaa-0000-0000-0000-000000000000");
    const plan = planNesting([a, b, lead()]);
    expect(plan.topLevel.map((s) => s.id)).toEqual([LEAD]);
    expect(plan.orphans.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("preserves the caller's order at the top level, so partition order is untouched", () => {
    const other = lead({ id: "zzz", name: "zzz" });
    const plan = planNesting([...LISTING, other]);
    expect(plan.topLevel.map((s) => s.id)).toEqual([LEAD, "zzz"]);
  });
});

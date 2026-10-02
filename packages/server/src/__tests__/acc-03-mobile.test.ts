/**
 * ACCEPTANCE CHECK B4 — the `/mobile/` view, adversarial half.
 *
 * The author's mobile-subagents.test.ts covers the happy path on a recorded
 * payload. What it does not cover is what a phone poll can actually hand this
 * code: a self-parented row, a cycle, a child whose lead this poll did not
 * return, and a child arriving with no name. Those are the cases where "nested"
 * silently becomes "invisible" or "wrong".
 */
import { describe, it, expect, beforeAll } from "vitest";

const mod = () => import("../../../../public/mobile/src/subagents.js") as Promise<any>;

const LEAD = "aaaaaaaa-1111-4111-8111-111111111111";
const A = "bbbbbbbb-2222-4222-8222-222222222222";
const B = "cccccccc-3333-4333-8333-333333333333";
const GC = "dddddddd-4444-4444-8444-444444444444";

const child = (id: string, parent: string, o: Record<string, unknown> = {}) =>
  ({ id, name: id.slice(0, 8), cwd: "/projects/verify-fixture-lead", status: "ended",
     parentSessionId: parent, rlmDepth: 1, ...o });

describe("ACCEPTANCE: /mobile/ nests children under their lead", () => {
  let m: any;
  beforeAll(async () => { m = await mod(); });

  it("B4: each child is drawn at depth 1 and the grandchild at depth 2", () => {
    const rows: Array<{ session: any; depth: number }> = m.flattenWithChildren([
      child(A, LEAD, { name: "acc-a" }), child(B, LEAD, { name: "acc-b" }),
      child(GC, A, { name: "acc-gc", rlmDepth: 2 }),
      { id: LEAD, name: "verify-fixture-lead", cwd: "/projects/verify-fixture-lead", status: "active" },
    ]);
    const d = new Map(rows.map((r) => [r.session.id, r.depth]));
    expect(d.get(LEAD)).toBe(0);
    expect(d.get(A)).toBe(1);
    expect(d.get(B)).toBe(1);
    expect(d.get(GC)).toBe(2);
    // and the grandchild must come AFTER its own parent, or the indent reads backwards
    const order = rows.map((r) => r.session.id);
    expect(order.indexOf(GC)).toBeGreaterThan(order.indexOf(A));
  });

  it("B4: EVERY input row is drawn — none is lost to the nesting pass", () => {
    const input = [
      child(A, LEAD, { name: "acc-a" }),
      child(GC, A, { name: "acc-gc", rlmDepth: 2 }),
      { id: LEAD, name: "verify-fixture-lead", cwd: "/p", status: "active" },
    ];
    const rows = m.flattenWithChildren(input);
    expect(new Set(rows.map((r) => r.session.id))).toEqual(new Set(input.map((s) => s.id)));
  });

  it("EDGE: a child whose lead is absent from this poll is drawn, not dropped", () => {
    const rows = m.flattenWithChildren([child(A, LEAD, { name: "acc-orphan" })]);
    expect(rows.map((r) => r.session.id)).toContain(A);
  });

  it("EDGE: a SELF-parented row is drawn and does not hang the phone", () => {
    const t0 = Date.now();
    const rows = m.flattenWithChildren([
      child(A, A, { name: "acc-selfparent" }),
      { id: LEAD, name: "lead", cwd: "/p", status: "active" },
    ]);
    expect(Date.now() - t0, "flatten terminates").toBeLessThan(2000);
    expect(rows.map((r) => r.session.id)).toContain(A);
  });

  it("EDGE: a two-row cycle is drawn and does not hang the phone", () => {
    const t0 = Date.now();
    const rows = m.flattenWithChildren([
      child(A, B, { name: "acc-a" }), child(B, A, { name: "acc-b" }),
      { id: LEAD, name: "lead", cwd: "/p", status: "active" },
    ]);
    expect(Date.now() - t0, "flatten terminates").toBeLessThan(2000);
    expect(rows.map((r) => r.session.id)).toEqual(expect.arrayContaining([A, B]));
  });

  it("EDGE: a child with no name still renders a row that can be opened", () => {
    // no `name` and no `title`: the id must be the fallback, or the row is blank
    const bare = { id: A, cwd: "/p", status: "active", parentSessionId: LEAD };
    const rows = m.flattenWithChildren([bare, { id: LEAD, name: "lead", cwd: "/p", status: "active" }]);
    const r = rows.find((x: any) => x.session.id === A);
    expect(r, "the nameless child is in the list").toBeTruthy();
    expect(r.depth).toBe(1);
  });

  it("EDGE: a child marked with parentSessionId='' is NOT treated as a child", () => {
    // empty string is falsy-ish data; treating it as a parent link would file
    // the row under a parent named ""
    const rows = m.flattenWithChildren([
      { id: A, name: "acc-empty-parent", cwd: "/p", status: "active", parentSessionId: "" },
      { id: LEAD, name: "lead", cwd: "/p", status: "active" },
    ]);
    const r = rows.find((x: any) => x.session.id === A);
    expect(r.depth, "an empty parentSessionId is not a parent link").toBe(0);
  });
});

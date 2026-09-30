/**
 * The BOUNDS on `public/mobile/src/format.js` — the part the Playwright suite
 * does not reach.
 *
 * Written by the INDEPENDENT VERIFIER after finding, by mutation, that the
 * recursion guard is untested: replacing
 *
 *     if (depth >= MAX_DEPTH) return `(list of ${value.length})`;
 *
 * with the old `return String(value)` — which is exactly the `[object Object]`
 * bug this branch exists to kill — leaves all 8 Playwright tests GREEN. No
 * recorded fixture nests deeply enough to hit MAX_DEPTH (4), so the guard that
 * stops a hostile or pathological payload from recursing without limit has no
 * test standing behind it.
 *
 * These tests are unit tests on `fmt` rather than browser tests because the
 * property under test is arithmetic (depth and width bounds), and because a
 * browser test cannot cheaply assert "this terminates". `format.js` is plain
 * ES module JS served statically with no build step, so it is imported directly.
 */
import { describe, it, expect } from "vitest";
import { fmt } from "../../../../public/mobile/src/format.js";

/** A payload nested `depth` levels deep, alternating array/object. */
function nest(depth: number): unknown {
  let v: unknown = { leaf: "bottom" };
  for (let i = 0; i < depth; i++) v = i % 2 === 0 ? [v] : { k: v };
  return v;
}

describe("format.js — the depth guard that no recorded fixture reaches", () => {
  it("truncates an array nested past MAX_DEPTH instead of stringifying it", () => {
    const out = fmt(nest(9));
    // The mutation this pins: no `[object`, whatever the depth.
    expect(out).not.toMatch(/\[object/);
    expect(out).not.toContain("undefined");
    expect(out).not.toContain("NaN");
    // It says what it summarised instead of pretending it printed everything.
    expect(out).toMatch(/list of \d+|\d+ keys/);
  });

  it("truncates an object nested past MAX_DEPTH and reports the key count", () => {
    const deep: Record<string, unknown> = {};
    let cur = deep;
    for (let i = 0; i < 9; i++) {
      const next: Record<string, unknown> = {};
      cur.next = next;
      cur = next;
    }
    cur.leaf = "bottom";
    const out = fmt(deep);
    expect(out).not.toMatch(/\[object/);
    expect(out).toMatch(/keys\)/);
  });

  it("TERMINATES on a self-referential payload", () => {
    // The dangerous case: a cycle makes an unbounded walk hang the phone client
    // rather than merely print badly. A depth bound is what makes this return.
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    cyclic.list = [cyclic];
    let out = "";
    expect(() => {
      out = fmt(cyclic);
    }).not.toThrow();
    expect(out).not.toMatch(/\[object/);
  });

  it("keeps a mutually-referential pair from recursing without limit", () => {
    const a: Record<string, unknown> = { tag: "a" };
    const b: Record<string, unknown> = { tag: "b", a };
    a.b = b;
    const out = fmt(a);
    expect(out).not.toMatch(/\[object/);
    expect(out).toContain("a");
  });
});

describe("format.js — the width guards", () => {
  it("summarises an array wider than MAX_ITEMS and says how many it hid", () => {
    const wide = Array.from({ length: 120 }, (_, i) => `item-${i}`);
    const out = fmt(wide);
    expect(out).toMatch(/… 70 more/);
    expect(out).toContain("item-0");
  });

  it("summarises an object wider than MAX_ITEMS and says how many keys it hid", () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 120; i++) wide[`k${i}`] = i;
    const out = fmt(wide);
    expect(out).toMatch(/… 70 more keys/);
  });

  it("clips a long string and states the real length", () => {
    const out = fmt("x".repeat(1000));
    expect(out).toMatch(/… \[1000 chars total\]/);
  });
});

describe("format.js — the never-leak-the-words contract", () => {
  it.each([
    [null, "(null)"],
    [undefined, "(absent)"],
    [Number.NaN, "(NaN)"],
    [Number.POSITIVE_INFINITY, "(Infinity)"],
    [{ a: undefined }, "a: (absent)"],
  ])("renders %j as %s, never as a bare leaked word", (input, expected) => {
    const out = fmt(input);
    expect(out).toContain(expected);
    expect(out).not.toMatch(/\bundefined\b/);
    expect(out).not.toMatch(/\bNaN\b(?![)])/);
  });

  it("never emits [object ...] for any of a spread of odd values", () => {
    const odd: unknown[] = [
      { a: 1 },
      [1, 2, 3],
      [[{ a: [{ b: 1 }] }]],
      new Date(0),
      /re/g,
      { toString: () => "custom" },
      Object.create(null),
    ];
    for (const v of odd) expect(fmt(v)).not.toMatch(/\[object/);
  });
});

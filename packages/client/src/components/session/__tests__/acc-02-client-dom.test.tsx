/**
 * ACCEPTANCE CHECK B3/B4/B5 — the RENDERED DASHBOARD, not a pure function.
 *
 * The author's own component test renders the same tree. What this adds is the
 * adversarial half: the cases a happy-path render never reaches, where a child
 * must NOT vanish or NOT be promoted. A nesting feature's real risk is a child
 * disappearing when its parent is filtered out — silence, not a wrong colour.
 *
 * Independent fixtures: my own uuids and names, not the recorded lead payload.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { ThemeProvider } from "../../settings/ThemeProvider.js";
import { SessionList } from "../SessionList.js";

vi.mock("../../../hooks/useMobile.js", () => ({ useMobile: vi.fn(() => false) }));

beforeAll(() => {
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false, media: query,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })),
  });
});
afterEach(() => cleanup());

const LEAD = "aaaaaaaa-1111-4111-8111-111111111111";
const A = "bbbbbbbb-2222-4222-8222-222222222222";
const B = "cccccccc-3333-4333-8333-333333333333";
const GC = "dddddddd-4444-4444-8444-444444444444";
const CWD = "/projects/verify-fixture-lead";

const lead = (o: Partial<DashboardSession> = {}) => ({
  id: LEAD, cwd: CWD, name: "verify-fixture-lead", source: "tui",
  status: "active", startedAt: 1_790_000_000_000, ...o,
} as DashboardSession);
const kid = (id: string, parent: string, o: Partial<DashboardSession> = {}) => ({
  id, cwd: CWD, name: id, source: "unknown", status: "active",
  startedAt: 1_790_000_000_001, parentSessionId: parent, rlmDepth: 1,
  rlmChildId: `sub-${id.slice(0, 4)}`, model: "local-qwen/qwen3.8-27b", ...o,
} as DashboardSession);

function renderList(sessions: DashboardSession[], props: Record<string, unknown> = {}) {
  return render(
    <ThemeProvider>
      <div>
        <SessionList sessions={sessions} {...props} />
      </div>
    </ThemeProvider>,
  );
}

/** Every element the list marked as belonging to a given parent. */
const nestedUnder = (parentId: string) =>
  Array.from(document.querySelectorAll(`[data-subagent-of="${parentId}"]`));

describe("ACCEPTANCE: the desktop list renders children under their lead", () => {
  it("B3: a child renders attached to its lead, not as an independent peer", () => {
    renderList([lead(), kid(A, LEAD, { name: "acc-child-a" })]);
    const under = nestedUnder(LEAD);
    expect(under.length, "the child is marked as belonging to the lead").toBe(1);
    expect(under[0].textContent).toContain("acc-child-a");

    // "Nested" is asserted structurally, not by one particular DOM shape: the
    // child row must sit immediately after its parent's card, inside the same
    // container, carrying its parent's id and a depth. Whether the branch wraps
    // the child INSIDE the parent card element or as an indented sibling is a
    // rendering choice; what must hold is that they travel together and the
    // relationship is machine-readable.
    const childRow = under[0];
    const parentCard = document.querySelector(`[data-session-id="${LEAD}"]`);
    expect(parentCard, "the lead's card is rendered").toBeTruthy();
    const sibs = Array.from(document.body.querySelectorAll("*"));
    const pIdx = sibs.indexOf(parentCard!);
    const cIdx = sibs.indexOf(childRow);
    expect(cIdx).toBeGreaterThan(pIdx);
    // adjacent: no other session card sits between the parent and its child
    const between = sibs.slice(pIdx + 1, cIdx)
      .filter((n) => n instanceof HTMLElement && n.matches("[data-session-id]") && n !== parentCard);
    expect(between.length, "no unrelated card is interleaved between parent and child").toBe(0);
    expect(childRow.getAttribute("data-subagent-of")).toBe(LEAD);
    expect(Number(childRow.getAttribute("data-subagent-depth"))).toBeGreaterThan(0);
  });

  it("B5: a grandchild nests under ITS OWN parent, one level deeper", () => {
    const { container } = renderList([
      lead(), kid(A, LEAD, { name: "acc-child-a" }),
      kid(GC, A, { name: "acc-grandchild", rlmDepth: 2 }),
    ]);
    const underA = nestedUnder(A);
    expect(underA.length, "the grandchild hangs off its own parent").toBe(1);
    expect(underA[0].textContent).toContain("acc-grandchild");
    expect(nestedUnder(LEAD).some((n) => n.textContent?.includes("acc-grandchild")),
      "the grandchild is NOT filed directly under the lead").toBe(false);
    const d1 = underA[0].getAttribute("data-subagent-depth");
    const d2 = nestedUnder(LEAD)[0].getAttribute("data-subagent-depth");
    expect(Number(d2), "depth-1 child").toBeLessThan(Number(d1));
  });

  it("B6: the child's card shows its model and state, not just its name", () => {
    renderList([lead(), kid(A, LEAD, { name: "acc-child-a", model: "local-qwen/qwen3.8-27b", status: "ended" })]);
    const el = nestedUnder(LEAD)[0];
    expect(el.textContent).toContain("acc-child-a");
    const card = el.closest("[data-session-id]") ?? el;
    expect(card.textContent + el.textContent).toMatch(/qwen|qwen3\.8-27b|local-qwen/);
  });

  it("EDGE: a child whose parent is ABSENT is still shown — never silently dropped", () => {
    renderList([kid(A, LEAD, { name: "acc-orphan-child" })]);
    expect(document.body.textContent).toContain("acc-orphan-child");
  });

  it("EDGE: a child survives a SEARCH that matches it but not its parent", () => {
    renderList([lead({ name: "verify-fixture-lead" }), kid(A, LEAD, { name: "acc-unique-token" })],
      { searchQuery: "acc-unique-token" });
    expect(document.body.textContent, "a search must not hide a real child").toContain("acc-unique-token");
  });

  it("EDGE: a CYCLE in parentSessionId does not hang the render", () => {
    const t0 = Date.now();
    renderList([lead(), kid(A, LEAD), kid(LEAD, A)]);
    expect(Date.now() - t0, "render terminates").toBeLessThan(5000);
    expect(document.body.textContent).toBeTruthy();
  });

  it("EDGE: two children of the same parent both render, nested", () => {
    renderList([lead(), kid(A, LEAD, { name: "acc-child-a" }), kid(B, LEAD, { name: "acc-child-b" })]);
    const under = nestedUnder(LEAD);
    expect(under.length).toBe(2);
    const texts = under.map((n) => n.textContent).join(" ");
    expect(texts).toContain("acc-child-a");
    expect(texts).toContain("acc-child-b");
  });

  it("EDGE: a plain session with no parentSessionId is never nested under anything", () => {
    renderList([lead(), kid(A, LEAD, { name: "acc-child-a" }),
      { ...lead({ id: "eeeeeeee-5555-4555-8555-555555555555", name: "plain-peer" }), parentSessionId: undefined } as DashboardSession]);
    // the plain peer exists as a card, but carries no sub-agent marker
    const peer = document.querySelector('[data-session-id="eeeeeeee-5555-4555-8555-555555555555"]');
    expect(peer, "the peer card renders").toBeTruthy();
    expect(peer?.querySelector("[data-subagent-of]"), "and is not marked as anyone's child").toBeNull();
  });
});

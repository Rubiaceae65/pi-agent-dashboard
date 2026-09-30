/**
 * The desktop session list must render an rlm sub-agent CHILD inside its lead's
 * card, not beside it as a peer.
 *
 * Why this needs a component test: the grouping decision lives in
 * `SessionList.tsx`'s render pipeline, which partitions active/ended/lanes/pins
 * BEFORE any card is drawn. A pure-function test of `planNesting` proves the
 * rule but not that the component applies it at the right point — the
 * regression this guards against is precisely "a child partitioned as a peer and
 * rendered at the top level".
 *
 * Fixture is the RECORDED payload of lead `release-packaging-20260930` with its
 * three children and one grandchild. See
 * `packages/server/src/__tests__/fixtures/rlm-subagents/`.
 *
 * See change: surface-rlm-subagent-children.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { ThemeProvider } from "../../settings/ThemeProvider.js";
import { SessionList } from "../SessionList.js";

vi.mock("../../../hooks/useMobile.js", () => ({
  useMobile: vi.fn(() => false),
}));

// Harness glue copied from SessionCard.ended-reason.test.tsx: `SessionList`
// pulls in useInstallPrompt, which reads matchMedia at module scope.
beforeAll(() => {
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

afterEach(() => cleanup());

const LEAD = "01a0f18d-643d-759e-969e-e29ad64012f6";
const RESEARCH = "01a0f18f-7d8d-760c-881d-efcb0b8db6f1";
const MAP = "01a0f18f-8ffc-75b9-841b-052732d446f4";
const INV = "01a0f18f-6154-709b-92d4-766431b6067d";
const SURVEY = "01a0f190-132d-7169-9f31-63bdea399a5f";
const CWD = "/projects/release-packaging-20260930";

function lead(over: Partial<DashboardSession> = {}): DashboardSession {
  return {
    id: LEAD, cwd: CWD, name: "release-packaging-20260930",
    source: "tui", status: "active", startedAt: 1_790_759_100_000, ...over,
  } as DashboardSession;
}
function child(id: string, parentId: string, over: Partial<DashboardSession> = {}): DashboardSession {
  return {
    id, cwd: CWD, name: id.slice(0, 8), source: "unknown",
    status: "ended", startedAt: 1_790_759_200_000,
    parentSessionId: parentId, rlmDepth: 1, rlmChildId: `sub-${id.slice(0, 8)}`,
    ...over,
  } as DashboardSession;
}

const LISTING: DashboardSession[] = [
  child(RESEARCH, LEAD, { name: "research-prior-art", status: "active" }),
  child(MAP, LEAD, { name: "map-review" }),
  child(INV, LEAD, { name: "inv-components" }),
  child(SURVEY, INV, { name: "survey-planner", rlmDepth: 2 }),
  lead(),
];

function renderList(sessions: DashboardSession[]) {
  return render(
    <ThemeProvider>
      <SessionList
        sessions={sessions}
        selectedId={undefined}
        onSelect={vi.fn()}
      />
    </ThemeProvider>,
  );
}

describe("SessionList rlm sub-agent nesting", () => {
  it("renders each child inside a row that names its lead as the parent", () => {
    renderList(LISTING);
    for (const [childId, parentId] of [
      [RESEARCH, LEAD], [MAP, LEAD], [INV, LEAD], [SURVEY, INV],
    ] as const) {
      const row = screen.getByTestId(`subagent-row-${childId}`);
      expect(row.getAttribute("data-subagent-of")).toBe(parentId);
    }
  });

  it("does not render a child as a top-level card of its own", () => {
    // The regression this test exists for: a child partitioned as a peer
    // appears at the top level, indistinguishable from a lead.
    const { container } = renderList(LISTING);
    const nestedIds = [RESEARCH, MAP, INV, SURVEY].map((c) => `subagent-row-${c}`);
    for (const id of nestedIds) expect(container.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    // Every card in the list is either the lead itself or inside a nested row.
    const stray = container.querySelectorAll(
      `[data-session-id="${RESEARCH}"], [data-session-id="${MAP}"], [data-session-id="${INV}"], [data-session-id="${SURVEY}"]`,
    );
    for (const node of Array.from(stray)) {
      expect(node.closest("[data-subagent-of]")).not.toBeNull();
    }
  });

  it("indents the grandchild two levels under the lead, not one", () => {
    renderList(LISTING);
    expect(
      screen.getByTestId(`subagent-row-${INV}`).getAttribute("data-subagent-depth"),
    ).toBe("1");
    expect(
      screen.getByTestId(`subagent-row-${SURVEY}`).getAttribute("data-subagent-depth"),
    ).toBe("2");
  });

  it("keeps a live child visible when its parent has ended", () => {
    // The judgement call: a parent that ended while its child still runs must
    // stay in the ACTIVE tier, or the in-flight work hides behind the
    // ended-collapse and the lead reads as idle.
    const { container } = renderList([
      lead({ status: "ended" }),
      child(RESEARCH, LEAD, { name: "research-prior-art", status: "active" }),
    ]);
    expect(container.querySelector(`[data-testid="subagent-row-${RESEARCH}"]`)).not.toBeNull();
    expect(container.querySelector(`[data-testid="subagent-row-${LEAD}"]`)).toBeNull();
    // The lead is a top-level card again, and the child hangs off it.
    expect(container.querySelector(`[data-session-id="${LEAD}"]`)).not.toBeNull();
  });

  it("still renders a child as a flat card when its parent is not in the list", () => {
    const { container } = renderList([child(INV, LEAD, { name: "inv-components", status: "active" })]);
    expect(container.querySelector(`[data-session-id="${INV}"]`)).not.toBeNull();
    expect(container.querySelector(`[data-testid="subagent-row-${INV}"]`)).toBeNull();
  });
});

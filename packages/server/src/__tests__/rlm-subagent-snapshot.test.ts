/**
 * The websocket `sessions_snapshot` must carry rlm sub-agent children, not
 * only `GET /api/sessions`.
 *
 * WHY THIS TEST EXISTS — the defect the previous fix left standing. The
 * desktop client does NOT read its session list from the REST poll: on
 * connect the server sends `sessions_snapshot` and `useMessageHandler` does an
 * ATOMIC REPLACE of its whole `sessions` Map (change:
 * fix-stale-sessions-on-reconnect). So children merged into `GET /api/sessions`
 * by the rlm scanner are wiped the moment the socket opens. Measured on the
 * build this test guards: `/api/sessions` returned 8 rows including 6
 * children, while the rendered DOM contained 0 — the two leads and nothing
 * else. The REST route was fixed; the wire was not.
 *
 * A child cannot be broadcast live (it registers no bridge, so there is no
 * `session_added` to relay), but it CAN ride along in the connect snapshot,
 * which is what makes it appear at all.
 *
 * See change: surface-rlm-subagent-children.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LEAD = "01a0f18d-643d-759e-969e-e29ad64012f6";
const INV = "01a0f18f-6154-709b-92d4-766431b6067d";
const SURVEY = "01a0f190-132d-7169-9f31-63bdea399a5f";

let home: string;
let prevDir: string | undefined;

function sidecar(dir: string, over: Record<string, unknown>) {
  writeFileSync(join(dir, "rlm-subagent.json"), JSON.stringify({
    type: "rlm_subagent",
    status: "completed",
    rlmMaxDepth: 2,
    ...over,
  }, null, 2));
}
function transcript(dir: string, id: string, over: Record<string, unknown>) {
  writeFileSync(join(dir, `${id}.jsonl`), JSON.stringify({
    type: "session", version: 3, id,
    timestamp: new Date().toISOString(),
    cwd: "/projects/lead", rlmDepth: 1, ...over,
  }) + "\n");
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "rlm-snap-"));
  const agent = join(home, "agent");
  mkdirSync(join(agent, "sessions"), { recursive: true });
  const art = join(agent, "session-artifacts", LEAD);
  mkdirSync(join(art, "sub-a"), { recursive: true });
  sidecar(join(art, "sub-a"), {
    childId: "sub-a", sessionName: "inv-components", sessionFile: `${INV}.jsonl`,
  });
  transcript(join(art, "sub-a"), INV, {});
  mkdirSync(join(art, "sub-a", "sub-b"), { recursive: true });
  sidecar(join(art, "sub-a", "sub-b"), {
    childId: "sub-b", sessionName: "survey-planner", sessionFile: `${SURVEY}.jsonl`,
  });
  transcript(join(art, "sub-a", "sub-b"), SURVEY, { rlmDepth: 2, parentSession: `../${INV}.jsonl` });
  prevDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
});

afterEach(() => {
  if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevDir;
  rmSync(home, { recursive: true, force: true });
});

describe("rlm children in the connect snapshot", () => {
  it("carries children and the parent's childCount, not just the registered rows", async () => {
    const { withRlmChildrenInSnapshot } = await import("../session/rlm-subagent-snapshot.js");
    // A lead is REGISTERED with the manager, as any real lead is.
    const snapshot = { sessions: [{ id: LEAD, cwd: "/projects/lead", status: "ended" }], orders: {}, endedTotals: {} };
    const merged = withRlmChildrenInSnapshot(snapshot as any);

    const ids = merged.sessions.map((s: any) => s.id);
    expect(ids).toContain(INV);
    expect(ids).toContain(SURVEY);
    const lead = merged.sessions.find((s: any) => s.id === LEAD);
    expect(lead.childCount).toBe(1);
    const inv = merged.sessions.find((s: any) => s.id === INV);
    expect(inv.parentSessionId).toBe(LEAD);
    expect(inv.rlmDepth).toBe(1);
    const survey = merged.sessions.find((s: any) => s.id === SURVEY);
    expect(survey.parentSessionId).toBe(INV);
    expect(survey.rlmDepth).toBe(2);
  });

  it("never downgrades a registered row that shares a child's id", async () => {
    const { withRlmChildrenInSnapshot } = await import("../session/rlm-subagent-snapshot.js");
    // The live row is richer (it has tokens, model, bridge data). The disk
    // projection is a fallback, not an override — same precedence rule as
    // GET /api/sessions.
    const snapshot = {
      sessions: [
        { id: LEAD, cwd: "/projects/lead", status: "ended" },
        { id: INV, cwd: "/projects/lead", status: "active", tokensIn: 4242, source: "tui" },
      ],
      orders: {}, endedTotals: {},
    };
    const merged = withRlmChildrenInSnapshot(snapshot as any);
    const inv = merged.sessions.find((s: any) => s.id === INV);
    expect(inv.tokensIn).toBe(4242);
    expect(inv.source).toBe("tui");
  });

  it("is a no-op when there is no artifacts tree, so a plain pi install still snapshots", async () => {
    const { withRlmChildrenInSnapshot } = await import("../session/rlm-subagent-snapshot.js");
    delete process.env.PI_CODING_AGENT_DIR;
    const snapshot = { sessions: [{ id: LEAD }], orders: {}, endedTotals: {} };
    const merged = withRlmChildrenInSnapshot(snapshot as any);
    expect(merged.sessions).toHaveLength(1);
  });
});

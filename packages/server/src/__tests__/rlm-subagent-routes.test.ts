/**
 * `GET /api/sessions` must return a lead's rlm CHILDREN, linked to their parent.
 *
 * The defect this gates, measured 2026-09-30 on the Atelier Brain: the prime
 * daemon reported 27 live rlm children across the workshop and this endpoint
 * returned none of them. Cause: a child is an in-process sub-session that
 * registers no bridge (so it is not in `SessionManager`) and whose transcript
 * lives under `session-artifacts/`, a SIBLING of the scanned sessions dir (so it
 * is not in `scanAllSessions()`).
 *
 * `rlm-subagent-scanner.test.ts` gates the scanner. THIS file gates the
 * WIRING, through the real route on a real server, because a scanner that works
 * but is never called is a green check that proves nothing.
 *
 * See change: surface-rlm-subagent-children.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type DashboardServer } from "../server.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "rlm-subagents");
const LEAD = "01a0f18d-643d-759e-969e-e29ad64012f6";
const INV_COMPONENTS = "01a0f18f-6154-709b-92d4-766431b6067d";
const RESEARCH_PRIOR_ART = "01a0f18f-7d8d-760c-881d-efcb0b8db6f1";
const MAP_REVIEW = "01a0f18f-8ffc-75b9-841b-052732d446f4";
const SURVEY_PLANNER = "01a0f190-132d-7169-9f31-63bdea399a3f".replace("a3f", "a5f");
/**
 * Base time for the fixture mtimes, taken from the REAL clock.
 *
 * This was a hardcoded `2026-09-30T10:00:00Z`, which made this file a time
 * bomb: the scanner downgrades a `running` child to `ended` after 15 minutes of
 * transcript silence (RLM_RUNNING_STALE_MS), so a test that pinned mtimes to a
 * fixed past instant passed only while that instant was recent, and started
 * failing on its own with no code change. Caught 2026-09-30 when this test
 * failed at 10:23 having passed at 10:00. Anything that must be "1 minute ago"
 * has to be 1 minute ago from NOW.
 */
const NOW = Date.now();
const CHILD_IDS = [INV_COMPONENTS, RESEARCH_PRIOR_ART, MAP_REVIEW, SURVEY_PLANNER];

let home: string;
let artifacts: string;
let server: DashboardServer;
let base: string;

interface Row {
  id: string;
  name?: string;
  parentSessionId?: string;
  rlmDepth?: number;
  rlmChildId?: string;
  childCount?: number;
  status?: string;
  model?: string;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "rlm-route-"));
  // Lay out a throwaway prime-agent HOME with the real shape: `sessions/` and
  // its SIBLING `session-artifacts/`. The route derives the artifacts dir from
  // the resolved sessions dir's parent, so this is what makes the path real.
  const agentDir = join(home, "prime-agent", "agent");
  artifacts = join(agentDir, "session-artifacts");
  mkdirSync(artifacts, { recursive: true });
  mkdirSync(join(agentDir, "sessions"), { recursive: true });
  cpSync(FIXTURES, artifacts, { recursive: true });

  // The lead's own transcript, so the lead is a real row in this listing and the
  // `childCount` stamp has a parent to land on.
  const leadSess = join(agentDir, "sessions", `${LEAD}.jsonl`);
  writeFileSync(
    leadSess,
    `${JSON.stringify({ type: "session", version: 3, id: LEAD, timestamp: "2026-09-30T09:00:00.000Z", cwd: "/projects/release-packaging-20260930" })}\n`,
  );

  for (const rel of [
    `${LEAD}/sub-8a5ef7a4/${INV_COMPONENTS}.jsonl`,
    `${LEAD}/sub-5bfd46c3/${RESEARCH_PRIOR_ART}.jsonl`,
    `${LEAD}/sub-f2e1b6a6/${MAP_REVIEW}.jsonl`,
    `${LEAD}/sub-8a5ef7a4/sub-62abee8a/${SURVEY_PLANNER}.jsonl`,
  ]) {
    const when = (NOW - 60_000) / 1000;
    utimesSync(join(artifacts, rel), when, when);
  }

  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  server = await createServer({
    port: 0,
    piPort: 0,
    host: "127.0.0.1",
    dev: true,
    autoShutdown: false,
    shutdownIdleSeconds: 999,
    tunnel: false,
  });
  await server.start();
  base = `http://127.0.0.1:${server.httpPort()!}`;
});

afterAll(async () => {
  if (server) {
    try { await server.stop(); } catch { /* already down */ }
  }
  rmSync(home, { recursive: true, force: true });
  delete process.env.PI_CODING_AGENT_DIR;
});

async function rows(): Promise<Row[]> {
  const res = await fetch(`${base}/api/sessions`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { success: boolean; data: Row[] };
  expect(body.success).toBe(true);
  return body.data;
}

describe("GET /api/sessions — rlm children are present and linked to their lead", () => {
  it("returns the lead AND every recorded child", async () => {
    const ids = (await rows()).map((r) => r.id);
    expect(ids, "the lead itself").toContain(LEAD);
    for (const id of CHILD_IDS) expect(ids, id).toContain(id);
  });

  it("links each child to its parent by session id, with depth, name and child id", async () => {
    const byId = new Map((await rows()).map((r) => [r.id, r]));
    expect(byId.get(INV_COMPONENTS)?.name).toBe("inv-components");
    expect(byId.get(INV_COMPONENTS)?.parentSessionId).toBe(LEAD);
    expect(byId.get(INV_COMPONENTS)?.rlmDepth).toBe(1);
    expect(byId.get(INV_COMPONENTS)?.rlmChildId).toMatch(/^sub-/);
    // The grandchild hangs off ITS parent, not off the lead: a client that
    // groups on parentSessionId files it under the wrong card otherwise.
    expect(byId.get(SURVEY_PLANNER)?.parentSessionId).toBe(INV_COMPONENTS);
    expect(byId.get(SURVEY_PLANNER)?.rlmDepth).toBe(2);
  });

  it("stamps the lead with its DIRECT child count, excluding the grandchild", async () => {
    const byId = new Map((await rows()).map((r) => [r.id, r]));
    expect(byId.get(LEAD)?.childCount, "3 direct children, survey-planner excluded").toBe(3);
    expect(byId.get(INV_COMPONENTS)?.childCount).toBe(1);
  });

  it("carries the child's model and a state, so a card can say both", async () => {
    const byId = new Map((await rows()).map((r) => [r.id, r]));
    expect(byId.get(RESEARCH_PRIOR_ART)?.model).toBe("openrouter-mimo/stealth/space-bunny-alpha");
    // research-prior-art's real sidecar said `running`; its transcript was
    // touched a minute before NOW, so `active` is the honest report.
    expect(byId.get(RESEARCH_PRIOR_ART)?.status).toBe("active");
    // inv-components' real sidecar said `completed`.
    expect(byId.get(INV_COMPONENTS)?.status).toBe("ended");
  });

  it("leaves every non-child row free of the new fields, so an old client is unaffected", async () => {
    for (const r of await rows()) {
      if (CHILD_IDS.includes(r.id)) continue;
      expect(r.parentSessionId, r.id).toBeUndefined();
      expect(r.rlmDepth, r.id).toBeUndefined();
      expect(r.rlmChildId, r.id).toBeUndefined();
    }
  });
});

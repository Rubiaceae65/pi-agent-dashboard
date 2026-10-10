/**
 * RLM sub-agent discovery — the failing-first test for the defect this fixes.
 *
 * Recorded 2026-09-30 on the Atelier Brain (prime-agent 0.9.6). The fixture is
 * a REAL slice of `~/.prime/agent/session-artifacts/`, copied verbatim from the
 * lead `release-packaging-20260930` (session
 * `01a0f18d-643d-759e-969e-e29ad64012f6`), which at that moment had three
 * children and one of those had a child of its own:
 *
 *   sub-8a5ef7a4  inv-components        depth 1   (3 grandchildren)
 *   sub-5bfd46c3  research-prior-art   depth 1   status running
 *   sub-f2e1b6a6  map-review            depth 1
 *     sub-62abee8a  survey-planner      depth 2   (under sub-8a5ef7a4)
 *
 * The transcript headers and sidecars in the fixture are the real bytes, with
 * only the `parentSession` path rewritten to be relative so the tree is
 * portable. No field is invented.
 *
 * The defect, measured at the same moment: `prime-agent sessions --json`
 * reported 27 live children across the workshop, and `GET /api/sessions`
 * returned NONE of them — not one, at any depth.
 *
 * See change: surface-rlm-subagent-children.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { directChildCounts, scanRlmSubagents } from "../session/rlm-subagent-scanner.js";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "rlm-subagents");

/** The lead that owns the fixture tree. */
const LEAD = "01a0f18d-643d-759e-969e-e29ad64012f6";
const INV_COMPONENTS = "01a0f18f-6154-709b-92d4-766431b6067d";
const RESEARCH_PRIOR_ART = "01a0f18f-7d8d-760c-881d-efcb0b8db6f1";
const MAP_REVIEW = "01a0f18f-8ffc-75b9-841b-052732d446f4";
const SURVEY_PLANNER = "01a0f190-132d-7169-9f31-63bdea399a3f".replace("a3f", "a5f");

/** A fixed clock, so "fresh" vs "stale" is a fact of the test, not of the day. */
const NOW = Date.parse("2026-09-30T10:00:00.000Z");

let root: string;

/** Transcript path of each fixture child, relative to the copied tree root. */
const FILES = {
  invComponents: `${LEAD}/sub-8a5ef7a4/${INV_COMPONENTS}.jsonl`,
  researchPriorArt: `${LEAD}/sub-5bfd46c3/${RESEARCH_PRIOR_ART}.jsonl`,
  mapReview: `${LEAD}/sub-f2e1b6a6/${MAP_REVIEW}.jsonl`,
  surveyPlanner: `${LEAD}/sub-8a5ef7a4/sub-62abee8a/${SURVEY_PLANNER}.jsonl`,
} as const;

/**
 * Re-base a transcript's mtime onto the fixed clock, so "fresh" and "stale" are
 * facts of the test rather than of the day it runs. Copying a file preserves its
 * source mtime, which is the host's — and a test whose result depends on that
 * is a test that will pass on Tuesday and fail on Wednesday.
 */
function age(relPath: string, ageMs: number): void {
  const when = (NOW - ageMs) / 1000;
  utimesSync(join(root, relPath), when, when);
}

/** Every child comfortably inside the 6 h retention window and the 15 min
 *  staleness window except where a test says otherwise. */
function ageAll(): void {
  age(FILES.invComponents, 60_000);
  age(FILES.researchPriorArt, 5 * 60_000);
  age(FILES.mapReview, 20 * 60_000);
  age(FILES.surveyPlanner, 30 * 60_000);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "rlm-fixture-"));
  const walk = (from: string, to: string): void => {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const src = join(from, entry.name);
      const dst = join(to, entry.name);
      if (entry.isDirectory()) walk(src, dst);
      else copyFileSync(src, dst);
    }
  };
  walk(FIXTURES, root);
});

beforeEach(ageAll);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function scan(overrides: Record<string, unknown> = {}) {
  return scanRlmSubagents({ artifactsDir: root, now: NOW, ...overrides });
}

const byId = (rows: DashboardSession[], id: string) => rows.find((r) => r.id === id);

describe("scanRlmSubagents — the recorded real payloads", () => {
  it("finds all four children, at depth 1 and depth 2", () => {
    const { sessions } = scan();
    const ids = sessions.map((s) => s.id).sort();
    expect(ids).toEqual([INV_COMPONENTS, RESEARCH_PRIOR_ART, MAP_REVIEW, SURVEY_PLANNER].sort());
  });

  it("reads each child's real name, cwd and model from the sidecar and header", () => {
    const { sessions } = scan();
    const inv = byId(sessions, INV_COMPONENTS);
    expect(inv?.name).toBe("inv-components");
    expect(inv?.cwd).toBe("/projects/release-packaging-20260930");
    expect(inv?.model).toBe("openrouter-mimo/stealth/space-bunny-alpha");
  });

  it("links every depth-1 child to the lead by the lead's session uuid", () => {
    const { sessions } = scan();
    for (const id of [INV_COMPONENTS, RESEARCH_PRIOR_ART, MAP_REVIEW]) {
      expect(byId(sessions, id)?.parentSessionId, id).toBe(LEAD);
      expect(byId(sessions, id)?.rlmDepth, id).toBe(1);
      expect(byId(sessions, id)?.rlmChildId, id).toMatch(/^sub-[0-9a-f]{8}$/);
    }
  });

  it("links the grandchild to its own parent, not to the lead", () => {
    // This is the case a flat `sub-*` scan gets wrong: survey-planner's own
    // header names its parent's transcript, and its directory is nested inside
    // sub-8a5ef7a4. Reporting the LEAD here would file it under the wrong card.
    const { sessions } = scan();
    const grand = byId(sessions, SURVEY_PLANNER);
    expect(grand?.name).toBe("survey-planner");
    expect(grand?.parentSessionId).toBe(INV_COMPONENTS);
    expect(grand?.rlmDepth).toBe(2);
  });

  it("keeps a settled child listed — a child that vanishes the moment it reports back is half the defect", () => {
    // inv-components has `status: "completed"` in its sidecar and last wrote a
    // minute ago. It must still be listed.
    const { sessions } = scan();
    const inv = byId(sessions, INV_COMPONENTS);
    expect(inv, "settled 1 min ago").toBeDefined();
    expect(inv?.status).toBe("ended");
  });

  it("drops a child whose transcript has gone past the retention window", () => {
    // 9 h and 7 days, against a 6 h window. Reported in `skipped` with the
    // reason, so a vanished child is diagnosable rather than merely absent.
    age(FILES.mapReview, 9 * 60 * 60_000);
    age(FILES.surveyPlanner, 7 * 24 * 60 * 60_000);
    const { sessions, skipped } = scan();
    expect(byId(sessions, MAP_REVIEW), "9 h old, past retention").toBeUndefined();
    expect(byId(sessions, SURVEY_PLANNER), "7 days old, past retention").toBeUndefined();
    expect(byId(sessions, INV_COMPONENTS), "the fresh ones survive").toBeDefined();
    expect(skipped.filter((s) => /retention window/.test(s.reason)).length).toBe(2);
  });

  it("withholds a child's `running` claim once its transcript has gone cold", () => {
    // prime-agent's sidecar is not authoritative about liveness: a crashed
    // daemon leaves `status: running` on disk forever. A child whose transcript
    // has not been written inside the window is reported `ended`, not `active`.
    const { sessions } = scan({ runningStaleMs: 1000 });
    const stale = byId(sessions, RESEARCH_PRIOR_ART);
    expect(stale, "still listed, retention not shortened").toBeDefined();
    expect(stale?.status).toBe("ended");
  });

  it("reports a genuinely fresh running child as active", () => {
    const { sessions } = scan();
    expect(byId(sessions, RESEARCH_PRIOR_ART)?.status).toBe("active");
  });

  it("indexes children by parent so a client can nest them", () => {
    const { childrenByParent } = scan();
    expect(childrenByParent.get(LEAD)?.sort()).toEqual([INV_COMPONENTS, RESEARCH_PRIOR_ART, MAP_REVIEW].sort());
    expect(childrenByParent.get(INV_COMPONENTS)).toEqual([SURVEY_PLANNER]);
  });

  it("counts DIRECT children only — the lead is 3, and survey-planner is not one of them", () => {
    // The lead has three children; survey-planner is inv-components' child. A
    // count that swept the whole subtree would say 4 and put a grandchild on
    // the lead's own badge.
    const { sessions } = scan();
    const counts = directChildCounts(sessions);
    expect(counts.get(LEAD)).toBe(3);
    expect(counts.get(INV_COMPONENTS)).toBe(1);
  });

  it("sorts newest first, so the client's lane order needs no extra work", () => {
    const { sessions } = scan();
    const starts = sessions.map((s) => s.startedAt ?? 0);
    expect([...starts].sort((a, b) => b - a)).toEqual(starts);
  });
});

describe("scanRlmSubagents — hostile and absent input", () => {
  it("returns nothing, not a throw, when the artifacts dir does not exist", () => {
    const r = scanRlmSubagents({ artifactsDir: join(root, "no-such-dir"), now: NOW });
    expect(r.sessions).toEqual([]);
    expect(r.childrenByParent.size).toBe(0);
  });

  it("skips a child dir with no sidecar instead of crashing the whole scan", () => {
    const stray = join(root, LEAD, "sub-deadbeef");
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, "01a0f190-0000-0000-0000-000000000000.jsonl"), "{}\n");
    try {
      const { sessions, skipped } = scan();
      expect(sessions.map((s) => s.id)).not.toContain("01a0f190-0000-0000-0000-000000000000");
      expect(skipped.some((s) => s.dir === stray && /sidecar/.test(s.reason))).toBe(true);
    } finally {
      rmSync(stray, { recursive: true, force: true });
    }
  });

  it("refuses a sidecar whose sessionFile escapes its own directory", () => {
    const evil = join(root, LEAD, "sub-cafebabe");
    mkdirSync(evil, { recursive: true });
    writeFileSync(
      join(evil, "rlm-subagent.json"),
      JSON.stringify({ type: "rlm_subagent", childId: "sub-cafebabe", sessionFile: "../../../../etc/passwd" }),
    );
    try {
      const { sessions, skipped } = scan();
      expect(sessions.map((s) => s.id)).not.toContain("cafebabe");
      expect(skipped.some((s) => s.reason.includes("bare filename"))).toBe(true);
    } finally {
      rmSync(evil, { recursive: true, force: true });
    }
  });

  it("skips a transcript whose header is not JSON rather than emitting a blank row", () => {
    const broken = join(root, LEAD, "sub-0badbad0");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "rlm-subagent.json"), JSON.stringify({ type: "rlm_subagent", sessionFile: "x.jsonl" }));
    writeFileSync(join(broken, "x.jsonl"), "not json at all\n");
    try {
      const { sessions, skipped } = scan();
      expect(sessions.some((s) => s.sessionFile?.includes("0badbad0"))).toBe(false);
      expect(skipped.some((s) => s.dir === broken && /header/.test(s.reason))).toBe(true);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  it("honours maxDepth, so a deep tree cannot make the scan unbounded", () => {
    const { sessions } = scan({ maxDepth: 1 });
    expect(sessions.map((s) => s.id)).not.toContain(SURVEY_PLANNER);
    expect(sessions.map((s) => s.id).sort()).toEqual([INV_COMPONENTS, RESEARCH_PRIOR_ART, MAP_REVIEW].sort());
  });
});

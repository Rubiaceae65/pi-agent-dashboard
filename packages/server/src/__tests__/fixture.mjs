/**
 * Independent fixture builder for the acceptance checks.
 *
 * DELIBERATELY NOT the author's fixture set. These uuids, names and layouts are
 * mine, so a check that passes here is passing on the SHAPE of the tree, not on
 * a recorded snapshot of the author's own lead.
 *
 * Real shape (quoted from the author's payloads.md and confirmed against the
 * live tree at ~/.prime/agent/session-artifacts/<parent>/sub-<8hex>/<uuid>.jsonl):
 *   <agentDir>/sessions/<lead-uuid>.jsonl
 *   <agentDir>/session-artifacts/<lead-uuid>/sub-XXXXXXXX/rlm-subagent.json
 *   <agentDir>/session-artifacts/<lead-uuid>/sub-XXXXXXXX/<child-uuid>.jsonl
 * and a grandchild at sub-XXXXXXXX/sub-YYYYYYYY/<uuid>.jsonl
 */
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";

export const LEAD = "aaaaaaaa-1111-4111-8111-111111111111";
export const CHILD_A = "bbbbbbbb-2222-4222-8222-222222222222";
export const CHILD_B = "cccccccc-3333-4333-8333-333333333333";
export const GRANDCHILD = "dddddddd-4444-4444-8444-444444444444";

export function writeTranscript(dir, id, over = {}) {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${id}.jsonl`);
  writeFileSync(f, JSON.stringify({
    type: "session", version: 3, id,
    timestamp: "2026-09-30T08:00:00.000Z",
    cwd: "/projects/verify-fixture-lead",
    ...over,
  }) + "\n");
  return f;
}

export function writeSidecar(dir, over = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "rlm-subagent.json"), JSON.stringify({
    type: "rlm_subagent",
    rlmMaxDepth: 2,
    model: { provider: "local-qwen", modelId: "qwen3.8-27b" },
    ...over,
  }, null, 2));
}

/**
 * One child directory: <root>/sub-<hex>/, with its sidecar and transcript.
 *
 * `root` is the CONTAINING directory (artifacts/<parentId> for a depth-1 child,
 * or the parent's own child dir for a grandchild). `parentId` is what the
 * transcript header claims, and it is deliberately allowed to differ from the
 * directory name, because the scanner is supposed to trust the header.
 */
export function makeChild(parentDir, parentId, hex, id, opts = {}) {
  const dir = join(parentDir, `sub-${hex}`);
  writeSidecar(dir, {
    childId: `sub-${hex}`,
    sessionName: opts.name ?? `child-${hex}`,
    sessionFile: `${id}.jsonl`,
    status: opts.status ?? "completed",
    ...(opts.sidecarExtra ?? {}),
  });
  const f = writeTranscript(dir, id, {
    rlmDepth: opts.depth ?? 1,
    parentSession: `/home/u/.prime/agent/sessions/${parentId}.jsonl`,
    cwd: opts.cwd ?? "/projects/verify-fixture-lead",
  });
  return { dir, file: f, id };
}

/** Build the whole tree. Returns the paths a check needs. */
export function buildTree(home, opts = {}) {
  const agentDir = join(home, ".prime", "agent");
  const sessions = join(agentDir, "sessions");
  const artifacts = join(agentDir, "session-artifacts");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(artifacts, { recursive: true });

  // the lead itself, so it is a real row
  writeFileSync(join(sessions, `${LEAD}.jsonl`), JSON.stringify({
    type: "session", version: 3, id: LEAD,
    timestamp: "2026-09-30T07:00:00.000Z",
    cwd: "/projects/verify-fixture-lead",
  }) + "\n");

  const files = [];
  const a = makeChild(join(artifacts, LEAD), LEAD, "aaaa1111", CHILD_A, { name: "acceptance-child-a", status: "running", depth: 1 });
  const b = makeChild(join(artifacts, LEAD), LEAD, "bbbb2222", CHILD_B, { name: "acceptance-child-b", status: "completed", depth: 1 });
  files.push(a.file, b.file);
  // The grandchild's directory is nested INSIDE child A's own directory, which
  // is how prime-agent writes it; the scanner has to recurse to find it.
  const g = makeChild(a.dir, CHILD_A, "cccc3333", GRANDCHILD, { name: "acceptance-grandchild", depth: 2 });
  files.push(g.file);

  if (opts.touch !== false) {
    const now = Date.now() / 1000;
    for (const f of files) utimesSync(f, now - 30, now - 30); // 30 s ago: "recent"
  }
  if (opts.hostile) opts.hostile({ artifacts, agentDir, sessions });

  return { agentDir, sessions, artifacts, files };
}

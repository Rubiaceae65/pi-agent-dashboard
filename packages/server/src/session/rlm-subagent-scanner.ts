/**
 * RLM sub-agent scanner — discovers prime-agent's `rlm` CHILD sessions and
 * projects them as `DashboardSession` rows, so a lead's children appear in the
 * dashboard instead of being invisible.
 *
 * WHY THIS EXISTS (root cause, measured 2026-09-30 on brain2)
 * ------------------------------------------------------------
 * `scanAllSessions()` reads exactly one level under `resolvePiSessionsDir()`:
 * `~/.prime/agent/sessions/<uuid>.jsonl`. An rlm child's transcript is NOT
 * there. It is at
 *
 *   ~/.prime/agent/session-artifacts/<parent-session-uuid>/sub-<8hex>/<child-uuid>.jsonl
 *
 * — a SIBLING directory of `sessions`, which nothing in this repository
 * mentions. On top of that a child is an in-process sub-session: it runs no
 * bridge extension, so it never sends `session_register` and never enters
 * `SessionManager` either. Result: at that moment the daemon reported 27 live
 * children and `GET /api/sessions` returned zero of them.
 *
 * The fix is a second, independent discovery source rather than a change to the
 * bridge: rlm children cannot send a registration, so the only place their
 * existence is recorded is on disk. Each child directory also carries an
 * `rlm-subagent.json` sidecar naming it (`sessionName`, `model`, `status`), and
 * the child's own transcript header carries `parentSession` and `rlmDepth`.
 * Both are read here, and neither is invented by this module.
 *
 * See change: surface-rlm-subagent-children.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";

/** Sidecar prime-agent writes next to every rlm child transcript. */
export const RLM_SUBAGENT_SIDECAR = "rlm-subagent.json";

/** Directory-name prefix of an rlm child session directory. */
export const RLM_CHILD_DIR_PREFIX = "sub-";

/**
 * How deep the walk goes. prime-agent's own `rlmMaxDepth` default is 2, and a
 * grandchild's directory is nested INSIDE its parent's child directory
 * (`.../sub-A/sub-B/<uuid>.jsonl`), so a flat scan would find depth-1 children
 * and silently drop their children. Bounded so a corrupt or symlinked tree
 * cannot make the scan unbounded.
 */
export const RLM_MAX_WALK_DEPTH = 4;

/**
 * Finished children stay listed for this long after their last write, then stop
 * being reported. Without it a lead's finished children vanish the instant they
 * settle, which is the second half of "the dashboards miss them": you cannot
 * see a child that just reported back. Zero disables the window (running only).
 */
export const RLM_FINISHED_RETENTION_MS = 6 * 60 * 60 * 1000;

/**
 * Silence after which a child whose sidecar still says `running` is reported
 * `ended` instead of `active`.
 *
 * A separate question from the retention window, and deliberately much shorter.
 * A child's transcript is appended on every turn, so a live child writes to it
 * continuously; 15 minutes of total silence means it is not working. The
 * sidecar's own `running` flag cannot be trusted here: prime-agent updates it
 * in the worker that owns the child, so a crashed or evicted worker leaves
 * `running` on disk indefinitely (measured on brain2, 2026-09-30: 6 children
 * still marked `running` with transcripts 8-39 h old).
 */
export const RLM_RUNNING_STALE_MS = 15 * 60 * 1000;

export interface RlmSubagentSidecar {
  type?: string;
  childId?: string;
  sessionName?: string;
  sessionDir?: string;
  sessionFile?: string;
  rlmMaxDepth?: number;
  rlmParentNodeId?: string;
  status?: string;
  createdAt?: number;
  updatedAt?: string;
  model?: { provider?: string; modelId?: string };
}

export interface RlmSubagentScanOptions {
  /** Root that holds `<parent-session-uuid>/sub-<id>/…`. */
  artifactsDir: string;
  /** Epoch ms now; injected so tests are not clock-dependent. */
  now?: number;
  /** How long a finished child stays listed. Default 6 h. */
  finishedRetentionMs?: number;
  /** Silence after which a `running` child is downgraded to `ended`. Default 15 min. */
  runningStaleMs?: number;
  /** Walk bound. Default {@link RLM_MAX_WALK_DEPTH}. */
  maxDepth?: number;
}

export interface RlmSubagentScanResult {
  /** Child rows, each carrying `parentSessionId` + `rlmDepth`. */
  sessions: DashboardSession[];
  /** `parentSessionId -> child session ids`, for the UI's nesting pass. */
  childrenByParent: Map<string, string[]>;
  /** Directories that looked like children but were skipped, and why. */
  skipped: { dir: string; reason: string }[];
}

/** Read the first line of a JSONL transcript, parsed. `null` if unusable. */
function readSessionHeader(file: string): Record<string, unknown> | null {
  try {
    const fd = readFileSync(file, "utf-8");
    const nl = fd.indexOf("\n");
    const first = nl === -1 ? fd : fd.slice(0, nl);
    const parsed = JSON.parse(first);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readSidecar(file: string): RlmSubagentSidecar | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as RlmSubagentSidecar) : null;
  } catch {
    return null;
  }
}

/** `<uuid>.jsonl` -> `<uuid>`; anything else -> `undefined`. */
function sessionIdFromHeader(header: Record<string, unknown>, fallbackFile: string): string | undefined {
  if (typeof header.id === "string" && header.id) return header.id;
  const base = fallbackFile.replace(/\.jsonl$/, "");
  return /^[0-9a-fA-F-]{36}$/.test(base) ? base : undefined;
}

/**
 * prime-agent writes `parentSession` as the parent's transcript PATH. We need
 * the parent's session UUID, because that is the `id` the rest of the dashboard
 * keys on. Strip the directory and the `.jsonl` suffix; refuse anything that is
 * not a bare uuid rather than inventing a link.
 */
function parentIdFromHeader(header: Record<string, unknown>): string | undefined {
  const raw = header.parentSession;
  if (typeof raw !== "string" || !raw) return undefined;
  const base = raw.replace(/\.jsonl$/, "").split("/").pop() ?? "";
  return /^[0-9a-fA-F-]{36}$/.test(base) ? base : undefined;
}

function modelLabel(sidecar: RlmSubagentSidecar | null, header: Record<string, unknown>): string | undefined {
  const provider = sidecar?.model?.provider;
  const modelId = sidecar?.model?.modelId ?? (typeof header.modelId === "string" ? header.modelId : undefined);
  if (!provider && !modelId) return undefined;
  return provider && modelId ? `${provider}/${modelId}` : (modelId ?? provider);
}

/**
 * `status` for a child row. prime-agent's sidecar vocabulary is
 * `running | completed | deleted`; the dashboard's `SessionStatus` is
 * `active | idle | streaming | ended`. `running` is mapped to `active` because a
 * running child is genuinely mid-task; everything else is `ended`.
 *
 * A sidecar can be stale — a crashed daemon leaves `running` on disk forever
 * (measured: children marked `running` with a 39 h old transcript). So
 * `running` is only honoured while the transcript is still being written inside
 * the retention window; past that the child is reported `ended`, which is what
 * it is. This is a deliberate disagreement with the sidecar, and it is stated
 * here rather than hidden.
 */
function statusFor(sidecar: RlmSubagentSidecar | null, mtimeMs: number, now: number, staleMs: number): "active" | "ended" {
  if (sidecar?.status !== "running") return "ended";
  return now - mtimeMs <= staleMs ? "active" : "ended";
}

/**
 * Walk one child directory into a row, recursing into ITS sub-directories.
 *
 * Returns the rows found at and below `dir` (the child first, then its own
 * children), or an `error` explaining why this directory is not a usable child.
 * The parent link comes from the child's own transcript header wherever the
 * header states one, because prime-agent writes it there; the directory
 * structure is the fallback, not the authority.
 */
function scanChildDir(
  dir: string,
  enclosingParentId: string,
  depth: number,
  now: number,
  retentionMs: number,
  staleMs: number,
  maxDepth: number,
  skipped: { dir: string; reason: string }[],
): { rows: DashboardSession[] } | { error: string } {
  const sidecarPath = join(dir, RLM_SUBAGENT_SIDECAR);
  if (!existsSync(sidecarPath)) return { error: "no rlm-subagent.json sidecar" };
  const sidecar = readSidecar(sidecarPath);
  if (!sidecar) return { error: "rlm-subagent.json is not readable JSON" };

  const fileName = sidecar.sessionFile ?? "";
  // Defence in depth: a sidecar is DATA. `join(dir, "../../../etc/passwd")` would
  // read outside the child directory, so require a BARE filename. Checked BEFORE
  // the extension so a traversing path is reported as what it is, rather than
  // as a missing `.jsonl`.
  if (fileName !== fileName.split("/").pop()) return { error: "sidecar sessionFile is not a bare filename" };
  if (!fileName.endsWith(".jsonl")) return { error: "sidecar has no sessionFile" };
  const transcript = join(dir, fileName);
  if (!existsSync(transcript)) return { error: `transcript ${fileName} is missing` };

  const header = readSessionHeader(transcript);
  if (!header) return { error: "transcript has no readable session header" };
  const id = sessionIdFromHeader(header, fileName);
  if (!id) return { error: "no session id in header or filename" };

  let mtimeMs: number;
  try {
    mtimeMs = statSync(transcript).mtimeMs;
  } catch {
    return { error: "transcript is not statable" };
  }

  // Depth-1 children live in a directory named after the PARENT session uuid, so
  // the enclosing directory is the parent. Deeper children are nested inside
  // their parent's child directory, so the enclosing session id is theirs.
  // Retention: a child whose transcript has not been written inside the window
  // stops being reported. This is the fix for the second half of the defect —
  // without it a lead's finished children disappear the instant they settle, so
  // you cannot see the child that just reported back. A `running` sidecar does
  // NOT exempt a child from it: a crashed daemon leaves `running` on disk
  // forever (measured: 39 h), and honouring that would show a dead child as
  // live forever.
  if (now - mtimeMs > retentionMs) return { error: `transcript untouched for ${Math.round((now - mtimeMs) / 60000)} min, past the ${Math.round(retentionMs / 60000)} min retention window` };

  const parentSessionId = parentIdFromHeader(header) ?? enclosingParentId;
  const startedAt = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : mtimeMs;

  const row: DashboardSession = {
    id,
    name: sidecar.sessionName,
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    // prime-agent children are not bridge-attached, so there is no honest value
    // from `SessionSource`'s vocabulary. `unknown` is the member that means
    // "provenance not reported" rather than a false claim of a TUI.
    source: "unknown",
    status: statusFor(sidecar, mtimeMs, now, staleMs),
    startedAt: Number.isFinite(startedAt) ? startedAt : mtimeMs,
    lastActivityAt: mtimeMs,
    sessionFile: transcript,
    model: modelLabel(sidecar, header),
    // The three fields this change adds. Absent on every non-child session, so
    // `parentSessionId === undefined` is exactly "not a child".
    rlmChildId: sidecar.childId,
    rlmDepth: typeof header.rlmDepth === "number" ? header.rlmDepth : depth,
    parentSessionId,
  };

  const rows: DashboardSession[] = [row];
  if (depth + 1 <= maxDepth) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.startsWith(RLM_CHILD_DIR_PREFIX)) continue;
      const sub = scanChildDir(join(dir, entry), id, depth + 1, now, retentionMs, staleMs, maxDepth, skipped);
      if ("error" in sub) {
        skipped.push({ dir: join(dir, entry), reason: sub.error });
        continue;
      }
      rows.push(...sub.rows);
    }
  }
  return { rows };
}

/**
 * Discover every rlm child under `artifactsDir`, newest first.
 *
 * `artifactsDir` holds one directory per parent session, each containing that
 * session's `sub-<id>` child directories. A top-level session is not a child and
 * never appears here; only `sub-*` directories do.
 *
 * Returns the child rows plus a `parentSessionId -> child ids` index, which is
 * what the client needs to nest them and what a lead's `childCount` is derived
 * from.
 */
export function scanRlmSubagents(opts: RlmSubagentScanOptions): RlmSubagentScanResult {
  const now = opts.now ?? Date.now();
  const retentionMs = opts.finishedRetentionMs ?? RLM_FINISHED_RETENTION_MS;
  const staleMs = opts.runningStaleMs ?? RLM_RUNNING_STALE_MS;
  const maxDepth = opts.maxDepth ?? RLM_MAX_WALK_DEPTH;
  const sessions: DashboardSession[] = [];
  const childrenByParent = new Map<string, string[]>();
  const skipped: { dir: string; reason: string }[] = [];

  let roots: string[];
  try {
    roots = readdirSync(opts.artifactsDir);
  } catch {
    // No artifacts dir (a plain pi install, or HOME redirected): no children.
    return { sessions, childrenByParent, skipped };
  }

  for (const root of roots) {
    const rootDir = join(opts.artifactsDir, root);
    let entries: string[];
    try {
      if (!statSync(rootDir).isDirectory()) continue;
      entries = readdirSync(rootDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith(RLM_CHILD_DIR_PREFIX)) continue;
      const res = scanChildDir(join(rootDir, entry), root, 1, now, retentionMs, staleMs, maxDepth, skipped);
      if ("error" in res) {
        skipped.push({ dir: join(rootDir, entry), reason: res.error });
        continue;
      }
      for (const row of res.rows) {
        sessions.push(row);
        if (row.parentSessionId) {
          const list = childrenByParent.get(row.parentSessionId);
          if (list) list.push(row.id);
          else childrenByParent.set(row.parentSessionId, [row.id]);
        }
      }
    }
  }

  sessions.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return { sessions, childrenByParent, skipped };
}

/**
 * Number of DIRECT children per parent id, from a scan result. Counted from the
 * rows rather than from `childrenByParent` so a parent whose only child is a
 * grandchild-sibling cannot inflate the number.
 */
export function directChildCounts(rows: readonly DashboardSession[]): Map<string, number> {
  const counts = new Map<string, number>();
  const depthOf = new Map(rows.map((r) => [r.id, r.rlmDepth ?? 1]));
  for (const r of rows) {
    if (!r.parentSessionId) continue;
    // Only a row whose OWN depth is one more than its parent's is a direct child.
    const parentDepth = depthOf.get(r.parentSessionId);
    if (parentDepth !== undefined && (r.rlmDepth ?? 1) !== parentDepth + 1) continue;
    counts.set(r.parentSessionId, (counts.get(r.parentSessionId) ?? 0) + 1);
  }
  return counts;
}

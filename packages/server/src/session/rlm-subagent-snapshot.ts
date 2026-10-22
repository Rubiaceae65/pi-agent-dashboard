/**
 * Fold prime-agent rlm sub-agent CHILDREN into the websocket connect snapshot.
 *
 * WHY THIS EXISTS
 * ---------------
 * The first half of this change put children into `GET /api/sessions`. That is
 * necessary and not sufficient, because the desktop client does not read its
 * list from that poll. On connect the server sends `sessions_snapshot`, and
 * `useMessageHandler` REPLACES its entire `sessions` Map on receipt (change:
 * fix-stale-sessions-on-reconnect, deliberately atomic so a session from a
 * previous server lifetime cannot linger). Measured on this build, served from
 * the sandbox against real data: `GET /api/sessions` returned 8 rows including
 * 6 children, and the rendered DOM contained 0 — the two leads and nothing
 * else, because the snapshot had already overwritten the poll.
 *
 * So the wire needs the same merge. A child still cannot be broadcast LIVE (it
 * registers no bridge, so there is no `session_added` to relay — see
 * `rlm-subagent-scanner.ts` for why), but it can ride along in the connect
 * snapshot, which is what makes it appear at all. It will not update until the
 * client reconnects or re-polls; that residual gap is stated in REPORT.md
 * rather than papered over.
 *
 * Merge precedence is identical to the REST route: a registered/live row wins
 * on id collision, and the disk projection is a fallback. `childCount` is
 * stamped onto whichever parent row is present.
 *
 * See change: surface-rlm-subagent-children.
 */
import { resolveRlmArtifactsDir } from "@blackbelt-technology/pi-dashboard-shared/dashboard-paths.js";
import { directChildCounts, scanRlmSubagents } from "./rlm-subagent-scanner.js";

/** The one field of a session row this merge reads and the one it stamps. */
export interface SnapshotRow {
  id?: string;
  childCount?: number;
}

/**
 * The subset of the connect snapshot this merge touches.
 *
 * Generic over the row type so the caller's real shape survives the call:
 * `buildSnapshot()` returns `DashboardSession[]` plus `orders`/`endedTotals`,
 * and `sessions_snapshot` requires all three. The previous index-signature
 * shape (`Record<string, unknown>`) rejected `DashboardSession` (an interface
 * has no index signature) and widened the result so the frame lost `orders`
 * and `endedTotals` at the type level - two tsc errors in browser-gateway.ts.
 */
export interface SnapshotLike<R extends SnapshotRow = SnapshotRow> {
  sessions: R[];
}

/**
 * Returns a NEW snapshot with rlm children merged in. The input is not
 * mutated: `buildSnapshot()`'s result is also used for `orders` and
 * `endedTotals` by the caller, and a child is not in the manager's order map.
 *
 * A no-op (same object) when there is no artifacts tree, so a plain pi install
 * with no rlm children snapshots exactly as before.
 */
export function withRlmChildrenInSnapshot<R extends SnapshotRow, T extends SnapshotLike<R>>(snapshot: T & SnapshotLike<R>): T {
  const artifactsDir = resolveRlmArtifactsDir();
  if (!artifactsDir) return snapshot;

  const { sessions: children } = scanRlmSubagents({ artifactsDir });
  if (children.length === 0) return snapshot;

  const merged = new Map<string, R>();
  for (const row of snapshot.sessions) {
    if (row?.id) merged.set(row.id, row);
  }
  // Present-in-snapshot wins, so a child that ever DOES get a richer live row
  // is not downgraded to the disk projection.
  for (const child of children) {
    // A child is a disk projection of the same session-row shape the REST
    // route serves; it carries `id` and is merged as a row of the caller's type.
    if (!merged.has(child.id)) merged.set(child.id, child as unknown as R);
  }
  for (const [parentId, count] of directChildCounts(children)) {
    const parent = merged.get(parentId);
    // Only stamp a parent that is actually in the snapshot; a child whose
    // parent the dashboard does not know about gets no phantom row.
    if (parent) parent.childCount = count;
  }
  return { ...snapshot, sessions: [...merged.values()] };
}

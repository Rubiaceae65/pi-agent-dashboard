/**
 * Nesting pass for prime-agent rlm sub-agent children.
 *
 * A child arrives as an ordinary `DashboardSession` that additionally carries
 * `parentSessionId` (server change: surface-rlm-subagent-children). The session
 * list is grouped by DIRECTORY, so without this a child lands in its own folder
 * group beside its lead, or — when the two share a cwd — as a peer card with no
 * visible relationship to the agent that spawned it. Neither says "this is
 * `inv-components`, working for `release-packaging-20260930`".
 *
 * Pure functions, no React, so the rule is unit-testable without a DOM. The
 * component calls them and renders the result.
 *
 * Two decisions worth stating, because both are judgement calls:
 *
 * 1. A child whose parent is not in the given list is NOT dropped. It is
 *    returned as an orphan so the caller can render it flat. Dropping it would
 *    make a child disappear whenever the parent's card is filtered out by a
 *    search, a tag filter, or the ended-collapse — the child is real work and
 *    hiding it because its parent scrolled out of a filter is a silent loss.
 *
 * 2. Children are NOT removed from `rows` here. The caller decides, because
 *    `SessionList` partitions into active/ended/lanes/pins before it renders
 *    anything, and a child removed from the input would never reach the point
 *    where nesting is applied. `extractChildren` is the single place that knows
 *    which rows are children, so partition and render cannot disagree.
 */
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";

/** A session that is an rlm child, per the server's own marker. */
export function isRlmChild(session: DashboardSession): boolean {
  return typeof session.parentSessionId === "string" && session.parentSessionId.length > 0;
}

/** Parent id -> its direct children, in the order they were given. */
export function indexChildrenByParent(sessions: readonly DashboardSession[]): Map<string, DashboardSession[]> {
  const index = new Map<string, DashboardSession[]>();
  for (const s of sessions) {
    if (!isRlmChild(s)) continue;
    const parentId = s.parentSessionId as string;
    const list = index.get(parentId);
    if (list) list.push(s);
    else index.set(parentId, [s]);
  }
  return index;
}

/** Direct children of `parentId`, or `[]`. */
export function childrenOf(
  index: Map<string, DashboardSession[]>,
  parentId: string,
): DashboardSession[] {
  return index.get(parentId) ?? [];
}

/** How many children `parentId` has in `index`, including deeper descendants. */
export function countDescendants(
  index: Map<string, DashboardSession[]>,
  parentId: string,
): number {
  const seen = new Set<string>();
  const walk = (id: string): number => {
    let total = 0;
    for (const child of index.get(id) ?? []) {
      if (seen.has(child.id)) continue; // cycle guard, see descendantsOf
      seen.add(child.id);
      total += 1 + walk(child.id);
    }
    return total;
  };
  return walk(parentId);
}

/**
 * Every rlm descendant of `parentId`, depth-first, parents before their own
 * children. A grandchild appears after its own parent, which is the only order
 * that makes an indented tree readable.
 */
export function descendantsOf(
  index: Map<string, DashboardSession[]>,
  parentId: string,
): DashboardSession[] {
  const out: DashboardSession[] = [];
  const emitted = new Set<string>([parentId]);
  const walk = (id: string): void => {
    for (const child of index.get(id) ?? []) {
      // A malformed `parentSessionId` can point at an ancestor and make this
      // walk non-terminating, which takes the whole session list down with a
      // stack overflow. Emitting each row at most once bounds it.
      if (emitted.has(child.id)) continue;
      emitted.add(child.id);
      out.push(child);
      walk(child.id);
    }
  };
  walk(parentId);
  return out;
}

/**
 * The rows that are NOT rlm children — what the list should partition and render
 * as top-level cards. Everything else is reachable from a parent through
 * {@link descendantsOf}.
 *
 * A cycle (a malformed `parentSessionId` pointing at itself or into a loop) must
 * not hang the UI. Every member of such a cycle names a parent, so none of them
 * is a top-level row and the cycle renders nowhere — a row that cannot be placed
 * beats an infinite loop, and throwing would take the whole list down.
 */
export function topLevelRows(sessions: readonly DashboardSession[]): DashboardSession[] {
  // A row that names a parent IS a child, whether or not that parent is in the
  // list. Deriving this by walking the tree instead would be equivalent on a
  // well-formed listing and wrong on a malformed one: a row whose
  // `parentSessionId` is its own id is its own ancestor, so no downward walk
  // from any top-level row reaches it, and it would surface as a peer card.
  return sessions.filter((s) => !isRlmChild(s));
}

/**
 * Depth of each child relative to `rootId`, for indentation. Computed by walking
 * DOWN from the root so a cycle cannot produce an unbounded depth, and a child
 * whose parent chain does not reach the root is simply absent from the map
 * rather than rendered at a made-up depth.
 */
export function relativeDepths(
  index: Map<string, DashboardSession[]>,
  rootId: string,
): Map<string, number> {
  const depths = new Map<string, number>();
  const walk = (id: string, depth: number): void => {
    for (const child of index.get(id) ?? []) {
      if (depths.has(child.id)) continue; // cycle guard
      depths.set(child.id, depth);
      walk(child.id, depth + 1);
    }
  };
  walk(rootId, 1);
  return depths;
}

/** How the list should be arranged for one render scope (one folder group). */
export interface NestingPlan {
  /** Rows to render as cards at the top level, in the order given. */
  topLevel: DashboardSession[];
  /**
   * Parent id -> its rlm descendants, depth-first, parents before their own
   * children. A key is present only when it has at least one descendant to
   * show, so a caller can test `nested.size` to decide whether to draw any
   * nesting affordance at all.
   */
  nested: Map<string, DashboardSession[]>;
  /**
   * Children that cannot be placed: their named parent is not in this scope,
   * or they are in a parent cycle. They are returned rather than dropped
   * because a child is real work — losing it because its parent's card was
   * filtered out by a search, a tag filter or a folder boundary would be a
   * silent loss. The caller renders them flat.
   */
  orphans: DashboardSession[];
}

/**
 * Decide which rows are top-level cards and which nest under which parent,
 * for ONE scope (one folder group of the list).
 *
 * A child is nested under its parent only when that parent is itself in the
 * same scope. A child whose parent lives in another folder group therefore
 * lands in {@link NestingPlan.orphans} and renders flat beside its folder's
 * own cards — not lost, and not silently relocated into a folder it does not
 * belong to.
 */
export function planNesting(rows: readonly DashboardSession[]): NestingPlan {
  const index = indexChildrenByParent(rows);
  const present = new Set(rows.map((r) => r.id));
  const nested = new Map<string, DashboardSession[]>();
  const placed = new Set<string>();

  // Walk down from the rows that are not children at all. `descendantsOf` is
  // already cycle-guarded and emits each row once, so a cycle yields no
  // placement and is collected as an orphan below.
  for (const row of rows) {
    if (isRlmChild(row)) continue;
    const desc = descendantsOf(index, row.id);
    if (desc.length === 0) continue;
    nested.set(row.id, desc);
    for (const d of desc) placed.add(d.id);
  }

  const orphans = rows.filter((s) => isRlmChild(s) && !placed.has(s.id));
  return { topLevel: rows.filter((s) => !isRlmChild(s)), nested, orphans };
}

/**
 * Types for `subagents.js`. The phone client ships as plain ES module JS with
 * no build step; this declaration exists only so the TypeScript tests that
 * import the module directly (`mobile-subagents.test.ts`, `acc-03-mobile.test.ts`)
 * type-check under the root `tsc --noEmit` gate. The browser never loads it.
 */

/** A session row as `/api/sessions` serves it (only the fields read here are named). */
export interface SessionRow {
  id: string;
  parentSessionId?: string;
  name?: string;
  rlmDepth?: number;
  [field: string]: unknown;
}

/** One row to draw, with its indentation depth (0 = a lead or an orphan). */
export interface FlatRow {
  session: SessionRow;
  depth: number;
}

/** Total: answers for any value, including `null` and non-objects. */
export declare function isRlmChild(session: unknown): boolean;
/** The rows that are real session objects (non-null, with a non-empty string id). */
export declare function usableRows(sessions: unknown): SessionRow[];
export declare function indexChildrenByParent(sessions: readonly unknown[]): Map<string, SessionRow[]>;
export declare function topLevelRows(sessions: readonly SessionRow[]): SessionRow[];
/** Total: a payload of pure junk is an empty list. */
export declare function flattenWithChildren(sessions: unknown): FlatRow[];
export declare function buildRow(
  s: SessionRow,
  depth: number,
  onOpen: (id: string, name: string) => void,
): HTMLButtonElement;

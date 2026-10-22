/**
 * Types for `model.js`. The sub-app ships as plain ES module JS with no build
 * step; this declaration exists only so the TypeScript tests that import the
 * module directly (`packages/server/src/comms-graph/__tests__/model.test.ts`)
 * type-check under the root `tsc --noEmit` gate. The browser never loads it.
 */

export interface ModelNode {
  key: string;
  name: string;
  kind?: string;
  parent?: string | null;
  depth?: number;
  state?: string | null;
  gone?: boolean;
  lastActivityAt?: string | null;
  cluster?: boolean;
  childCount?: number;
  childGone?: number;
  childWorking?: number;
  messagesIn?: number;
  messagesOut?: number;
  [field: string]: unknown;
}

export interface ModelEdge {
  from: string;
  to: string;
  kind?: string;
  lastAt?: string;
  [field: string]: unknown;
}

export interface ModelMessage {
  from: string;
  to: string;
  firstLine?: string;
  [field: string]: unknown;
}

export interface ModelGraph {
  nodes: ModelNode[];
  edges: ModelEdge[];
  [field: string]: unknown;
}

export interface GraphFilters {
  windowMs?: number;
  subtree?: string | null;
  hideFinished?: boolean;
  focus?: string | null;
}

export declare const WINDOWS: ReadonlyArray<{ id: string; label: string; ms: number }>;
export declare const STATES: Readonly<Record<string, { label: string; color: string }>>;

export declare function stateOf(node: ModelNode, nowMs?: number): string;
export declare function isFinished(node: ModelNode, nowMs?: number): boolean;
export declare function ancestorKeys(nodes: readonly ModelNode[]): (key: string) => string[];
export declare function selectGraph(
  graph: Partial<ModelGraph>,
  filters?: GraphFilters,
  nowMs?: number,
): { nodes: ModelNode[]; edges: ModelEdge[] };
export declare function clusterByLead<G extends ModelGraph>(
  graph: G,
  options?: { collapse?: boolean; expanded?: Set<string> },
): G;
export declare function messagesForNode<M extends ModelMessage>(
  recent: readonly M[] | null | undefined,
  key: string,
  limit?: number,
): M[];
export declare function leadList(nodes: readonly ModelNode[]): Array<{ key: string; name: string; children: number }>;
export declare function recency(at: string, nowMs: number): string;
export declare function dataRouteCandidates(pagePath?: string): [string, string];
export declare function isGraphResponse(status: number, contentType: string | null | undefined): boolean;
export declare function labelSetFor(
  nodes: readonly ModelNode[],
  edges: readonly ModelEdge[] | null | undefined,
  options?: { cap?: number; hovered?: string | null; selected?: string | null },
): Set<string>;

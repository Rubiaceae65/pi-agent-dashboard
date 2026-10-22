/**
 * Types for `fixture.mjs` (the independent acceptance-check fixture builder),
 * so the TypeScript acceptance tests that import it type-check under the
 * root `tsc --noEmit` gate instead of failing with TS7016.
 */
export declare const LEAD: string;
export declare const CHILD_A: string;
export declare const CHILD_B: string;
export declare const GRANDCHILD: string;

export interface ChildOpts {
  name?: string;
  status?: string;
  depth?: number;
  cwd?: string;
  sidecarExtra?: Record<string, unknown>;
}

export interface TreeOpts {
  /** `false` leaves the transcripts' mtimes as written (default: 30 s ago). */
  touch?: boolean;
  hostile?: (paths: { artifacts: string; agentDir: string; sessions: string }) => void;
}

export declare function writeTranscript(dir: string, id: string, over?: Record<string, unknown>): string;
export declare function writeSidecar(dir: string, over?: Record<string, unknown>): void;
export declare function makeChild(
  parentDir: string,
  parentId: string,
  hex: string,
  id: string,
  opts?: ChildOpts,
): { dir: string; file: string; id: string };
export declare function buildTree(
  home: string,
  opts?: TreeOpts,
): { agentDir: string; sessions: string; artifacts: string; files: string[] };

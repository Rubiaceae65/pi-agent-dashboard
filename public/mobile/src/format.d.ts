/**
 * Types for `format.js`. The phone client ships as plain ES module JS with no
 * build step; this declaration exists only so the TypeScript tests that import
 * the module directly (`packages/server/src/__tests__/mobile-format-bounds.test.ts`)
 * type-check under the root `tsc --noEmit` gate. The browser never loads it.
 */

/** One rendered line: a CSS class and its text. */
export interface Line {
  cls: string;
  text: string;
}

/** A value -> readable text, always (never "[object Object]"). */
export declare function fmt(value: unknown, depth?: number, key?: string): string;
export declare function sessionName(s: Record<string, unknown>): string;
export declare function label<F>(value: unknown, fallback: F): string | F;
export declare function messageLines(message: unknown): Line[];
export declare function blockLines(block: unknown): Line[];
export declare function describeEvent(event: unknown): { role: string; title: string; lines: Line[] };

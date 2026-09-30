/**
 * BLACK-BOX guard on the rlm-child wire fix.
 *
 * Why this file exists, and why it does not import the module under test
 * ---------------------------------------------------------------------
 * `rlm-subagent-snapshot.test.ts` asserts on `withRlmChildrenInSnapshot`'s
 * RETURN VALUE. That is a correct unit test and a useless guard on the wiring:
 * delete the call site in `browser-gateway.ts` and the whole suite stays green
 * while the product is broken again. Reproduced 2026-09-30 — reverting
 * `browser-gateway.ts` to the pre-fix version left all 19 tests in
 * `rlm-subagent-snapshot.test.ts` + `browser-gateway-snapshot-on-connect.test.ts`
 * PASSING with the fix deleted. (The commit message for 49dd69608 claims its 3
 * tests "all fail against the previous gateway". They do not. That claim was
 * wrong and this file is the correction.)
 *
 * This test instead builds a REAL gateway, opens a connection, and reads the
 * `sessions_snapshot` frame the gateway actually sends. It imports nothing from
 * the scanner or the snapshot module, so it goes red exactly when the wiring
 * does.
 *
 * Why the wire matters at all: the desktop client does NOT read its session list
 * from `GET /api/sessions`. On connect the server sends `sessions_snapshot` and
 * `useMessageHandler` REPLACES its entire sessions Map. So children present in
 * the REST route but absent from this frame are not merely missing from a
 * refresh — they are deleted on the next socket open.
 *
 * See change: surface-rlm-subagent-children.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PiGateway } from "../pi/pi-gateway.js";
import { createBrowserGateway } from "../pairing/browser-gateway.js";
import { createMemoryEventStore } from "../persistence/memory-event-store.js";
import { createMemorySessionManager } from "../session/memory-session-manager.js";
import type { SessionOrderManager } from "../session/session-order-manager.js";

// ── fixture tree, built here rather than copied, so nothing is imported ──────

const LEAD = "11111111-2222-4333-8444-555555555555";
const CHILD = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const GRANDCHILD = "99999999-8888-4777-8666-555555555555";

let home: string;
let previousAgentDir: string | undefined;

function writeChild(dir: string, sessionFile: string, header: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "rlm-subagent.json"),
    JSON.stringify({ type: "rlm_subagent", childId: `sub-${sessionFile.slice(0, 8)}`, sessionName: `child-${sessionFile.slice(0, 4)}`, sessionFile, status: "running" }),
  );
  writeFileSync(join(dir, sessionFile), `${JSON.stringify(header)}\n`);
}

/** A transcript mtime `ageMs` before `at`, so the fixture is never a time bomb. */
function age(path: string, at: number, ageMs: number): void {
  const when = (at - ageMs) / 1000;
  utimesSync(path, when, when);
}

beforeAll(() => {
  const now = Date.now();
  home = mkdtempSync(join(tmpdir(), "rlm-wire-"));
  const agentDir = join(home, "prime-agent", "agent");
  const artifacts = join(agentDir, "session-artifacts");
  mkdirSync(join(agentDir, "sessions"), { recursive: true });

  // depth 1 under the lead, and a depth-2 grandchild nested inside it.
  const childDir = join(artifacts, LEAD, "sub-aaaaaaaa");
  writeChild(childDir, `${CHILD}.jsonl`, {
    type: "session", version: 3, id: CHILD, timestamp: new Date(now - 60_000).toISOString(),
    cwd: "/repo/wire", parentSession: `../${LEAD}.jsonl`, rlmDepth: 1,
  });
  const grandDir = join(childDir, "sub-99999999");
  writeChild(grandDir, `${GRANDCHILD}.jsonl`, {
    type: "session", version: 3, id: GRANDCHILD, timestamp: new Date(now - 60_000).toISOString(),
    cwd: "/repo/wire", parentSession: `../${CHILD}.jsonl`, rlmDepth: 2,
  });
  age(join(childDir, `${CHILD}.jsonl`), now, 60_000);
  age(join(grandDir, `${GRANDCHILD}.jsonl`), now, 60_000);

  // The lead's own row, so there is a parent to hang the children off.
  const manager = createMemorySessionManager();
  void manager;
  writeFileSync(
    join(agentDir, "sessions", `${LEAD}.jsonl`),
    `${JSON.stringify({ type: "session", version: 3, id: LEAD, timestamp: new Date(now - 120_000).toISOString(), cwd: "/repo/wire" })}\n`,
  );

  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterAll(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(home, { recursive: true, force: true });
});

function makeFakeWs() {
  const ws = new EventEmitter() as EventEmitter & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn>; bufferedAmount: number; readyState: number; OPEN: number };
  ws.send = vi.fn();
  ws.close = vi.fn();
  ws.terminate = vi.fn();
  ws.readyState = 1;
  ws.OPEN = 1;
  ws.bufferedAmount = 0;
  return ws;
}

function makeStubPiGateway(): PiGateway {
  return {
    start: vi.fn(), stop: vi.fn(), sendToSession: vi.fn(),
    getConnectedSessionIds: vi.fn(() => []), hasSession: vi.fn(() => false), onEvent: vi.fn(),
  } as unknown as PiGateway;
}

function makeStubOrderManager(): SessionOrderManager {
  return {
    insert: vi.fn(), remove: vi.fn(), getOrder: vi.fn(() => []), reorder: vi.fn(),
    getAllOrders: vi.fn(() => ({})), moveToFront: vi.fn(),
  } as unknown as SessionOrderManager;
}

/** Open a connection and return the sessions_snapshot rows the gateway sent. */
function snapshotRowsViaGateway(): { rows: Array<Record<string, unknown>>; ws: ReturnType<typeof makeFakeWs> } {
  const orders = makeStubOrderManager();
  const manager = createMemorySessionManager(undefined, orders);
  manager.restore({ id: LEAD, cwd: "/repo/wire", source: "tui", status: "active", startedAt: Date.now(), hidden: false, dataUnavailable: false } as never);

  const gateway = createBrowserGateway(manager, createMemoryEventStore(() => false), makeStubPiGateway(), undefined, undefined, orders);
  const ws = makeFakeWs();
  gateway.wss.emit("connection", ws, {});

  const frames = ws.send.mock.calls
    .map((a) => { try { return JSON.parse(String(a[0])); } catch { return null; } })
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object");
  const snapshots = frames.filter((m) => m.type === "sessions_snapshot");
  expect(snapshots, "the gateway sent no sessions_snapshot").toHaveLength(1);
  const snap = snapshots[0] as { sessions: Array<Record<string, unknown>> };
  return { rows: snap.sessions, ws };
}

describe("the sessions_snapshot FRAME carries rlm children (black-box on the wire)", () => {
  it("includes a child and its grandchild in the frame, not only in the REST route", () => {
    const { rows } = snapshotRowsViaGateway();
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.has(CHILD), "the depth-1 child is absent from the frame").toBe(true);
    expect(byId.has(GRANDCHILD), "the depth-2 grandchild is absent from the frame").toBe(true);
  });

  it("links each row to its parent, so the client can nest instead of guessing", () => {
    const { rows } = snapshotRowsViaGateway();
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(CHILD)?.parentSessionId).toBe(LEAD);
    expect(byId.get(CHILD)?.rlmDepth).toBe(1);
    expect(byId.get(GRANDCHILD)?.parentSessionId).toBe(CHILD);
    expect(byId.get(GRANDCHILD)?.rlmDepth).toBe(2);
  });

  it("stamps childCount on the parent row the frame already carries", () => {
    const { rows } = snapshotRowsViaGateway();
    const lead = rows.find((r) => r.id === LEAD);
    expect(lead?.childCount).toBe(1);
  });

  it("leaves the lead itself free of a parent link", () => {
    const { rows } = snapshotRowsViaGateway();
    const lead = rows.find((r) => r.id === LEAD);
    expect(lead?.parentSessionId).toBeUndefined();
  });
});

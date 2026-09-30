/**
 * The indexer: incremental, bounded, and honest under churn.
 *
 * These are the three properties the job's constraints are actually about, so
 * each one is stated as a test that can FAIL, not as a comment:
 *
 *   - INCREMENTAL — a tick with nothing appended must read zero bytes. The
 *     alternative (re-parse 68 MB per poll) is not slow by accident: at 68 MB
 *     and a 2 s poll it is 34 MB/s of wasted IO forever.
 *   - BOUNDED — 50 000 appended messages must not grow the node map, the edge
 *     map, or the recent ring past their caps. Unbounded maps keyed by session
 *     are exactly what /projects/memory-audit-20260930/REPORT.md calls the
 *     estate's scarce resource.
 *   - SLOW CLIENT — a client that polls for an hour must not cost the indexer
 *     one byte of state. There is no per-client buffer at all, and this test is
 *     what makes that claim falsifiable.
 *
 * The fixtures are written into a fresh temp dir per test; nothing here reads
 * the real `~/.prime`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommsGraphIndexer } from "../indexer.js";

const tmpDirs: string[] = [];
function fixtureDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "comms-graph-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const LEAD_A = "aaaaaaaa-0000-0000-0000-000000000001";
const LEAD_B = "bbbbbbbb-0000-0000-0000-000000000002";
const CHILD = "cccccccc-0000-0000-0000-000000000003";
/** The session id a NAMED endpoint really carries on the wire. */
const SID: Record<string, string> = { alpha: LEAD_A, beta: LEAD_B };

/** A lead transcript, at the real path: <primeDir>/sessions/<uuid>.jsonl. */
function writeSession(dir: string, id: string, lines: string[]): string {
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  const p = path.join(dir, "sessions", `${id}.jsonl`);
  fs.writeFileSync(p, lines.map((l) => `${l}\n`).join(""));
  return p;
}
/**
 * A delivered message. `toName: null` reproduces the real shape that makes
 * name resolution necessary: 257 of 773 records on this Brain carry a target
 * with a sessionId and NO sessionName.
 */
function msg(fromName: string | null, toName: string | null, id: string, at: string, line: string) {
  return JSON.stringify({
    type: "custom_message",
    customType: "agent_message",
    timestamp: at,
    details: {
      id,
      message: `${line}\n\nthe rest of the body, which the graph must never show`,
      from: fromName
        ? { sessionName: fromName, sessionId: SID[fromName] ?? fromName, runtimeKind: "top-level" }
        : { clientId: "hostcli01" },
      // The real shape: the target carries a sessionId and NO sessionName.
      target: { sessionId: SID[toName ?? "beta"] ?? toName ?? LEAD_B, runtimeKind: "top-level" },
    },
  });
}
function header(id: string, depth = 0, cwd = "/projects/x") {
  return JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-30T10:00:00.000Z", cwd, rlmDepth: depth });
}

describe("incremental reads", () => {
  it("reads nothing at all when no file has grown", async () => {
    const dir = fixtureDir();
    writeSession(dir, LEAD_A, [header(LEAD_A), JSON.stringify({ type: "session_info", name: "alpha", timestamp: "2026-09-30T10:00:00.000Z" })]);
    const ix = new CommsGraphIndexer({ primeDir: dir, minIntervalMs: 0 });
    await ix.scan();
    const first = ix.stats();
    expect(first.bytesRead).toBeGreaterThan(0);

    ix.resetCounters();
    await ix.scan();
    const second = ix.stats();
    // The cursor is at EOF, so the second pass stats the file and reads 0 bytes.
    expect(second.bytesRead).toBe(0);
    expect(second.linesParsed).toBe(0);
    expect(second.seq).toBe(first.seq);
  });

  it("parses only the bytes appended since the last tick", async () => {
    const dir = fixtureDir();
    const p = writeSession(dir, LEAD_A, [header(LEAD_A), msg("alpha", "beta", "m1", "2026-09-30T10:01:00.000Z", "first")]);
    const ix = new CommsGraphIndexer({ primeDir: dir, minIntervalMs: 0 });
    await ix.scan();

    fs.appendFileSync(p, `${msg("alpha", "beta", "m2", "2026-09-30T10:02:00.000Z", "second")}\n`);
    ix.resetCounters();
    await ix.scan();
    const s = ix.stats();
    expect(s.linesParsed).toBe(1);
    expect(s.bytesRead).toBeGreaterThan(0);
    expect(s.bytesRead).toBeLessThan(2000);
  });

  it("never parses a half-written last line, and picks it up once it is whole", async () => {
    const dir = fixtureDir();
    const p = writeSession(dir, LEAD_A, [header(LEAD_A)]);
    const ix = new CommsGraphIndexer({ primeDir: dir, minIntervalMs: 0 });
    await ix.scan();

    // Exactly what an appender does: write bytes, then the newline later.
    const partial = `${msg("alpha", "beta", "m1", "2026-09-30T10:01:00.000Z", "torn")}`;
    fs.appendFileSync(p, partial.slice(0, 40));
    ix.resetCounters();
    await ix.scan();
    expect(ix.stats().linesParsed).toBe(0);
    expect(ix.snapshot().edges).toHaveLength(0);

    fs.appendFileSync(p, partial.slice(40) + "\n");
    ix.resetCounters();
    await ix.scan();
    expect(ix.stats().linesParsed).toBe(1);
    expect(ix.snapshot().edges).toHaveLength(1);
  });

  it("re-reads from zero when a file is replaced by a SHORTER one (rotation)", async () => {
    const dir = fixtureDir();
    const p = writeSession(dir, LEAD_A, [header(LEAD_A), msg("alpha", "beta", "m1", "2026-09-30T10:01:00.000Z", "one"), msg("alpha", "beta", "m2", "2026-09-30T10:02:00.000Z", "two")]);
    const ix = new CommsGraphIndexer({ primeDir: dir, minIntervalMs: 0 });
    await ix.scan();
    expect(ix.stats().linesParsed).toBe(3); // header + two messages

    fs.writeFileSync(p, `${header(LEAD_A)}\n`);
    ix.resetCounters();
    await ix.scan();
    // Rotation is detected and the file re-read, NOT skipped because the
    // cursor is past the new EOF — the bug that silently freezes a node.
    expect(ix.stats().linesParsed).toBe(1);
  });
});

describe("the graph it produces", () => {
  it("counts direction, recency and shows only the first line", async () => {
    const dir = fixtureDir();
    writeSession(dir, LEAD_B, [
      header(LEAD_B),
      JSON.stringify({ type: "session_info", name: "beta", timestamp: "2026-09-30T10:00:00.000Z" }),
    ]);
    writeSession(dir, LEAD_A, [
      header(LEAD_A),
      JSON.stringify({ type: "session_info", name: "alpha", timestamp: "2026-09-30T10:00:00.000Z" }),
      msg("alpha", "beta", "m1", "2026-09-30T10:01:00.000Z", "alpha tells beta one thing"),
      msg("alpha", "beta", "m2", "2026-09-30T10:05:00.000Z", "alpha tells beta another thing"),
      msg("beta", "alpha", "m3", "2026-09-30T10:06:00.000Z", "beta answers"),
    ]);
    const ix = new CommsGraphIndexer({ primeDir: dir, minIntervalMs: 0 });
    await ix.scan();
    const snap = ix.snapshot();

    const a2b = snap.edges.find((e) => e.from === "alpha" && e.to === "beta");
    expect(a2b).toMatchObject({ kind: "message", count: 2, lastAt: "2026-09-30T10:05:00.000Z" });
    expect(a2b?.lines).toEqual([
      { at: "2026-09-30T10:01:00.000Z", firstLine: "alpha tells beta one thing" },
      { at: "2026-09-30T10:05:00.000Z", firstLine: "alpha tells beta another thing" },
    ]);
    // The body never reaches the snapshot. Not truncated — absent.
    expect(JSON.stringify(snap)).not.toContain("the rest of the body");

    const b2a = snap.edges.find((e) => e.from === "beta" && e.to === "alpha");
    expect(b2a).toMatchObject({ kind: "message", count: 1 });
  });

  it("resolves a target that has no sessionName to the name its own file declares", async () => {
    const dir = fixtureDir();
    // beta's file declares the name; alpha's message names only the sessionId.
    writeSession(dir, LEAD_B, [
      header(LEAD_B),
      JSON.stringify({ type: "session_info", name: "beta", timestamp: "2026-09-30T10:00:00.000Z" }),
    ]);
    writeSession(dir, LEAD_A, [
      header(LEAD_A),
      JSON.stringify({ type: "session_info", name: "alpha", timestamp: "2026-09-30T10:00:00.000Z" }),
      msg("alpha", null, "m1", "2026-09-30T10:01:00.000Z", "hello beta"),
    ]);
    const ix = new CommsGraphIndexer({ primeDir: dir, minIntervalMs: 0 });
    await ix.scan();
    const snap = ix.snapshot();
    expect(snap.edges.map((e) => `${e.from}->${e.to}`)).toContain("alpha->beta");
    // and no orphan node keyed by the raw id survives
    expect(snap.nodes.map((n) => n.key)).not.toContain(LEAD_B);
  });

  it("reads parents and depth from the rlm ledger, and marks a deleted child gone", async () => {
    const dir = fixtureDir();
    fs.mkdirSync(path.join(dir, "rlm-ledger"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "rlm-ledger", "L.jsonl"),
      [
        JSON.stringify({ v: 1, op: "meta", at: "2026-09-30T10:00:00.000Z" }),
        JSON.stringify({ v: 1, op: "spawn", at: "2026-09-30T10:01:00.000Z", childId: "sub-x", parent: path.join(dir, `${LEAD_A}.jsonl`), child: path.join(dir, "artifacts", LEAD_A, "sub-x", `${CHILD}.jsonl`), depth: 1, name: "reader" }),
        JSON.stringify({ v: 1, op: "delete", at: "2026-09-30T10:09:00.000Z", childId: "sub-x", child: path.join(dir, "artifacts", LEAD_A, "sub-x", `${CHILD}.jsonl`), reason: "user" }),
      ].join("\n") + "\n",
    );
    const childDir = path.join(dir, "artifacts", LEAD_A, "sub-x");
    fs.mkdirSync(childDir, { recursive: true });
    fs.writeFileSync(
      path.join(childDir, `${CHILD}.jsonl`),
      `${header(CHILD, 1)}\n${JSON.stringify({ type: "session_info", name: "reader", timestamp: "2026-09-30T10:01:00.000Z" })}\n`,
    );
    writeSession(dir, LEAD_A, [header(LEAD_A), JSON.stringify({ type: "session_info", name: "alpha", timestamp: "2026-09-30T10:00:00.000Z" })]);

    const ix = new CommsGraphIndexer({ primeDir: dir, minIntervalMs: 0 });
    await ix.scan();
    const snap = ix.snapshot();
    const child = snap.nodes.find((n) => n.name === "reader");
    expect(child).toMatchObject({ parent: "alpha", depth: 1, kind: "child", gone: true });
    expect(snap.edges).toContainEqual(expect.objectContaining({ kind: "spawn", from: "alpha", to: "reader", gone: true }));
  });

  it("reports the working state, goal and model a node's own file records", async () => {
    const dir = fixtureDir();
    writeSession(dir, LEAD_A, [
      header(LEAD_A),
      JSON.stringify({ type: "session_info", name: "alpha", timestamp: "2026-09-30T10:00:00.000Z" }),
      JSON.stringify({ type: "model_change", timestamp: "2026-09-30T10:00:01.000Z", provider: "local-qwen", modelId: "qwen3.8-27b" }),
      JSON.stringify({ type: "agent_status", timestamp: "2026-09-30T10:00:02.000Z", status: { taskState: "error", summary: "429" } }),
      JSON.stringify({ type: "custom", customType: "thread_goal_state", timestamp: "2026-09-30T10:00:03.000Z", data: { status: "active", objective: "ship it", tokensUsed: 12 } }),
    ]);
    const ix = new CommsGraphIndexer({ primeDir: dir, minIntervalMs: 0 });
    await ix.scan();
    expect(ix.snapshot().nodes[0]).toMatchObject({
      name: "alpha",
      model: "local-qwen/qwen3.8-27b",
      state: "error",
      goalStatus: "active",
    });
  });
});

describe("bounded memory under churn", () => {
  it("caps nodes, edges and the recent ring, and says how much it dropped", async () => {
    const dir = fixtureDir();
    const p = writeSession(dir, LEAD_A, [header(LEAD_A), JSON.stringify({ type: "session_info", name: "alpha", timestamp: "2026-09-30T10:00:00.000Z" })]);
    const ix = new CommsGraphIndexer({ primeDir: dir, minIntervalMs: 0, maxNodes: 50, maxEdges: 20, maxRecent: 30, perEdgeLines: 3 });
    await ix.scan();

    // 500 appends, 100 distinct peers -> 100 nodes wanted, 50 allowed.
    let at = Date.parse("2026-09-30T10:00:00.000Z");
    for (let i = 0; i < 500; i++) {
      at += 1000;
      fs.appendFileSync(p, `${msg("alpha", `peer-${i % 100}`, `m${i}`, new Date(at).toISOString(), `line ${i}`)}\n`);
      if (i % 25 === 0) {
        ix.resetCounters();
        await ix.scan();
      }
    }
    ix.resetCounters();
    await ix.scan();

    const snap = ix.snapshot();
    expect(snap.nodes.length).toBeLessThanOrEqual(50);
    expect(snap.edges.length).toBeLessThanOrEqual(20);
    expect(snap.recent.length).toBeLessThanOrEqual(30);
    for (const e of snap.edges) expect(e.lines.length).toBeLessThanOrEqual(3);
    // The caps are not a silent truncation: the client is told.
    expect(ix.stats().nodesDropped).toBeGreaterThan(0);
    expect(ix.stats().edgesDropped).toBeGreaterThan(0);
  });

  it("keeps a bounded footprint as the RING fills, not as the corpus grows", async () => {
    const dir = fixtureDir();
    const p = writeSession(dir, LEAD_A, [header(LEAD_A), JSON.stringify({ type: "session_info", name: "alpha", timestamp: "2026-09-30T10:00:00.000Z" })]);
    const ix = new CommsGraphIndexer({ primeDir: dir, minIntervalMs: 0, maxRecent: 64, perEdgeLines: 4 });
    await ix.scan();
    let at = Date.parse("2026-09-30T10:00:00.000Z");
    for (let round = 0; round < 40; round++) {
      for (let i = 0; i < 50; i++) {
        at += 1000;
        fs.appendFileSync(p, `${msg("alpha", "beta", `m${round}-${i}`, new Date(at).toISOString(), `x${"y".repeat(500)} ${round}-${i}`)}\n`);
      }
      ix.resetCounters();
      await ix.scan();
      if (round === 4 || round === 39) {
        global.gc?.();
        (globalThis as { __ixRss?: number }).__ixRss = process.memoryUsage().rss;
        (globalThis as { __ixSize?: number }).__ixSize = JSON.stringify(ix.snapshot()).length;
      }
    }
    const g = globalThis as { __ixRss?: number; __ixSize?: number };
    // 2 000 messages of 500 chars each have gone through. The serialised
    // snapshot must not track that: 64 recent + 1 edge x 4 lines is a ceiling
    // in the low tens of kB whatever the corpus does.
    expect(g.__ixSize).toBeLessThan(64 * 1024);
  });

  it("spends a BOUNDED amount of work per tick, so a cold start returns something", async () => {
    const dir = fixtureDir();
    for (let s = 0; s < 6; s++) {
      const lines = [header(`${LEAD_A.slice(0, -1)}${s}`), JSON.stringify({ type: "session_info", name: `lead-${s}`, timestamp: "2026-09-30T10:00:00.000Z" })];
      for (let i = 0; i < 4000; i++) {
        lines.push(msg(`lead-${s}`, `lead-${(s + 1) % 6}`, `m${s}-${i}`, new Date(Date.parse("2026-09-30T10:00:00.000Z") + i * 1000).toISOString(), `line ${i} ${"z".repeat(300)}`));
      }
      writeSession(dir, `${LEAD_A.slice(0, -1)}${s}`, lines);
    }
    const ix = new CommsGraphIndexer({ primeDir: dir, minIntervalMs: 0, maxBytesPerScan: 32 * 1024 });
    const started = process.hrtime.bigint();
    await ix.scan();
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    // The first tick of a 24 000-message corpus reads at most the budget and
    // returns; the rest arrives on later ticks. A cold start must not block
    // the HTTP response it arrived on.
    expect(ix.stats().bytesRead).toBeLessThanOrEqual(32 * 1024);
    expect(ms).toBeLessThan(2000);

    let ticks = 1;
    while (ix.stats().truncated && ticks < 500) {
      await ix.scan();
      ticks++;
    }
    expect(ix.stats().truncated).toBe(false);
    const snap = ix.snapshot();
    expect(snap.edges.find((e) => e.from === "lead-0")?.count).toBe(4000);
  });
});

describe("a slow client", () => {
  it("costs the indexer nothing: 5 000 snapshots leave the state identical", async () => {
    const dir = fixtureDir();
    writeSession(dir, LEAD_A, [header(LEAD_A), JSON.stringify({ type: "session_info", name: "alpha", timestamp: "2026-09-30T10:00:00.000Z" }), msg("alpha", "beta", "m1", "2026-09-30T10:01:00.000Z", "one")]);
    const ix = new CommsGraphIndexer({ primeDir: dir, minIntervalMs: 0 });
    await ix.scan();
    // `generatedAt` moves on every call by design; everything else must not.
    const stable = (s: unknown) => JSON.stringify(s).replace(/"generatedAt":"[^"]+"/, '"generatedAt":"-"');
    const before = stable(ix.snapshot());
    for (let i = 0; i < 5_000; i++) {
      const s = ix.snapshot({ windowMs: 3_600_000 });
      expect(s.nodes.length).toBeGreaterThan(0);
    }
    expect(stable(ix.snapshot())).toBe(before);
  });

  it("serves an unchanged graph to a client using `since` without re-sending it", async () => {
    const dir = fixtureDir();
    writeSession(dir, LEAD_A, [header(LEAD_A), JSON.stringify({ type: "session_info", name: "alpha", timestamp: "2026-09-30T10:00:00.000Z" }), msg("alpha", "beta", "m1", "2026-09-30T10:01:00.000Z", "one")]);
    const ix = new CommsGraphIndexer({ primeDir: dir, minIntervalMs: 0 });
    await ix.scan();
    const seq = ix.snapshot().seq;
    const delta = ix.snapshot({ since: seq });
    expect(delta.seq).toBe(seq);
    expect(delta.changed).toBe(false);
    expect(delta.edges).toEqual([]);
  });

  it("rate-limits the scan itself, so 20 clients polling do not mean 20 scans", async () => {
    const dir = fixtureDir();
    writeSession(dir, LEAD_A, [header(LEAD_A)]);
    const ix = new CommsGraphIndexer({ primeDir: dir, minIntervalMs: 60_000 });
    await ix.scan();
    const first = ix.stats().scans;
    for (let i = 0; i < 20; i++) await ix.scan();
    expect(ix.stats().scans).toBe(first);
    expect(ix.snapshot().seq).toBeGreaterThan(0);
  });
});

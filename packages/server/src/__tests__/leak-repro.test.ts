/**
 * Leak reproduction + failing-first regression — change: bound-dashboard-memory.
 *
 * ONE file, two jobs, because they must not drift:
 *   1. `REPRODUCE` (default) boots a REAL server and runs synthetic churn —
 *      many sessions registering/ending, plus a browser client that never reads
 *      its socket — and writes the sample table to artifacts/. That CSV is the
 *      before/after evidence in REPORT.md.
 *   2. The `bounded under churn` tests assert the FIX, against the same
 *      harness. They are written to FAIL on the pre-fix tree.
 *
 * Nothing here reimplements gateway logic: the numbers come from the running
 * server's own registries and from process.memoryUsage().
 *
 * Run the reproduction:  tools/repro.sh --ticks 40 --label before
 * Run the regression:     tools/run-vitest.sh src/__tests__/leak-repro.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server.js";
import { runChurn, formatResults, type ChurnResult } from "../../leak-repro/churn.js";

const MB = 1024 * 1024;
const ARTIFACTS = "/projects/dash-memory-leak-20260930/artifacts";

let home: string;
let server: Awaited<ReturnType<typeof createServer>>;

async function boot() {
  home = mkdtempSync(join(tmpdir(), "leak-repro-"));
  process.env.HOME = home;
  server = await createServer({
    port: 0,
    piPort: 0,
    host: "127.0.0.1",
    dev: true,
    autoShutdown: false,
    shutdownIdleSeconds: 999,
    tunnel: false,
  });
  await server.start();
}

async function shutdown() {
  try {
    await server?.stop?.();
  } catch {
    /* best effort */
  }
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** Run the churn and return the samples. */
async function churn(overrides: Parameters<typeof runChurn>[1] = {}): Promise<ChurnResult> {
  return runChurn(server, {
    ticks: 12,
    perTick: 4,
    concurrentSessions: 6,
    tickMs: 10,
    healthyClients: 1,
    slowClients: 1,
    bytesPerTick: 32 * 1024,
    ...overrides,
  });
}

/**
 * The resident cap the session registry holds ended rows to.
 *
 * Stated HERE, as a test constant, rather than imported from the module under
 * test: a test that imports the cap it is asserting against cannot fail when
 * the cap is wrong, because it would read whatever the code says. This one
 * fails on behaviour — churn well past the tier and watch the rows.
 *
 * Derivation: the dashboard's snapshot window keeps the newest 120 ended
 * sessions visible (SNAPSHOT_ENDED_GLOBAL = 120), and renders 3 per group on
 * top of that. A resident tier of 240 holds the whole visible window with a
 * full window of headroom, so eviction can never race the window it feeds.
 */
const MAX_RESIDENT_ENDED = 240;

/**
 * How many distinct sessions the gateway's per-session drop counters remember.
 *
 * Stated here, as a test constant, for the same reason as the tier above: a
 * test must not import the cap it asserts against.
 *
 * Derivation: the counters exist to attribute a stuck tool-card incident, and
 * a post-mortem only ever looks at the sessions involved in it — which are the
 * recent ones. The estate produces on the order of 120-180 distinct sessions a
 * day (audit §5.3), so 500 entries is several days of full fidelity while
 * keeping the table bounded at ~60 KiB (measured 100-150 B per entry).
 */
const MAX_DROP_COUNTER_SESSIONS = 500;

describe("REPRODUCE: dashboard memory under synthetic churn", () => {
  beforeAll(boot, 120_000);
  afterAll(shutdown);

  it("records RSS, heap, table sizes and send-buffer occupancy over time", async () => {
    // The workload is sized to CROSS the retention tier, so the CSV shows the
    // plateau rather than a run that never reached the bound. Defaults:
    // 40 ticks x 12 per tick = 480 retired sessions against a 240-row tier.
    const result = await churn({
      ticks: Number(process.env.REPRO_TICKS ?? 40),
      perTick: Number(process.env.REPRO_PER_TICK ?? 12),
      bytesPerTick: Number(process.env.REPRO_BYTES ?? 128 * 1024),
      slowClients: Number(process.env.REPRO_SLOW ?? 6),
      healthyClients: Number(process.env.REPRO_HEALTHY ?? 1),
    });
    mkdirSync(ARTIFACTS, { recursive: true });
    const label = process.env.REPRO_LABEL ?? "run";
    writeFileSync(`${ARTIFACTS}/leak-repro-${label}.csv`, formatResults(label, result));
    // Print a compact trace so the run is legible in CI output.
    for (const s of result.samples) {
      console.log(
        `t=${s.tSec.toFixed(1)}s rss=${(s.rssBytes / MB).toFixed(1)}MiB ` +
          `heap=${(s.heapUsedBytes / MB).toFixed(1)}MiB rows=${s.sessionRows} ended=${s.endedRows} ` +
          `routes=${s.gatewayRoutes} buf=${(s.browserBufferedBytes / MB).toFixed(2)}MiB drops=${s.droppedFrames}`,
      );
    }
    console.log(
      `sessionRowDelta=${result.sessionRowDelta} gatewayRouteDelta=${result.gatewayRouteDelta} ` +
        `peakSingleSocket=${(result.peakSingleSocketBufferedBytes / MB).toFixed(2)}MiB ` +
        `finalBrowserBuffered=${(result.finalBrowserBufferedBytes / MB).toFixed(2)}MiB`,
    );
    expect(result.samples.length).toBeGreaterThan(5);
  });
});

describe("bounded under churn (regression — red before the fix)", () => {
  beforeAll(boot, 120_000);
  afterAll(shutdown);

  it("does not grow the browser send buffer without bound when a client stops reading", async () => {
    const result = await churn({ ticks: 20, bytesPerTick: 128 * 1024 });
    // The stall must be REAL for the bound to mean anything. If the slow
    // client's buffer never climbed, this test would pass vacuously.
    expect(result.peakSingleSocketBufferedBytes).toBeGreaterThan(0);
    // The bound is PER CLIENT, and it must be a function of the CAP, not of
    // how much was pushed at that client. A client that never reads must not
    // be able to make the server hold more than its cap plus one frame.
    //
    // Derivation: MAX_WS_BUFFER is 4 MiB (the gateway default); a single
    // frame may overshoot it by at most one frame, so 2x the cap is a
    // generous ceiling that still fails a backlog scaling with load.
    const MAX_WS_BUFFER = 4 * MB;
    expect(result.peakSingleSocketBufferedBytes).toBeLessThanOrEqual(2 * MAX_WS_BUFFER);
  }, 120_000);

  it("bounds the TOTAL send buffer across many stalled clients", async () => {
    // This is the audit's own arithmetic: a per-client send buffer of 4-6 MB
    // multiplied by the number of connected clients. The per-client cap alone
    // does not bound the process — N stalled clients still park N x cap. So
    // the claim under test is the TOTAL, across clients that are all stalled
    // at once.
    const result = await churn({
      ticks: 20,
      bytesPerTick: 128 * 1024,
      slowClients: 6,
      healthyClients: 0,
    });
    // All six clients really were connected and stalled: the peak was reached
    // with more than one socket alive holding a non-trivial backlog. Without
    // this the bound below would pass vacuously.
    expect(result.socketsAtPeak).toBeGreaterThan(1);
    expect(result.peakTotalBufferedBytes).toBeGreaterThan(0);

    // The bound: the total parked across ALL clients must stay within a fixed
    // budget that does NOT scale with the number of stalled clients.
    //
    // Derivation: the gateway's budget is 8 MiB, and a single frame may
    // overshoot the per-socket cap by at most one frame, so the observed peak
    // is admitted up to budget + one frame per live socket at that moment.
    // Pre-fix the total is `stalledClients x 4 MiB` — 24.5 MiB measured on six
    // clients — and the test fails by a factor of three.
    const TOTAL_WS_BUFFER_BUDGET = 8 * MB;
    const ONE_FRAME_ALLOWANCE = 512 * 1024;
    const admissible = TOTAL_WS_BUFFER_BUDGET + result.socketsAtPeak * ONE_FRAME_ALLOWANCE;
    expect(result.peakTotalBufferedBytes).toBeLessThanOrEqual(admissible);

    // And the mechanism that enforces it must actually have run: clients were
    // terminated, not merely shed. Shedding frees no memory.
    expect(result.budgetTerminations).toBeGreaterThan(0);
  }, 120_000);

  it("keeps the gateway routing table flat under churn", async () => {
    const result = await churn({ ticks: 20, perTick: 6 });
    // Every session that registered and then unregistered must leave no
    // routing entry behind. Pre-fix the table is write-mostly.
    expect(result.gatewayRouteDelta).toBeLessThanOrEqual(0);
  }, 120_000);

  it("does not accumulate an unbounded per-session drop-counter table", async () => {
    // The audit's §5.8 read: `droppedFramesBySession` and
    // `droppedBlockingBySession` are `Map<string, number>` keyed by session id,
    // incremented on every shed frame, with no `.delete()` and no `.clear()`
    // anywhere in the file. Each session that ever dropped a frame left an
    // entry for the lifetime of the process.
    //
    // Small in absolute terms (~15 KiB for a day's sessions) but the SHAPE is
    // the same one this file exists to catch: a map keyed by session that is
    // only ever added to. A churn that drops frames under many distinct
    // session ids must leave the counter bounded.
    const result = await churn({
      ticks: 40,
      perTick: 25,
      concurrentSessions: 6,
      tickMs: 2,
      bytesPerTick: 128 * 1024,
      slowClients: 4,
      healthyClients: 0,
    });
    // The counter must have been exercised, or the bound is vacuous: a run
    // that never shed a frame never wrote a key.
    const last = result.samples[result.samples.length - 1]!;
    expect(last.droppedFrames).toBeGreaterThan(0);
    expect(last.dropCounterSessions).toBeLessThanOrEqual(MAX_DROP_COUNTER_SESSIONS);
  }, 180_000);

  it("does not accumulate an unbounded ended-session tombstone tier", async () => {
    // Churn ENOUGH to cross the retention tier. A tombstone cap cannot be
    // proven by a run that never reaches it, so the workload is sized to
    // retire more sessions than the tier holds.
    const perTick = 20;
    const ticks = 20; // 400 retired sessions, against a 240-row tier
    const result = await churn({ ticks, perTick, concurrentSessions: 6 });
    expect(result.unregistered).toBeGreaterThan(MAX_RESIDENT_ENDED);

    // `unregister` used to flip status to `ended` and leave the row forever, so
    // the registry grew one row per session that ever ended. The snapshot
    // WINDOW hides those rows from the wire, which is why the growth was
    // invisible: bounded in what it SHOWS, unbounded in what it HOLDS.
    //
    // The bound: ended rows never exceed the retention tier, so the registry
    // is flat under churn no matter how many sessions come and go.
    const last = result.samples[result.samples.length - 1]!;
    expect(last.endedRows).toBeLessThanOrEqual(MAX_RESIDENT_ENDED);
    // Stated on total growth too: the registry may exceed the baseline by the
    // live pool plus the tier, and not by one row per retired session.
    expect(result.sessionRowDelta).toBeLessThanOrEqual(MAX_RESIDENT_ENDED + 6);
  }, 180_000);
});

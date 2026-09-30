/**
 * Leak reproduction harness — change: bound-dashboard-memory.
 *
 * Boots the REAL server in-process and drives it the way the estate does:
 * many pi sessions register over the pi gateway, come and go, and browser
 * clients connect — one of them deliberately SLOW (it never reads its socket,
 * which is exactly the state that grew the dashboard).
 *
 * Nothing here reimplements gateway logic. Every number is read from the
 * running server: process memory from `process.memoryUsage()`, table sizes
 * from the server's own registries, send-buffer occupancy from the real
 * `ws` sockets the gateway holds.
 *
 * Run it against a branch to produce the before/after table in REPORT.md.
 */
import type { DashboardServer } from "../src/server.js";
import { WebSocket } from "ws";
import { writeFileSync } from "node:fs";

export interface ChurnSample {
  tSec: number;
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  /** Rows in the session registry, whatever their status. */
  sessionRows: number;
  /** Of those, rows already `ended` (tombstones the ended tier keeps). */
  endedRows: number;
  /** Entries in the pi gateway routing table. */
  gatewayRoutes: number;
  /** Sum of `bufferedAmount` over every browser socket the gateway holds. */
  browserBufferedBytes: number;
  /** Browser sockets currently open. */
  browserSockets: number;
  /** Cumulative transcript frames shed under back-pressure. */
  droppedFrames: number;
}

export interface ChurnResult {
  samples: ChurnSample[];
  /** Sessions that registered during the run. */
  registered: number;
  /** Sessions that unregistered during the run. */
  unregistered: number;
  /** Net growth in the session registry across the run. */
  sessionRowDelta: number;
  /** Net growth in the gateway routing table across the run. */
  gatewayRouteDelta: number;
  /** Peak bytes parked in any one browser socket's send buffer. */
  peakSingleSocketBufferedBytes: number;
  /** Bytes parked across ALL browser sockets while they were still connected. */
  liveBrowserBufferedBytes: number;
  /**
   * Highest TOTAL bytes parked across all browser sockets at any sample, and
   * the most browser sockets alive at that moment. The pair is what bounds
   * the process: `maxTotal` is what the server held at its worst, and
   * `socketsAtPeak` is how many clients it held it for. A per-client cap that
   * multiplies by client count shows up here as a rising `maxTotal`.
   */
  peakTotalBufferedBytes: number;
  socketsAtPeak: number;
  /** Clients the gateway terminated for breaching the total send-buffer budget. */
  budgetTerminations: number;
  /** Browser sockets connected at that moment. */
  liveBrowserSockets: number;
  /** Bytes still parked in browser send buffers at the end of the run. */
  finalBrowserBufferedBytes: number;
}

const MB = 1024 * 1024;

function rssBytes(): number {
  return process.memoryUsage().rss;
}

export interface ChurnOpts {
  /** Concurrent live pi sessions held open. */
  concurrentSessions?: number;
  /** New sessions registered per churn tick. */
  perTick?: number;
  /** Ticks to run. */
  ticks?: number;
  /** Virtual/real ms between ticks. */
  tickMs?: number;
  /** Browser clients that read normally. */
  healthyClients?: number;
  /** Browser clients that connect and then never read (the stall). */
  slowClients?: number;
  /** Bytes of transcript pushed to each session per tick. */
  bytesPerTick?: number;
  /** Label recorded in the output file. */
  label?: string;
  onSample?: (s: ChurnSample) => void;
  signal?: AbortSignal;
}

/**
 * Run the churn. The caller owns the server (so the same process can be
 * sampled before and after); this drives clients and sessions only.
 */
export async function runChurn(
  server: DashboardServer,
  opts: ChurnOpts = {},
): Promise<ChurnResult> {
  const {
    concurrentSessions = 8,
    perTick = 4,
    ticks = 30,
    tickMs = 50,
    healthyClients = 2,
    slowClients = 1,
    bytesPerTick = 64 * 1024,
    onSample,
    signal,
  } = opts;

  const gw = server.browserGateway as typeof server.browserGateway & {
    getTotalBufferBudget?: () => { budgetBytes: number; terminations: number };
  };
  const browserSockets: WebSocket[] = [];
  const piSockets = new Map<string, WebSocket>();

  // ── browser clients ────────────────────────────────────────────────────
  // A "slow" client is a real ws that completes the handshake and then never
  // reads. `ws` buffers on the RECEIVE side only when you attach a readable
  // stream; with no consumer the socket's receive window fills and the
  // server's `bufferedAmount` climbs — which is the production stall.
  const connectBrowser = (paused: boolean) =>
    new Promise<WebSocket>((resolve, reject) => {
      const url = `ws://127.0.0.1:${server.httpPort() ?? 0}/ws`;
      const ws = new WebSocket(url, { perMessageDeflate: false });
      ws.once("open", () => {
        if (paused) {
          // Stop reading: pause the underlying socket. The handshake frames
          // already read are fine; after this nothing is consumed.
          (ws as unknown as { _socket?: { pause(): void } })._socket?.pause();
        }
        resolve(ws);
      });
      ws.once("error", reject);
      browserSockets.push(ws);
    });

  for (let i = 0; i < healthyClients; i++) await connectBrowser(false);
  for (let i = 0; i < slowClients; i++) await connectBrowser(true);

  // `broadcastEvent` reaches only SUBSCRIBED sockets (that is what
  // `getSubscribers(sessionId)` returns), so a client that never subscribes
  // receives nothing and the stall never happens. Every browser client here
  // subscribes to every session as it appears — the estate's dashboard is
  // subscribed to the sessions it shows.
  const subscribeAll = (ws: WebSocket) => {
    for (const id of piSockets.keys()) {
      ws.send(JSON.stringify({ type: "subscribe", sessionId: id }));
    }
  };

  // ── pi sessions over the gateway ───────────────────────────────────────
  const connectPi = (id: string, cwd: string) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.piPort() ?? 0}`);
      ws.once("open", () => {
        ws.send(
          JSON.stringify({
            type: "session_register",
            sessionId: id,
            cwd,
            source: "tui",
            name: id,
          }),
        );
        resolve(ws);
      });
      ws.once("error", reject);
      piSockets.set(id, ws);
    });

  const openPool: string[] = [];
  for (let i = 0; i < concurrentSessions; i++) {
    const id = `leak-${String(i).padStart(4, "0")}`;
    await connectPi(id, `/projects/fake/repo-${i % 4}`);
    openPool.push(id);
  }
  for (const ws of browserSockets) subscribeAll(ws);

  // Routing-table size comes from the server's OWN published diagnostics
  // (`/api/health` → `activeBridgeCount`), not from a new field on the public
  // interface: the harness must measure what an operator can see, and the
  // health route is already the surface the watch reads.
  const readGatewayRoutes = async (): Promise<number> => {
    try {
      const res = await fetch(`http://127.0.0.1:${server.httpPort() ?? 0}/api/health`);
      const body = (await res.json()) as { activeBridgeCount?: number };
      return body.activeBridgeCount ?? -1;
    } catch {
      return -1;
    }
  };

  let registered = 0;
  let unregistered = 0;
  let counter = 10_000;
  const started = Date.now();

  const takeSample = async (): Promise<ChurnSample> => {
    const mu = process.memoryUsage();
    const all = server.sessionManager.listAll();
    let buffered = 0;
    let peak = 0;
    for (const ws of gw.wss.clients) {
      const b = (ws as unknown as { bufferedAmount: number }).bufferedAmount;
      buffered += b;
      if (b > peak) peak = b;
    }
    const s: ChurnSample = {
      tSec: (Date.now() - started) / 1000,
      rssBytes: mu.rss,
      heapUsedBytes: mu.heapUsed,
      externalBytes: mu.external,
      sessionRows: all.length,
      endedRows: all.filter((x) => x.status === "ended").length,
      gatewayRoutes: await readGatewayRoutes(),
      browserBufferedBytes: buffered,
      browserSockets: gw.wss.clients.size,
      droppedFrames: gw.getDroppedFrameStats().total,
    };
    onSample?.(s);
    return s;
  };

  // settle + gc so the first sample is a baseline, not a startup spike
  await sleep(300);
  const baseline = await takeSample();
  const samples: ChurnSample[] = [baseline];
  let peakSingle = 0;
  let peakTotal = 0;
  let socketsAtPeak = 0;

  for (let t = 0; t < ticks; t++) {
    if (signal?.aborted) break;

    // churn: retire `perTick` of the open pool and register `perTick` new ones
    for (let k = 0; k < perTick; k++) {
      const victim = openPool.shift();
      if (!victim) break;
      const ws = piSockets.get(victim);
      ws?.send(JSON.stringify({ type: "session_unregister", sessionId: victim }));
      ws?.close();
      piSockets.delete(victim);
      unregistered++;
    }
    for (let k = 0; k < perTick; k++) {
      const id = `leak-${counter++}`;
      await connectPi(id, `/projects/fake/repo-${counter % 4}`);
      openPool.push(id);
      registered++;
      for (const ws of browserSockets) subscribeAll(ws);
    }

    // transcript traffic: push a real payload down the fan-out
    for (const id of openPool) {
      gw.broadcastEvent(id, t, {
        type: "message_update",
        text: "x".repeat(bytesPerTick),
      });
    }

    if (tickMs > 0) await sleep(tickMs);
    const s = await takeSample();
    samples.push(s);
    let localPeak = 0;
    for (const ws of gw.wss.clients) {
      const b = (ws as unknown as { bufferedAmount: number }).bufferedAmount;
      if (b > localPeak) localPeak = b;
    }
    if (localPeak > peakSingle) peakSingle = localPeak;
    if (s.browserBufferedBytes > peakTotal) {
      peakTotal = s.browserBufferedBytes;
      socketsAtPeak = s.browserSockets;
    }
  }

  // Sample the LIVE stall BEFORE tearing anything down. A measurement taken
  // after teardown reports zero and would prove nothing about the leak.
  const atPeak = await takeSample();
  samples.push(atPeak);

  // Now tear the clients down and take one more, so the CSV shows both the
  // live stall and the settled state.
  for (const ws of browserSockets) ws.terminate();
  for (const ws of piSockets.values()) ws.terminate();
  await sleep(200);
  const last = await takeSample();
  samples.push(last);

  return {
    samples,
    registered,
    unregistered,
    sessionRowDelta: last.sessionRows - baseline.sessionRows,
    gatewayRouteDelta: last.gatewayRoutes - baseline.gatewayRoutes,
    peakSingleSocketBufferedBytes: peakSingle,
    // Bytes parked while every stalled client was STILL CONNECTED — the number
    // that must be bounded per client and across clients.
    liveBrowserBufferedBytes: atPeak.browserBufferedBytes,
    liveBrowserSockets: atPeak.browserSockets,
    peakTotalBufferedBytes: peakTotal,
    socketsAtPeak,
    // Optional: a pre-fix gateway has no total-buffer budget at all, and the
    // harness must still run against it (that is the whole point of a
    // before/after harness). Absence reads as 0, which the regression then
    // fails on, rather than crashing the measurement.
    budgetTerminations: gw.getTotalBufferBudget?.().terminations ?? 0,
    finalBrowserBufferedBytes: last.browserBufferedBytes,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function formatResults(label: string, r: ChurnResult): string {
  const rows = r.samples.map((s) =>
    [
      s.tSec.toFixed(1),
      (s.rssBytes / MB).toFixed(1),
      (s.heapUsedBytes / MB).toFixed(1),
      String(s.sessionRows),
      String(s.endedRows),
      String(s.gatewayRoutes),
      (s.browserBufferedBytes / MB).toFixed(2),
      String(s.droppedFrames),
    ].join(","),
  );
  return [
    `# ${label}`,
    "t_sec,rss_MiB,heapUsed_MiB,sessionRows,endedRows,gatewayRoutes,browserBuffered_MiB,droppedFrames",
    ...rows,
    `# registered=${r.registered} unregistered=${r.unregistered} sessionRowDelta=${r.sessionRowDelta} gatewayRouteDelta=${r.gatewayRouteDelta} peakSingleSocketBuffered=${(r.peakSingleSocketBufferedBytes / MB).toFixed(2)}MiB peakTotalBuffered=${(r.peakTotalBufferedBytes / MB).toFixed(2)}MiB over ${r.socketsAtPeak} sockets budgetTerminations=${r.budgetTerminations} finalBrowserBuffered=${(r.finalBrowserBufferedBytes / MB).toFixed(2)}MiB`,
    "",
  ].join("\n");
}

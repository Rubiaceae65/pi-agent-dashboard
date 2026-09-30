
import fs from "node:fs";
import path from "node:path";
// Measured memory footprint of the comms-graph indexer.
//
// Run: node --expose-gc --import tsx measure.mjs <primeDir>
//
// WHAT THIS MEASURES, and the mistake the first version of this file made:
// it counted 30 "steady" ticks that were still ingesting a 336 MB corpus and
// called the 9.8 MB RSS growth a leak. It was not a leak; it was work. So the
// order is now fixed and is the whole point of the file:
//
//   1. COLD START, run to COMPLETION (no tick cap, or a cap proven not to
//      bind) — how many ticks and how long until the corpus is fully read.
//   2. ONLY THEN steady state: idle ticks with nothing appended, which is the
//      number that answers "does it leak when a page is left open".
//   3. The wire size, twice: a full snapshot, and the `since` response when
//      nothing moved — which is what a client actually polls at.
//
// `global.gc()` before every reading, because without it the number is a
// garbage-collection schedule, not a footprint.
import { CommsGraphIndexer } from "./indexer.js";

const primeDir = process.argv[2];
if (!primeDir) {
  console.error("usage: measure.mjs <primeDir>");
  process.exit(2);
}

const mb = (n) => +((n / 1048576).toFixed(1));

function corpusSize(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    let e;
    try {
      e = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const x of e) {
      const p = path.join(d, x.name);
      if (x.isDirectory()) walk(p);
      else if (x.name.endsWith(".jsonl")) {
        files++;
        try {
          bytes += fs.statSync(p).size;
        } catch {
          /* raced with a writer; the indexer handles it, so the census can too */
        }
      }
    }
  };
  walk(path.join(dir, "sessions"));
  walk(path.join(dir, "session-artifacts"));
  walk(path.join(dir, "rlm-ledger"));
  return { files, bytes };
}

const cs = corpusSize(primeDir);

global.gc?.();
const baseline = process.memoryUsage();
const ix = new CommsGraphIndexer({ primeDir, minIntervalMs: 0 });

// ---- 1. cold start, to completion -----------------------------------------
const coldStart = Date.now();
let ticks = 0;
let ticksToFirstNode = null;
let maxTickMs = 0;
for (;;) {
  const t0 = Date.now();
  await ix.scan();
  const dt = Date.now() - t0;
  if (dt > maxTickMs) maxTickMs = dt;
  ticks++;
  if (ticksToFirstNode === null && ix.snapshot().nodes.length > 0) ticksToFirstNode = ticks;
  if (!ix.stats().truncated) break;
  if (ticks > 20_000) throw new Error("cold start did not converge in 20000 ticks — a cap is binding");
}
const coldMs = Date.now() - coldStart;
global.gc?.();
const afterCold = process.memoryUsage();
const snap = ix.snapshot();
const coldBytesRead = ix.stats().bytesRead;

// ---- 2. steady state, nothing appended ------------------------------------
global.gc?.();
const beforeIdle = process.memoryUsage();
const IDLE_TICKS = 200;
for (let i = 0; i < IDLE_TICKS; i++) await ix.scan();
global.gc?.();
const afterIdle = process.memoryUsage();

// ---- 3. the wire ----------------------------------------------------------
const fullWire = JSON.stringify(ix.snapshot()).length;
const idleWire = JSON.stringify(ix.snapshot({ since: ix.snapshot().seq })).length;

console.log(
  JSON.stringify(
    {
      corpus: { files: cs.files, bytes: cs.bytes, mb: mb(cs.bytes) },
      coldStart: {
        ticks,
        ticksToFirstNode,
        totalSeconds: +(coldMs / 1000).toFixed(1),
        slowestTickMs: maxTickMs,
        rssDeltaMb: mb(afterCold.rss - baseline.rss),
        heapDeltaMb: mb(afterCold.heapUsed - baseline.heapUsed),
        rssAfterMb: mb(afterCold.rss),
        graph: { nodes: snap.nodes.length, edges: snap.edges.length, recent: snap.recent.length },
      },
      steadyState: {
        idleTicks: IDLE_TICKS,
        rssDeltaKb: +((afterIdle.rss - beforeIdle.rss) / 1024).toFixed(1),
        heapDeltaKb: +((afterIdle.heapUsed - beforeIdle.heapUsed) / 1024).toFixed(1),
        bytesReadDuringIdleTicks: ix.stats().bytesRead,
      },
      wire: { fullSnapshotBytes: fullWire, unchangedSinceBytes: idleWire },
      dropped: {
        nodes: ix.stats().nodesDropped,
        edges: ix.stats().edgesDropped,
        recent: ix.stats().recentDropped,
        edgeLines: ix.stats().linesDropped,
      },
    },
    null,
    2,
  ),
);

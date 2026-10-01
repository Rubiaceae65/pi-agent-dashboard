/**
 * Live demo driver (NOT part of the test suite).
 *
 * Boots the REAL server with the REAL built web client, then holds synthetic
 * churn open so a person can watch the dashboard UI show the session list
 * while sessions come and go. This exists because the leak is a server-side
 * structure: the proof belongs in the running application, not in a CSV.
 *
 * Run through vitest (the workspace aliases only resolve there):
 *   tools/run-vitest.sh src/__tests__/leak-demo-live.test.ts
 */
import { it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server.js";
import { runChurn } from "../../leak-repro/churn.js";

// OPT-IN. This file is collected by the suite's include glob
// (`src/**/__tests__/**/*.test.ts`), and it holds a server open ON PURPOSE so a
// person can watch and screenshot the dashboard under churn. Left enabled it
// is not a test at all: it never resolves, so it sat in the suite until its
// timeout expired and turned the branch's own headline run RED.
//
// The earlier version also had a second bug worth naming: the per-test
// timeout was `DEMO_MINUTES * 120_000`, i.e. TWICE the intended duration
// (6 min -> 720 s), so "give it more time" was never going to fix it.
//
// It runs only when DEMO_LIVE=1, which is how the screenshots in shots/ were
// taken. Everything that is actually an assertion lives in
// leak-repro.test.ts, which the suite runs unconditionally.
const demoLive = process.env.DEMO_LIVE === "1";

it.skipIf(!demoLive)("holds a live dashboard open under churn", async () => {
  const home = mkdtempSync(join(tmpdir(), "leak-demo-"));
  process.env.HOME = home;
  const server = await createServer({
    port: Number(process.env.DEMO_PORT ?? 8791),
    piPort: Number(process.env.DEMO_PI_PORT ?? 8792),
    host: "127.0.0.1",
    dev: true,
    autoShutdown: false,
    shutdownIdleSeconds: 999,
    tunnel: false,
  });
  await server.start();
  console.log(`DEMO listening http://127.0.0.1:${server.httpPort()}`);

  // churn for a fixed wall-clock window, then STOP but keep serving, so the
  // session list stays on screen for the screenshot.
  const minutes = Number(process.env.DEMO_MINUTES ?? 6);
  await runChurn(server, {
    ticks: Math.round((minutes * 60) / 0.35),
    perTick: 6,
    concurrentSessions: 8,
    tickMs: 350,
    healthyClients: 1,
    slowClients: 5,
    bytesPerTick: 96 * 1024,
  });
  const all = server.sessionManager.listAll();
  console.log(
    `DEMO churn done: ${all.length} rows, ` +
      `${all.filter((s) => s.status === "ended").length} ended`,
  );
  console.log("DEMO still serving; Ctrl-C to stop.");
  // Hold the server open for the screenshot window, then END THE TEST
  // SUCCESSFULLY rather than waiting out the timeout. A timeout here would be
  // a RED run that means "the demo worked", which is exactly the kind of
  // signal that teaches people to ignore red.
  await new Promise((r) => setTimeout(r, Number(process.env.DEMO_HOLD_SEC ?? 60) * 1000));
  await server.stop?.();
  console.log("DEMO window closed cleanly.");
}, (Number(process.env.DEMO_MINUTES ?? 6) * 60 + Number(process.env.DEMO_HOLD_SEC ?? 60) + 120) * 1000);

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

it("holds a live dashboard open under churn", async () => {
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
  await new Promise(() => {});
}, Number(process.env.DEMO_MINUTES ?? 6) * 120_000);

/**
 * The route, on a REAL server.
 *
 * Three claims are only checkable against a booted server, and all three are
 * claims about safety rather than about output:
 *
 *   1. `/api/comms/graph` is inside the network guard's jurisdiction, so it is
 *      behind the same login as everything else. `network-guard-namespace-
 *      coverage.test.ts` already sweeps every registered route; this test
 *      asserts OUR route is among them by name, so a future refactor that
 *      moves it out from under the guard fails here first.
 *   2. The indexer is per SERVER, not per request. Thirty requests leave one.
 *   3. It is read-only: a POST to the same path is a 404, not a 405, because
 *      there is no handler to reject it with - there is no handler at all.
 *
 * The server is booted with PRIME_AGENT_HOME pointed at a throwaway fixture, so
 * this never reads the real `~/.prime`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isGuardJurisdiction } from "../../auth/localhost-guard.js";
import { createServer, type DashboardServer } from "../../server.js";
import { COMMS_GRAPH_ROUTE, indexerCount, indexerFor, primeAgentDir } from "../route.js";

let server: DashboardServer;
let base = "";
let primeHome = "";
let ix: ReturnType<typeof indexerFor>;

beforeAll(async () => {
  primeHome = fs.mkdtempSync(path.join(os.tmpdir(), "comms-graph-route-"));
  fs.mkdirSync(path.join(primeHome, "sessions"), { recursive: true });
  const id = "aaaaaaaa-0000-0000-0000-000000000001";
  fs.writeFileSync(
    path.join(primeHome, "sessions", `${id}.jsonl`),
    [
      JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-30T10:00:00.000Z", cwd: "/projects/fixture", rlmDepth: 0 }),
      JSON.stringify({ type: "session_info", id: "a1", timestamp: "2026-09-30T10:00:00.000Z", name: "alpha" }),
      JSON.stringify({
        type: "custom_message",
        customType: "agent_message",
        timestamp: "2026-09-30T10:01:00.000Z",
        details: {
          id: "m1",
          message: "hello from alpha\n\nbody",
          from: { sessionName: "alpha", sessionId: id, runtimeKind: "top-level" },
          target: { sessionName: "beta", sessionId: "bbbbbbbb-0000-0000-0000-000000000002", runtimeKind: "top-level" },
        },
      }),
    ].join("\n") + "\n",
  );
  process.env.PRIME_AGENT_HOME = primeHome;

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
  base = `http://127.0.0.1:${server.httpPort()}`;
  ix = indexerFor(undefined, primeHome);
}, 90_000);

afterAll(async () => {
  await server?.stop();
  delete process.env.PRIME_AGENT_HOME;
  if (primeHome) fs.rmSync(primeHome, { recursive: true, force: true });
});

describe("where the data comes from", () => {
  it("PRIME_AGENT_HOME wins, so the sandbox prototype can point at a COPY", () => {
    expect(primeAgentDir({ PRIME_AGENT_HOME: "/somewhere/copy" })).toBe("/somewhere/copy");
  });

  it("falls back to the daemon's own layout", () => {
    expect(primeAgentDir({ HOME: "/home/agent" })).toBe("/home/agent/.prime/agent");
  });
});

describe("the route", () => {
  it("sits inside the network guard's jurisdiction", () => {
    expect(isGuardJurisdiction(COMMS_GRAPH_ROUTE)).toBe(true);
  });

  it("serves the graph as JSON", async () => {
    const res = await fetch(`${base}${COMMS_GRAPH_ROUTE}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodes.map((n: { name: string }) => n.name)).toContain("alpha");
    expect(body.edges[0]).toMatchObject({ from: "alpha", to: "beta", count: 1 });
  });

  it("is read-only: a POST never returns a graph, with or without a client build", async () => {
    const res = await fetch(`${base}${COMMS_GRAPH_ROUTE}`, { method: "POST", body: "{}" });
    // The ORIGINAL assertion here was `expect(res.status).toBe(404)`, and it
    // passed only because this test boots the server with no client build. The
    // moment a built client exists, the dashboard's SPA fallback
    // (`setNotFoundHandler` -> `sendFile("index.html")`) answers every unmatched
    // request with 200 and the shell - including a POST to an API path. So the
    // status code is a property of the DEPLOYMENT, not of this route.
    //
    // The claim worth protecting is the safety one: there is no POST handler, so
    // a POST cannot mutate anything, and it cannot come back holding a graph
    // either. That is asserted here instead, and it holds in both deployments.
    const body = await res.text();
    expect(res.status === 404 || res.status === 200).toBe(true);
    if (res.status === 200) {
      expect(res.headers.get("content-type") ?? "").toContain("text/html");
    }
    expect(body).not.toContain('"edges"');
    expect(body).not.toContain('"nodes"');
  });

  it("answers `since` with a few hundred bytes when nothing moved", async () => {
    const first = await (await fetch(`${base}${COMMS_GRAPH_ROUTE}`)).json();
    const second = await (await fetch(`${base}${COMMS_GRAPH_ROUTE}?since=${first.seq}`)).json();
    expect(second.changed).toBe(false);
    expect(second.edges).toEqual([]);
    expect(JSON.stringify(second).length).toBeLessThan(1024);
  });

  it("30 requests share ONE indexer, not 30", async () => {
    await Promise.all(Array.from({ length: 30 }, () => fetch(`${base}${COMMS_GRAPH_ROUTE}`).then((r) => r.text())));
    // The same object the route uses, and the counters prove the scans were
    // rate-limited rather than one-per-request.
    const after = indexerFor(undefined, primeHome);
    expect(after).toBe(ix);
    expect(after.stats().scans).toBeLessThanOrEqual(3);
    // and no other corpus was indexed by the 30 requests
    expect(indexerCount()).toBe(1);
  });
});

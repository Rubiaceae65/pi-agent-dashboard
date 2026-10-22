/**
 * `GET /auth/status` reports `operator` with the SAME rule `operatorGuard`
 * applies to the operator-only pairing routes (auth/operator.ts), so the client
 * only calls `GET /api/pair/pending` when the server would admit it.
 *
 * The case this exists for: an owner behind a front door (Authelia ext-authz)
 * — a forwarded, non-session request. The door's login is NOT a dashboard
 * session, so it is not an operator (no widening), and the page must not
 * request the operator list on every load (rc-suites recheck RC 0011: 401
 * "operator credential required" in every engine).
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { COOKIE_NAME, signToken } from "../auth/auth.js";
import { registerAuthPlugin } from "../auth/auth-plugin.js";
import { isOperatorRequest } from "../auth/operator.js";
import { createOperatorGuard } from "../routes/pairing-routes.js";

const SECRET = "test-secret-32-chars-long-abcdef";
const LOCAL_TOKEN = "local-token-abcdef";
const SESSION = `${COOKIE_NAME}=${signToken({ sub: "o@example.com", name: "O", username: "o", provider: "github" }, SECRET)}`;
/** What the door forwards: a cluster peer address plus forwarding headers. */
const DOOR = { "x-forwarded-for": "198.51.100.7", "x-forwarded-proto": "https", host: "localhost" };

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function boot(trusted: string[] = []) {
  app = Fastify();
  await registerAuthPlugin(app, {
    authConfig: { secret: SECRET, providers: { github: { clientId: "cid", clientSecret: "cs" } } },
    port: 8000,
    resolvedTrustedNetworks: trusted,
    localToken: LOCAL_TOKEN,
  });
  // The real guard, host admission permissive for "localhost" (bind default).
  const guard = createOperatorGuard({ localToken: LOCAL_TOKEN, hostAdmission: () => ({ bindHost: "127.0.0.1" }) });
  app.get("/api/pair/pending", { preHandler: guard }, async () => ({ success: true, data: [] }));
  await app.ready();
  return app;
}

type Case = { name: string; remoteAddress: string; headers: Record<string, string>; operator: boolean };
const CASES: Case[] = [
  { name: "genuine loopback", remoteAddress: "127.0.0.1", headers: { host: "localhost" }, operator: true },
  {
    name: "dashboard session (remote)",
    remoteAddress: "203.0.113.5",
    headers: { host: "localhost", cookie: SESSION },
    operator: true,
  },
  {
    name: "valid local token",
    remoteAddress: "203.0.113.5",
    headers: { host: "localhost", "x-pi-local-token": LOCAL_TOKEN },
    operator: true,
  },
  { name: "forwarded non-session (front door)", remoteAddress: "10.42.0.9", headers: DOOR, operator: false },
  { name: "relayed loopback (tunnel)", remoteAddress: "127.0.0.1", headers: DOOR, operator: false },
];

describe("GET /auth/status operator flag (auth enabled)", () => {
  for (const c of CASES) {
    it(`${c.name}: operator=${c.operator}, and the guard agrees`, async () => {
      // The door's peer is a trusted network (PI_DASHBOARD_TRUSTED_NETWORKS),
      // which admits it past login but must not make it an operator.
      const a = await boot(["10.42.0.0/16"]);
      const status = await a.inject({ method: "GET", url: "/auth/status", ...c });
      expect(status.statusCode).toBe(200);
      expect(status.json().operator).toBe(c.operator);
      const pending = await a.inject({ method: "GET", url: "/api/pair/pending", ...c });
      // Agreement with the guard is the point: operator ⇔ not refused as non-operator.
      expect(pending.statusCode === 200).toBe(c.operator);
    });
  }

  it("a session cookie from a trusted network is NOT a session to the guard, and status says so", async () => {
    // The auth hook admits a trusted-source request before it reads the cookie,
    // so `authVia` stays unset and the guard refuses. Status must not claim more.
    const a = await boot(["10.42.0.0/16"]);
    const c = { remoteAddress: "10.42.0.9", headers: { ...DOOR, cookie: SESSION } };
    expect((await a.inject({ method: "GET", url: "/auth/status", ...c })).json()).toMatchObject({
      authenticated: true,
      operator: false,
    });
    expect((await a.inject({ method: "GET", url: "/api/pair/pending", ...c })).statusCode).toBe(401);
  });
});

describe("isOperatorRequest (shared rule)", () => {
  it("a paired-device bearer is not an operator", () => {
    expect(isOperatorRequest({ authVia: "device", ip: "203.0.113.5", headers: {} }, LOCAL_TOKEN)).toBe(false);
  });
  it("no local token configured: a presented token does not count", () => {
    expect(
      isOperatorRequest({ authVia: undefined, ip: "203.0.113.5", headers: { "x-pi-local-token": "x" } }, undefined),
    ).toBe(false);
  });
});

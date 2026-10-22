// PI_DASHBOARD_TRUSTED_NETWORKS end to end through the REAL server read path:
// env -> loadConfig().resolvedTrustedNetworks -> config snapshot ->
// liveTrustedNetworks() (what server.ts hands the universal guard hook, the
// per-route guard and the route-tier gate) and config.resolvedTrustedNetworks
// (what the WS upgrade gate reads). Trust is decided on the SOCKET PEER only.
//
// Defect: finca publish 28 / RC 0010 acceptance — behind the Cilium Gateway
// (Authelia forward-auth), the signed-in owner got 403 network_not_allowed on
// /mobile/, /links/, /api/* and WS upgrades, because the gateway's upstream
// source (the Cilium node ingress IP 10.244.0.243) could not be declared
// trusted by the deployment. See change: add-trusted-networks-env.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, TRUSTED_NETWORKS_ENV } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateWsUpgrade } from "../auth/auth-plugin.js";
import { classifyCorsOrigin } from "../auth/cors-origin.js";
import { createNetworkGuardHook, isTrustedSource } from "../auth/localhost-guard.js";
import { liveTrustedNetworks, resetConfigSnapshot } from "../config-snapshot.js";

const GATEWAY = "10.244.0.243"; // Cilium node ingress IP = Envoy upstream source
const OTHER_POD = "10.244.0.50"; // same pod CIDR, NOT the gateway

let testDir: string;
let origHome: string | undefined;
let origEnv: string | undefined;
let app: FastifyInstance | null = null;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "trusted-networks-env-"));
  origHome = process.env.HOME;
  origEnv = process.env[TRUSTED_NETWORKS_ENV];
  process.env.HOME = testDir; // no config.json: the finca deployment shape
  process.env[TRUSTED_NETWORKS_ENV] = `${GATEWAY}/32`;
  resetConfigSnapshot();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await app?.close();
  app = null;
  process.env.HOME = origHome;
  if (origEnv === undefined) delete process.env[TRUSTED_NETWORKS_ENV];
  else process.env[TRUSTED_NETWORKS_ENV] = origEnv;
  resetConfigSnapshot();
  vi.restoreAllMocks();
  fs.rmSync(testDir, { recursive: true, force: true });
});

async function buildApp(): Promise<FastifyInstance> {
  const a = Fastify();
  // Same wiring as server.ts: a live thunk over the config snapshot.
  a.addHook("onRequest", createNetworkGuardHook({ trustedNetworks: () => liveTrustedNetworks([]) }));
  a.get("/api/sessions", async () => ({ ok: true }));
  a.get("/mobile/", async () => "mobile");
  a.get("/links/", async () => "links");
  await a.ready();
  app = a;
  return a;
}

describe("universal network guard + PI_DASHBOARD_TRUSTED_NETWORKS", () => {
  it.each(["/api/sessions", "/mobile/", "/links/"])("(a) admits the declared gateway peer on %s", async (url) => {
    const a = await buildApp();
    const res = await a.inject({
      method: "GET",
      url,
      remoteAddress: GATEWAY,
      // A real gateway hop carries forwarding headers — they neither help nor hurt.
      headers: { "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "https" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("(a) admits the IPv4-mapped form of the gateway peer", async () => {
    const a = await buildApp();
    const res = await a.inject({ method: "GET", url: "/api/sessions", remoteAddress: `::ffff:${GATEWAY}` });
    expect(res.statusCode).toBe(200);
  });

  it.each(["/api/sessions", "/mobile/"])("(b) still refuses a peer outside the list on %s", async (url) => {
    const a = await buildApp();
    const res = await a.inject({ method: "GET", url, remoteAddress: OTHER_POD });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("network_not_allowed");
  });

  it("(c) X-Forwarded-For naming the gateway does NOT grant trust to another peer", async () => {
    const a = await buildApp();
    for (const headers of [
      { "x-forwarded-for": GATEWAY },
      { "x-real-ip": GATEWAY },
      { forwarded: `for=${GATEWAY}` },
      { "x-forwarded-for": `${GATEWAY}, ${OTHER_POD}` },
    ]) {
      const res = await a.inject({ method: "GET", url: "/api/sessions", remoteAddress: OTHER_POD, headers });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("network_not_allowed");
    }
  });

  it("(c) a relayed-loopback peer stays refused even if the env lists loopback", async () => {
    process.env[TRUSTED_NETWORKS_ENV] = "127.0.0.1/32";
    resetConfigSnapshot();
    const a = await buildApp();
    const res = await a.inject({
      method: "GET",
      url: "/api/sessions",
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("(d) blanket / invalid env entries are dropped — nothing is trusted", async () => {
    process.env[TRUSTED_NETWORKS_ENV] = "0.0.0.0/0, *, ::/0, gateway.example.com";
    resetConfigSnapshot();
    expect(liveTrustedNetworks([])).toEqual([]);
    const a = await buildApp();
    const res = await a.inject({ method: "GET", url: "/api/sessions", remoteAddress: OTHER_POD });
    expect(res.statusCode).toBe(403);
  });

  it("without the env var the gateway peer is refused (the measured defect)", async () => {
    delete process.env[TRUSTED_NETWORKS_ENV];
    resetConfigSnapshot();
    const a = await buildApp();
    const res = await a.inject({ method: "GET", url: "/mobile/", remoteAddress: GATEWAY });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("network_not_allowed");
  });
});

describe("WS upgrade decision + PI_DASHBOARD_TRUSTED_NETWORKS", () => {
  // server.ts upgrade handler: `trusted = config.resolvedTrustedNetworks`, then
  // the no-auth branch admits on `isTrustedSource(remoteAddress, headers, trusted)`
  // and the auth branch on `validateWsUpgrade(..., trusted, ...)`.
  it("admits the gateway peer, refuses another peer and a spoofed XFF", () => {
    const trusted = loadConfig().resolvedTrustedNetworks;
    const xff = { "x-forwarded-for": GATEWAY };
    expect(isTrustedSource(GATEWAY, { "x-forwarded-for": "203.0.113.7" }, trusted)).toBe(true);
    expect(isTrustedSource(OTHER_POD, {}, trusted)).toBe(false);
    expect(isTrustedSource(OTHER_POD, xff, trusted)).toBe(false);
    expect(validateWsUpgrade(undefined, GATEWAY, "s", trusted, { headers: {} })).toBe(true);
    expect(validateWsUpgrade(undefined, OTHER_POD, "s", trusted, { headers: xff })).toBe(false);
  });
});

describe("CORS origin decision is NOT widened by env entries", () => {
  // server.ts feeds corsOpts().trustedNetworks from liveTrustedNetworks(), which
  // now carries the env entry; the classifier must not treat it as an origin.
  it("an Origin whose host is the env-declared peer is not a trusted-network origin", () => {
    const trustedNetworks = liveTrustedNetworks([]);
    expect(trustedNetworks).toEqual([`${GATEWAY}/32`]);
    const decision = classifyCorsOrigin(`http://${GATEWAY}:8000`, { configuredOrigins: [], trustedNetworks });
    expect(decision.allowed).toBe(false);
  });

  it("config-declared networks keep their CORS allowance alongside the env list", () => {
    const decision = classifyCorsOrigin("http://192.168.1.20:8000", {
      configuredOrigins: [],
      trustedNetworks: ["192.168.1.0/24", `${GATEWAY}/32`],
    });
    expect(decision).toMatchObject({ allowed: true, kind: "trusted-network" });
  });

  it("without the env var the same list entry IS a trusted-network origin (unchanged behaviour)", () => {
    delete process.env[TRUSTED_NETWORKS_ENV];
    const decision = classifyCorsOrigin(`http://${GATEWAY}:8000`, {
      configuredOrigins: [],
      trustedNetworks: [`${GATEWAY}/32`],
    });
    expect(decision).toMatchObject({ allowed: true, kind: "trusted-network" });
  });
});

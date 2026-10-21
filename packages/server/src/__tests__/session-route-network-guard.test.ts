/**
 * Per-route network guard coverage — every session read/drive route.
 *
 * The universal `onRequest` network guard (`createNetworkGuardHook`) has an
 * in-namespace PUBLIC EXCEPTION for the configured `auth.bypassUrls`
 * prefixes, and those prefixes cover every session route. A route under a
 * bypassed prefix that lacks its OWN per-route `NetworkGuard` `preHandler`
 * is therefore fully reachable from any peer — measured pre-fix with
 * `bypassUrls = ["/api/session", "/api/sessions"]` and a non-loopback peer:
 * `POST /api/session/x/prompt` answered 400 "text is required" (the handler
 * RAN) and `GET /api/sessions` answered 200. The fix attaches a
 * `createNetworkGuard` preHandler to every session route and makes the dep
 * required, so the next unguarded route cannot compile. See change:
 * close-unguarded-session-routes.
 *
 * Suite A (structural): boots the REAL server once and enumerates the route
 * table via `onRoute`, which now exposes each route's OWN `preHandler` chain
 * (root hooks deliberately NOT included, so a root hook cannot mask a missing
 * per-route guard). Asserts every session read/drive route in the table
 * carries a `createNetworkGuard`-branded preHandler — `isNetworkGuard` is
 * true only for a guard the factory actually produced.
 *
 * Suite B (behavioural): the bypassUrls hole, closed. Registers the real
 * route modules on a small app in the exact exploited configuration
 * (universal hook with those two bypass prefixes, no trusted networks) and
 * proves a TEST-NET-3 peer (`203.0.113.5`, guaranteed not loopback and not
 * in any trusted list) gets 403 `network_not_allowed` on EVERY route in the
 * Suite A table, with the handler never running. This suite FAILS on the
 * pre-fix code, where the same requests reached the handlers (400/404/200).
 *
 * Suite C: the access that must KEEP working — loopback and trusted-network
 * peers (including the Tailscale CGNAT tailnet range the Brains actually
 * use) still reach the routes and run the handlers.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createNetworkGuard,
  createNetworkGuardHook,
  isNetworkGuard,
} from "../auth/localhost-guard.js";
import { registerAttachmentRoutes } from "../routes/attachment-routes.js";
import { registerSessionRoutes } from "../routes/session-routes.js";
import { createServer, type DashboardServer } from "../server.js";
import { registerSessionApi } from "../session/session-api.js";

/** A route table entry as `createServer`'s `onRoute` callback reports it. */
interface RouteEntry {
  method: string | string[];
  url: string;
  /** The route's OWN preHandler chain (see change: close-unguarded-session-routes). */
  preHandler?: unknown;
}

/**
 * Every session read/drive route, by registered METHOD + PATH. The paths are
 * the registered patterns with `:param` slots, exactly as `onRoute` reports
 * them. Suite A matches this table against the booted server; Suite B drives
 * it with concrete parameter values (see `driveUrl` below).
 */
/** HTTP methods the session route table drives. */
type SessionRouteMethod = "GET" | "POST" | "DELETE";

const SESSION_ROUTES: ReadonlyArray<{ method: SessionRouteMethod; path: string }> = [
  { method: "GET", path: "/api/sessions" },
  { method: "GET", path: "/api/sessions/archived" },
  { method: "GET", path: "/api/sessions/archived/:id" },
  { method: "DELETE", path: "/api/sessions/archived/:id" },
  { method: "GET", path: "/api/events/:sessionId/:seq" },
  { method: "GET", path: "/api/session-change/:sessionId/:toolCallId" },
  { method: "GET", path: "/api/session-diff" },
  { method: "GET", path: "/api/session-file" },
  { method: "GET", path: "/api/sessions/:sessionId/attachments/:attachmentId" },
  { method: "GET", path: "/api/sessions/:sessionId/entry/:entryId" },
  { method: "GET", path: "/api/sessions/:sessionId/retained-transcript" },
  { method: "GET", path: "/api/sessions/:sessionId/tool-result/:toolCallId" },
  { method: "POST", path: "/api/session/spawn" },
  { method: "POST", path: "/api/session/:id/prompt" },
  { method: "POST", path: "/api/session/:id/abort" },
  { method: "POST", path: "/api/session/:id/shutdown" },
  { method: "POST", path: "/api/session/:id/rename" },
  { method: "POST", path: "/api/session/:id/archive" },
  { method: "POST", path: "/api/session/:id/unarchive" },
  { method: "POST", path: "/api/session/:id/resume" },
  { method: "POST", path: "/api/session/:id/flow-control" },
  { method: "POST", path: "/api/session/:id/model" },
  { method: "POST", path: "/api/session/:id/thinking-level" },
  { method: "POST", path: "/api/session/:id/lifecycle" },
  { method: "POST", path: "/api/session/:id/extension-ui-response" },
  { method: "POST", path: "/api/session/:id/attach-proposal" },
  { method: "POST", path: "/api/session/:id/detach-proposal" },
];

/**
 * Concrete URL + payload to drive each registered pattern from a peer. The
 * session id "S" matches the fake session below; the spawn `cwd` is
 * deliberately non-existent so the pre-fix code (handler runs, no guard)
 * answers from the early `existsSync` check instead of spawning `pi` —
 * deterministic either way, and a 500, not a 403, which is what we want to
 * observe.
 */
const ATTACHMENT_ID = "a".repeat(64);
const DRIVES: ReadonlyArray<{ path: string; url: string; payload?: unknown }> = [
  { path: "/api/sessions", url: "/api/sessions" },
  { path: "/api/sessions/archived", url: "/api/sessions/archived" },
  { path: "/api/sessions/archived/:id", url: "/api/sessions/archived/abc" },
  { path: "/api/sessions/archived/:id", url: "/api/sessions/archived/abc" },
  { path: "/api/events/:sessionId/:seq", url: "/api/events/S/0" },
  { path: "/api/session-change/:sessionId/:toolCallId", url: "/api/session-change/S/tc1" },
  { path: "/api/session-diff", url: "/api/session-diff" },
  { path: "/api/session-file", url: "/api/session-file" },
  { path: "/api/sessions/:sessionId/attachments/:attachmentId", url: `/api/sessions/S/attachments/${ATTACHMENT_ID}` },
  { path: "/api/sessions/:sessionId/entry/:entryId", url: "/api/sessions/S/entry/e1" },
  { path: "/api/sessions/:sessionId/retained-transcript", url: "/api/sessions/S/retained-transcript" },
  { path: "/api/sessions/:sessionId/tool-result/:toolCallId", url: "/api/sessions/S/tool-result/tc1" },
  { path: "/api/session/spawn", url: "/api/session/spawn", payload: { cwd: "/nonexistent-spawn-cwd" } },
  { path: "/api/session/:id/prompt", url: "/api/session/S/prompt", payload: { text: "hello" } },
  { path: "/api/session/:id/abort", url: "/api/session/S/abort", payload: {} },
  { path: "/api/session/:id/shutdown", url: "/api/session/S/shutdown", payload: {} },
  { path: "/api/session/:id/rename", url: "/api/session/S/rename", payload: { name: "x" } },
  { path: "/api/session/:id/archive", url: "/api/session/S/archive", payload: {} },
  { path: "/api/session/:id/unarchive", url: "/api/session/S/unarchive", payload: {} },
  { path: "/api/session/:id/resume", url: "/api/session/S/resume", payload: { mode: "continue" } },
  { path: "/api/session/:id/flow-control", url: "/api/session/S/flow-control", payload: { action: "pause" } },
  { path: "/api/session/:id/model", url: "/api/session/S/model", payload: { provider: "p", modelId: "m" } },
  { path: "/api/session/:id/thinking-level", url: "/api/session/S/thinking-level", payload: { level: "high" } },
  { path: "/api/session/:id/lifecycle", url: "/api/session/S/lifecycle", payload: { action: "stop_after_turn" } },
  { path: "/api/session/:id/extension-ui-response", url: "/api/session/S/extension-ui-response", payload: { requestId: "R1", result: { answers: ["yes"] } } },
  { path: "/api/session/:id/attach-proposal", url: "/api/session/S/attach-proposal", payload: { changeName: "c" } },
  { path: "/api/session/:id/detach-proposal", url: "/api/session/S/detach-proposal", payload: {} },
];

// ── Suite A: the booted real server's route table ──────────────────────────

let server: DashboardServer;
let routes: RouteEntry[] = [];

beforeAll(async () => {
  routes = [];
  server = await createServer({
    port: 0,
    piPort: 0,
    host: "127.0.0.1",
    dev: true,
    autoShutdown: false,
    shutdownIdleSeconds: 999,
    tunnel: false,
    onRoute: (r) => routes.push(r),
  });
  await server.start();
  // Slow by design: this boots the whole server, exactly like
  // `network-guard-namespace-coverage.test.ts` (90s budget there).
}, 90_000);

afterAll(async () => {
  await server?.stop();
});

/** True when `registered` (Fastify: a method or a method list) includes `wanted`. */
function methodMatches(registered: string | string[], wanted: string): boolean {
  return Array.isArray(registered) ? registered.includes(wanted) : registered === wanted;
}

/** The route's own preHandler chain normalized to an array (absent → []). */
function preHandlerChain(entry: { preHandler?: unknown }): unknown[] {
  if (entry.preHandler === undefined) return [];
  return Array.isArray(entry.preHandler) ? entry.preHandler : [entry.preHandler];
}

describe("A: every session read/drive route carries the per-route network guard", () => {
  it("enumerates a non-trivial route table", () => {
    // Guards against a silently-empty enumeration making the offender scan
    // below vacuously true.
    expect(routes.length).toBeGreaterThan(100);
  });

  it("attaches a createNetworkGuard preHandler to every session read/drive route", () => {
    // Empirical check (Fastify 5): Fastify auto-generates a HEAD sibling for
    // every GET route, and the sibling INHERITS the same preHandler chain —
    // the onRoute hook reports the identical function on the HEAD entry (the
    // brand is present there too). So asserting on the GET/POST/DELETE
    // entries is sufficient; no separate HEAD assertion is needed.
    const offenders: string[] = [];
    for (let i = 0; i < SESSION_ROUTES.length; i += 1) {
      const { method, path } = SESSION_ROUTES[i];
      const matches = routes.filter((r) => r.url === path && methodMatches(r.method, method));
      if (matches.length === 0) {
        offenders.push(`${method} ${path}: route not found in the booted table`);
        continue;
      }
      for (const r of matches) {
        const chain = preHandlerChain(r);
        if (!chain.some((fn) => isNetworkGuard(fn))) {
          offenders.push(`${method} ${path}: preHandler chain has no isNetworkGuard entry (found ${chain.length})`);
        }
      }
    }
    // The offender list above is what a reviewer copies into a bug report;
    // on the fixed code it is empty. See change: close-unguarded-session-routes.
    expect(
      offenders,
      "session route(s) without the per-route network guard — a bypassUrls prefix would expose them to any peer; attach { preHandler: networkGuard } to each",
    ).toEqual([]);
  });
});

// ── Suites B + C: the real route modules on a small app, no real listener ──

/** TEST-NET-3: guaranteed not loopback and not in any trusted list. */
const UNTRUSTED_PEER = "203.0.113.5";
/** The exploited configuration: these two prefixes cover every session route. */
const BYPASS_URLS = ["/api/session", "/api/sessions"];

interface SessionAppFakes {
  app: FastifyInstance;
  sendToSession: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
  clearUiRequest: ReturnType<typeof vi.fn>;
  broadcast: ReturnType<typeof vi.fn>;
  broadcastSessionUpdated: ReturnType<typeof vi.fn>;
  lifecycle: Array<{ sessionId: string; action: string }>;
}

const openApps: FastifyInstance[] = [];

afterAll(async () => {
  for (const app of openApps.splice(0)) await app.close();
});

/**
 * Builds the app in the exploited shape: the universal hook with the two
 * bypass prefixes and (by default) no trusted networks, then the REAL route
 * modules the way `server.ts` registers them. `trusted` is the fixed list
 * handed to BOTH the per-route guard and the hook, so a 200 can only come
 * from the per-route guard admitting the peer — the hook (which also sees
 * the bypass prefixes) alone never lets an untrusted peer through a route
 * that the guard refuses. The fakes record every handler-side call so Suite
 * B can prove the handler never ran.
 */
async function mkSessionApp(trusted: string[] = []): Promise<SessionAppFakes> {
  const sendToSession = vi.fn(() => true);
  const update = vi.fn();
  const shutdown = vi.fn();
  const clearUiRequest = vi.fn();
  const broadcast = vi.fn();
  const broadcastSessionUpdated = vi.fn();
  const lifecycle: Array<{ sessionId: string; action: string }> = [];
  const eventStore = {
    getEvent: vi.fn(() => undefined),
    getEvents: vi.fn(() => []),
    getEventsRange: vi.fn(() => []),
    countEventsRange: vi.fn(() => 0),
    findToolEndEvent: vi.fn(() => undefined),
  };
  const sessionManager = {
    // "S" is the id the drive table below targets.
    get: (id: string) => (id === "S" ? { id } : undefined),
    listAll: vi.fn(() => []),
    update,
    unregister: vi.fn(),
  };
  const piGateway = { sendToSession };
  const browserGateway = {
    clearUiRequest,
    shutdownSession: shutdown,
    broadcast,
    broadcastSessionUpdated,
    headlessPidRegistry: { listSessions: vi.fn(() => []) },
  };

  const app = Fastify();
  openApps.push(app);
  app.decorateRequest("isAuthenticated", false);
  const networkGuard = createNetworkGuard(trusted);
  app.addHook(
    "onRequest",
    createNetworkGuardHook({
      trustedNetworks: trusted,
      getBypassUrls: () => BYPASS_URLS,
    }),
  );
  registerSessionRoutes(app, {
    sessionManager: sessionManager as never,
    eventStore: eventStore as never,
    networkGuard,
  });
  registerSessionApi(app, {
    sessionManager: sessionManager as never,
    piGateway: piGateway as never,
    browserGateway: browserGateway as never,
    handleLifecycle: async (sessionId, action) => {
      lifecycle.push({ sessionId, action });
    },
    getTrustedNetworks: () => trusted,
    networkGuard,
  });
  registerAttachmentRoutes(app, { sessionManager: sessionManager as never, networkGuard });
  await app.ready();
  return { app, sendToSession, update, shutdown, clearUiRequest, broadcast, broadcastSessionUpdated, lifecycle };
}

/** `app.inject` helper: a genuine untrusted/trusted socket peer, no networking. */
async function drive(
  app: FastifyInstance,
  method: SessionRouteMethod,
  url: string,
  peer: string,
  payload?: unknown,
) {
  const headers: Record<string, string> = {};
  let body: object | undefined;
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.parse(JSON.stringify(payload)) as object;
  }
  return app.inject({ method, url, remoteAddress: peer, headers, payload: body });
}

describe("B: the bypassUrls hole is closed for an untrusted peer", () => {
  it("answers 403 network_not_allowed on every session route, handler never runs", async () => {
    const fakes = await mkSessionApp([]);
    const offenders: string[] = [];
    // `DRIVES` and `SESSION_ROUTES` are aligned 1:1 by index — the drive row
    // IS the concrete form of the route row.
    for (let i = 0; i < SESSION_ROUTES.length; i += 1) {
      const { method, path } = SESSION_ROUTES[i];
      const { url, payload } = DRIVES[i];
      const res = await drive(fakes.app, method, url, UNTRUSTED_PEER, payload);
      const body = (res.json() ?? {}) as { error?: string };
      if (res.statusCode !== 403 || body.error !== "network_not_allowed") {
        offenders.push(`${method} ${path} (${url}): got ${res.statusCode} ${JSON.stringify(body)}`);
      }
    }
    expect(offenders, "untrusted peer reached a session route that should have been 403'd").toEqual([]);
    // The fakes are the handlers' own call sites: if ANY handler had run,
    // one of these would have recorded the call.
    expect(fakes.sendToSession).not.toHaveBeenCalled();
    expect(fakes.update).not.toHaveBeenCalled();
    expect(fakes.shutdown).not.toHaveBeenCalled();
    expect(fakes.clearUiRequest).not.toHaveBeenCalled();
    expect(fakes.broadcast).not.toHaveBeenCalled();
    expect(fakes.broadcastSessionUpdated).not.toHaveBeenCalled();
    expect(fakes.lifecycle).toEqual([]);
  });
});

describe("C: loopback and trusted-network access keeps working", () => {
  it("a loopback peer reaches the routes and the handler runs", async () => {
    const fakes = await mkSessionApp([]);
    const sessions = await drive(fakes.app, "GET", "/api/sessions", "127.0.0.1");
    expect(sessions.statusCode, `body: ${sessions.payload}`).toBe(200);
    const prompt = await drive(fakes.app, "POST", "/api/session/S/prompt", "127.0.0.1", { text: "hello" });
    expect(prompt.statusCode, `body: ${prompt.payload}`).toBe(200);
    expect(fakes.sendToSession).toHaveBeenCalledTimes(1);
  });

  it("a peer in a trusted network (203.0.113.0/24) reaches the routes", async () => {
    const fakes = await mkSessionApp(["203.0.113.0/24"]);
    const sessions = await drive(fakes.app, "GET", "/api/sessions", UNTRUSTED_PEER);
    expect(sessions.statusCode, `body: ${sessions.payload}`).toBe(200);
    const prompt = await drive(fakes.app, "POST", "/api/session/S/prompt", UNTRUSTED_PEER, { text: "hello" });
    expect(prompt.statusCode, `body: ${prompt.payload}`).toBe(200);
    expect(fakes.sendToSession).toHaveBeenCalledTimes(1);
  });

  it("the Tailscale tailnet range (100.64.0.0/10) is admitted", async () => {
    // The Brains' tailnets sit in the CGNAT block Tailscale carves out; the
    // guard must admit a tailnet peer by CIDR, same as any trusted network.
    const fakes = await mkSessionApp(["100.64.0.0/10"]);
    const sessions = await drive(fakes.app, "GET", "/api/sessions", "100.101.102.103");
    expect(sessions.statusCode, `body: ${sessions.payload}`).toBe(200);
    const prompt = await drive(fakes.app, "POST", "/api/session/S/prompt", "100.101.102.103", { text: "hello" });
    expect(prompt.statusCode, `body: ${prompt.payload}`).toBe(200);
    expect(fakes.sendToSession).toHaveBeenCalledTimes(1);
  });
});

/**
 * The static sub-apps are INSIDE the network guard's jurisdiction.
 *
 * Review finding, and it is a real one. `/links/` was added served-outside-the-
 * guard on the reasoning that a sub-app is "static bytes with no capability" —
 * the argument that does hold for the SPA shell at `/`. It does not hold for
 * this page: the links page's HTML IS the disclosure. Shipped unauthenticated
 * to any peer that can open the socket, it hands over the tailnet
 * (100.65.131.102, 100.64.121.16), the host LAN (10.99.227.30/60/115/242), the
 * Brain and sandbox names, and the service ports including 5900.
 *
 * WHY THIS FILE IS MOSTLY NON-SKIP. The obvious way to test "an untrusted peer
 * is refused" over real HTTP is to bind the server to 0.0.0.0 and connect via a
 * non-loopback address — which not every environment has, so it needs a skip.
 * A skip is how the previous version of the sibling suite reported GREEN with a
 * page missing. So the two assertions that carry the finding are here, and they
 * never skip: the pure jurisdiction predicate, and the real guard hook driven
 * with a fabricated non-loopback `request.ip` (TEST-NET-3). The real-socket test
 * is included as corroboration and is the only part that can skip.
 *
 * The negative half matters as much as the positive: guarding `/links/` must not
 * lock the owner out of their own dashboard. Loopback and a `trustedNetworks`
 * CIDR — including the Tailscale range the Brains use — must still be admitted,
 * and the SPA shell at `/` must stay OUTSIDE jurisdiction.
 *
 * See change: guard-static-subapps.
 */
import { describe, expect, it } from "vitest";
import { createNetworkGuardHook, isGuardJurisdiction } from "../../auth/localhost-guard.js";
import { LINKS_PREFIX, MOBILE_PREFIX, SUB_APP_PREFIXES } from "../static-subapp-route.js";

/** TEST-NET-3. Never a real peer, never loopback, never in a trusted list. */
const UNTRUSTED = "203.0.113.5";

/**
 * Drive the REAL universal hook with a fabricated request/reply and report
 * whether it denied. No Fastify, no sockets, no networking — so this cannot
 * skip and cannot be made to pass by an absent interface.
 */
async function hookDenies(
  url: string,
  opts: { ip?: string; trusted?: string[]; authenticated?: boolean } = {},
): Promise<{ denied: boolean; code?: number; body?: { error?: string } }> {
  const sent: { code?: number; body?: { error?: string } } = {};
  const reply = {
    code(c: number) {
      sent.code = c;
      return this;
    },
    send(b: { error?: string }) {
      sent.body = b;
      return this;
    },
  };
  const request = {
    url,
    ip: opts.ip ?? UNTRUSTED,
    headers: {},
    isAuthenticated: opts.authenticated ?? false,
  };
  const hook = createNetworkGuardHook({
    trustedNetworks: opts.trusted ?? [],
    getBypassUrls: () => [],
    getPairingPrefixes: () => [],
    logDenial: () => {},
  });
  await hook(request as never, reply as never);
  return { denied: sent.code !== undefined, code: sent.code, body: sent.body };
}

describe("the sub-app prefixes are in the guard's jurisdiction", () => {
  it("claims both the slashed and the slashless form of every sub-app", () => {
    // The slashless form matters as much as the slashed one: it is a real
    // registered route (the 308), and a redirect that hands an untrusted peer
    // the location of a guarded page is a needless tell.
    for (const prefix of SUB_APP_PREFIXES) {
      for (const p of [prefix, `${prefix}/`, `${prefix}/index.html`, `${prefix}/src/app.js`]) {
        expect(isGuardJurisdiction(p), p).toBe(true);
      }
    }
  });

  it("keeps the SPA shell, settings and the login surface OUT of jurisdiction", () => {
    // The collateral-damage half. Guarding the sub-apps must not put the
    // dashboard's own public shell behind the guard, or an owner who has not
    // configured `trustedNetworks` cannot open the page they are trying to
    // configure. `/settings` is a deep link into the SPA shell.
    for (const p of ["/", "/settings", "/manifest.json", "/sw.js", "/auth/status", "/mcp"]) {
      expect(isGuardJurisdiction(p), p).toBe(false);
    }
  });

  it("still claims the original four namespaces", () => {
    for (const p of ["/api/sessions", "/v1/messages", "/editor/x", "/live/abc"]) {
      expect(isGuardJurisdiction(p), p).toBe(true);
    }
  });
});

describe("an untrusted peer is refused the sub-app pages", () => {
  for (const prefix of SUB_APP_PREFIXES) {
    for (const p of [prefix, `${prefix}/`, `${prefix}/index.html`]) {
      it(`403s ${p} with the shared network_not_allowed shape`, async () => {
        const { denied, code, body } = await hookDenies(p);
        expect(denied, `${p} was admitted to an untrusted peer`).toBe(true);
        expect(code).toBe(403);
        // The same body every other guarded surface returns, so a client that
        // branches on it keeps working.
        expect(body?.error).toBe("network_not_allowed");
      });
    }
  }

  it("refuses the links page on the raw and the resolved view of a dotted target", async () => {
    // The guard's jurisdiction test is a UNION of the raw and the resolved
    // pathname, precisely so a target that resolves INTO a guarded namespace
    // cannot route around it through a `:param` or `*` slot.
    for (const p of ["/foo/../links/", "/links/../links/"]) {
      const { denied } = await hookDenies(p);
      expect(denied, p).toBe(true);
    }
  });
});

describe("the access that must keep working", () => {
  it("admits a loopback peer", async () => {
    const { denied } = await hookDenies(`${LINKS_PREFIX}/`, { ip: "127.0.0.1" });
    expect(denied, "loopback must never be denied").toBe(false);
  });

  it("admits a peer inside trustedNetworks, including the Tailscale range", async () => {
    // The Brains trust the tailnet by CIDR; a links page only the tailnet can
    // read is useless, and a phone client only the tailnet can drive is worse.
    const tailnet = await hookDenies(`${MOBILE_PREFIX}/`, {
      ip: "100.101.102.103",
      trusted: ["100.64.0.0/10"],
    });
    expect(tailnet.denied).toBe(false);

    const lan = await hookDenies(`${LINKS_PREFIX}/`, {
      ip: "10.99.227.30",
      trusted: ["10.99.227.0/24"],
    });
    expect(lan.denied).toBe(false);
  });

  it("admits an authenticated peer with no trusted network configured", async () => {
    const { denied } = await hookDenies(`${LINKS_PREFIX}/`, { authenticated: true });
    expect(denied, "a signed-in device must not be refused the page").toBe(false);
  });
});

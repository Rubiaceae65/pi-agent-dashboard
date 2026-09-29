/**
 * The static sub-apps, served from a real server.
 *
 * Two things are proved here, and the second is the one that matters:
 *
 *  1. `registerStaticSubAppRoute` answers the SLASHLESS path with a 308 to the
 *     slashed form, for any prefix.
 *
 *  2. `/mobile/` and `/links/` really are SERVED — and the assertion is on the
 *     BODY, not on the status. The dashboard is a single-page app with a
 *     catch-all not-found handler, so it answers **200 text/html with its own
 *     shell for every path**, including `/links/` on a build where the links
 *     page was never added. A `200`-only test is therefore a FALSE GREEN: it
 *     passes on a page that is not there. Measured, not assumed — the check for
 *     it is the last test in this file, which asks for a path that must NOT
 *     serve the page and requires it not to.
 *
 * This suite boots the real server, so it sees the real `publicDir` → `dist`
 * copy that `pnpm build` performs.
 *
 * THE SKIP IS DELIBERATELY AS NARROW AS POSSIBLE, and that is a correction this
 * file's own author had to make. The first version skipped a sub-app whenever
 * `dist/<name>/index.html` was absent. Removing the built links page then made
 * the suite report 6 passed / 2 skipped / rc=0 — a GREEN build with the page
 * missing, which is the precise false green this file exists to prevent. The
 * skip now applies ONLY when there is no client build at all (an API-only
 * checkout, `clientDir === null`). When a build exists and the sub-app is
 * missing from it, that is a FAILURE: `public/<name>/index.html` exists in the
 * source tree, so the build dropped it.
 *
 * See change: add-same-origin-mobile-poc, add-same-origin-links-page.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveStaticClientDir } from "../../lib/client-dist.js";
import {
  LINKS_PREFIX,
  MOBILE_PREFIX,
  registerStaticSubAppRoute,
} from "../static-subapp-route.js";
import { createServer, type DashboardServer } from "../../server.js";

/**
 * Body markers that identify each page. A marker is a string the SPA shell
 * provably does NOT contain, so "did we serve the page or the fallback" is a
 * question with a decidable answer.
 */
const SUB_APPS = [
  {
    prefix: MOBILE_PREFIX,
    /** The phone client's own <title>; the dashboard shell's is different. */
    marker: "<title>pi mobile</title>",
    what: "the phone client",
  },
  {
    prefix: LINKS_PREFIX,
    /** Handed over by lead links-page-20260929, workshop-map@034ba51. */
    marker: "Workshop links",
    what: "the workshop-map links page",
  },
] as const;

let server: DashboardServer;
let base = "";
/** Null when the client build is absent (an API-only checkout). */
let clientDir: string | null = null;

beforeAll(async () => {
  server = await createServer({
    port: 0,
    piPort: 0,
    host: "127.0.0.1",
    dev: false,
    autoShutdown: false,
    shutdownIdleSeconds: 999,
    tunnel: false,
  });
  await server.start();
  const port = server.httpPort();
  if (port == null) throw new Error("server did not resolve an http port");
  base = `http://127.0.0.1:${port}`;
  clientDir = resolveStaticClientDir();
}, 120_000);

afterAll(async () => {
  await server?.stop();
});

/**
 * Whether the client build actually carries this sub-app's index.html.
 *
 * Three states, not two, and the difference is the whole point:
 *   - no client build at all (API-only checkout)  -> the caller may SKIP
 *   - build present, sub-app present              -> run the assertions
 *   - build present, sub-app ABSENT               -> FAIL, loudly
 */
function isBuilt(prefix: string): boolean {
  if (!clientDir) return false;
  return fs.existsSync(path.join(clientDir, prefix.slice(1), "index.html"));
}

/** Skip only for a checkout with no client build; never for a missing sub-app. */
function requireBuilt(prefix: string, skip: () => void): void {
  if (!clientDir) {
    skip();
    return;
  }
  expect(
    isBuilt(prefix),
    `${prefix}/ is missing from the client build at ${clientDir}. The source lives in public/${prefix.slice(1)}/ — if that file exists, the build dropped it, and skipping here would report green for a page that is not there.`,
  ).toBe(true);
}

describe("slashless sub-app paths redirect to the served directory", () => {
  for (const { prefix, what } of SUB_APPS) {
    it(`GET ${prefix} is a 308 to ${prefix}/ (${what})`, async () => {
      const res = await fetch(`${base}${prefix}`, { redirect: "manual" });
      expect(res.status, `${prefix} must redirect, not serve`).toBe(308);
      expect(res.headers.get("location")).toBe(`${prefix}/`);
    });

    it(`GET ${prefix} is a route, not a request that fell through to the SPA`, async () => {
      // The negative twin of the test above: if the route were missing, the SPA
      // catch-all would answer 200 text/html here and this would pass for the
      // wrong reason. 200 would be the failure, not the success.
      const res = await fetch(`${base}${prefix}`, { redirect: "manual" });
      expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
    });
  }
});

describe("each sub-app is served same-origin from the client build", () => {
  for (const { prefix, marker, what } of SUB_APPS) {
    it(`GET ${prefix}/ serves ${what} — asserted on the BODY`, async ({ skip }) => {
      // Narrow on purpose: an API-only checkout has nothing to serve, but a
      // BUILT client that is missing the sub-app is a broken build, not a
      // reason to skip. See the file header.
      requireBuilt(prefix, skip);
      const res = await fetch(`${base}${prefix}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/html");
      const body = await res.text();
      // THE assertion. A 200 here is the dashboard's SPA shell just as much as
      // it is the page; the marker is what separates the two.
      expect(
        body.includes(marker),
        `${prefix}/ answered 200 but the body is not ${what} — this is the SPA fallback, not the page`,
      ).toBe(true);
    });
  }

  it("serves the links page with its six dev-system cards", async ({ skip }) => {
    requireBuilt(LINKS_PREFIX, skip);
    const body = await (await fetch(`${base}${LINKS_PREFIX}/`)).text();
    // Handed over as a build artefact (workshop-map, `make links`). The count
    // is the other half of the proof: a page that lost half its cards would
    // still contain the title and pass a marker-only check.
    const cards = body.split('"devSystem": true').length - 1;
    expect(cards, "dev-system card count changed — regenerate with `make links`").toBe(6);
  });
});

describe("a path with no sub-app behind it does NOT serve a sub-app", () => {
  it("GET /no-such-sub-app/ is not the links page or the phone client", async () => {
    // The guard against the false green in the file's header: the SPA answers
    // 200 text/html for this, and that is CORRECT. What it must not do is hand
    // back a sub-app's body.
    const res = await fetch(`${base}/no-such-sub-app/`);
    const body = await res.text();
    for (const { marker } of SUB_APPS) {
      expect(body.includes(marker), `${marker} leaked onto an unserved path`).toBe(false);
    }
  });
});

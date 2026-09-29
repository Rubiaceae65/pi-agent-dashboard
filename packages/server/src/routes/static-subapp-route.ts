/**
 * Static sub-apps served same-origin off the dashboard (`/mobile/`, `/links/`).
 *
 * A sub-app is a directory of plain files in the repo's top-level `public/`
 * tree. Vite copies `public/` VERBATIM into the client build
 * (`packages/client/dist/<name>/`) and `@fastify/static` already serves that
 * directory at `/`, so `<prefix>/` resolves to the bundle's own `index.html`
 * with no route, no second process and no second origin. The dashboard serving
 * its own static pages is the point: one origin means no CORS grant, and the
 * page can talk to `/api/...` and `/ws` without a proxy in between.
 *
 * What DOES need a route is the SLASHLESS path. `@fastify/static` matches a
 * FILE, not a directory, so `/mobile` finds nothing and falls through to the
 * SPA not-found handler — a phone that types the short URL gets the entire
 * desktop app. A permanent redirect to the slashed form is the whole fix, and
 * the slashed form is the one a human types.
 *
 * GUARD POSITION — read this before "fixing" it.
 * A sub-app's files are OUTSIDE the network guard's jurisdiction on purpose.
 * `isGuardJurisdiction` covers `/api/`, `/v1/`, `/editor/`, `/live/` only, and
 * the SPA shell at `/`, `/manifest.json` and the PWA icons are already outside
 * it: they are static bytes with no capability. A sub-app is the same kind of
 * surface — the page loading tells an attacker nothing about what it may read.
 * Every byte of DATA a sub-app can reach comes from `/api/...` or `/ws`, all of
 * which ARE guarded, so a sub-app on an untrusted network is a UI that cannot
 * read a single session. Guarding the HTML instead would buy nothing and would
 * cost the owner the ability to open the dashboard's own pages on a phone.
 * See change: add-same-origin-mobile-poc.
 */
import type { FastifyInstance } from "fastify";

/** The phone client, published by this branch. */
export const MOBILE_PREFIX = "/mobile";
/** The workshop-map links page (see change: add-same-origin-links-page). */
export const LINKS_PREFIX = "/links";

/** Normalise a sub-app prefix to a leading slash and no trailing slash. */
function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/\/+$/, "");
  if (!trimmed.startsWith("/")) throw new Error(`sub-app prefix must start with "/": ${prefix}`);
  if (trimmed.length < 2) throw new Error(`sub-app prefix must name a path: ${prefix}`);
  return trimmed;
}

/**
 * Register the slashless redirect for one static sub-app.
 *
 * MUST be called BEFORE `fastify.register(fastifyStatic, ...)`: explicit Fastify
 * route matching wins over the static plugin's fallback, which is the same
 * ordering rule `registerManifestRoute` follows for `/manifest.json`.
 *
 * Idempotent per instance+prefix, so a second call for the same sub-app is a
 * no-op rather than Fastify's duplicate-route error — two plugins may both ask
 * for `/mobile` without either of them having to know about the other.
 */
export function registerStaticSubAppRoute(fastify: FastifyInstance, prefix: string): void {
  const base = normalizePrefix(prefix);
  const seen = (fastify as { __staticSubAppPrefixes?: Set<string> }).__staticSubAppPrefixes ??= new Set<string>();
  if (seen.has(base)) return;
  seen.add(base);

  fastify.get(base, async (_request, reply) => {
    // 308, not 302: a phone that "Add to Home Screen"ed the short URL must not
    // have its launcher entry pinned to a redirect, and the target is the same
    // path with a slash, so re-POSTing is never a concern.
    reply.code(308).header("Location", `${base}/`);
  });
}

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
 * GUARD POSITION — read this before "changing" it.
 *
 * A sub-app IS in the network guard's jurisdiction. The first version of this
 * file argued the opposite — that a sub-app is "static bytes with no
 * capability", the same argument that holds for the SPA shell at `/`. That
 * argument is FALSE here, and the review that caught it is the reason this
 * paragraph is blunt: the links page is not a shell, it is the inventory.
 * Shipped in its HTML, unauthenticated, to anyone who can reach the port, it
 * hands over the tailnet addresses (100.65.131.102, 100.64.121.16), the host
 * LAN (10.99.227.30/60/115/242), the Brain and sandbox names, and the service
 * ports including 5900. A sub-app's reachability is therefore a disclosure
 * decision about that page's CONTENT, not a fact about its being a file.
 *
 * The prefixes are exported and consumed by `localhost-guard.ts` to build the
 * guard's jurisdiction, so adding a sub-app here and forgetting the guard (or
 * vice versa) is not expressible.
 *
 * See change: add-same-origin-mobile-poc, guard-static-subapps.
 */
import type { FastifyInstance } from "fastify";

// The prefix list itself lives in `lib/` so the network guard can read the same
// list without importing `routes/`. Re-exported here because this is the module
// that registers the routes, and a caller that only wants the constants should
// not have to know that.
export { LINKS_PREFIX, MOBILE_PREFIX, SUB_APP_PREFIXES } from "../lib/static-subapps.js";

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

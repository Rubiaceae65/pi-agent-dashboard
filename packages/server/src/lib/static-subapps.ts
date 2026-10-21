/**
 * The static sub-app surfaces, as ONE list.
 *
 * A "sub-app" is a directory of plain files under the repo's top-level `public/`
 * tree, copied verbatim into the client build and served same-origin by
 * `@fastify/static` (see `routes/static-subapp-route.ts` for the routing and the
 * slashless redirect).
 *
 * This module exists so the two facts that must never disagree are written down
 * exactly once:
 *
 *   1. which prefixes get a route, and
 *   2. which prefixes the network guard claims.
 *
 * `auth/localhost-guard.ts` builds `GUARD_JURISDICTION_PREFIXES` from
 * `SUB_APP_PREFIXES`, so a sub-app cannot be added to the served set and
 * forgotten by the guard. That omission is not hypothetical: `/links/` shipped
 * outside the guard while its own data — the tailnet, the host LAN, the Brain
 * and sandbox names, and the service ports — sat in the HTML, readable by any
 * peer that could open the socket.
 *
 * It lives in `lib/` rather than being imported from `routes/` because
 * `localhost-guard.ts` deliberately keeps itself free of `routes/` imports (see
 * that module's `getPairingPrefixes` note, which injects pairing prefixes for
 * the same reason). One neutral module, imported by both, breaks no cycle and
 * keeps the layering honest.
 *
 * See change: add-same-origin-mobile-poc, guard-static-subapps.
 */

/** The phone client. */
export const MOBILE_PREFIX = "/mobile";

/** The workshop-map links page (workshop-map `make links`). */
export const LINKS_PREFIX = "/links";

/** The live agent communication graph (comms-graph-20260930). */
export const GRAPH_PREFIX = "/graph";

/**
 * Every static sub-app prefix.
 *
 * The guard matches these BARE (no trailing slash) rather than slash-anchored
 * the way it matches `/api/`. A sub-app prefix is a whole top-level surface
 * owned by one feature, so claiming `/links` and `/mobile` (the slashless
 * redirect entries) too is the stricter reading; the over-claim only reaches
 * paths no other feature can own, and a 403 on a URL that serves nothing is
 * the direction to err in.
 */
export const SUB_APP_PREFIXES: readonly string[] = [MOBILE_PREFIX, LINKS_PREFIX, GRAPH_PREFIX];

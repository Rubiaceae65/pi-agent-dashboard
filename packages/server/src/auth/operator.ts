/**
 * "Is this request an operator?" — ONE rule, shared by the operator-only
 * pairing routes (`operatorGuard` in `routes/pairing-routes.ts`) and the
 * `operator` flag of `GET /auth/status`, so the client's "may I call an
 * operator API" answer and the server's "will I admit it" answer cannot drift.
 *
 * An operator holds exactly one of:
 *
 * 1. a dashboard login session (`authVia === "session"`), or
 * 2. a valid `X-Pi-Local-Token`, or
 * 3. `isGenuinelyLocal` — loopback with no forwarding headers.
 *
 * Deliberately NOT an operator: a paired-device bearer, a trusted-network
 * address with no credential, and a request a front door (reverse proxy with
 * its own login) forwarded — the door's login is not a dashboard session.
 *
 * Host admission is the guard's SECOND step and is not part of this rule.
 */
import { verifyLocalToken } from "./local-token.js";
import { isGenuinelyLocal } from "./localhost-guard.js";

export interface OperatorCandidate {
  /** `request.authVia` as set by the admission hooks ("session" | "device" | undefined). */
  authVia: unknown;
  /** Socket peer address (`request.ip`; Fastify does not trust proxies here). */
  ip: string;
  headers: Record<string, unknown>;
}

export function isOperatorRequest(req: OperatorCandidate, localToken: string | undefined): boolean {
  return (
    req.authVia === "session" ||
    (localToken !== undefined && verifyLocalToken(req.headers, localToken)) ||
    isGenuinelyLocal(req.ip, req.headers)
  );
}

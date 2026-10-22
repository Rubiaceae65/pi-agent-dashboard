# Add PI_DASHBOARD_TRUSTED_NETWORKS (deployment-declared trusted proxy sources)

## Why

Measured on finca (publish 28 / RC 0010 acceptance; deployment `estate-rc0005/dashboard`,
env only `PI_DASHBOARD_HOST=0.0.0.0`, `DASHBOARD_PORT=8000`, `TUNNEL_ENABLED=0`, no
`config.json` auth, no `trustedNetworks`): the dashboard sits behind a Cilium Gateway API
Envoy whose HTTPRoute carries an ExternalAuth (Authelia forward-auth, owner group only).
The signed-in owner got `403 {error:"network_not_allowed"}` on `/mobile/`, `/links/`,
`/api/*`, and WS upgrades got 403.

The universal network guard (`createNetworkGuardHook` → `hasNetworkPassCondition` →
`isTrustedSource`) admits only genuine-local, local-token, a `trustedNetworks` socket
peer, or an authenticated request. Every request arrives from the gateway's upstream
source address (the Cilium node ingress IP `10.244.0.243`), and the only way to trust it
is `trustedNetworks` in `~/.pi/dashboard/config.json`, set through the UI — which the
deployment cannot reach because the UI is behind the very guard that refuses it.

## What Changes

- New env var `PI_DASHBOARD_TRUSTED_NETWORKS`: comma- and/or whitespace-separated exact
  IPv4/IPv6 addresses or IPv4 CIDRs. `loadConfig()` merges the validated entries into
  `resolvedTrustedNetworks` (alongside `trustedNetworks` + `auth.bypassHosts`). They are
  never written to `config.json` and never appear in `trustedNetworks`, so the UI cannot
  remove them and nothing is persisted.
- Validation refuses (drops, with one `console.warn` per distinct env value naming the
  entry; never throws): wildcards (`*`), hostnames / non-IPs, IPv4 prefixes shorter than
  `/8` (incl. `0.0.0.0/0`), invalid prefixes, and any IPv6 CIDR (incl. `::/0`) because the
  peer matcher `matchCidr` is IPv4-only.
- Trust stays decided on the SOCKET PEER only (`request.ip` / upgrade `remoteAddress`);
  Fastify `trustProxy` stays off; `X-Forwarded-For` never grants trust; a relayed-loopback
  peer stays refused (`isRelayedLoopback`) even if the env lists loopback.
- CORS: env entries name trusted socket peers, not browser origins, so the CORS /
  origin-admission classifier (`classifyCorsOrigin` branch 8 in `auth/cors-origin.ts`)
  skips any entry listed in `PI_DASHBOARD_TRUSTED_NETWORKS` (conservative: an entry also
  listed in `config.json` is skipped too). `server.ts` is unchanged.

## Consumers of resolvedTrustedNetworks

| Consumer | Source | Env entries reach it? |
|---|---|---|
| universal guard hook (`createNetworkGuardHook`) | `liveTrustedNetworks()` | yes (the fix) |
| per-route `createNetworkGuard` | `liveTrustedNetworks()` | yes |
| route-tier gate (`createRouteTierGate`) | `liveTrustedNetworks()` | yes — same trust as a config entry |
| session API `getTrustedNetworks` | `liveTrustedNetworks()` | yes |
| WS upgrade (no-auth branch + `validateWsUpgrade`) | boot `config.resolvedTrustedNetworks` | yes (env is boot-time) |
| auth plugin `bypassHosts` | `resolvedTrustedNetworks` | yes — same as a config entry |
| `/api/health` `trustPosture` | `liveTrustedNetworks()` | yes (loopback-covering flag only) |
| CORS / origin admission (`classifyCorsOrigin` via `corsOpts()`) | `liveTrustedNetworks()` | **no** — env entries skipped in branch 8 |
| access routes list/revoke, network plane append | `config.trustedNetworks` (persisted) | no — by design; not UI-editable |

## Impact

- Deployment: set `PI_DASHBOARD_TRUSTED_NETWORKS=10.244.0.243/32` on finca. Operator
  caveat: every client whose traffic reaches the dashboard from a listed address is fully
  trusted, so the address must be one only the authenticating proxy uses (on Cilium the
  node ingress IP is shared by every Gateway/Ingress route on that node — every route to
  this Service must carry the forward-auth).
- No change when the variable is unset.

## Discipline Skills

- `security-hardening` — untrusted-input validation of the env list; blanket-trust
  refusal; socket-peer-only trust (XFF never trusted); CORS not widened.
- `systematic-debugging` — reproduce the measured 403 for the gateway peer in a test
  before the fix.

# Tasks

## 1. Reproduce

- [x] 1.1 Test: with no `config.json` and no env, a request whose socket peer is `10.244.0.243` to `/mobile/` is `403 network_not_allowed` (`packages/server/src/__tests__/trusted-networks-env.test.ts`).

## 2. Env list

- [x] 2.1 `parseTrustedNetworksEnv` + `deploymentTrustedNetworks` in `packages/shared/src/config.ts` (validation, memoized one-shot warn).
- [x] 2.2 `loadConfig` merges the env list into `resolvedTrustedNetworks` — also on the no-file / defaults path.
- [x] 2.3 `classifyCorsOrigin` branch 8 (`packages/server/src/auth/cors-origin.ts`) skips env entries.

## 3. Tests

- [x] 3.1 Shared: parse/validation + loadConfig merge (`packages/shared/src/__tests__/config-trusted-networks-env.test.ts`).
- [x] 3.2 Server: guard hook admits the declared peer on `/api/sessions`, `/mobile/`, `/links/`; refuses other peers, spoofed `X-Forwarded-For`, relayed loopback; blanket entries dropped; WS decision; CORS not widened.
- [x] 3.3 `forwarded-ip-trust.test.ts`, `genuine-local.test.ts`, `localhost-guard.test.ts`, `config.test.ts` stay green.

## 4. Docs

- [x] 4.1 `docker/README.md` env table, `docker/compose.yml` pass-through, `docker/entrypoint.sh` header, index rows (`config.ts.AGENTS.md`, `cors-origin.ts.AGENTS.md`, `docker/entrypoint.sh.AGENTS.md`).

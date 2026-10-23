# Runtime image (`docker/Dockerfile` stage `runtime`)

Deployed image = last Dockerfile stage `runtime`. Default target of `docker build` and `scripts/build-image.sh`.
Full dev/test tree stays available as stage `app` (`--target app`).
Why: trivy on `rubiaceae65/pi-dashboard:dev-3` (2026-10-23) — ~84% of fixable CRITICAL/HIGH findings were build tooling shipped in the runtime image (pnpm store, electron-builder `app-builder-bin`, esbuild under vite/vitest/vite-node).

## Stages

| Stage | From | Content | Used by |
|---|---|---|---|
| `base` | `node:24-bookworm-slim@sha256:…` | apt tools (tmux, jq, git, curl, ripgrep, fd, poppler-utils, build-essential, python3), gh, jj; zrok2 only with `INCLUDE_ZROK=1` | all |
| `globals` | `base` | user `pi` (UID 1000), global npm: pi-coding-agent, openspec, pi-flows, pi-anthropic-messages, pi-dashboard-subagents; `corepack enable` | `app`, `prod-deps`, `runtime` |
| `app` | `globals` | full `pnpm install` (devDependencies), qa/, tests/, knip inputs, `.github/`, `.pi/skills` | `docker/test-up.sh` (via `compose.test.target.yml`) + `compose.dev.yml` (`build.target: app`) |
| `prod-deps` | `globals` | `pnpm install --frozen-lockfile --prod`, `pnpm run build`, `docker/scripts/prune-build-only.mjs` | `runtime` (COPY of `/app` only) |
| `runtime` | `globals` | `/app` from `prod-deps`, entrypoint, supervise-daemon, `npm link`, build-essential/python3 purged | deployment (default target) |

## What `runtime` keeps (and why)

- `/app/packages/*` source. Server runs TypeScript via jiti (`packages/server/bin/pi-dashboard.mjs`): source IS the runtime.
- All workspace packages. Server discovers plugins by scanning `packages/*` from the monorepo root (`packages/dashboard-plugin-runtime/src/server/loader.ts:63` `findMonorepoRoot`, `pnpm-workspace.yaml` marker) → every workspace's prod deps needed.
- `packages/client/dist` — static client (`packages/server/src/lib/client-dist.ts:64` `resolveStaticClientDir`). No vite at runtime: `--dev` only proxies to an external Vite port (`server.ts` `detectVitePort`).
- `node_modules/esbuild` (0.28.2) — runtime dep: `@earendil-works/chord` (`pi-agent-core` ← `pi-coding-agent`) does `import { build } from "esbuild"` (`dist/node/bundle.js:4`); `packages/deck3d/src/render/index.ts:33` + `src/parse/harvest/bundle.ts:20` import it for the deck3d skill.
- `tsx` — `packages/server/package.json` `dependencies` (governed by `scripts/verify-release-deps.mjs`); doctor reports it (`packages/shared/src/doctor-core.ts:1267`).
- `playwright` (prod dep of `packages/deck3d`, mermaid harvest) — no browsers downloaded.
- `gh` — spawned by git routes (`packages/server/src/routes/git-routes.ts:928`, `:976`; `packages/shared/src/platform/git.ts:285`).
- `zrok2`/`zrok` — **only when built with `--build-arg INCLUDE_ZROK=1`** (dev/personal build that wants the public tunnel). Default `INCLUDE_ZROK=0` = release image: no zrok binary (zrok 2.0.8's embedded Go deps — pgx, amqp091-go, smallstep/certificates, grpc — carry fixable CRITICAL/HIGH CVEs no zrok release fixes; release posture is public tunnel off). Without it the entrypoint logs `zrok not installed in this image — tunnel unavailable` and the server reports the tunnel as `unavailable` (`/api/tunnel-status`) without failing boot.
- `jj`, git, tmux, rg, fd, pdftotext, jq — unchanged from `base`.
- `corepack enable` shims (pnpm on demand for user projects; no store baked in).
- Native install scripts as in `app`: node-pty, koffi, ffmpeg-static, @ffprobe-installer, protobufjs.

## What `runtime` drops

| Dropped | How |
|---|---|
| pnpm store (`/root/.local/share/pnpm/store`) | stays in `prod-deps`; `runtime` copies `/app` only |
| devDependencies: vitest, vite-node, electron, electron-builder, app-builder-bin, typescript, knip, biome, @playwright/test, jsdom, patch-package | `pnpm install --prod` |
| vite, @vitejs/plugin-react, @tailwindcss/vite + only-theirs deps (rollup, @rollup/*, lightningcss, @tailwindcss/oxide, babel, vite's nested esbuild 0.25) | `prune-build-only.mjs` (see below) |
| `packages/pi-forms-bpmn/.pi/skills/openforms-mui/tools/node_modules` (vite 6, vitest 2, esbuild, tsx, typescript) | `rm -rf` in `prod-deps` |
| qa/, tests/, .github/, root `.pi/skills`, knip*.json, playwright.config.ts | not COPYed (test harness / dead-code oracle inputs only) |
| build-essential, python3 | `apt-get purge` (as before) |

## `docker/scripts/prune-build-only.mjs`

- Client lists vite + plugins under `dependencies` on purpose (git install with `--omit=dev` runs client `prepare`; `scripts/verify-release-deps.mjs` rule). `--prod` keeps them.
- Script walks real `node_modules` with Node resolution from every workspace manifest (deps + optional + peer).
- FULL walk vs KEEP walk with BUILD_ONLY edges cut (`packages/client` → vite, @vitejs/plugin-react, @tailwindcss/vite; `packages/dashboard-plugin-runtime` peer → vite, type-only import).
- Deletes FULL \ KEEP only. Unreachable/phantom dirs untouched. Anything a runtime path reaches stays.
- Refuses (exit 1) if a dir to delete contains a kept package.
- `--dry-run` lists without deleting.
- Measured on develop ea66a4b3 (scratch prod install): 62 dirs removed, 1391 reachable kept.

## Behaviour changes

- Root `.pi/skills` (ci-troubleshoot and the other dev/CI agent skills, scanned only for a session whose cwd is `/app`) is left out ON PURPOSE:
  it is developer tooling, not product. The product's skills live under `packages/*/.pi/skills` and ARE in the runtime image. Do not "restore" it.
- openforms-mui skill preview/diagnose harness (`tools/`, Vite dev server) has no deps in the image. Recreate: `npm --prefix /app/packages/pi-forms-bpmn/.pi/skills/openforms-mui/tools install`.
- `docker/test-up.sh` layers new `compose.test.target.yml` and `compose.dev.yml` sets `build.target: app`. Manual `docker compose -f compose.yml -f compose.test.yml up --build` (without test-up.sh) now builds `runtime` — add `-f compose.test.target.yml`. A harness run without `--build` against a `pi-dashboard:local` built by `scripts/build-image.sh` gets the slim image — rebuild with `--build`.
- Unchanged: ENTRYPOINT/CMD, `pi` user, HOME, ports 8000/9999, VOLUMEs, `/api/health`, tini (= compose `init: true`; not in the image), OCI labels + `SOURCE_DATE_EPOCH` from `scripts/build-image.sh`.

## Verify after a build

```bash
scripts/build-image.sh build pi-dashboard:local
docker run --rm --user root --entrypoint sh pi-dashboard:local -c \
  'ls /root/.local/share/pnpm 2>&1; ls /app/node_modules | grep -E "^(vite|vitest|vite-node|app-builder-bin|electron-builder)$"; find / -name esbuild -path "*/bin/*" 2>/dev/null'
docker compose -f docker/compose.yml up -d && curl -f http://localhost:8000/api/health
```
Expected: no pnpm dir, no grep hits, esbuild binaries only under `/app/node_modules/@esbuild/linux-*` and the global pi install.

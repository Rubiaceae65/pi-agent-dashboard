# PI Dashboard

Web dashboard to monitor + control pi agent sessions remotely. Three components: bridge extension + Node server + React client. Full architecture: [docs/architecture.md](docs/architecture.md).

## Retrieval pointers (repo-specific)

The kb-first READ doctrine is injected per turn by the kb extension. Two
repo-specific pointers the canonical doctrine leaves out:

- build / run / install / setup / release / "how do I X" → `grep -i <kw> docs/faq.md README.md docs/` — then quote.
- reproduce the kb retrieval-quality numbers → `tsx packages/kb/eval/run-fixtures.ts`.

## Code Instructions (per-turn doctrine)

Behavioral guidelines to reduce common LLM mistakes. Bias toward caution over speed. Trivial tasks → judgment.

1. **Think before coding.** State assumptions; if uncertain, ask via `ask_user`. Present multiple interpretations, don't pick silently. Push back when a simpler approach exists. **Never speculate about code you haven't opened.** Confirm the plan before any major change.
2. **Simplicity first.** Minimum code that solves the problem. No speculative features/abstractions/flexibility/error-handling for impossible cases. DRY: extract a shared helper when a pattern repeats (not for a single call site). "Would a senior engineer call this overcomplicated?" If yes, simplify.
3. **Surgical changes.** Touch only what you must. Don't improve/refactor/reformat adjacent code. Match existing style. Mention unrelated dead code, don't delete it. Remove only orphans YOUR change created. Every changed line traces to the request.
4. **Goal-driven (TDD).** Turn tasks into verifiable goals. Write/update tests first, verify they fail, then minimal implementation to pass. State a brief plan for multi-step tasks (step → verify).
5. **Communication.** High-level summary of what changed each step. Use `ask_user` (not plain text) for clarification/choices.

## Docs delegation (project-specific)

The generic WRITE discipline (doc routing, the `| File | Purpose |` row schema,
the size-split rule, root-lean) is injected per turn. Repo-specific additions:

- **Every write under `docs/`** (prose AND `docs/AGENTS.md`) is delegated to a general-purpose subagent (DocScribe) with the **caveman-style** rule passed verbatim — short declarative fragments, drop articles/copulas, subject→verb→object, one fact per line, concrete tokens (paths/fns/env/ports) over prose, symbols verbatim. Main agent orchestrates, never edits `docs/` directly. Source-tree rows under `packages/` + non-source areas: main agent edits directly.
- Source-of-truth change the doctor skill derives → `doctor --regenerate <module>` — never hand-maintain version/name tables.

## Architecture

Full details: [docs/architecture.md](docs/architecture.md). Electron bootstrap: [docs/electron-bootstrap-flow.md](docs/electron-bootstrap-flow.md). Doctor skill: [docs/doctor-skill.md](docs/doctor-skill.md).

- **Bridge Extension** (`packages/extension/src/`) — runs in every pi session, forwards events via WebSocket
- **Dashboard Server** (`packages/server/src/`) — aggregates events, in-memory + JSON persistence, dual WebSocket servers
- **Web Client** (`packages/client/src/`) — React + Tailwind responsive UI
- **Shared Types** (`packages/shared/src/`) — protocol definitions

## Commands

```bash
pnpm install         # deps — pnpm ONLY (pnpm-workspace.yaml sets nodeLinker: hoisted); `npm install` drifts the tree
npm test             # all tests (vitest)
npm run build        # build web client (Vite)
npm run dev          # Vite dev server
npm run reload       # reload all connected pi sessions
pi-dashboard         # start server   (--dev = Vite proxy)
```

**Docker** (self-contained all-in-one: server + pi + code-server + zrok + tmux). Full guide: [`docker/README.md`](docker/README.md); per-file map: [`docker/AGENTS.md`](docker/AGENTS.md).
```bash
cd docker && cp .env.example .env && docker compose up -d --build
PI_WORKSPACES="/abs/a:/abs/b" ./up.sh
```

## Running Tests

Pipe once to a tmp file, then grep — never rerun to inspect errors. Keep `pipefail` + the summary pattern: without them a failing run reports exit 0 and leaves no verdict in the transcript.
```bash
set -o pipefail; npm test 2>&1 | tee /tmp/pi-test.log
grep -nE 'FAIL|Error|✗|✘|Tests +[0-9]+ (failed|passed)' /tmp/pi-test.log
```

## Build & Restart Workflow

**Rebuild/restart procedure — extension→reload, server→restart, client→build+restart, openspec-apply→full rebuild — plus the code discipline for landing a change: the `implement` skill** (auto-loads on "rebuild", "after edit", "implement X", "how do I land this"). Two-tier code review (`review-code` inline + opt-in CodeRabbit ship gate), Biome quality ratchet (`code-quality` skill, `npm run quality:changed`), and the discipline-skill checkpoint table also live there. Full quality ref: [`docs/code-quality.md`](docs/code-quality.md).

Quick reference:
```bash
npm run reload                              # after packages/extension/ changes
curl -X POST http://localhost:8000/api/restart   # after packages/server|packages/shared changes (jiti — no build)
npm run build && curl -X POST .../api/restart    # after packages/client changes (production)
curl -s http://localhost:8000/api/health | jq .mode   # dev | production
```
`/api/restart` is the single restart source of truth (CLI `restart` delegates to it when the dashboard is up). `--dev` proxies to Vite with automatic production fallback. `full-rebuild.ts` = deploy checked-out dev to the local instance; NOT a feature step.

## Cross-Platform QA

Two additive layers: **VM smoke** (`qa/`, clean-install + runtime per OS) and **Playwright browser E2E** (`tests/e2e/`, rendered-UI behaviour vs the docker harness). New browser scenarios → Playwright specs, NOT `qa/tests/*.sh`. Full setup: [`qa/README.md`](qa/README.md). E2E is opt-in (`npm run test:e2e`); harness lifecycle via `docker/test-up.sh`/`test-down.sh`.

## Subagent Routing

Delegate specialist work to the matching subagent (isolated context). Explicit `Agent` call with `subagent_type` required (skills auto-load by NL; subagents don't). One specialist per task; skip for trivial edits.

| Subagent | Use for |
|---|---|
| `Explore` | Read-only search / "where is X" when the tree misses (per-file lookups use `kb agents` directly). |
| `react-expert` | React refactors/hooks/state/render-perf in `packages/client/`, `packages/*-plugin/src/client/`. |
| `typescript-expert` | Type-system, generics, strict-mode, async typing, `.d.ts`. |
| `nodejs-expert` | Server async/streams/perf in `packages/server/`, `packages/extension/`, `packages/electron/` main. |
| `tailwind-expert` | Utility-class refactors, breakpoints, tokens, dark-mode. |
| `Audit` | Deep security+perf pass on a diff (read-only findings; parent fixes). |
| `DocScribe` | Write `docs/` prose in caveman style (Rule-6 target). Returns tree rows for parent to apply. |
| `SessionGuideline` | Turn a session into a how-we-did-it playbook. |

**Apply-loop spawn checkpoints** (signal in diff/tasks.md → spawn): touches auth/secrets/PII/untrusted-input/webhooks or a latency budget → `Audit`; contextFiles list large → `Explore`; a change landed + `docs/` needs prose → `DocScribe`; ≥3 React components touched, or a hook added/reworked, or a render-perf fix → `react-expert`; ≥3 server modules touched, or new async/stream/WS path → `nodejs-expert`.

**Discipline-skill checkpoints** (invoke the `eng-disciplines` skill when the signal appears): auth/untrusted-input/secrets/PII → `security-hardening`; latency/throughput budget or large-data path → `performance-optimization`; new endpoint/job/external-call → `observability-instrumentation`; irreversible step (migration/public-API) before it stands → `doubt-driven-review`; bug mid-implementation → `systematic-debugging`; opaque runtime state (jiti/PTY/WS) → `node-inspect-debugger`; non-trivial change + tests pass before commit → `review-code`; works but feels heavy → `code-simplification`.

Context inheritance: this repo ships `pi-dashboard-subagents` (default `inheritContext: true` → child gets a compressed parent snapshot, capped by `maxChars`). Still pass exact file paths + the question in `task:`; use `Explore` first if locations are unknown.

## OpenSpec Conventions

In a worktree, resolve OpenSpec skills from the main repo root, not the checkout. **Create** change artifacts at `openspec/changes/<name>/` (never under `active/`/`archive/`); prefer `openspec change new <name>`. Creation-time only — `ship-change` MOVES a completed change into `openspec/changes/archive/<date>-<name>/`, which `scripts/check-conventions.mjs` skips as immutable history; a review asking to move an archived change back is a false positive. In `proposal.md`, add a `## Discipline Skills` section naming the `eng-disciplines` skills its tasks trigger (per the checkpoint tables above); when none apply, say so under the heading rather than omitting it. **Gating** on any `proposal.md` a change touches (`ship-it` step 4.4 via `scripts/check-conventions.mjs`); untouched proposals are not backfilled. Use `ask_user` (batch for multi-question) for any needed input.

## Diagram Style

Use Mermaid (```mermaid blocks), not ASCII box drawings — explore mode, design docs, all artifacts.


## Entry points and system role
_Added 2026-10-16 by repo-entrypoint-docs-20261016; documents develop as of d03fb2bb2 (the repo has no main/master; `develop` is HEAD and the branch the release pins)._

**Department:** software

**Entry points** (as they exist on develop today):
- `packages/server` (`@blackbelt-technology/pi-dashboard-server`) — server — the dashboard server; bin `pi-dashboard` (`bin/pi-dashboard.mjs`, main `src/cli.ts`).
- `docker/Dockerfile` + `docker/entrypoint.sh` — image base — the estate container image (`EXPOSE 8000 9999`; `ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]`; `CMD ["start"]`). `start` (the image's own CMD) seeds auth/spawn config on first run, starts the server **detached** and supervised (`supervise-daemon.sh`) and returns — the entrypoint keeps PID 1 alive; `TUNNEL_ENABLED=0` passes `--no-tunnel`.
- `docker/compose.yml` — compose — the full-stack container: dashboard `:8000` + pi gateway `:9999`, state in the `pi-state` named volume, provider API keys seeded into `auth.json` on first run only. Variants: `compose.dev.yml`, `compose.override.yml.example`, `compose.kroki.yml`, `compose.test.yml`. `docker/up.sh` drives path-identical workspace mounts + first-run pins (`PI_WORKSPACES="/host/a:/host/b" ./up.sh`).
- `docker/test-up.sh` / `docker/test-down.sh` — scripts — the **disposable isolated test harness** (docker/TESTING.md): runs the exact image `docker-packaging` builds on `:18000`, structurally incapable of colliding with a host dashboard; `harness-audit.sh` audits the harness.
- root npm scripts (package.json) — `dev`, `build`, `test` (= `test:parallel` vitest + `test:real-process` vitest with a scratch HOME per run), `test:ci-scenarios`, `lint` (tsc --noEmit), `lint:biome`, `quality:changed`, `spec:validate` (openspec), `electron:dev` / `electron:start` / `electron:make` / `electron:build`, `reload` / `reload:check` (`scripts/reload-all.sh`).
- `packages/electron` — app — the Electron desktop app (`packages/electron/scripts/build-installer.sh`); standalone mode bundles Node.js + pi + dashboard into `~/.pi-dashboard/` (no terminal needed).
- `tests/` — vitest unit tests + `tests/e2e`, `tests/e2e-electron` — Playwright e2e (`playwright.config.ts`, `playwright.electron.config.ts`).
- `site/` — the website (upstream content).
- `.github/workflows/` — upstream CI (ci.yml, publish.yml, nightly.yml, deploy-site.yml, the e2e workflows) — see Superseded.

**Who calls it in the full system:**
- flux-atelier `rc0005/10-dashboard.yaml` (L3, finca; namespace `estate-rc0005`) → deploys `rubiaceae65/dashboard@sha256:fd4f22a2` (the RC 0005 image, built from **exactly this commit** d03fb2bb per the RC 0005 manifest) with `command: ["start"]`, `PI_DASHBOARD_HOST=0.0.0.0`, `TUNNEL_ENABLED=0`; health `GET :8000 -> 200`; a `Service` exposes `:8000`. Image path: `docker.io/rubiaceae65/dashboard` → Talos machine-config mirror → in-cluster zot, seeded one-way from ag-zot.
- The RC 0005 release manifest (atelier repo, `release/manifests/rc/0005/three-machines.json`, component `dashboard`) → kind `compose`, image `ghcr.io/rubiaceae65/dashboard@fd4f22a2` (one-way-import provenance; see Superseded), `command: ["start"]`, port 8000, role `brain` → the "atelier" machine (Brain). RC 0005's note records the earlier git-checkout install model (operator places a checkout and runs nothing from it) being **replaced by the estate image**.
- Humans and agents → the dashboard UI/REST: it is the standing pi/prime-agent session dashboard (the Brain's, at `:8000` on the tailnet per the workshop's standing briefs) — spawn parallel pi sessions, watch reasoning live, send prompts, abort runs.
- Rubiaceae65/release → pins pi-agent-dashboard as a submodule (`components/pi-agent-dashboard` @ d03fb2bb, the RC pin — the release pins `develop`, no main exists).

**What it calls:**
- pi (pi-mono) agent sessions → the pi gateway (`:9999`) and the spawn strategy (`tmux` default or `headless`); the dashboard is the control surface for pi sessions (it works only with pi; "Oh My Pi is not supported").
- LLM providers → via `auth.json` / OAuth (Anthropic/OpenAI/Gemini keys are deployment inputs, seeded on first run only — the `pi-state` volume wins afterwards; the RC air-gapped deployment seeds none and adds providers in the UI).
- The zrok tunnel (optional; `TUNNEL_ENABLED=1` by default — **disabled in the RC air-gapped deployment** with `TUNNEL_ENABLED=0`: "an air-gapped venue has no tunnel target, and a tunnel attempt is an egress attempt").

**Run / test in isolation:**
- `npm run test` — vitest (`test:parallel` + `test:real-process`, each with a scratch `HOME`); `npm run lint` (tsc --noEmit) and `npm run lint:biome`. Prerequisites: node + npm workspaces (the repo also carries a pnpm lockfile).
- Playwright e2e: `tests/e2e` and `tests/e2e-electron` (`playwright.config.ts` / `playwright.electron.config.ts`).
- The docker test harness: from the project you want to test, `docker/test-up.sh` — builds + runs the exact `docker-packaging` image attached on `:18000`; manual browser QA (e.g. `agent-browser open http://localhost:18000`); tear down with `docker/test-down.sh` (discards all state). No new image build — a compose overlay + entrypoint wrapper on `compose.yml`.
- The plain compose stack: `cd docker && cp .env.example .env && docker compose up -d --build` → dashboard at `http://localhost:8000`.

**Deployment ways (software repos):** _(owner steer 10-16 — both ways where they exist)_
- k8s way: flux-atelier `rc0005/10-dashboard.yaml` — Deployment + Service on finca (namespace `estate-rc0005`, `:8000`, image by digest from the in-cluster zot).
- plain-machine compose way: `docker/compose.yml` via `docker/up.sh` — the RC 0005 install method on the "atelier" machine (the Brain); the standing session dashboard at `:8000` is the current dev/ops form.
- Placement note: the RC 0005 three-machines placement (dashboard on the "atelier" machine) is _superseded by the owner ruling of 2026-10-16: in this deployment release only the BACKUP machine is Puppet-managed; all other services run on finca (Talos) via Flux_ — the finca deployment (above) is the current RC 0005 on-finca form; placement may change in later releases.

**Superseded:**
- The upstream (BlackBeltTechnology) release surface — the `.github/workflows` CI/publish/nightly/deploy-site workflows, the npm package publish, the GitHub Releases download path and the README badges: this is the upstream project's CI, **not the estate release path**. The estate RC 0005 image is built from this repo's `docker/Dockerfile` at the pinned commit, signed into `/projects/releases/rc-0005/images/` (the `source: ghcr.io/rubiaceae65/dashboard@fd4f22a2` field in the release's `images.lock.json` is the one-way-import provenance, not a GitHub release); the RC release has NOTHING on GitHub (no Actions, no ghcr, no releases).
- The RC 0003/0004-era git-checkout install model (operator clones at the pinned commit and "runs nothing from it") — superseded by the estate image in RC 0005 (2026-10-11), per the RC 0005 manifest note.

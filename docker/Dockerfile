# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# pi-dashboard all-in-one image.
#
# Stage `base`      — Debian Bookworm + Node 24 LTS, system tools, zrok, gh, jj.
# Stage `globals`   — non-root `pi` user, global pi agent + peers, corepack.
# Stage `app`       — FULL dev/test tree (devDependencies, tests, knip inputs).
#                     Target of the docker test harness and the dev overlay
#                     (compose.test.target.yml via test-up.sh, compose.dev.yml).
# Stage `prod-deps` — `pnpm install --prod` + client build + build-only prune.
# Stage `runtime`   — DEFAULT (last) stage, the deployed image: `globals` +
#                     /app from `prod-deps`. No pnpm store, no devDependencies
#                     (vitest, electron-builder/app-builder-bin, ...), no vite.
#                     What is in it and why: docs/runtime-image.md.
#
# Debian (glibc), NOT Alpine (musl): node-pty needs glibc for correct PTY
# behavior. See openspec change docker-packaging, Decision 2.
# ---------------------------------------------------------------------------

# ============================ base stage ===================================
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS base

# Pinned tool versions — override at build time with --build-arg.
# zrok + gh downloads are verified against the sha256 pinned here, per arch
# (taken from the release's own checksum manifest). Overriding a *_VERSION
# therefore requires overriding its *_SHA256_* args too.
# zrok v2.0.8 (2026-10-08) and gh v2.103.0 (2026-10-21): newest stable
# releases on 2026-10-23 (2.0.4 / 2.62.0 carried fixable CRITICAL/HIGH Go
# module + stdlib CVEs in trivy 0.76.0).
ARG ZROK_VERSION=2.0.8
ARG ZROK_SHA256_AMD64=027cc46c8b652a82f87823cec45fbb5fc878455268857e69e22fbe9dca225f3a
ARG ZROK_SHA256_ARM64=c06f32935a88b918f03daf8a5f9f1da8c8e278bba9300b53c2666968f0ec91fc
ARG ZROK_SHA256_ARMV7=4e5ceed36fd3b742b855104df334fde61a42f6807dd4c36c4ea3ac6fa105a4bd
ARG GH_VERSION=2.103.0
ARG GH_SHA256_AMD64=fdd768eb70f6409f80fcfa9f3a1c0adf0fc98d827ab3ce0bed2ac22762c5d786
ARG GH_SHA256_ARM64=7f322df34e624d14f5ec0c4acb121fd6dfa14392fdbbd1066aa8e0a05ac3721e
ARG GH_SHA256_ARMV6=fc3b42f7ffdd196cc6b6bc0f90bac6dc2c43810e07c0f70932c7b5e615ec680d
ARG JJ_VERSION=0.24.0

ENV DEBIAN_FRONTEND=noninteractive

# 1.1 System packages. build-essential + python3 needed only for node-pty
# native compile in the app stage; removed there afterwards.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tmux \
      jq \
      git \
      curl \
      ca-certificates \
      ripgrep \
      fd-find \
      poppler-utils \
      build-essential \
      python3 \
 && rm -rf /var/lib/apt/lists/*

# fd-find ships the binary as `fdfind` on Debian; expose `fd` too.
RUN ln -s "$(command -v fdfind)" /usr/local/bin/fd || true

# 1.2 zrok (pinned). Map Debian arch → zrok release arch.
RUN set -eux; \
    deb_arch="$(dpkg --print-architecture)"; \
    case "${deb_arch}" in \
      amd64) zrok_arch="amd64"; zrok_sha="${ZROK_SHA256_AMD64}" ;; \
      arm64) zrok_arch="arm64"; zrok_sha="${ZROK_SHA256_ARM64}" ;; \
      armhf) zrok_arch="armv7"; zrok_sha="${ZROK_SHA256_ARMV7}" ;; \
      *) echo "unsupported arch: ${deb_arch}" >&2; exit 1 ;; \
    esac; \
    asset="zrok_${ZROK_VERSION}_linux_${zrok_arch}.tar.gz"; \
    base="https://github.com/openziti/zrok/releases/download/v${ZROK_VERSION}"; \
    curl -fsSL -o "/tmp/${asset}" "${base}/${asset}"; \
    # Verify the downloaded tarball against the PINNED sha256 (fail build on mismatch).
    echo "${zrok_sha}  /tmp/${asset}" | sha256sum -c -; \
    # zrok v2 ships the binary as `zrok2`; extract it and symlink `zrok` so both
    # names resolve (belt-and-suspenders with the dual-binary runtime resolver).
    tar -xzf "/tmp/${asset}" -C /usr/local/bin zrok2; \
    ln -sf zrok2 /usr/local/bin/zrok; \
    rm "/tmp/${asset}"; \
    zrok2 version; \
    zrok version

# 1.3b GitHub CLI (pinned). Spawned/probed by the dashboard git panel.
RUN set -eux; \
    deb_arch="$(dpkg --print-architecture)"; \
    case "${deb_arch}" in \
      amd64) gh_arch="amd64"; gh_sha="${GH_SHA256_AMD64}" ;; \
      arm64) gh_arch="arm64"; gh_sha="${GH_SHA256_ARM64}" ;; \
      armhf) gh_arch="armv6"; gh_sha="${GH_SHA256_ARMV6}" ;; \
      *) echo "unsupported arch: ${deb_arch}" >&2; exit 1 ;; \
    esac; \
    asset="gh_${GH_VERSION}_linux_${gh_arch}.tar.gz"; \
    base="https://github.com/cli/cli/releases/download/v${GH_VERSION}"; \
    curl -fsSL -o "/tmp/${asset}" "${base}/${asset}"; \
    # Verify the tarball against the PINNED sha256 (fail build on mismatch).
    echo "${gh_sha}  /tmp/${asset}" | sha256sum -c -; \
    tar -xzf "/tmp/${asset}" -C /tmp; \
    install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${gh_arch}/bin/gh" /usr/local/bin/gh; \
    rm -rf "/tmp/${asset}" "/tmp/gh_${GH_VERSION}_linux_${gh_arch}"; \
    gh --version

# 1.3c jujutsu (pinned). Spawned/probed by the dashboard jj panel. musl
# static binary runs fine on glibc.
RUN set -eux; \
    deb_arch="$(dpkg --print-architecture)"; \
    case "${deb_arch}" in \
      amd64) jj_arch="x86_64-unknown-linux-musl" ;; \
      arm64) jj_arch="aarch64-unknown-linux-musl" ;; \
      *) echo "unsupported arch: ${deb_arch}" >&2; exit 1 ;; \
    esac; \
    asset="jj-v${JJ_VERSION}-${jj_arch}.tar.gz"; \
    base="https://github.com/jj-vcs/jj/releases/download/v${JJ_VERSION}"; \
    # jj releases publish no checksum manifest (only the tarballs), so unlike
    # zrok/gh there is nothing to verify against; rely on HTTPS + pinned tag.
    curl -fsSL -o "/tmp/${asset}" "${base}/${asset}"; \
    # jj tarball stores the binary as ./jj (not bare jj like zrok).
    tar -xzf "/tmp/${asset}" -C /usr/local/bin ./jj; \
    rm "/tmp/${asset}"; \
    jj --version

# ============================ globals stage ================================
# Shared by `app` (dev/test) and `runtime` (deployed): everything outside /app.
FROM base AS globals

# 1.4 Non-root user (UID 1000). node:22 image already ships a `node` user at
# UID 1000; create a dedicated `pi` user instead for clarity.
RUN if getent passwd 1000 >/dev/null; then userdel -r "$(getent passwd 1000 | cut -d: -f1)"; fi \
 && useradd --create-home --uid 1000 --shell /bin/bash pi

# Global installs have no lockfile, so npm resolves their TRANSITIVE deps
# against the live registry at build time. Build 2026-10-21 19:03Z failed with
# `ETARGET No matching version found for @aws-sdk/types@^3.975.0`: a dependent
# AWS SDK package had been published requiring types 3.975.0, which itself
# was published only at 19:05:32Z (npm view @aws-sdk/types time). NPM_BEFORE
# pins the resolution to the registry as it was at NPM_BEFORE (npm
# `--before`), so the same commit resolves the same tree and never a half-
# published release. Raise it deliberately, together with the pins below.
ARG NPM_BEFORE=2026-10-21T00:00:00Z

# 1.4 Global pi coding agent + openspec (spawned/probed by the dashboard).
# Install must be fatal; the version probes stay non-fatal (grouped so a
# non-zero `--version` can't mask an `npm install -g` failure).
# openspec is @fission-ai/openspec at the version the workspace lockfile uses
# (packages/server, packages/extension: 1.11.0). The bare npm name `openspec`
# is an unrelated 2019 placeholder (0.0.0, no bin): the build log showed
# `openspec: not found`.
# Pins (version, npm publish date): pi-coding-agent 0.86.1 (2026-09-20),
# @fission-ai/openspec 1.11.0 (2026-08-26).
RUN npm install -g --before="${NPM_BEFORE}" @earendil-works/pi-coding-agent@0.86.1 @fission-ai/openspec@1.11.0 \
 && { pi --version || true; } \
 && { openspec --version || true; }

# 1.4b Flow-plugin e2e peers (change: add-flow-plugin-e2e-tests). The pi-flows
# engine + the anthropic-messages bridge peer are BAKED here; test-entrypoint.sh
# selectively wires them per PI_TEST_PEERS (both|no-am|legacy|bad-registration)
# so the L3 harness can drive real flows + assert the bridge state machine. Kept
# non-fatal on version probe, fatal on install, same as the pi install above.
ARG PI_FLOWS_VERSION=0.3.2
ARG PI_ANTHROPIC_MESSAGES_VERSION=0.3.4
# pi-dashboard-subagents is the ONLY producer of `tool_execution_update` for a
# subagent: its `extensions/agent.ts` drives `createProgressEmitter` ->
# `progress.schedule(details)` into the tool's `onProgress` callback. Without it
# the collapse scenarios (P2/F4) have no workload and pass vacuously.
# See change: collapse-superseded-tool-execution-updates.
ARG PI_DASHBOARD_SUBAGENTS_VERSION=0.2.4
# Pins (version, npm publish date): pi-flows 0.3.2 (2026-07-01), pi-anthropic-messages 0.3.4
# (2026-06-18), pi-dashboard-subagents 0.2.4 (2026-08-10); resolved as of NPM_BEFORE.
RUN npm install -g --before="${NPM_BEFORE}" \
      "@blackbelt-technology/pi-flows@${PI_FLOWS_VERSION}" \
      "@blackbelt-technology/pi-anthropic-messages@${PI_ANTHROPIC_MESSAGES_VERSION}" \
      "@blackbelt-technology/pi-dashboard-subagents@${PI_DASHBOARD_SUBAGENTS_VERSION}" \
 && ls -d /usr/local/lib/node_modules/@blackbelt-technology/pi-flows \
         /usr/local/lib/node_modules/@blackbelt-technology/pi-anthropic-messages \
         /usr/local/lib/node_modules/@blackbelt-technology/pi-dashboard-subagents

# Enable corepack so `pnpm` resolves to the version pinned by the root
# package.json `packageManager` field (pnpm@11.15.1). The global `npm install
# -g` tool installs above stay npm (Column C-style user installs).
RUN corepack enable

# ============================ app stage ====================================
# Full dev/test tree, unchanged from the single-stage image. NOT the default
# target: build it with `--target app` (the test harness and dev overlay do).
FROM globals AS app

WORKDIR /app

# 1.5 Install deps + build the web client. Copy package manifests first for
# layer caching, then the full source.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Root tsconfigs that every package extends (../../tsconfig.base.json).
COPY tsconfig.base.json tsconfig.json ./
# Root scripts/ (postinstall: maybe-patch-package + fix-pty-permissions) and
# patches/ (replayed by patch-package during install).
COPY scripts ./scripts
COPY patches ./patches
COPY packages ./packages
# Faux model fixture (provider + scenario catalog). test-entrypoint.sh stages
# these as a global auto-discovered pi extension under PI_E2E_SEED so UI-spawned
# sessions drive a key-free faux model. See change: add-e2e-faux-model-roundtrip.
# qa/ in full (not just fixtures) because qa/scripts/*.mjs is part of the module
# graph the dead-code oracle analyses.
COPY qa ./qa
# Dead-code oracle inputs. Knip's verdict is only reproducible against the SAME
# tree: analysing a subset silently changes the counts, so every tree the
# knip.json entries name must be present or the harness answers a different
# question than the host does.
# NOTE: `.pi/skills` ONLY — never `.pi/settings.json`, which pins a host
# absolute path for its extension packages and would break container sessions.
# playwright.config.ts roots tests/e2e/global-setup.ts, and Knip's
# GitHub-Actions plugin reads .github/workflows/*.yml to root the scripts they
# invoke (e.g. scripts/sync-versions.js). Without either, the container reported
# 13 unused files / 233 exports against the host's 10 / 227.
COPY knip.json knip-baseline.json playwright.config.ts ./
COPY tests ./tests
COPY public ./public
COPY .github ./.github
COPY .pi/skills ./.pi/skills
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh
# Sourced by both entrypoints so the deployment and the test harness supervise
# the detached daemon identically.
COPY --chmod=0755 docker/supervise-daemon.sh /usr/local/bin/supervise-daemon.sh
COPY docker/scripts ./docker/scripts

# Opt-in: keep `fixture: true` plugin clients (demo-plugin) in the production
# bundle. Empty by default, so the deployment image is unchanged; the test
# overlay (compose.test.yml) passes "1". Visible to the RUN below as an env var.
# See change: expose-plugin-credential-and-oauth-seams (D8).
ARG PI_DASHBOARD_FIXTURE_PLUGINS=""
# pnpm re-resolves the full platform optional-dep tree from pnpm-lock.yaml
# (so the npm/cli#4828 lockfile-nuke hack — which dropped
# @rollup/rollup-linux-x64-gnu on the linux build — is no longer needed).
RUN pnpm install --frozen-lockfile \
 && pnpm run build \
 # Link the root package so `pi-dashboard` is on PATH.
 && npm link \
 # 1.5 Drop build toolchain — not needed at runtime (~200 MB saved).
 && apt-get purge -y --auto-remove build-essential python3 \
 && rm -rf /var/lib/apt/lists/* \
 && chown -R pi:pi /app

# The VOLUME paths below are created by the VOLUME instruction itself, as ROOT,
# regardless of the USER in force — and a fresh named volume inherits that
# root:root ownership on first use, which a container running as `pi` cannot
# write. Create them here, owned by pi, so the copy-on-first-use hands the
# volume to the user that actually runs.
RUN mkdir -p /home/pi/.pi /home/pi/.zrok2 && chown pi:pi /home/pi/.pi /home/pi/.zrok2

USER pi
ENV HOME=/home/pi

# 1.6 Network + storage surface.
EXPOSE 8000 9999
VOLUME ["/home/pi/.pi", "/home/pi/.zrok2"]

# 2.3 Entrypoint seeds auth, starts tmux, execs pi-dashboard.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
# 1.6 Default command — entrypoint passes these through to pi-dashboard.
CMD ["start"]

# ============================ prod-deps stage ==============================
# Production dependency tree for the runtime image. Runs as root in a stage
# that still has build-essential/python3 (node-pty's install script falls back
# to node-gyp) and the pnpm store; neither reaches `runtime`, which copies only
# /app out of here.
FROM globals AS prod-deps

WORKDIR /app

# Only what the server, its plugins and the client build read. Not copied (dev/
# test only): qa/, tests/, .github/, .pi/skills, knip*.json, playwright.config.ts.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.base.json tsconfig.json ./
COPY scripts ./scripts
COPY patches ./patches
COPY packages ./packages
# vite publicDir (packages/client/vite.config.ts `publicDir: "../../../public"`).
COPY public ./public
# seed-auth.js (entrypoint) + prune-build-only.mjs (below).
COPY docker/scripts ./docker/scripts

ARG PI_DASHBOARD_FIXTURE_PLUGINS=""
# --prod: no devDependencies (vitest/vite-node, electron-builder + app-builder-
#   bin, typescript, knip, biome, playwright test runner, ...). Lifecycle scripts
#   run as in `app` (node-pty, koffi, ffmpeg-static, ffprobe, protobufjs).
# build: the client to packages/client/dist (static files the server serves).
# prune-build-only.mjs: drops vite/@vitejs/plugin-react/@tailwindcss/vite and
#   whatever only they pull in (rollup, lightningcss, babel, vite's own esbuild).
#   The client declares them as `dependencies` on purpose (verify-release-deps).
# openforms-mui tools/node_modules: installed by pi-forms-bpmn's postinstall
#   with that skill's devDependencies (vite 6, vitest 2, esbuild, tsx,
#   typescript) for its preview harness. Not shipped; `npm --prefix <tools>
#   install` recreates it (docs/runtime-image.md).
RUN pnpm install --frozen-lockfile --prod \
 && pnpm run build \
 && node docker/scripts/prune-build-only.mjs /app \
 && rm -rf packages/pi-forms-bpmn/.pi/skills/openforms-mui/tools/node_modules \
 && test -f packages/client/dist/index.html \
 && test ! -e node_modules/vite \
 && test ! -e node_modules/vitest \
 && test ! -e node_modules/app-builder-bin

# ============================ runtime stage (default) ======================
FROM globals AS runtime

WORKDIR /app

COPY --from=prod-deps --chown=pi:pi /app /app
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY --chmod=0755 docker/supervise-daemon.sh /usr/local/bin/supervise-daemon.sh

# Link the root package so `pi-dashboard` is on PATH (as in `app`), then drop
# the build toolchain inherited from `base` — not needed at runtime.
RUN npm link \
 && apt-get purge -y --auto-remove build-essential python3 \
 && rm -rf /var/lib/apt/lists/*

# Same as `app`: VOLUME paths must exist owned by pi before the VOLUME line.
RUN mkdir -p /home/pi/.pi /home/pi/.zrok2 && chown pi:pi /home/pi/.pi /home/pi/.zrok2

USER pi
ENV HOME=/home/pi

EXPOSE 8000 9999
VOLUME ["/home/pi/.pi", "/home/pi/.zrok2"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["start"]

deps-bump-20261023b: a671c782 (deps-bump-20261023, written off develop ea66a4b3) re-applied by
cherry-pick onto develop 55b57fae (runtime-slim: base -> globals -> {app, prod-deps -> runtime}).
Supersedes branch deps-bump-20261023 (left untouched).

Dockerfile: git's 3-way merge applied the hunks without conflict; they land in stage `base`, which
is where /usr/local/bin/zrok2 (+zrok symlink) and /usr/local/bin/gh are installed. `runtime` is
FROM globals FROM base, so both tools (gh: git-routes.ts, zrok: tunnel.ts) ship in the runtime
image. runtime-slim's prod-deps asserts (no vite/vitest/app-builder-bin) and its runtime stage are
unchanged. develop did not touch pnpm-lock.yaml, so the lockfile from a671c782 applies as is.

Validation 2026-10-23 (pnpm 11.15.1, node 22.23.3, scratch copies of HEAD via git archive):
1. pnpm install --frozen-lockfile --ignore-scripts (full): rc=0 -> rebase-b-pnpm-install-full.log
2. pnpm install --frozen-lockfile --prod --ignore-scripts: rc=0 -> rebase-b-pnpm-install-prod.log
3. node scripts/verify-release-deps.mjs: OK (11 rules); node scripts/verify-lockfile-versions.mjs: OK (92)
4. docker buildx build --check --target {base,globals,app,prod-deps,runtime}: no warnings (all 5)
5. Resolved (lockfile + installed node_modules package.json):
   undici 6.28.1 / 7.29.1 (8.10.2 untouched, not overridden); brace-expansion 1.1.20 / 2.1.6 / 5.0.11;
   @xmldom/xmldom 0.9.12 (0.8.15 untouched); fastify 5.12.2; fast-uri 3.1.7 / 4.1.4;
   form-data 2.5.6 (via request@2.88.2, electron optional chain; 4.0.6 untouched);
   handlebars 4.7.10; nodemailer 9.1.0 (via mailparser@3.9.14, server dep); proxy-addr 2.0.8;
   source-map-js 1.2.2.
NOT validated: image build, unit tests, /api/health in a container, arm64/armhf sha256 by download,
runtime behaviour of the out-of-range overrides (form-data 2.5.6 vs request ~2.3.2,
nodemailer 9.1.0 vs mailparser's 9.0.3 pin).

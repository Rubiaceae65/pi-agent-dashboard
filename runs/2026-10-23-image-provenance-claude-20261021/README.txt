Validation of branch runtime-slim-20261023 (no image build; host disk budget).
Scratch tree = git archive of develop ea66a4b3 (package.json, lockfile, workspace yaml, packages, scripts, patches, tsconfigs, public).
1. pnpm 11.15.1 `pnpm install --frozen-lockfile --prod` (lifecycle scripts on, as in prod-deps): rc=0, client prepare built packages/client/dist -> pnpm-install-prod.log
2. node docker/scripts/prune-build-only.mjs <scratch>: 62 dirs removed, 1391 kept -> prune-build-only.log
   node_modules 1295 MB -> 1247 MB after prune (openforms tools/node_modules, 212 MB, removed separately).
   After prune: no node_modules/{vite,vitest,vite-node,app-builder-bin,electron-builder}; esbuild only node_modules/esbuild 0.28.2 (+ @esbuild/linux-x64).
3. Server smoke from pruned tree: `pi-dashboard start --port 18765 --pi-port 18766 --no-tunnel` (scratch HOME, node 22.23.3):
   /api/health ok=true mode=production version=0.8.0 clientBuild.status=matched; GET / -> 200; 18 plugins loaded, 0 load failures -> server-smoke-plugins.log
4. npm link with scratch global prefix: node_modules unchanged (820 top-level pkgs, 1256 MB before and after).
5. docker buildx 0.30.1 `build --check` default target, --target app, --target prod-deps: "Check complete, no warnings found." -> buildx-check-runtime.log
6. node scripts/verify-release-deps.mjs: OK - 11 rules passed.
NOT validated: real image build, node 24 base, trivy rescan, /api/health inside the container.

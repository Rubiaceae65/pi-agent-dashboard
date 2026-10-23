Validation of branch deps-bump-20261023 (no image build; host disk frozen 05:35Z).
1. pnpm 11.15.1 `pnpm install --lockfile-only --ignore-scripts` with the new overrides: rc=0; only the targeted
   packages changed in pnpm-lock.yaml -> lockfile-changed-entries.txt
2. `pnpm install --frozen-lockfile --ignore-scripts` (full tree): rc=0; resolved undici 7.29.1, fastify 5.12.2,
   handlebars 4.7.10, nodemailer 9.1.0, proxy-addr 2.0.8.
3. node scripts/verify-release-deps.mjs: OK (11 rules); node scripts/verify-lockfile-versions.mjs: OK (92 checked).
4. docker buildx build --check: no warnings.
5. zrok 2.0.8 + gh 2.103.0 amd64 tarballs downloaded: sha256 match the pinned values (= upstream manifests);
   `zrok2 version` -> v2.0.8 [7d46bbfd], `gh --version` -> 2.103.0. A wrong sha makes `sha256sum -c` fail (rc=1).
NOT validated: unit tests (npm run test:parallel started, stopped unfinished when the host froze the disk;
no result), image build, arm64/armhf hashes beyond the manifest, trivy rescan.

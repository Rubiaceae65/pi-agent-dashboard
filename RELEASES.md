# Releases of rubiaceae65/pi-dashboard

One line per image pushed to ag-zot (10.99.227.94:5000, the release artifact store) and the
in-cluster zot (the store the Talos mirror pulls from). Step per host steer
release-build-local-for-now-20261021 + host-jobs 4ca9c9d (keycustody): merged main commit -> fresh
clone -> `scripts/build-image.sh build` (INCLUDE_ZROK=0 = the release shape) -> SBOM -> offline gate
15 scan (0 fixable HIGH/CRIT) -> push by digest -> SIGN REQUEST. The dev builds below are unsigned;
the custodian signs with the release key (atelier-release, keycustody) at the RC cut.

| date | tag | commit | command | digest | signature | SBOM | test |
|---|---|---|---|---|---|---|---|
| 2026-11-08 | dev-10 (ag-zot + in-cluster zot) | b8313cb5 (main; cve-patch-rc0021-20261105: devDependencies to latest + type fixes; gate 15 35 -> 0) | scripts/build-image.sh build pi-dashboard:cve-verify (INCLUDE_ZROK=0, fresh clone @ b8313cb5; rebuilt 2026-11-08 by release-v011-20261108 because the cve-patch build's tar was lost to the /tmp wipe - same commit, labels verified: org.opencontainers.image.revision=b8313cb5) | sha256:16fe77ee24e3b5bb01d270c764c7eee3a691ed799be1362f10bde8765e41be85 (ag-zot :dev-10, in-cluster zot :pinned-16fe77ee24e3) | unsigned dev build (the custodian signs at the RC cut, host-jobs 4ca9c9d keycustody) | spdx-json (syft) /projects/release-v011-20261108/artifacts/pi-dashboard-cve-20261108.sbom.spdx.json | gate 15 PASS 0 fixable HIGH/CRIT, re-run on this rebuild (trivy 0.76.0, offline DB 2026-11-05T07:00Z - the same DB as the cve-patch lead's PASS; /projects/release-v011-20261108/artifacts/gate15-pi-dashboard-20261108/); tsc --noEmit + vitest PASS on b8313cb5 (cve-patch artifacts/result-pi-dashboard.md) |

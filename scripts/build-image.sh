#!/usr/bin/env bash
# Usage: scripts/build-image.sh [build|push] [tag]
#
#   build        (default) build ONE commit (HEAD of a clean tree) into out/dashboard.oci.tar,
#                write out/dashboard.digest (manifest digest) and out/dashboard.sbom.json (syft).
#   push <tag>   build, then copy the OCI archive as-is to
#                ${REGISTRY:-10.99.227.241:32500}/rubiaceae65/dashboard:<tag> and verify the digest.
#
# Needs: git, docker + buildx (a docker-container builder is created on first use, because the
# plain `docker` driver cannot export OCI archives), skopeo, syft, python3.
# Env: REGISTRY (push destination), BUILDER (buildx builder name, default image-build),
#      NO_CACHE=1 (build without the BuildKit cache).
#
# Reproducibility: every base image is pinned by digest in release-image/dashboard/Dockerfile.release;
# SOURCE_DATE_EPOCH = the commit time and rewrite-timestamp=true, so the image config and
# layer timestamps depend only on the commit. The OCI archive is the artifact; out/ is gitignored.
# Generalised from fluxmona/flux-atelier voice/image/build.sh @ 00ad71b.
set -euo pipefail

IMAGE=dashboard
DOCKERFILE=release-image/dashboard/Dockerfile.release
TARGET=
SOURCE_URL=https://github.com/Rubiaceae65/pi-agent-dashboard
TITLE=dashboard

CMD="${1:-build}"; TAG="${2:-}"
case "$CMD" in
  build) ;;
  push) [ -n "$TAG" ] || { echo "usage: $0 push <tag>" >&2; exit 64; } ;;
  *) echo "usage: $0 [build|push] [tag]" >&2; exit 64 ;;
esac

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$ROOT"

# 1. one commit: refuse a dirty tree or untracked files in the build context.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "refusing: tracked changes in the tree (commit or stash them)" >&2; exit 1
fi
if [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo "refusing: untracked files in the build context:" >&2
  git ls-files --others --exclude-standard >&2; exit 1
fi

# 2. revision + reproducible timestamp
REV="$(git rev-parse HEAD)"
export SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)"

OUT="$ROOT/out"; mkdir -p "$OUT"
TAR="$OUT/$IMAGE.oci.tar"
LOG="$OUT/$IMAGE.build.log"
REF="rubiaceae65/$IMAGE"

BUILDER="${BUILDER:-image-build}"
docker buildx inspect "$BUILDER" >/dev/null 2>&1 \
  || docker buildx create --name "$BUILDER" --driver docker-container >/dev/null

TARGET_ARGS=()
[ -n "$TARGET" ] && TARGET_ARGS=(--target "$TARGET")
CACHE_ARGS=()
[ "${NO_CACHE:-0}" = 1 ] && CACHE_ARGS=(--no-cache)

# 3. build
{
  echo "# $IMAGE rev=$REV SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH no_cache=${NO_CACHE:-0} $(date -u +%FT%TZ)"
  docker buildx build --builder "$BUILDER" --platform linux/amd64 \
    --provenance=false --sbom=false "${CACHE_ARGS[@]}" "${TARGET_ARGS[@]}" \
    -f "$DOCKERFILE" \
    --build-arg SOURCE_DATE_EPOCH \
    --label "org.opencontainers.image.revision=$REV" \
    --label "org.opencontainers.image.source=$SOURCE_URL" \
    --label "org.opencontainers.image.title=$TITLE" \
    --output "type=oci,dest=$TAR,rewrite-timestamp=true,name=docker.io/$REF" \
    .
} 2>&1 | tee "$LOG"

# manifest digest = what the registry will serve (skopeo copies the archive as-is)
DIGEST="$(tar -xOf "$TAR" index.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["manifests"][0]["digest"])')"
echo "$DIGEST" > "$OUT/$IMAGE.digest"
echo "built $REF rev=$REV digest=$DIGEST" | tee -a "$LOG"

# 5. SBOM
syft "oci-archive:$TAR" -o "spdx-json=$OUT/$IMAGE.sbom.json" 2>&1 | tail -n 3 | tee -a "$LOG"

# 4. push
if [ "$CMD" = push ]; then
  REG="${REGISTRY:-10.99.227.241:32500}"
  skopeo copy --retry-times 3 --dest-tls-verify=false "oci-archive:$TAR" "docker://$REG/$REF:$TAG" 2>&1 | tee -a "$LOG"
  GOT="sha256:$(skopeo inspect --tls-verify=false --raw "docker://$REG/$REF:$TAG" | sha256sum | cut -d' ' -f1)"
  echo "pushed $REG/$REF:$TAG want=$DIGEST got=$GOT" | tee -a "$LOG"
  [ "$GOT" = "$DIGEST" ] || { echo "DIGEST MISMATCH" >&2; exit 1; }
  echo "$GOT"
fi

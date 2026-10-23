#!/usr/bin/env bash
# Usage: scripts/build-image.sh [build [<image-ref>]|--help]      (default: build pi-dashboard:local)
#
#   build  docker buildx build --load of ONE commit (refuses a dirty tree) of docker/Dockerfile,
#          tagged <image-ref> (default pi-dashboard:local = the `image:` of docker/compose.yml, so
#          `docker compose -f docker/compose.yml up -d --no-build` runs exactly this build).
#
# Provenance: the image carries org.opencontainers.image.revision=<git HEAD>,
#   org.opencontainers.image.source=https://github.com/Rubiaceae65/pi-agent-dashboard and
#   org.opencontainers.image.version=<"version" in package.json>. SOURCE_DATE_EPOCH = committer time of HEAD.
#
# INCLUDE_ZROK (env, default 0): passed as --build-arg. 0 = release image, no zrok2 binary
#   (public tunnel unavailable). INCLUDE_ZROK=1 = dev/personal build that wants the public
#   zrok tunnel (pinned zrok2, sha256-verified). Never set to 1 for a release image.
set -euo pipefail

SOURCE="https://github.com/Rubiaceae65/pi-agent-dashboard"
CMD="${1:-build}"
REF="${2:-pi-dashboard:local}"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$ROOT"
SELF="$ROOT/scripts/build-image.sh"
case "$CMD" in
    -h|--help|help) sed -n '2,/^set -euo/{/^set -euo/d;s/^# \{0,1\}//;p}' "$SELF"; exit 0 ;;
    build) ;;
    *) sed -n '2p' "$SELF" >&2; exit 64 ;;
esac
die() { echo "build-image: $*" >&2; exit 1; }

VERSION="$(node -p 'require("./package.json").version' 2>/dev/null \
    || python3 -c 'import json; print(json.load(open("package.json"))["version"])')"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || die "package.json version is not a version: '$VERSION'"

# one commit: no modified, staged or untracked (non-ignored) files anywhere in the tree
git diff --quiet || die "dirty tree (unstaged changes) - commit first"
git diff --cached --quiet || die "dirty tree (staged changes) - commit first"
[ -z "$(git ls-files --others --exclude-standard)" ] || die "untracked files in the tree - commit or remove them"

INCLUDE_ZROK="${INCLUDE_ZROK:-0}"
[[ "$INCLUDE_ZROK" =~ ^[01]$ ]] || die "INCLUDE_ZROK must be 0 or 1, got '$INCLUDE_ZROK'"
REV="$(git rev-parse HEAD)"
export SOURCE_DATE_EPOCH="$(git log -1 --format=%ct HEAD)"
echo "build-image: $REF version=$VERSION rev=$REV include_zrok=$INCLUDE_ZROK"
DOCKER_BUILDKIT=1 docker buildx build --load --provenance=false --sbom=false \
    --build-arg SOURCE_DATE_EPOCH \
    --build-arg INCLUDE_ZROK="$INCLUDE_ZROK" \
    --label "org.opencontainers.image.revision=$REV" \
    --label "org.opencontainers.image.source=$SOURCE" \
    --label "org.opencontainers.image.version=$VERSION" \
    --label "org.opencontainers.image.title=pi-agent-dashboard" \
    -f docker/Dockerfile -t "$REF" .
echo "build-image: $REF $(docker image inspect -f '{{.Id}}' "$REF")"

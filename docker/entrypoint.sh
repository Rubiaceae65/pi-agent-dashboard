#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# pi-dashboard container entrypoint.
#
#   1. Seed ~/.pi/agent/auth.json from *_API_KEY env vars (first run only).
#   2. Seed spawn strategy into config.json (first run only).
#   3. Start a tmux server (for the tmux spawn strategy).
#   4. exec pi-dashboard with env-driven port/tunnel flags.
#
# Port mappings (compose env -> pi-dashboard flag):
#   DASHBOARD_PORT    -> --port
#   PI_GATEWAY_PORT   -> --pi-port
#   TUNNEL_ENABLED=0  -> --no-tunnel
#
# Read by the server directly from the environment (no flag):
#   PI_DASHBOARD_HOST              bind host (0.0.0.0 in the container)
#   PI_DASHBOARD_TRUSTED_NETWORKS  deployment-declared trusted socket peers
#                                  (exact IPs / IPv4 CIDRs, e.g. an SSO
#                                  gateway's upstream 10.244.0.243/32);
#                                  never persisted (add-trusted-networks-env)
# See openspec change docker-packaging.
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEED_AUTH="${SCRIPT_DIR}/../docker/scripts/seed-auth.js"
# When installed to /usr/local/bin the script dir differs; fall back to /app.
[ -f "${SEED_AUTH}" ] || SEED_AUTH="/app/docker/scripts/seed-auth.js"

# 1. Seed auth.json (no-op if it already exists in the pi-state volume).
node "${SEED_AUTH}"

# 2. Seed spawn strategy on first run only. loadConfig() deep-merges partials,
#    so a single-key file is safe. Never overwrites an existing config.
CONFIG_FILE="${HOME}/.pi/dashboard/config.json"
if [ -n "${PI_SPAWN_STRATEGY:-}" ] && [ ! -f "${CONFIG_FILE}" ]; then
  mkdir -p "$(dirname "${CONFIG_FILE}")"
  # Build JSON with jq so a malformed strategy value can't break config parsing.
  jq -n --arg s "${PI_SPAWN_STRATEGY}" '{spawnStrategy: $s}' > "${CONFIG_FILE}"
  echo "[entrypoint] seeded spawnStrategy=${PI_SPAWN_STRATEGY} into ${CONFIG_FILE}"
fi

# 3. Start a detached tmux server so the tmux spawn strategy has a host.
tmux start-server 2>/dev/null || true

# 3.5 zrok v2 headless enrollment. `zrok2 enable <token>` without --headless
#     dies on `open /dev/tty: device not configured` in a non-interactive
#     container. Enroll only when not already enrolled (idempotent across
#     restarts on the ~/.zrok2 volume). See change: support-zrok-v2.
#     zrok is an opt-in build component (Dockerfile ARG INCLUDE_ZROK, default
#     0): release images ship without it, so skip enrollment cleanly then.
if ! command -v zrok2 >/dev/null 2>&1; then
  echo "[entrypoint] zrok not installed in this image — tunnel unavailable${ZROK_TOKEN:+ (ZROK_TOKEN ignored)}"
elif [ -n "${ZROK_TOKEN:-}" ]; then
  ZROK_ENV="${HOME}/.zrok2/environment.json"
  # Validate the SAME required fields as readZrokEnvironment() — a malformed or
  # partial environment.json must not permanently suppress enrollment.
  if jq -e '
    (.api_endpoint | type == "string" and length > 0) and
    (.ziti_identity | type == "string" and length > 0) and
    (.zrok_token | type == "string" and length > 0)
  ' "${ZROK_ENV}" >/dev/null 2>&1; then
    echo "[entrypoint] zrok already enrolled (~/.zrok2/environment.json valid) — skipping enable"
  else
    [ ! -f "${ZROK_ENV}" ] || mv "${ZROK_ENV}" "${ZROK_ENV}.invalid"
    echo "[entrypoint] enrolling zrok v2 (headless)"
    zrok2 enable "${ZROK_TOKEN}" --headless || echo "[entrypoint] zrok enable failed — tunnel will be unavailable"
  fi
else
  echo "[entrypoint] ZROK_TOKEN unset — skipping zrok enrollment (tunnel disabled unless enrolled)"
fi

# 4. Build pi-dashboard flags from env.
ARGS=("${@:-start}")
[ -n "${DASHBOARD_PORT:-}" ]  && ARGS+=("--port" "${DASHBOARD_PORT}")
[ -n "${PI_GATEWAY_PORT:-}" ] && ARGS+=("--pi-port" "${PI_GATEWAY_PORT}")
case "${TUNNEL_ENABLED:-}" in
  0|false|no|off) ARGS+=("--no-tunnel") ;;
esac

# `PI_ENTRYPOINT_NO_SUPERVISE=1` returns here instead of blocking, for a caller
# that wraps this script and supervises itself (`test-entrypoint.sh`).
if [ "${PI_ENTRYPOINT_NO_SUPERVISE:-}" = "1" ]; then
  echo "[entrypoint] exec pi-dashboard ${ARGS[*]}"
  exec pi-dashboard "${ARGS[@]}"
fi

# `start` spawns the server DETACHED and returns, so exec'ing it as PID 1 ends
# the container the moment the daemon is up. Launch, then supervise the pidfile
# for the daemon's lifetime. See docker/supervise-daemon.sh for why the daemon
# is not simply run in the foreground instead (`POST /api/restart`).
echo "[entrypoint] pi-dashboard ${ARGS[*]}"
pi-dashboard "${ARGS[@]}" || echo "[entrypoint] launcher exited non-zero (readiness timeout?); the daemon is detached — supervising"

# shellcheck source=docker/supervise-daemon.sh
. /usr/local/bin/supervise-daemon.sh
supervise_daemon "${HOME:-/home/pi}/.pi/dashboard/server.pid"

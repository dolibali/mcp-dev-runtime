#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Reuse normal zsh startup configuration when a noninteractive launcher lacks credentials.
# Startup output is suppressed; secrets are passed only through the child environment.
if [[ ( -z "${CONTROL_PLANE_TUNNEL_ID:-}" || -z "${CONTROL_PLANE_API_KEY:-}" ) && "${LOCAL_DEV_MCP_TUNNEL_ENV_LOADED:-0}" != 1 && -x /bin/zsh ]]; then
  export LOCAL_DEV_MCP_TUNNEL_ENV_LOADED=1
  exec 3>&1 4>&2
  exec /bin/zsh -lic 'unsetopt xtrace verbose; export CONTROL_PLANE_TUNNEL_ID CONTROL_PLANE_API_KEY; exec 1>&3 2>&4; exec 3>&- 4>&-; exec /bin/bash "$1"' local-dev-tunnel "$ROOT/scripts/start-tunnel.sh" >/dev/null 2>&1
fi
: "${CONTROL_PLANE_TUNNEL_ID:?Set CONTROL_PLANE_TUNNEL_ID in this terminal}"
: "${CONTROL_PLANE_API_KEY:?Set CONTROL_PLANE_API_KEY in this terminal}"
BIN="${TUNNEL_BIN:-$ROOT/../tunnel-client/bin/tunnel-client}"
if [[ ! -x "$BIN" ]]; then
  BIN="$(command -v tunnel-client || true)"
fi
if [[ -z "$BIN" || ! -x "$BIN" ]]; then echo 'Tunnel executable not found; set TUNNEL_BIN.' >&2; exit 1; fi
MCP_URL="${MCP_URL:-http://127.0.0.1:3001/mcp}"
HEALTH="${MCP_HEALTH_URL:-http://127.0.0.1:3001/healthz}"
HEALTH_PORT="${TUNNEL_HEALTH_PORT:-9098}"
if command -v lsof >/dev/null && lsof -nP -iTCP:"$HEALTH_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Tunnel health port $HEALTH_PORT is occupied. Stop the previous client in its own terminal or set TUNNEL_HEALTH_PORT." >&2
  exit 1
fi
curl --noproxy '*' -fsS --max-time 5 "$HEALTH" >/dev/null
exec "$BIN" run --mcp.server-url="$MCP_URL" \
  --health.listen-addr="127.0.0.1:$HEALTH_PORT" \
  --log.level="${TUNNEL_LOG_LEVEL:-info}" --log.format=struct-text

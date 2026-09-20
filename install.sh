#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "MCP Dev Runtime setup: Node.js 24+ is required. Install Node.js, then run ./install.sh again." >&2
  exit 1
fi

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ ]] || (( NODE_MAJOR < 24 )); then
  echo "MCP Dev Runtime setup: Node.js 24+ is required; found $(node --version 2>/dev/null || echo unknown)." >&2
  exit 1
fi

exec node "$ROOT/scripts/setup.mjs" "$@"

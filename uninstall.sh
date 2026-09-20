#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'MCP Dev Runtime uninstall requires Node.js for a source checkout.' >&2
  printf '%s\n' 'The precompiled distribution uses its bundled Node automatically.' >&2
  exit 1
fi

exec node "$ROOT/scripts/uninstall.mjs" "$@"

#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js >= 22 is required. Install Node.js first: https://nodejs.org/" >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  exec node "$SCRIPT_DIR/scripts/install.mjs" install
else
  exec node "$SCRIPT_DIR/scripts/install.mjs" "$@"
fi

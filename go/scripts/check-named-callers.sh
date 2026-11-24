#!/usr/bin/env bash
# Run the managed plugin kit against the Go caller-aware factory.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
export TMPDIR=${TMPDIR:-$HOME/.cache/ma-std-tmp}
mkdir -p "$TMPDIR" "$repo/go/.bin"
(cd "$repo/go" && mise exec -- go build -o .bin/modular-agent-fixtures ./modular/cmd/fixtures)
node "$repo/conformance/plugin/run.mjs" --named-callers -- "$repo/go/.bin/modular-agent-fixtures" named-callers

#!/usr/bin/env bash
# Run the four standard-ma cases and the SDK fixture cases in disposable projects.
set -euo pipefail
repo=$(cd -- "$(dirname -- "$0")/../.." && pwd)
export TMPDIR=${TMPDIR:-$HOME/.cache/ma-std-tmp}
mkdir -p "$TMPDIR" "$repo/go/.bin"
(cd "$repo/go" && mise exec -- go build -o .bin/ma ./cmd/ma && mise exec -- go test -c -o .bin/agui-fixture ./modular)
cd "$repo/conformance/agui"
npm ci --silent --no-audit --no-fund
exec node run.mjs "$@" -- "$PWD/go.mjs"

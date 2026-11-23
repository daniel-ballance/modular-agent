#!/usr/bin/env bash
# Run the standard-ma cases and the SDK fixture cases in disposable projects.
set -euo pipefail
repo=$(cd -- "$(dirname -- "$0")/../.." && pwd)
export TMPDIR=${TMPDIR:-$HOME/.cache/ma-std-tmp}
mkdir -p "$TMPDIR" "$repo/go/.bin"
(cd "$repo/go" && mise exec -- go build -o .bin/ma ./cmd/ma && mise exec -- go test -c -o .bin/agui-fixture ./modular)
# Other language lanes can install the same kit at the same time. npm ci
# removes node_modules, so give this run its own copy.
kit="$repo/conformance/agui"
scratch=$(mktemp -d "$TMPDIR/go-agui-kit.XXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
cp "$kit"/*.mjs "$kit"/package{,-lock}.json "$scratch/"
npm ci --silent --no-audit --no-fund --prefix "$scratch"
node "$scratch/run.mjs" "$@" -- "$kit/go.mjs"

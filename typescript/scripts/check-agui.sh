#!/usr/bin/env bash
# Each lane can run npm ci without replacing a sibling lane's kit dependencies.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
export TMPDIR=${TMPDIR:-"$HOME/.cache/ma-std-tmp"}
mkdir -p "$TMPDIR"
kit=$(mktemp -d "$TMPDIR/ma-typescript-agui.XXXXXXXX")
trap 'rm -rf "$kit"' EXIT
cp "$repo"/conformance/agui/{*.mjs,package*.json} "$kit/"
npm ci --silent --prefix "$kit"
node "$kit/run.mjs" -- "$(command -v node)" "$repo/typescript/scripts/agui-ma.mjs"

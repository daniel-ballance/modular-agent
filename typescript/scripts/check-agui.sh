#!/usr/bin/env bash
# Each lane can run npm ci without replacing a sibling lane's kit dependencies.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
export TMPDIR=${TMPDIR:-"$HOME/.cache/ma-std-tmp"}
mkdir -p "$TMPDIR"
scratch=$(mktemp -d "$TMPDIR/ma-typescript-agui.XXXXXXXX")
trap 'rm -rf "$scratch"' EXIT
kit="$scratch/agui"
mkdir -p "$kit" "$scratch/tools"
cp "$repo/conformance/tools/websocket.mjs" "$scratch/tools/"
if [[ -d "$repo/conformance/waiting" ]]; then cp -R "$repo/conformance/waiting" "$scratch/"; fi
cp "$repo"/conformance/agui/{*.mjs,package*.json} "$kit/"
npm ci --silent --prefix "$kit"
node "$kit/run.mjs" -- "$(command -v node)" "$repo/typescript/scripts/agui-ma.mjs"

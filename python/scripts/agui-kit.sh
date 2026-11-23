#!/usr/bin/env bash
# A private install: other language lanes may run the same kit concurrently.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
kit=$(mktemp -d "${TMPDIR:-$HOME/.cache/ma-std-tmp}/python-agui-kit-XXXXXX")
trap 'rm -rf "$kit"' EXIT
cp "$root"/conformance/agui/{*.mjs,package*.json} "$kit/"
npm ci --silent --prefix "$kit"
node "$kit/run.mjs" -- "$root/python/.venv/bin/python" "$root/python/scripts/agui_fixture.py"

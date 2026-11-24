#!/usr/bin/env bash
# A private install: other language lanes may run the same kit concurrently.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
parent="${TMPDIR:-/tmp}"
mkdir -p "$parent"
kit=$(mktemp -d "$parent/python-agui-kit-XXXXXX")
trap 'rm -rf "$kit"' EXIT
mkdir -p "$kit/agui"
cp "$root"/conformance/agui/{*.mjs,package*.json} "$kit/agui/"
if [[ -d "$root/conformance/waiting" ]]; then
  cp -R "$root/conformance/waiting" "$kit/waiting"
  mkdir "$kit/tools"
  cp "$root"/conformance/tools/{*.mjs,package*.json} "$kit/tools/"
  npm ci --silent --prefix "$kit/tools"
fi
npm ci --silent --prefix "$kit/agui"
node "$kit/agui/run.mjs" -- "$root/python/.venv/bin/python" "$root/python/scripts/agui_fixture.py"

#!/usr/bin/env bash
set -euo pipefail
export TMPDIR="${TMPDIR:-$HOME/.cache/ma-std-tmp}"
export CARGO_INCREMENTAL=0
mkdir -p "$TMPDIR"
demo="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$demo/../.." && pwd)"
mkdir -p "$demo/.build"

# In the shared check phase the language lanes have just built both.
if [[ ${1:-} != --sdk-built ]]; then
  (cd "$repo/typescript" && npm ci && npm run build)
  (cd "$repo/rust" && mise exec -- cargo build --locked -p standard --bin ma)
fi
(cd "$demo/host" && npm ci && npm run build && npm test)
(cd "$repo/go" && mise exec -- go -C "$demo/verifier" build -mod=readonly -o "$demo/.build/verifier" .)
uv sync --locked --project "$demo/triage" --python 3.13

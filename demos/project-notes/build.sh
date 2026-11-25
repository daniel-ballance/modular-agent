#!/usr/bin/env bash
set -euo pipefail

demo="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$demo/../.." && pwd)"
mkdir -p "$demo/.build"

# The TypeScript SDK's path dependency links to its built exports.
if [[ ${1:-} != --sdk-built ]]; then
  (cd "$repo/typescript" && npm ci && npm run build)
fi
(cd "$demo/environment" && npm ci && npm run build)
(cd "$repo/go" && mise exec -- go -C "$demo/agent" build -mod=readonly -o "$demo/.build/agent" .)
(cd "$repo/rust" && mise exec -- cargo build --locked --manifest-path "$demo/history/Cargo.toml" --target-dir "$repo/rust/target")
uv sync --locked --project "$demo/tools" --python 3.13

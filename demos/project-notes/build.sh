#!/usr/bin/env bash
set -euo pipefail

demo="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$demo/../.." && pwd)"
if [[ ${1:-} != --sdk-built ]]; then
  (cd "$repo/typescript" && npm ci && npm run build)
fi
for part in agent environment; do
  (cd "$demo/$part" && npm ci && npm run build)
done
(cd "$repo/rust" && mise exec -- cargo build --locked --manifest-path "$demo/Cargo.toml" --target-dir "$repo/rust/target")

#!/usr/bin/env bash
set -euo pipefail
demo="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$demo/../.." && pwd)"
if [[ ${1:-} != --sdk-built ]]; then
  npm ci --silent --prefix "$repo/conformance/telemetry"
  (cd "$repo/typescript" && npm ci && npm run build)
  (cd "$repo/rust" && mise exec -- cargo build --locked -p standard --bin ma)
fi
(cd "$demo/host" && npm ci && npm run build && npm test)

#!/usr/bin/env bash
# Run the kit against production ma and the Rust SDK's disposable controller.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
(cd "$repo/rust" && mise exec -- cargo build --locked -p standard --bin ma --example agui_fixture)
npm ci --silent --prefix "$repo/conformance/agui"
exec node "$repo/conformance/agui/run.mjs" -- "$repo/conformance/agui/rust-launch.mjs"

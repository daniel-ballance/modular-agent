#!/usr/bin/env bash
# The plugin and ACP kits in --connect mode, through the loopback test bridge
# (conformance/tools/ws-bridge.mjs), against the Rust fixture plugin and Rust ma.
# Needs: rust/target/debug/modular-agent and rust/target/debug/ma built, and
# npm ci in conformance/acp and conformance/tools. Called by scripts/check.sh.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export TMPDIR="${TMPDIR:-$HOME/.cache/ma-std-tmp}"
work="$(mktemp -d "$TMPDIR/ws-kits-XXXXXX")"
pids=()
cleanup() { [ ${#pids[@]} -gt 0 ] && kill "${pids[@]}" 2>/dev/null; wait 2>/dev/null; rm -rf "$work"; }
trap cleanup EXIT

(umask 077 && openssl rand -hex 32 >"$work/token")
port() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
bridge="$repo/conformance/tools/ws-bridge.mjs"
plugin="$repo/rust/target/debug/modular-agent --serve-plugin"

# Plugin kit: the full plugin, and each Runtime tier on its own service.
p1=$(port); p2=$(port); p3=$(port)
node "$bridge" --binding plugin --listen "ws://127.0.0.1:$p1/" --token-file "$work/token" -- $plugin >"$work/b1.log" 2>&1 & pids+=($!)
MODULAR_AGENT_PLUGIN_PARTS=runtime node "$bridge" --binding plugin --listen "ws://127.0.0.1:$p2/" --token-file "$work/token" -- $plugin >"$work/b2.log" 2>&1 & pids+=($!)
MODULAR_AGENT_PLUGIN_PARTS=durable-runtime node "$bridge" --binding plugin --listen "ws://127.0.0.1:$p3/" --token-file "$work/token" -- $plugin >"$work/b3.log" 2>&1 & pids+=($!)
for p in $p1 $p2 $p3; do
  for _ in $(seq 100); do (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null && break; sleep 0.1; done
done
(cd "$repo/conformance/plugin" && node run.mjs --connect "ws://127.0.0.1:$p1/" --token-file "$work/token" \
  --runtime-url "ws://127.0.0.1:$p2/" --durable-runtime-url "ws://127.0.0.1:$p3/")

# ACP kit: the kit starts, kills and restarts the bridged service itself.
(cd "$repo/conformance/acp" && MODULAR_AGENT_CONFORMANCE=1 node run.mjs --crash-checks --probe-checks --job-checks \
  --connect "ws://127.0.0.1:$(port)/" --token-file "$work/token" \
  --service-command "node $bridge --binding acp -- $repo/rust/target/debug/ma --acp")

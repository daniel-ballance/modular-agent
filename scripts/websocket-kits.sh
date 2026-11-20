#!/usr/bin/env bash
# The plugin and ACP kits in --connect mode against one language's own WebSocket servers:
# its conformance plugin served with --listen (with each Runtime tier as a separate service),
# and `ma --acp --listen`, which the ACP kit starts, kills and restarts itself.
#
#   scripts/websocket-kits.sh rust|typescript|go|python
#
# Needs that language built as scripts/check.sh builds it, and npm ci in conformance/acp.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
language="${1:?usage: websocket-kits.sh rust|typescript|go|python}"
case "$language" in
  rust) plugin=("$repo/rust/target/debug/modular-agent" --serve-plugin) ;;
  typescript) plugin=(node "$repo/typescript/packages/plugin-wire/dist/src/serve-cli.js") ;;
  go) plugin=("$repo/go/.bin/modular" --serve-plugin) ;;
  python) plugin=("$repo/python/.venv/bin/python" -m ma_plugin.serve) ;;
  *) echo "unknown language: $language" >&2; exit 2 ;;
esac
ma=$(node -e "const a=require('$repo/conformance/reference/agents/$language.json');console.log(a.command.map(x=>x.replaceAll('{repo}',process.argv[1])).join(' '))" "$repo")

export TMPDIR="${TMPDIR:-$HOME/.cache/ma-std-tmp}"
work="$(mktemp -d "$TMPDIR/ws-kits-XXXXXX")"
pids=()
cleanup() { [ ${#pids[@]} -gt 0 ] && kill "${pids[@]}" 2>/dev/null; wait 2>/dev/null; rm -rf "$work"; }
trap cleanup EXIT
(umask 077 && openssl rand -hex 32 >"$work/token")

# Start one plugin service on a free port; print its URL once it accepts connections.
service() { # parts (or ""), name
  local out="$work/$2.url"
  if [ -n "$1" ]; then
    MODULAR_AGENT_PLUGIN_PARTS="$1" "${plugin[@]}" --listen 127.0.0.1:0 --token-file "$work/token" >"$out" 2>"$work/$2.log" &
  else
    "${plugin[@]}" --listen 127.0.0.1:0 --token-file "$work/token" >"$out" 2>"$work/$2.log" &
  fi
  pids+=($!)
  for _ in $(seq 300); do [ -s "$out" ] && break; sleep 0.1; done
  [ -s "$out" ] || { echo "the $2 service did not report its URL" >&2; cat "$work/$2.log" >&2; exit 1; }
  head -1 "$out"
}
full=$(service "" full); runtime=$(service runtime runtime); durable=$(service durable-runtime durable)

(cd "$repo/conformance/plugin" && node run.mjs --connect "$full" --token-file "$work/token" \
  --runtime-url "$runtime" --durable-runtime-url "$durable")

port=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
(cd "$repo/conformance/acp" && MODULAR_AGENT_CONFORMANCE=1 node run.mjs --crash-checks --probe-checks --job-checks \
  --connect "ws://127.0.0.1:$port/" --token-file "$work/token" \
  --service-command "$ma --acp --listen \"\$MODULAR_AGENT_CONFORMANCE_URL\" --token-file \"\$MODULAR_AGENT_CONFORMANCE_TOKEN_FILE\"")

#!/usr/bin/env bash
# Run the ADR 0030 ACP and history checks against one language's own builds.
#
#   scripts/production-kits.sh rust|typescript|go|python
#   scripts/production-kits.sh LANGUAGE --erasure-with HISTORY_LANGUAGE
#       only the ACP erasure checks, with LANGUAGE's agents on HISTORY_LANGUAGE's history service
#
# Needs the launchers and history service built as in scripts/check.sh, and the kit npm dependencies.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
language="${1:?usage: production-kits.sh rust|typescript|go|python [--erasure-with HISTORY_LANGUAGE]}"
history_language="$language"; erasure_only=false
if [ "${2:-}" = --erasure-with ]; then history_language="${3:?--erasure-with needs a language}"; erasure_only=true; fi
case "$language" in
  rust) base=("$repo/rust/target/debug/modular-agent" --acp) ;;
  typescript) base=(node "$repo/typescript/packages/agent/dist/src/cli.js" --acp) ;;
  go) base=("$repo/go/.bin/modular" --mode acp) ;;
  python) base=("$repo/python/.venv/bin/modular-agent" --acp) ;;
  *) echo "unknown language: $language" >&2; exit 2 ;;
esac
mapfile -t ma < <(node -e '
  const [repo, language] = process.argv.slice(1);
  for (const arg of require(`${repo}/conformance/reference/agents/${language}.json`).command)
    console.log(arg.replaceAll("{repo}", repo));
' "$repo" "$language")
ma+=(--acp)

export TMPDIR="${TMPDIR:-$HOME/.cache/ma-std-tmp}"
mkdir -p "$TMPDIR"
work="$(mktemp -d "$TMPDIR/production-kits-XXXXXX")"
work="$(cd "$work" && pwd -P)"
pids=()
stop_history() {
  if [ "${#pids[@]}" -gt 0 ]; then
    kill "${pids[@]}" 2>/dev/null || true
    wait "${pids[@]}" 2>/dev/null || true
    pids=()
  fi
}
cleanup() { stop_history; rm -rf "$work"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
umask 077
export TMPDIR="$work"

free_port() {
  node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p))})'
}

history_service() { # Store directory; sets history_url when the service is ready.
  local dir="$1" address=127.0.0.1:0 line=""
  local -a service
  mkdir "$dir"
  openssl rand -hex 32 >"$dir/token"
  case "$history_language" in
    rust)
      # The SDK example uses 2500 ms outside of the registry restart phases.
      # It takes a fixed address and does not print its bound URL.
      address="127.0.0.1:$(free_port)"
      service=(env -u MODULAR_AGENT_KIT_RESTART_PHASE "$repo/rust/target/debug/examples/history_service" "$address" "$dir/token" "$dir/store")
      ;;
    typescript)
      local settings
      settings=$(node -e 'const fs=require("fs"), dir=process.argv[1]; console.log(JSON.stringify({
        dir: `${dir}/store`, token: fs.readFileSync(`${dir}/token`, "utf8").trim(), leaseTtl: 2500,
      }))' "$dir")
      service=(node "$repo/typescript/packages/services/dist/src/serve.js" history "$settings")
      ;;
    go)
      service=("$repo/go/.bin/modular-service" --role history --listen "$address" --token-file "$dir/token" --state "$dir/store" --history-ttl 2500ms)
      ;;
    python)
      service=("$repo/python/.venv/bin/python" -c '
import signal
import sys
from pathlib import Path
from modular_agent import file_history, serve_history

root = Path(sys.argv[1])
listener = serve_history(file_history(root / "store"), address=("127.0.0.1", 0),
                         token_file=root / "token", witness=root / "witness", lease_ttl=2.5)
print(listener.url, flush=True)
signal.pause()
' "$dir")
      ;;
  esac
  HOME="$work" "${service[@]}" >"$dir/url" 2>"$dir/service.log" &
  local pid=$!
  pids+=("$pid")
  for _ in $(seq 300); do
    kill -0 "$pid" 2>/dev/null || break
    if [ "$history_language" = rust ]; then
      if (exec 3<>"/dev/tcp/${address%:*}/${address#*:}") 2>/dev/null; then
        line="http://$address"
        break
      fi
    elif read -r line <"$dir/url"; then
      break
    fi
    sleep 0.1
  done
  if [ -z "$line" ] || ! kill -0 "$pid" 2>/dev/null; then
    echo "the $history_language history service did not start ($dir)" >&2
    tail -n 30 "$dir/service.log" >&2
    return 1
  fi
  case "$line" in
    http://*) history_url="$line" ;;
    *) history_url=$(node -e 'console.log(JSON.parse(process.argv[1]).url)' "$line") ;;
  esac
}

failed=0
run() { # Label, command and arguments. Keep going so each option is checked.
  printf '\n=== %s: %s ===\n' "$language" "$1"
  shift
  "$@" || failed=1
}

if ! $erasure_only; then
  history_service "$work/history-a"; first="$history_url"
  history_service "$work/history-b"; second="$history_url"
  run 'history --isolation-checks' node "$repo/conformance/history/run.mjs" \
    "$first" "$work/history-a/token" --isolation-checks "$second" "$work/history-b/token"
  stop_history
  # The pending-erasure registry profile, across a service restart on a fixed address.
  mkdir "$work/registry"; openssl rand -hex 32 >"$work/registry/token"
  port=$(free_port); restart=--restart
  case "$history_language" in
    rust) restart=--restart-ttl
      registry=("$repo/rust/target/debug/examples/history_service" "127.0.0.1:$port" "$work/registry/token" "$work/registry/store") ;;
    typescript)
      registry=(node "$repo/typescript/packages/services/dist/src/serve.js" history "$(node -e 'const fs=require("fs"); console.log(JSON.stringify({ dir: process.argv[1] + "/store", token: fs.readFileSync(process.argv[1] + "/token", "utf8").trim(), port: +process.argv[2], leaseTtl: 2500 }))' "$work/registry" "$port")") ;;
    go) registry=("$repo/go/.bin/modular-service" --role history --listen "127.0.0.1:$port" --token-file "$work/registry/token" --state "$work/registry/store" --history-ttl 2500ms) ;;
    python) registry=("$repo/python/.venv/bin/python" -c '
import signal, sys
from pathlib import Path
from modular_agent import file_history, serve_history
root = Path(sys.argv[1])
serve_history(file_history(root / "store"), address=("127.0.0.1", int(sys.argv[2])),
              token_file=root / "token", witness=root / "witness", lease_ttl=2.5)
signal.pause()
' "$work/registry" "$port") ;;
  esac
  run "history --erasure-registry-checks" node "$repo/conformance/history/run.mjs" \
    "http://127.0.0.1:$port" "$work/registry/token" --erasure-registry-checks "$restart" -- "${registry[@]}"
fi

# The kit makes each operator policy, including the small capacity ceilings.
# Erasure needs a shared store without the raw records left by the history kit.
openssl rand -hex 32 >"$work/acp-token"
unset MODULAR_AGENT_HISTORY_URL MODULAR_AGENT_HISTORY_TOKEN_FILE MODULAR_AGENT_PLUGINS
cd "$repo/conformance/acp"
options=(--isolation-checks --capacity-checks --erasure-checks)
if $erasure_only; then options=(--erasure-checks); fi
for option in "${options[@]}"; do
  if [ "$option" = --erasure-checks ]; then
    history_service "$work/erasure"
    export MODULAR_AGENT_HISTORY_URL="$history_url" MODULAR_AGENT_HISTORY_TOKEN_FILE="$work/erasure/token"
  fi
  for launcher in ma base; do
    if [ "$launcher" = ma ]; then command=("${ma[@]}")
    else command=("${base[@]}"); fi
    run "ACP $launcher stdio $option" node run.mjs --production-only "$option" -- "${command[@]}"
    # Go's base CLI has no ACP listener; Go ma does.
    if [ "$language:$launcher" = go:base ]; then continue; fi
    # Each production profile writes an actors policy and supplies its own token files.
    printf -v service_command '%q ' "${command[@]}"
    run "ACP $launcher WebSocket $option" node run.mjs --production-only "$option" \
      --connect "ws://127.0.0.1:$(free_port)/" --token-file "$work/acp-token" \
      --service-command "exec $service_command --listen \"\$MODULAR_AGENT_CONFORMANCE_URL\""
  done
done
exit "$failed"

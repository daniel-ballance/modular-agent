#!/usr/bin/env bash
# Run the ADR 0030 ACP and history checks against one language's own builds.
#
#   scripts/production-kits.sh rust|typescript
#   scripts/production-kits.sh LANGUAGE --erasure-with HISTORY_LANGUAGE
#       only the ACP erasure checks, with LANGUAGE's agents on HISTORY_LANGUAGE's history service
#
# Needs the launchers and history service built as in scripts/check.sh, and the kit npm dependencies.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
language="${1:?usage: production-kits.sh rust|typescript [--erasure-with HISTORY_LANGUAGE]}"
history_language="$language"; erasure_only=false
if [ "${2:-}" = --erasure-with ]; then history_language="${3:?--erasure-with needs a language}"; erasure_only=true; fi
case "$language" in
  rust) base=("$repo/rust/target/debug/modular-agent" --acp) ;;
  typescript) base=(node "$repo/typescript/packages/agent/dist/src/cli.js" --acp) ;;
  *) echo "unknown language: $language" >&2; exit 2 ;;
esac
ma=()
while IFS= read -r arg; do ma+=("$arg"); done < <(node -e '
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

source "$repo/scripts/kit-history.sh"

failed=0
run() { # Label, command and arguments. Keep going so each option is checked.
  printf '\n=== %s: %s ===\n' "$language" "$1"
  shift
  "$@" || failed=1
}

if ! $erasure_only; then
  history_service "$history_language" "$work/history-a"; first="$history_url"
  history_service "$history_language" "$work/history-b"; second="$history_url"
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
    *) echo "unknown history language: $history_language" >&2; exit 2 ;;
  esac
  run "history --erasure-registry-checks" node "$repo/conformance/history/run.mjs" \
    "http://127.0.0.1:$port" "$work/registry/token" --erasure-registry-checks "$restart" -- "${registry[@]}"
fi

# The kit makes each operator policy, including the small capacity ceilings.
# Erasure needs a shared store without the raw records left by the history kit.
openssl rand -hex 32 >"$work/acp-token"
unset MODULAR_AGENT_HISTORY_URL MODULAR_AGENT_HISTORY_TOKEN_FILE MODULAR_AGENT_PLUGINS
cd "$repo/conformance/acp"
groups=(isolation capacity erasure)
if $erasure_only; then groups=(erasure); fi
for group in "${groups[@]}"; do
  if [ "$group" = erasure ]; then
    history_service "$history_language" "$work/erasure"
    export MODULAR_AGENT_HISTORY_URL="$history_url" MODULAR_AGENT_HISTORY_TOKEN_FILE="$work/erasure/token"
  fi
  # Only stock ma offers /skills and operator-configured waiting approvals.
  for launcher in ma base; do
    if [ "$launcher" = ma ]; then command=("${ma[@]}"); export MA_ACP_STOCK_MA=1
    else command=("${base[@]}"); unset MA_ACP_STOCK_MA; fi
    run "ACP $launcher stdio $group" node run.mjs --group "$group" -- "${command[@]}"
    # Each production profile writes an actors policy and supplies its own token files.
    # Replace the shell so the kit gets the agent's exit status and stderr.
    printf -v service_command '%q ' "${command[@]}"
    run "ACP $launcher WebSocket $group" node run.mjs --group "$group" \
      --connect "ws://127.0.0.1:$(free_port)/" --token-file "$work/acp-token" \
      --service-command "exec $service_command --listen \"\$MODULAR_AGENT_CONFORMANCE_URL\""
  done
done
exit "$failed"

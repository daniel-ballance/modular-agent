#!/usr/bin/env bash
# Run from the repository root. Run only one invocation at a time.
set -eu
export TMPDIR="$HOME/.cache/modular-agent-py-tmp" MA_OFFLINE_TEST=1
mkdir -p "$TMPDIR"
log=$(realpath -m "${1:-$TMPDIR/round7}")
mkdir -p "$log"
shift
py=("$PWD/.venv/bin/modular-agent" --mode acp --process-plugins '')
plugin="$PWD/.venv/bin/modular-agent-plugin"
ts=(node "$HOME/Code/modular-agent/packages/agent/dist/src/cli.js" --acp)
rs=("$HOME/Code/modular-agent-rs/target/debug/modular-agent" --acp)
go=("$HOME/Code/modular-agent-go/bin/modular" --mode acp)
ex=("$HOME/Code/modular-agent-ex/bin/agent")
failed=0
run() {
  local name=$1 status=0
  shift
  "$@" >"$log/$name.log" 2>&1 || status=$?
  printf '%s: %s\n' "$name" "$status"
  grep -E '^FAIL  |checks passed|failed, | passed in ' "$log/$name.log" || true
  if ((status)); then failed=1; fi
}
remote() {
  local name=$1 runtime=$2
  shift 2
  local specs
  specs=$(jq -cn --arg p "$plugin" --arg r "$runtime" '[{command:[$p],env:{MODULAR_AGENT_PLUGIN_PARTS:$r}},{command:[$p],env:{MODULAR_AGENT_PLUGIN_PARTS:"provider,hooks"}}]')
  run "$name" env MODULAR_AGENT_PLUGINS="$specs" node conformance/acp/run.mjs --crash-checks --plugin-checks --probe-checks -- "$@"
}
inbound() {
  local build=$1 runtime=$2 specs
  shift 2
  specs=$(jq -cn --argjson cmd "$(printf '%s\n' "$@" | jq -R . | jq -s .)" \
    --arg part "$runtime" --arg ts "$HOME/Code/modular-agent/packages/plugin-wire/dist/src/serve-cli.js" \
    '[{command:$cmd,env:{MODULAR_AGENT_PLUGIN_PARTS:$part}},
      {command:["node",$ts],env:{MODULAR_AGENT_PLUGIN_PARTS:"provider,hooks"}}]')
  run "inbound-$build-$runtime" env MODULAR_AGENT_PLUGINS="$specs" \
    node conformance/acp/run.mjs --crash-checks --plugin-checks --probe-checks -- "${py[@]}"
}
portable() (
  local name=$1
  shift
  local work pid url
  work=$(mktemp -d "$TMPDIR/history.XXXXXX")
  mkdir "$work/history"
  # Fixed disposable kit fixture only. Never use this token for a real service.
  local fixture=round-seven-disposable-fixture
  (umask 077; printf '%s\n' "$fixture" >"$work/token")
  node /tmp/ma-tools/history-service/serve.mjs "$(jq -cn --arg dir "$work/history" --arg token "$fixture" '{dir:$dir,token:$token,leaseMs:15000}')" >"$work/service.log" 2>&1 &
  pid=$!
  trap 'kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; rm -rf -- "$work"' EXIT
  for _ in $(seq 1 50); do [[ -s "$work/service.log" ]] && break; sleep .1; done
  url=$(jq -er .url "$work/service.log")
  local verbose=()
  if [[ ${MA_VERIFY_VERBOSE:-} == 1 ]]; then verbose+=(--verbose); fi
  run "$name" env MODULAR_AGENT_RUNTIME=durable MODULAR_AGENT_HISTORY_URL="$url" MODULAR_AGENT_HISTORY_TOKEN_FILE="$work/token" node conformance/acp/run.mjs "${verbose[@]}" --crash-checks --portable-checks --job-checks -- "$@"
  exit "$failed"
)
for mode in "$@"; do
  case "$mode" in
    suite)
      for r in transient durable; do
        for b in local process; do
          bash scripts/verify_round6.sh "$log" suite "$r" "$b" || failed=1
        done
      done ;;
    self) bash scripts/verify_round6.sh "$log" kits || failed=1 ;;
    inbound|inbound-rs)
      for part in runtime durable-runtime; do
        if [[ $mode == inbound ]]; then
          inbound ts "$part" node "$HOME/Code/modular-agent/packages/plugin-wire/dist/src/serve-cli.js"
          inbound ex "$part" "$HOME/Code/modular-agent-ex/bin/agent" --plugin
        fi
        inbound rs "$part" "$HOME/Code/modular-agent-rs/target/debug/modular-agent" --serve-plugin
      done ;;
    C) remote C-transient runtime "${ex[@]}"; remote C-durable durable-runtime "${ex[@]}" ;;
    E) remote E-durable durable-runtime "${go[@]}" ;;
    F2)
      for writer in ts rs go ex; do
        declare -n cmd="$writer"
        portable "F2-$writer" "${cmd[@]}" --then "${py[@]}" || failed=1
        unset -n cmd
      done ;;
    F2-*) writer=${mode#F2-}; declare -n cmd="$writer"; portable "$mode" "${cmd[@]}" --then "${py[@]}" || failed=1; unset -n cmd ;;
    F3) portable F3-ex "${py[@]}" --then "${ex[@]}" || failed=1 ;;
    *) printf 'Unknown mode: %s\n' "$mode" >&2; exit 2 ;;
  esac
done
exit "$failed"

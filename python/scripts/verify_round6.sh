#!/usr/bin/env bash
# Run from the repository root. Give each suite a separate delegated cgroup.
set -eu
export MA_OFFLINE_TEST=1
agent="$PWD/.venv/bin/modular-agent"
plugin="$PWD/.venv/bin/modular-agent-plugin"
log=$1
mode=$2
mkdir -p "$log"
log=$(realpath "$log")
failed=0
run() {
  local name=$1 status=0
  shift
  "$@" >"$log/$name.log" 2>&1 || status=$?
  printf '%s: %s\n' "$name" "$status"
  if ((status != 0)); then failed=1; fi
}
if [[ $mode == kits ]]; then
  run plugin node conformance/plugin/run.mjs -- "$plugin"
  base='[{"command":["'"$plugin"'"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"provider,hooks"}}'
  durable=',{"command":["'"$plugin"'"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"durable-runtime"}}'
  tools=',{"command":["'"$plugin"'"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"tools,environment"}}'
  (
    cd conformance/acp
    run acp-base env MODULAR_AGENT_PLUGINS="$base]" node run.mjs --crash-checks --plugin-checks --probe-checks --job-checks -- "$agent" --mode acp --process-plugins ''
    run acp-durable env MODULAR_AGENT_PLUGINS="$base$durable]" node run.mjs --crash-checks --plugin-checks --probe-checks --job-checks -- "$agent" --mode acp --process-plugins ''
    run acp-all env MODULAR_AGENT_PLUGINS="$base$durable$tools]" node run.mjs --crash-checks --plugin-checks --probe-checks --job-checks -- "$agent" --mode acp --process-plugins ''
    exit "$failed"
  ) || failed=1
  for r in transient durable; do (
    work=$(mktemp -d "${TMPDIR:-/tmp}/ma-history.XXXXXX")
    mkdir "$work/history"
    token=$(openssl rand -hex 24)
    (umask 077; printf '%s\n' "$token" > "$work/token")
    node /tmp/ma-tools/history-service/serve.mjs "$(jq -cn --arg dir "$work/history" --arg token "$token" '{dir:$dir,token:$token,leaseMs:15000}')" >"$work/service.log" 2>&1 &
    pid=$!
    trap 'kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; rm -rf -- "$work"' EXIT
    for i in $(seq 1 50); do [[ -s "$work/service.log" ]] && break; sleep .1; done
    url=$(jq -er .url "$work/service.log") || exit 1
    cd conformance/acp
    run "portable-$r" env MODULAR_AGENT_HISTORY_URL="$url" MODULAR_AGENT_HISTORY_TOKEN_FILE="$work/token" node run.mjs --crash-checks --portable-checks --job-checks -- "$agent" --mode acp --runtime "$r" --process-plugins '' --then "$agent" --mode acp --runtime "$r" --process-plugins ''
    exit "$failed"
  ) || failed=1; done
elif [[ $mode == suite ]]; then
  r=$3
  b=$4
  cg=${MA_CGROUP_ROOT:-/sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service}
  group="$cg/ma-round-six-$$-$r-$b"
  mkdir "$group"
  trap 'rmdir "$group"' EXIT
  run "suite-$r-$b" env MA_CGROUP_ROOT="$group" uv run --offline pytest -q --tb=short --runtime "$r" --binding "$b"
else
  printf 'Usage: %s LOG_DIR kits | LOG_DIR suite RUNTIME BINDING\n' "$0" >&2
  exit 2
fi
exit "$failed"

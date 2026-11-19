#!/usr/bin/env bash
# Run the unchanged conformance kits. Keep all child process identifiers exact.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
agent="$repo/bin/modular"
mode=${1:?use plugin, local, portable, or history}; shift
case "$mode" in
  plugin)
    cd "$repo"
    # The setsid check probes a shell PID from outside its namespace.
    # Keep that probe from hitting unrelated host processes.
    exec unshare --user --map-root-user --pid --fork --kill-child --mount-proc -- \
      bash -c 'for ((i=0;i<128;i++)); do /bin/true; done; exec node conformance/plugin/run.mjs -- "$1" --serve-plugin' bash "$agent"
    ;;
  local)
    if [[ ${1:-} == durable-runtime ]]; then parts=durable-runtime; else parts=provider,hooks; fi
    export MODULAR_AGENT_PLUGINS="[{\"command\":[\"$agent\",\"--serve-plugin\"],\"env\":{\"MODULAR_AGENT_PLUGIN_PARTS\":\"provider,hooks\"}}]"
    if [[ $parts == durable-runtime ]]; then
      export MODULAR_AGENT_PLUGINS="${MODULAR_AGENT_PLUGINS%]}, {\"command\":[\"$agent\",\"--serve-plugin\"],\"env\":{\"MODULAR_AGENT_PLUGIN_PARTS\":\"durable-runtime\"}}]"
    fi
    cd "$repo/conformance/acp"
    exec node run.mjs --crash-checks --plugin-checks --probe-checks -- "$agent" --mode acp
    ;;
  portable|history)
    service_kind=${1:-go}
    work=$(mktemp -d)
    mkdir "$work/history"
    token=$(openssl rand -hex 20)
    (umask 077; printf '%s\n' "$token" >"$work/token")
    if [[ $service_kind == go ]]; then
      "$repo/bin/modular-service" --role history --state "$work/history" --token-file "$work/token" >"$work/ready" &
    else
      node /tmp/ma-tools/history-service/serve.mjs "{\"dir\":\"$work/history\",\"token\":\"$token\",\"leaseMs\":15000}" >"$work/ready" &
    fi
    service=$!
    trap 'kill "$service" 2>/dev/null || true; wait "$service" 2>/dev/null || true; rm -rf "$work"' EXIT
    for ((i=0;i<100;i++)); do
      if [[ -s $work/ready ]]; then break; fi
      sleep .05
    done
    export MODULAR_AGENT_HISTORY_URL=$(jq -er .url "$work/ready")
    export MODULAR_AGENT_HISTORY_TOKEN_FILE="$work/token"
    if [[ $mode == history ]]; then
      cd "$repo"
      node conformance/history/run.mjs "$MODULAR_AGENT_HISTORY_URL" "$MODULAR_AGENT_HISTORY_TOKEN_FILE"
      exit
    fi
    runtime=${2:?use transient or durable}
    cd "$repo/conformance/acp"
    node run.mjs --crash-checks --portable-checks -- "$agent" --mode acp --runtime "$runtime" --then "$agent" --mode acp --runtime "$runtime"
    ;;
  *) printf 'Unknown check: %s\n' "$mode" >&2; exit 2 ;;
esac

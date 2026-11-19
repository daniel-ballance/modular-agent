#!/usr/bin/env bash
# Run the current kits using absolute agent and plugin commands.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
agent="$repo/bin/modular"
mode=${1:?use plugin, local, portable, or history}
shift
case "$mode" in
  plugin)
    cd "$repo"
    # The kit still probes a PID printed inside a command namespace when
    # checking setsid. Isolate that probe from unrelated host processes.
    exec unshare --user --map-root-user --pid --fork --kill-child --mount-proc -- \
      bash -c 'for ((i=0;i<128;i++)); do /bin/true; done; exec node conformance/plugin/run.mjs -- "$1" --serve-plugin' bash "$agent"
    ;;
  local)
    fixture='[{"command":[$agent,"--serve-plugin"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"provider,hooks"}}]'
    extra='{"command":[$agent,"--serve-plugin"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":$part}}'
    case "${1:-provider,hooks}" in
      provider,hooks) ;;
      durable-runtime) fixture+=" + [$extra]" ;;
      tools,environment) fixture+=" + [$extra]" ;;
      all) fixture+=" + [($extra | .env.MODULAR_AGENT_PLUGIN_PARTS = \"durable-runtime\"), ($extra | .env.MODULAR_AGENT_PLUGIN_PARTS = \"tools,environment\")]" ;;
      *) printf 'Unknown parts: %s\n' "$1" >&2; exit 2 ;;
    esac
    export MODULAR_AGENT_PLUGINS=$(jq -cn --arg agent "$agent" --arg part "${1:-}" "$fixture")
    cd "$repo/conformance/acp"
    exec node run.mjs --crash-checks --plugin-checks --probe-checks --job-checks -- "$agent" --mode acp
    ;;
  portable|history)
    service_kind=${1:?use go or supplied}
    work=$(mktemp -d)
    mkdir "$work/history"
    token=$(openssl rand -hex 20)
    (umask 077; printf '%s\n' "$token" >"$work/token")
    service=''
    trap 'if [[ -n $service ]]; then kill "$service" 2>/dev/null || true; wait "$service" 2>/dev/null || true; fi; rm -rf "$work"' EXIT
    case "$service_kind" in
      go) "$repo/bin/modular-service" --role history --state "$work/history" --token-file "$work/token" >"$work/ready" & ;;
      supplied) node /tmp/ma-tools/history-service/serve.mjs "{\"dir\":\"$work/history\",\"token\":\"$token\",\"leaseMs\":15000}" >"$work/ready" & ;;
      *) printf 'Unknown history service: %s\n' "$service_kind" >&2; exit 2 ;;
    esac
    service=$!
    for ((i=0;i<100;i++)); do
      if [[ -s $work/ready ]]; then break; fi
      sleep .05
    done
    export MODULAR_AGENT_HISTORY_URL=$(jq -er .url "$work/ready")
    export MODULAR_AGENT_HISTORY_TOKEN_FILE="$work/token"
    if [[ $mode == history ]]; then
      cd "$repo"
      node conformance/history/run.mjs "$MODULAR_AGENT_HISTORY_URL" "$MODULAR_AGENT_HISTORY_TOKEN_FILE"
    else
      runtime=${2:?use transient or durable}
      cd "$repo/conformance/acp"
      node run.mjs --crash-checks --portable-checks --job-checks -- "$agent" --mode acp --runtime "$runtime" --then "$agent" --mode acp --runtime "$runtime"
    fi
    ;;
  *) printf 'Unknown check: %s\n' "$mode" >&2; exit 2 ;;
esac

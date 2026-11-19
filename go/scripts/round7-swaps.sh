#!/usr/bin/env bash
# Reproduce one edition 3 matrix cell using peer executables only.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${TMPDIR:=$HOME/.cache/modular-agent-go-tmp}"
export TMPDIR
mkdir -p "$TMPDIR"
code=$HOME/Code
agent() {
  case $1 in
    go) cmd=("$PWD/bin/modular" --mode acp) ;;
    ts) cmd=(node "$code/modular-agent/packages/agent/dist/src/cli.js" --acp) ;;
    rs) cmd=("$code/modular-agent-rs/target/debug/modular-agent" --acp) ;;
    py) cmd=("$code/modular-agent-py/.venv/bin/modular-agent" --mode acp --process-plugins '') ;;
    ex) cmd=("$code/modular-agent-ex/bin/agent") ;;
    *) return 2 ;;
  esac
}
plugin() {
  case $1 in
    go) cmd=("$PWD/bin/modular" --serve-plugin) ;;
    ts) cmd=(node "$code/modular-agent/packages/plugin-wire/dist/src/serve-cli.js") ;;
    rs) cmd=("$code/modular-agent-rs/target/debug/modular-agent" --serve-plugin) ;;
    py) cmd=("$code/modular-agent-py/.venv/bin/modular-agent-plugin") ;;
    ex) cmd=("$code/modular-agent-ex/bin/agent" --plugin) ;;
    *) return 2 ;;
  esac
  jq -cn --args '$ARGS.positional' -- "${cmd[@]}"
}
case ${1:?use runtime or portable} in
  runtime)
    agent "${2:?host}"
    host=("${cmd[@]}")
    wire=$(plugin "${3:?plugin}")
    part=${4:-durable-runtime}
    export MODULAR_AGENT_PLUGINS=$(jq -cn --argjson command "$wire" --arg part "$part" \
      '[$part, "provider,hooks"] | map({command: $command, env: {MODULAR_AGENT_PLUGIN_PARTS: .}})')
    exec node conformance/acp/run.mjs --crash-checks --plugin-checks --probe-checks -- "${host[@]}"
    ;;
  portable)
    agent "${2:?writer}"
    writer=("${cmd[@]}")
    agent "${3:?reopener}"
    reopener=("${cmd[@]}")
    work=$(mktemp -d)
    token=$(openssl rand -hex 20)
    (umask 077; printf '%s\n' "$token" > "$work/token")
    service=''
    trap 'if [[ -n $service ]]; then kill "$service" 2>/dev/null || true; wait "$service" 2>/dev/null || true; fi; rm -rf "$work"' EXIT
    node /tmp/ma-tools/history-service/serve.mjs "$(jq -cn --arg dir "$work/history" --arg token "$token" '{dir:$dir,token:$token,leaseMs:15000}')" > "$work/ready" &
    service=$!
    for ((i=0;i<100;i++)); do
      if [[ -s $work/ready ]]; then break; fi
      sleep .05
    done
    export MODULAR_AGENT_RUNTIME=durable
    export MODULAR_AGENT_HISTORY_URL=$(jq -er .url "$work/ready")
    export MODULAR_AGENT_HISTORY_TOKEN_FILE="$work/token"
    # Go's CLI also accepts an explicit runtime selection.
    if [[ $2 == go ]]; then writer+=(--runtime durable); fi
    if [[ $3 == go ]]; then reopener+=(--runtime durable); fi
    node conformance/acp/run.mjs --crash-checks --portable-checks --job-checks -- "${writer[@]}" --then "${reopener[@]}"
    ;;
  *) exit 2 ;;
esac

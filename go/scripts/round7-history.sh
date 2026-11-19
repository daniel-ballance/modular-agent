#!/usr/bin/env bash
# Run the production history kit with a fresh store and a foreground service.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
(umask 077; openssl rand -hex 32 > "$work/token")
cd "$repo"
port=${2:-39079}
case ${1:-restart} in
  restart)
    node conformance/history/run.mjs "http://127.0.0.1:$port" "$work/token" --restart -- \
      "$repo/bin/modular-service" --role history --state "$work/store" --token-file "$work/token" --listen "127.0.0.1:$port" --history-ttl 3s
    ;;
  restart-ttl)
    node conformance/history/run.mjs "http://127.0.0.1:$port" "$work/token" --restart-ttl -- \
      /usr/bin/bash -c 'ttl=6s; if [[ $MODULAR_AGENT_KIT_RESTART_PHASE == restart ]]; then ttl=1s; fi; exec "$1" --role history --state "$2/store" --token-file "$2/token" --listen "127.0.0.1:$3" --history-ttl "$ttl"' bash "$repo/bin/modular-service" "$work" "$port"
    ;;
  *) exit 2 ;;
esac

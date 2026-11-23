#!/usr/bin/env bash
# Start or stop a local Arize Phoenix to look at traces from the SDKs and ma.
#
#   scripts/phoenix.sh start   UI at http://127.0.0.1:6006; OTLP/HTTP at
#                              http://127.0.0.1:6006/v1/traces, OTLP/gRPC at 127.0.0.1:4317
#   scripts/phoenix.sh stop    remove the container and its traces
#
# For development only: authentication is off and it listens on loopback.
# Phoenix's OTLP/HTTP endpoint takes protobuf (http/protobuf), not JSON.
# Needs podman (rootless) or docker.
set -euo pipefail

# arize-phoenix-v22.0.1, checked 2026-11-22.
image=docker.io/arizephoenix/phoenix@sha256:0aacce23fc1a22f03f8433f10a08de0e07ea00aaf33acfcbc9757814bce2f537
name=ma-phoenix
engine=$(command -v podman || command -v docker || true)
[[ -n $engine ]] || { echo 'Install podman or docker.' >&2; exit 2; }

case ${1:-} in
  start)
    # Leave a running Phoenix and its traces alone.
    if [[ $("$engine" inspect -f '{{.State.Running}}' "$name" 2>/dev/null) == true ]]; then
      echo 'Phoenix is already running: http://127.0.0.1:6006'
      exit 0
    fi
    "$engine" rm -f "$name" >/dev/null 2>&1 || true
    "$engine" run -d --name "$name" -e PHOENIX_ENABLE_AUTH=false \
      -p 127.0.0.1:6006:6006 -p 127.0.0.1:4317:4317 "$image" >/dev/null
    for _ in $(seq 1 120); do
      if curl -fs -o /dev/null http://127.0.0.1:6006/; then
        echo 'Phoenix: http://127.0.0.1:6006'
        echo 'Export with: OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:6006 OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf'
        exit 0
      fi
      sleep 1
    done
    echo 'Phoenix did not start; see: '"$engine logs $name" >&2
    exit 1
    ;;
  stop) "$engine" rm -f "$name" >/dev/null && echo 'Phoenix stopped.' ;;
  *) echo 'Usage: scripts/phoenix.sh start|stop' >&2; exit 2 ;;
esac

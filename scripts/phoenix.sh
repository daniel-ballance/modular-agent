#!/usr/bin/env bash
# Start or stop a local Arize Phoenix to look at traces from the SDKs and ma.
#
#   scripts/phoenix.sh start   UI at http://127.0.0.1:6006; OTLP/HTTP at
#                              http://127.0.0.1:6006/v1/traces, OTLP/gRPC at 127.0.0.1:4317
#   scripts/phoenix.sh stop    stop it; traces are kept in the ma-phoenix-data volume
#   scripts/phoenix.sh reset   stop it and delete its traces
#
# For development only: authentication is off and it listens on loopback.
# Phoenix's OTLP/HTTP endpoint takes protobuf (http/protobuf), not JSON.
# Needs podman (rootless) or docker.
#
# Where systemd user units are available, the container runs as the unit
# ma-phoenix. A container started from a shell that lives in a systemd scope,
# such as a coding agent's, is otherwise stopped when that scope ends.
set -euo pipefail

# arize-phoenix-v22.0.1, checked 2026-11-22.
image=docker.io/arizephoenix/phoenix@sha256:0aacce23fc1a22f03f8433f10a08de0e07ea00aaf33acfcbc9757814bce2f537
name=ma-phoenix
volume=ma-phoenix-data
engine=$(command -v podman || command -v docker || true)
[[ -n $engine ]] || { echo 'Install podman or docker.' >&2; exit 2; }
user_units() { command -v systemd-run >/dev/null && systemctl --user show-environment >/dev/null 2>&1; }

stop() {
  if user_units; then systemctl --user stop "$name" >/dev/null 2>&1 || true; fi
  "$engine" rm -f "$name" >/dev/null 2>&1 || true
}

case ${1:-} in
  start)
    # Leave a running Phoenix and its traces alone.
    if [[ $("$engine" inspect -f '{{.State.Running}}' "$name" 2>/dev/null) == true ]]; then
      echo 'Phoenix is already running: http://127.0.0.1:6006'
      exit 0
    fi
    stop
    run=("$engine" run --rm --name "$name" -e PHOENIX_ENABLE_AUTH=false
      -v "$volume:/root/.phoenix" -p 127.0.0.1:6006:6006 -p 127.0.0.1:4317:4317 "$image")
    if user_units; then
      systemctl --user reset-failed "$name" >/dev/null 2>&1 || true
      systemd-run --user --quiet --unit="$name" --collect "${run[@]}"
    else
      "${run[@]/--rm/-d}" >/dev/null
    fi
    for _ in $(seq 1 120); do
      if curl -fs -o /dev/null http://127.0.0.1:6006/; then
        echo 'Phoenix: http://127.0.0.1:6006'
        echo 'Export with: OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:6006 OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf'
        exit 0
      fi
      sleep 1
    done
    echo "Phoenix did not start; see: journalctl --user -u $name, or $engine logs $name" >&2
    exit 1
    ;;
  stop) stop; echo 'Phoenix stopped; its traces are kept.' ;;
  reset) stop; "$engine" volume rm -f "$volume" >/dev/null; echo 'Phoenix stopped and its traces deleted.' ;;
  *) echo 'Usage: scripts/phoenix.sh start|stop|reset' >&2; exit 2 ;;
esac

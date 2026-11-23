#!/usr/bin/env bash
# The ACP erasure checks with each language's agents on every other language's history
# service, all using the pendingErasure: 1 profile (docs/bindings/history-http.md).
# Needs everything scripts/production-kits.sh needs, for all four languages.
set -uo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
serial=false
case "${1:-}" in
  '') ;;
  --serial) serial=true ;;
  *) echo 'Usage: scripts/erasure-matrix.sh [--serial]' >&2; exit 2 ;;
esac
export TMPDIR="${TMPDIR:-$HOME/.cache/ma-std-tmp}"
mkdir -p "$TMPDIR" || exit 1
logs=$(mktemp -d "$TMPDIR/erasure-XXXXXX") || exit 1
printf 'Pairing logs: %s\n' "$logs"
start=$SECONDS

pair() {
  local agent="$1" history="$2" log="$logs/$1-on-$2.log" started=$SECONDS
  if "$repo/scripts/production-kits.sh" "$agent" --erasure-with "$history" >"$log" 2>&1; then
    printf 'PASS  %s agents on the %s history service (%ss)\n' "$agent" "$history" "$((SECONDS - started))"
  else
    printf 'FAIL  %s agents on the %s history service (%ss): %s\n' "$agent" "$history" "$((SECONDS - started))" "$log"
    return 1
  fi
}

failed=0
pids=()
for agent in rust typescript go python; do
  for history in rust typescript go python; do
    [ "$agent" = "$history" ] && continue # production-kits.sh runs these
    if $serial; then
      pair "$agent" "$history" || failed=1
    else
      pair "$agent" "$history" &
      pids+=("$!")
    fi
  done
done
for pid in "${pids[@]}"; do wait "$pid" || failed=1; done
printf 'Erasure matrix wall time: %ss\n' "$((SECONDS - start))"
exit "$failed"

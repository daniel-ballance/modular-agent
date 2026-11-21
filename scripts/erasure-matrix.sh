#!/usr/bin/env bash
# The ACP erasure checks with each language's agents on every other language's history
# service, all using the pendingErasure: 1 profile (docs/bindings/history-http.md).
# Needs everything scripts/production-kits.sh needs, for all four languages.
set -uo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
failed=0
for agent in rust typescript go python; do
  for history in rust typescript go python; do
    [ "$agent" = "$history" ] && continue # production-kits.sh runs these
    if "$repo/scripts/production-kits.sh" "$agent" --erasure-with "$history"; then
      echo "PASS  $agent agents on the $history history service"
    else
      echo "FAIL  $agent agents on the $history history service"; failed=1
    fi
  done
done
exit "$failed"

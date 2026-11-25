#!/usr/bin/env bash
# Start N independent copies of check.sh together to reproduce failures under load.
# Usage: scripts/stress.sh N [check.sh options]
set -euo pipefail

usage='Usage: scripts/stress.sh N [check.sh options] (N must be a positive integer)'
case "${1:-}" in -h|--help) echo "$usage"; exit 0 ;; esac
if [[ ! ${1:-} =~ ^[1-9][0-9]{0,8}$ ]]; then
  echo "$usage" >&2
  exit 2
fi
count=$1; shift
for arg in "$@"; do
  case "$arg" in
    --quick|--serial|rust|typescript|go|python) ;;
    -h|--help) echo "$usage"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
# The runs must overlap to load the machine, so all of them wait for their slots together.
. scripts/check-slot.sh
take_check_slots "$count" || exit
export TMPDIR="${TMPDIR:-$HOME/.cache/ma-std-tmp}"
mkdir -p "$TMPDIR"
TMPDIR="$(cd "$TMPDIR" && pwd -P)"
root="$(mktemp -d "$TMPDIR/stress-XXXXXX")"
printf 'Stress logs: %s\n' "$root"

# Copy tracked sources as they are on disk. Each run needs its own build outputs,
# virtual environment and node_modules (npm ci removes the old tree).
(
  drop_check_slots
  git ls-files -z | tar -cf "$root/source.tar" --null -T -
  for ((run = 1; run <= count; run++)); do
    src="$root/$run/src"
    mkdir -p "$src" "$root/$run/tmp"
    tar -xf "$root/source.tar" -C "$src"
    # The link checker uses git ls-files. Only a local index is needed.
    git -C "$src" init -q
    git -C "$src" add -f -- .
  done
  rm "$root/source.tar"
)

check() {
  local dir="$1" status=0; shift
  (
    cd "$dir/src" && export TMPDIR="$dir/tmp" &&
      export MISE_TRUSTED_CONFIG_PATHS="$dir/src${MISE_TRUSTED_CONFIG_PATHS:+:$MISE_TRUSTED_CONFIG_PATHS}" &&
      exec scripts/check.sh "$@"
  ) >"$dir/check.log" 2>&1 || status=$?
  printf '%s\n' "$status" >"$dir/status"
  # Keep logs and test scratch, not the disposable build trees.
  if ! rm -rf -- "$dir/src"; then
    printf 'Could not remove the build tree: %s\n' "$dir/src" >&2
  fi
}

# Each run gets its own process group, so stopping stress.sh can stop all of
# a run's processes. Neither the setup nor the runs keep the slot files open.
pids=()
stop_runs() { # exit status
  local pid
  for pid in "${pids[@]}"; do kill -TERM -- "-$pid" 2>/dev/null || true; done
  exit "$1"
}
trap 'stop_runs 129' HUP
trap 'stop_runs 130' INT
trap 'stop_runs 143' TERM
set -m
for ((run = 1; run <= count; run++)); do
  { drop_check_slots; check "$root/$run" "$@"; } &
  pids+=("$!")
done
set +m

shopt -s nullglob
failed=0
: >"$root/failures.tsv"
for i in "${!pids[@]}"; do
  dir="$root/$((i + 1))"
  wait "${pids[i]}" || failed=1
  status=125
  if [ -f "$dir/status" ]; then read -r status <"$dir/status"; fi
  manifests=("$dir/tmp"/check-*/failed-*.tsv)
  if [ "$status" -ne 0 ]; then
    failed=1
    if [ "${#manifests[@]}" -eq 0 ] || ! grep -q '^Wall time: ' "$dir/check.log"; then
      printf '(check.sh failed outside a step)\t%s\n' "$dir/check.log" >>"$root/failures.tsv"
    fi
  fi
  for manifest in "${manifests[@]}"; do
    while IFS=$'\t' read -r name log; do
      printf '%s\t%s\n' "$name" "$log"
    done <"$manifest"
  done >>"$root/failures.tsv"
done

if [ -s "$root/failures.tsv" ]; then
  printf '\nFailed step\tRuns failed\tFailing logs\n'
  LC_ALL=C sort -t $'\t' -k1,1 "$root/failures.tsv" | awk -F '\t' -v total="$count" '
    function print_step(   i) {
      if (!n) return
      printf "%s\t%d/%d\t%s\n", step, n, total, logs[1]
      for (i = 2; i <= n; i++) printf "\t\t%s\n", logs[i]
    }
    $1 != step { print_step(); step = $1; n = 0 }
    { logs[++n] = $2 }
    END { print_step() }
  '
elif [ "$failed" -eq 0 ]; then
  printf 'All %s runs passed.\n' "$count"
fi
exit "$failed"

# Sourced by check.sh and stress.sh. Heavy runs share MA_CHECK_SLOTS slots on
# this machine (default 3, 0 turns the limit off). A slot is a flock on a file in
# a fixed directory, so a run killed in any way gives its slot back.

check_slot_fds=()

take_check_slots() { # count: wait until this many slots are free, then hold them
  local want=$1 slots=${MA_CHECK_SLOTS:-3} dir="$HOME/.cache/ma-std-tmp/slots"
  local i fd started=$SECONDS waiting=false
  local -a taken fds
  if [[ ! $slots =~ ^[0-9]+$ ]]; then
    echo "check-slot: MA_CHECK_SLOTS must be a whole number, not '$slots'" >&2
    return 2
  fi
  (( slots == 0 )) && return 0
  if (( want > slots )); then
    echo "check-slot: $want slots wanted, but MA_CHECK_SLOTS is $slots. Run fewer at once, or set MA_CHECK_SLOTS=0 on a machine no one else is using." >&2
    return 2
  fi
  # A caller that holds a slot already (an outer check.sh, stress.sh or the
  # old wrapper) passes it on; its slot is one of the ones wanted.
  [ -n "${MA_CHECK_SLOT_HELD:-}" ] && want=$((want - 1))
  (( want <= 0 )) && return 0
  command -v flock >/dev/null || { echo "check-slot: flock (util-linux) is not installed" >&2; return 2; }
  mkdir -p "$dir" || return 2
  while :; do
    taken=() fds=()
    for ((i = 1; i <= slots && ${#taken[@]} < want; i++)); do
      exec {fd}>"$dir/slot-$i.lock" || return 2
      if flock -n "$fd"; then
        taken+=("$i") fds+=("$fd")
      else
        exec {fd}>&-
      fi
    done
    (( ${#taken[@]} == want )) && break
    # All or none: holding some while waiting for more could deadlock two stress runs.
    for fd in "${fds[@]}"; do exec {fd}>&-; done
    if ! $waiting; then
      printf 'check-slot: waiting for %s free of %s slots (MA_CHECK_SLOTS) at %s\n' \
        "$want" "$slots" "$(date -u +%T)" >&2
      waiting=true
    fi
    sleep 2
  done
  check_slot_fds+=("${fds[@]}")
  export MA_CHECK_SLOT_HELD=1
  printf 'check-slot: took slot %s of %s at %s after %ss\n' \
    "${taken[*]}" "$slots" "$(date -u +%T)" $((SECONDS - started)) >&2
}

drop_check_slots() { # in a child process: close the slot files, so a process left behind cannot keep a slot
  local fd
  for fd in "${check_slot_fds[@]}"; do exec {fd}>&-; done
}

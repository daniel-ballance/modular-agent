# Sourced by check.sh and stress.sh. Heavy runs share MA_CHECK_SLOTS slots on
# this machine (default 3, 0 turns the limit off). A slot is a flock on a file in
# a fixed directory, held until every process with the file open has exited.
#
# A wrapper that takes a slot itself hands it over by exporting
# MA_CHECK_SLOT_HELD=1 and MA_CHECK_SLOT_FD=<descriptor holding the lock>, then
# exec-ing the run, so the run's steps can close that descriptor too.

check_slot_fds=()

check_slot_number() { # value max: print value as a decimal, or fail if it is not one from 0 to max
  [[ $1 =~ ^[0-9]{1,9}$ ]] && (( 10#$1 <= $2 )) && echo $((10#$1))
}

check_slot_file() { # fd count dir: succeed if fd is open on one of the first count slot files
  local i
  for ((i = 1; i <= $2; i++)); do
    [ "/dev/fd/$1" -ef "$3/slot-$i.lock" ] && return 0
  done
  return 1
}

take_check_slots() { # count: wait until this many slots are free, then hold them
  local want=$1 slots dir="$HOME/.cache/ma-std-tmp/slots"
  local i fd started=$SECONDS waiting=false
  local -a taken fds
  if ! slots=$(check_slot_number "${MA_CHECK_SLOTS:-3}" 64); then
    echo "check-slot: MA_CHECK_SLOTS must be a whole number from 0 to 64, not '$MA_CHECK_SLOTS'" >&2
    return 2
  fi
  if [ -n "${MA_CHECK_SLOT_HELD:-}" ]; then
    # A run that waits while it holds a slot can deadlock with another one doing
    # the same, so a caller's slot is the only one its runs may use.
    if (( want > 1 )); then
      echo "check-slot: this process already holds a check slot (MA_CHECK_SLOT_HELD), so it cannot wait for $((want - 1)) more. Start a run that needs $want slots on its own, not inside check.sh or a slot wrapper." >&2
      return 2
    fi
    if [ -n "${MA_CHECK_SLOT_FD:-}" ]; then
      if ! fd=$(check_slot_number "$MA_CHECK_SLOT_FD" 999999999) || ! check_slot_file "$fd" 64 "$dir"; then
        echo "check-slot: MA_CHECK_SLOT_FD must be the number of an open descriptor on a slot file in $dir, not '$MA_CHECK_SLOT_FD'" >&2
        return 2
      fi
      check_slot_fds+=("$fd")
    fi
    return 0
  fi
  (( slots == 0 )) && return 0
  if (( want > slots )); then
    echo "check-slot: $want slots wanted, but MA_CHECK_SLOTS is $slots. Run fewer at once, or set MA_CHECK_SLOTS=0 on a machine no one else is using." >&2
    return 2
  fi
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
  check_slot_fds=()
  unset MA_CHECK_SLOT_FD
}

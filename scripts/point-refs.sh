# Sourced by check.sh. The guard that fails a run whose tests saved environment points
# (refs/modular-agent/) for a project in this checkout. Needs $repo and $logs.
#
# Worktrees share one ref store, so another checkout's run can add points while this one runs.
# Each point commit names its project in a `project:` trailer. A new point counts only when Git
# says that project lies in this worktree; a sibling or nested worktree, a missing trailer or
# more than one is not this run's.

point_refs() {
  git for-each-ref --format='%(refname) %(objectname)' refs/modular-agent/ | LC_ALL=C sort
}

worktree_roots() { # every worktree of this repository, canonical where it still exists
  local record
  git worktree list --porcelain -z | while IFS= read -r -d '' record; do
    [[ $record == 'worktree '* ]] || continue
    record=${record#worktree }
    (cd "$record" 2>/dev/null && pwd -P) || printf '%s\n' "$record"
  done
}

toplevel() { # dir: print the canonical top level of the worktree holding dir, or nothing
  local top
  top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) && (cd "$top" && pwd -P)
  return 0
}

# A project folder that still exists belongs to the worktree Git finds for it. One that is gone
# belongs to the deepest worktree, seen at the start or end of the run, that contains it, unless
# that worktree's folder now exists as something else, such as a plain folder of an enclosing
# checkout after `git worktree move`; then the next deepest one is tried. A worktree path that
# is created and removed within one run, or moved, reused and then deleted, leaves no record
# that tells whose point it was; delegates keep their worktrees outside the checkout.
point_owner() { # project
  local project=$1 root
  if [ -d "$project" ]; then
    toplevel "$project"
    return 0
  fi
  while IFS= read -r root; do
    [[ $project == "$root" || $project == "$root"/* ]] || continue
    if [ ! -d "$root" ] || [ "$(toplevel "$root")" = "$root" ]; then
      printf '%s\n' "$root"
      return 0
    fi
  done < <(awk '{ print length($0) "\t" $0 }' "$logs/worktrees" | LC_ALL=C sort -t$'\t' -k1,1nr | cut -f2-)
  return 0
}

check_test_refs() {
  local root ref sha record project
  local -A projects=() owners=()
  root="$(cd "$repo" && pwd -P)" || return
  point_refs >"$logs/refs-after" || return
  LC_ALL=C comm -13 "$logs/refs-before" "$logs/refs-after" >"$logs/refs-new" || return
  : >"$logs/refs-added"
  [ -s "$logs/refs-new" ] || return 0
  cp "$logs/worktrees-before" "$logs/worktrees" || return
  worktree_roots >>"$logs/worktrees" || return
  # The SDKs write `project: PATH`; a user's trailer settings must not change how it reads.
  cut -d' ' -f2 "$logs/refs-new" |
    git -c trailer.separators=: -c trailer.project.key=project log --no-walk=unsorted --stdin -z \
      --format='%H %(trailers:key=project,valueonly,separator=%x01)' >"$logs/refs-projects" || return
  while IFS= read -r -d '' record; do
    projects[${record%% *}]=${record#* }
  done <"$logs/refs-projects"
  while read -r ref sha; do
    project=${projects[$sha]-}
    [ -n "$project" ] && [[ $project != *[$'\n\001']* ]] || continue
    [ -n "${owners[$project]+set}" ] || owners[$project]=$(point_owner "$project")
    [ "${owners[$project]}" = "$root" ] && printf '%s %s\n' "$ref" "$sha" >>"$logs/refs-added"
  done <"$logs/refs-new"
  if [ -s "$logs/refs-added" ]; then
    printf 'Tests added %s refs under refs/modular-agent/ to the enclosing repository. See %s\n' \
      "$(wc -l <"$logs/refs-added")" "$logs/refs-added" >&2
    return 1
  fi
}

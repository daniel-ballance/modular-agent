#!/usr/bin/env bash
# Launch one disposable ACP transcript. Each group gets its own composition.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
language="${1:?language required}"
case "$language" in rust|typescript) ;; *) echo "unknown language: $language" >&2; exit 2 ;; esac
group="${2:?ACP group required}"
flags=(--group "$group")
case "$group" in
  core) registry=reference/agents; flags+=(--crash-checks --probe-checks --job-checks); args=(--acp --approval off) ;;
  covered) registry=reference/agents; args=(--acp --approval off) ;;
  waiting|stdio-rights) registry=sdk/fixtures; args=("acp-$group") ;;
  *) echo "use core, covered, waiting or stdio-rights; production groups need production-kits.sh" >&2; exit 2 ;;
esac
command=()
while IFS= read -r arg; do command+=("$arg"); done < <(
  node -e 'const [file, repo] = process.argv.slice(1); for (const arg of require(file).command) console.log(arg.replaceAll("{repo}", repo))' \
    "$repo/conformance/$registry/$language.json" "$repo"
)
[[ ${#command[@]} -gt 0 ]] || { echo "missing $language $registry launcher" >&2; exit 1; }
cd "$repo/conformance/acp"
export MODULAR_AGENT_CONFORMANCE=1
exec node run.mjs "${flags[@]}" -- "${command[@]}" "${args[@]}"

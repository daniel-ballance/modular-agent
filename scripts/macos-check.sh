#!/usr/bin/env bash
# Run from a fresh clone on an Apple silicon Mac. No sudo is needed.
set -uo pipefail

if [[ $(uname -s) != Darwin || $(uname -m) != arm64 ]]; then
  echo 'Run this script on Apple silicon in a native arm64 shell.' >&2
  exit 2
fi
missing=0
if ! command -v mise >/dev/null; then
  echo 'Install mise: https://mise.jdx.dev/getting-started.html' >&2
  missing=1
fi
if ! command -v node >/dev/null || ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)'; then
  echo 'Install Node.js 22 or later: https://nodejs.org/en/download' >&2
  missing=1
fi
if ! xcode-select -p >/dev/null 2>&1 || ! xcrun --find clang >/dev/null 2>&1; then
  echo 'Install the Xcode command line tools: xcode-select --install' >&2
  missing=1
fi
(( missing == 0 )) || exit 2

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$repo"
export TMPDIR="$HOME/.cache/ma-std-tmp"
mkdir -p "$TMPDIR" || exit 1
root=$(mktemp -d "$TMPDIR/macos-check.XXXXXX") || exit 1
logs=$root/logs
export HOME=$root/home TMPDIR=$root/tmp
mkdir -p "$logs" "$HOME" "$TMPDIR" || exit 1
# Do not use caller state, even when these locations have been overridden.
export XDG_CONFIG_HOME=$HOME/.config XDG_DATA_HOME=$HOME/.local/share
export XDG_CACHE_HOME=$HOME/.cache XDG_STATE_HOME=$HOME/.local/state
export MISE_CONFIG_DIR=$XDG_CONFIG_HOME/mise MISE_DATA_DIR=$XDG_DATA_HOME/mise
export MISE_CACHE_DIR=$XDG_CACHE_HOME/mise MISE_STATE_DIR=$XDG_STATE_HOME/mise
export RUSTUP_HOME=$HOME/.rustup CARGO_HOME=$HOME/.cargo
export npm_config_cache=$XDG_CACHE_HOME/npm GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME='macOS checks' GIT_COMMITTER_NAME='macOS checks'
export GIT_AUTHOR_EMAIL='checks@example.invalid' GIT_COMMITTER_EMAIL='checks@example.invalid'
# Strip inherited ma paths, plugins, test inputs and service configuration.
while IFS= read -r name; do
  case $name in MA_*|MODULAR_AGENT_*|CLAUDE_CONFIG_DIR) unset "$name" ;; esac
done < <(compgen -e)
trap 'rm -rf -- "$HOME" "$TMPDIR"' EXIT

failed=0
rows=()
step() {
  local name=$1; shift
  local log="$logs/${name//[^[:alnum:]]/_}.log" status
  printf '%s\n' "$name"
  if "$@" >"$log" 2>&1; then status=ok
  else status=FAIL; failed=1
  fi
  rows+=("$(printf '%-52s %-5s %s' "$name" "$status" "$log")")
}

step 'Kits: install Node dependencies' bash -c 'for kit in acp tools telemetry; do npm ci --silent --prefix "conformance/$kit" || exit; done'
step 'Rust: install toolchain and build ma and fixtures' bash -c 'cd rust && mise trust && mise install && mise exec -- cargo build --locked -p standard --bin ma && mise exec -- cargo build --locked -p agent-base -p sdk-scenarios'
step 'TypeScript: install dependencies and build ma' bash -c 'cd typescript && npm ci --silent && npm run build'

step 'Rust: workspace tests' bash -c 'cd rust && mise exec -- cargo test --locked --workspace --no-fail-fast -- --test-threads=1'
step 'TypeScript: tests' bash -c 'cd typescript && npm test'
step 'TypeScript: tests with remote parts' bash -c 'cd typescript && MA_REMOTE=provider-pi-ai,runtime-transient,tools-files,env-local npm test'
step 'TypeScript: Claude sidecar tests' bash -c 'cd typescript && npm test --workspace @modular-agent/claude'
step 'Rust: build history service' bash -c 'cd rust && mise exec -- cargo build --locked -p modular-agent --example history_service'
step 'Reference checks: both ma' env MODULAR_AGENT_REF_REQUIRE=all node conformance/reference/run.mjs --all

for language in rust typescript; do
  for group in core covered waiting; do
    step "ACP kit: $language $group" scripts/acp-kit.sh "$language" "$group"
  done
  step "ADR 0030 kits: $language ACP and history" scripts/production-kits.sh "$language"
done

printf '\n%-52s %-5s %s\n' Check Result Log
printf '%s\n' "${rows[@]}"
exit "$failed"

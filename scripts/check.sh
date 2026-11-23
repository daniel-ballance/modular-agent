#!/usr/bin/env bash
# Run the local checks. See CONTRIBUTING.md for the tools and how to start a long run.
#
#   scripts/check.sh [--quick] [--serial] [rust|typescript|go|python ...]
#   --quick    Builds, lint, SDK suites and cross-language checks; no binding kits.
#   --serial   Run one step at a time in the original order.
#
# With no language arguments, run all four. Cross-language checks need all four.
set -uo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo" || exit 1

quick=false
serial=false
languages=()
for arg in "$@"; do
  case "$arg" in
    --quick) quick=true ;;
    --serial) serial=true ;;
    rust|typescript|go|python)
      [[ " ${languages[*]} " == *" $arg "* ]] || languages+=("$arg") ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print } /^set / { exit }' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
[ ${#languages[@]} -eq 0 ] && languages=(rust typescript go python)
want() { [[ " ${languages[*]} " == *" $1 "* ]]; }
all=false; [ ${#languages[@]} -eq 4 ] && all=true

export TMPDIR="${TMPDIR:-$HOME/.cache/ma-std-tmp}"
mkdir -p "$TMPDIR" || exit 1
TMPDIR="$(cd "$TMPDIR" && pwd -P)"
logs="$(mktemp -d "$TMPDIR/check-XXXXXX")" || exit 1
printf 'Step logs: %s\n' "$logs"
start_run=$SECONDS

step() { # lane, name, command...
  local lane="$1" name="$2"; shift 2
  case "$lane" in
    setup|docs|shared) ;;
    *) want "$lane" || return 0 ;;
  esac
  [[ "$selection" == serial || "$selection" == "$lane" ]] || return 0
  local log="$logs/${name//[^A-Za-z0-9]/_}.log" start=$SECONDS
  if "$@" >"$log" 2>&1; then
    printf '[%s] %-58s ok    %4ss\n' "$lane" "$name" $((SECONDS - start))
  else
    printf '[%s] %-58s FAIL  %4ss  %s\n' "$lane" "$name" $((SECONDS - start)) "$log"
    printf '%s\t%s\n' "$name" "$log" >>"$logs/failed-$selection.tsv"
  fi
}

acp_kit() {
  local language="$1"
  local -a command
  mapfile -t command < <(node -e '
    const [repo, language] = process.argv.slice(1);
    for (const arg of require(`${repo}/conformance/reference/agents/${language}.json`).command)
      console.log(arg.replaceAll("{repo}", repo));
  ' "$repo" "$language")
  (cd conformance/acp && MODULAR_AGENT_CONFORMANCE=1 node run.mjs --crash-checks --probe-checks --job-checks -- "${command[@]}" --acp)
}

telemetry_kit() { # language, scope (empty for every placement)
  local language="$1" scope="$2"
  local -a adapter filters=()
  if [ -n "$scope" ]; then filters+=("$scope"); fi
  case "$language" in
    rust)
      if [ "$scope" != --peers ]; then
        (cd rust && mise exec -- cargo build -q -p sdk-scenarios --bin scenario-agent) || return
      fi
      adapter=("$repo/rust/target/debug/scenario-agent") ;;
    typescript) adapter=(node typescript/packages/fixtures/dist/src/scenario-agent.js) ;;
    go)
      if [ "$scope" != --peers ]; then
        (cd go && mise exec -- go test -c -o .bin/telemetry-scenarios ./modular/scenarios) || return
      fi
      adapter=(go/.bin/telemetry-scenarios -test.run=^TestTelemetryScenario$) ;;
    python) adapter=("$repo/python/.venv/bin/python" -m modular_agent._scenarios) ;;
  esac
  node conformance/telemetry/run.mjs "$language" "${filters[@]}" -- "${adapter[@]}"
}

# Language suites may discover peer fixture builds. Leave those placements for
# the shared phase, where all builds are ready and nobody is rewriting them.
only_lane_fixtures() {
  rust_shared=() go_shared=() ts_options="${NODE_OPTIONS:-}"
  if ! $serial; then
    rust_shared=(--skip served_by_every_sdk --skip services_from_other_sdks)
    go_shared=(-skip '^TestShared$')
    ts_options+=' --test-skip-pattern=/[(](process|service):(rust|go|python)[)]$/'
  fi
}

# The plan keeps the serial order. Each parallel worker follows only its own entries.
plan() {
  local selection="$1" runtime binding language label scope=--in-process telemetry_label=in-process
  local -a matrix_options=()
  if $serial; then
    matrix_options+=(--serial)
    if $all; then scope=; telemetry_label='every placement'; fi
  fi
  step setup "kits: npm ci (conformance/acp, conformance/tools)" bash -c 'npm ci --silent --prefix conformance/acp && npm ci --silent --prefix conformance/tools'
  if ! $quick; then
    step setup "kits: npm ci (conformance/telemetry)" npm ci --silent --prefix conformance/telemetry
  fi

  step rust "rust: build ma and fixture program" bash -c "cd rust && mise exec -- cargo build -q -p standard --bin ma && mise exec -- cargo build -q -p agent-base && mise exec -- cargo build -q -p sdk-scenarios --bin modular-agent-fixtures"
  step typescript "typescript: npm ci and build" bash -c "cd typescript && npm ci --silent && npm run -s build"
  step go "go: build ma and fixture program" bash -c "cd go && ./scripts/build-monty.sh && mise exec -- go build -o .bin/ma ./cmd/ma && mise exec -- go build -o .bin/modular ./cmd/modular && mise exec -- go build -o .bin/modular-agent-fixtures ./modular/cmd/fixtures"
  step python "python: uv sync" bash -c "cd python && uv sync --python 3.13 -q"

  step rust "rust: fmt and clippy" bash -c "cd rust && mise exec -- cargo fmt --all -- --check && mise exec -- cargo clippy -q --workspace --all-targets -- -D warnings"
  step go "go: vet and gofmt" bash -c 'cd go && mise exec -- go vet ./... && test -z "$(mise exec -- gofmt -l .)"'
  step python "python: ruff and strict mypy" bash -c "cd python && uv run --offline ruff check . && uv run --offline ruff format --check . && uv run --offline mypy"
  step docs "docs: relative links resolve" node scripts/check-links.mjs

  if $quick; then
    step rust "rust: SDK tests" bash -c "cd rust && mise exec -- cargo test -q -p modular-agent -p standard -- --test-threads=1"
    step typescript "typescript: tests" bash -c 'cd typescript && NODE_OPTIONS="$1" npm test' _ "$ts_options"
    step go "go: SDK and ma tests" bash -c 'cd go && mise exec -- go test -count=1 "$@" ./modular/... ./cmd/ma/...' _ "${go_shared[@]}"
    step python "python: tests (transient)" bash -c "cd python && uv run --offline pytest -q --runtime transient"
  else
    step rust "rust: workspace tests" bash -c 'cd rust && mise exec -- cargo test -q --workspace --no-fail-fast -- --test-threads=1 "$@"' _ "${rust_shared[@]}"
    step typescript "typescript: tests" bash -c 'cd typescript && NODE_OPTIONS="$1" npm test' _ "$ts_options"
    step typescript "typescript: tests with remote parts" bash -c 'cd typescript && NODE_OPTIONS="$1" MA_REMOTE=provider-pi-ai,runtime-transient,tools-files,env-local npm test' _ "$ts_options"
    step typescript "typescript: Claude sidecar tests" bash -c "cd typescript/sidecars/claude && npm ci --silent && npm test"
    step go "go: all tests" bash -c 'cd go && mise exec -- go test -count=1 "$@" ./...' _ "${go_shared[@]}"
    step go "go: race detector on SDK and ma" bash -c 'cd go && mise exec -- go test -race -count=1 "$@" ./modular/... ./cmd/ma/...' _ "${go_shared[@]}"
    for runtime in transient durable; do
      for binding in local process; do
        step python "python: tests ($runtime, $binding)" bash -c "cd python && uv run --offline pytest -q --runtime $runtime --binding $binding"
      done
    done
  fi

  if $all; then
    step shared "scenarios: Rust runner, every placement" bash -c "cd rust && MODULAR_AGENT_SDK_REQUIRE=all mise exec -- cargo test -q -p sdk-scenarios --test shared -- --test-threads=1"
    step shared "scenarios: TypeScript runner, every placement" bash -c "cd typescript && MODULAR_AGENT_SDK_REQUIRE=all node --test packages/fixtures/dist/test/shared.test.js"
    step shared "scenarios: Go runner, every placement" bash -c "cd go && MODULAR_AGENT_SDK_REQUIRE=all mise exec -- go test -count=1 ./modular/scenarios/"
    step shared "scenarios: Python runner, every placement" bash -c "cd python && MODULAR_AGENT_SDK_REQUIRE=all uv run --offline python -m modular_agent._scenarios"
    step shared "reference checks: all four ma" env MODULAR_AGENT_REF_REQUIRE=all node conformance/reference/run.mjs --all
    step shared "demo: project notes, including crash recovery" bash -c 'demos/project-notes/build.sh --sdk-built && demos/project-notes/run.py'
  fi

  if ! $quick; then
    for label in Rust TypeScript Go Python; do
      step "${label,,}" "telemetry: $label runner, $telemetry_label" telemetry_kit "${label,,}" "$scope"
    done
    step rust "rust: build history service example" bash -c "cd rust && mise exec -- cargo build -q -p modular-agent --example history_service"
    step go "go: build history service" bash -c "cd go && mise exec -- go build -o .bin/modular-service ./cmd/modular-service"
    for language in rust typescript go python; do
      step "$language" "ACP kit: $language ma (crash, probe, job checks)" acp_kit "$language"
      step "$language" "kits over WebSocket: $language plugin and ma" scripts/websocket-kits.sh "$language"
      step "$language" "ADR 0030 kits: $language ACP and history" scripts/production-kits.sh "$language"
    done
    if $all; then
      if ! $serial; then
        for label in Rust TypeScript Go Python; do
          step shared "telemetry: $label runner, peer placements" telemetry_kit "${label,,}" --peers
        done
      fi
      step shared "ADR 0030: erasure across languages (12 pairings)" scripts/erasure-matrix.sh "${matrix_options[@]}"
    fi
  fi
  return 0
}

only_lane_fixtures
failures=()
if $serial; then
  plan serial
else
  plan setup
  plan docs
  pids=()
  for language in "${languages[@]}"; do
    plan "$language" &
    pids+=("$!")
  done
  for i in "${!pids[@]}"; do
    if ! wait "${pids[i]}"; then failures+=("${languages[i]} lane stopped"); fi
  done
  plan shared
fi
if ! $all; then
  echo "(cross-language steps skipped: they need all four languages)"
fi
shopt -s nullglob
for results in "$logs"/failed-*.tsv; do
  while IFS=$'\t' read -r name log; do failures+=("$name"); done <"$results"
done

printf '\nWall time: %ss\n' "$((SECONDS - start_run))"
if [ ${#failures[@]} -eq 0 ]; then
  echo "All checks passed. Logs: $logs"
else
  echo "${#failures[@]} failed: ${failures[*]}"
  echo "Logs: $logs"
  exit 1
fi

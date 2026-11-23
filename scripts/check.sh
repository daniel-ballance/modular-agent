#!/usr/bin/env bash
# Every check this repository has, run locally. There is no hosted CI: run this before
# pushing. See CONTRIBUTING.md.
#
#   scripts/check.sh                 everything (about 45 minutes)
#   scripts/check.sh --quick         builds, lint, the SDK suites, the shared scenarios and
#                                    the reference checks; no full base suites or ACP kit runs
#   scripts/check.sh rust go         only those languages (cross-language steps still need
#                                    every language built)
#
# Needs Linux with unprivileged user, PID and mount namespaces, mise, Node.js 22+, uv.
set -uo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
export TMPDIR="${TMPDIR:-$HOME/.cache/ma-std-tmp}"
mkdir -p "$TMPDIR"
logs="$(mktemp -d "$TMPDIR/check-XXXXXX")"

quick=false
languages=()
for arg in "$@"; do
  case "$arg" in
    --quick) quick=true ;;
    rust|typescript|go|python) languages+=("$arg") ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
[ ${#languages[@]} -eq 0 ] && languages=(rust typescript go python)
want() { [[ " ${languages[*]} " == *" $1 "* ]]; }
all=false; [ ${#languages[@]} -eq 4 ] && all=true

failures=()
step() { # name, command...
  local name="$1"; shift
  local log="$logs/${name//[^A-Za-z0-9]/_}.log"
  printf '%-58s' "$name"
  local start=$SECONDS
  if "$@" >"$log" 2>&1; then
    printf 'ok    %4ss\n' $((SECONDS - start))
  else
    printf 'FAIL  %4ss  %s\n' $((SECONDS - start)) "$log"
    failures+=("$name")
  fi
}

# ---------- shared prerequisites ----------
step "kits: npm ci (conformance/acp, conformance/tools)" bash -c "cd conformance/acp && npm ci --silent && cd ../tools && npm ci --silent"

# ---------- builds ----------
want rust && step "rust: build ma and fixture program" bash -c "cd rust && mise exec -- cargo build -q -p standard --bin ma && mise exec -- cargo build -q -p agent-base && mise exec -- cargo build -q -p sdk-scenarios --bin modular-agent-fixtures"
want typescript && step "typescript: npm ci and build" bash -c "cd typescript && npm ci --silent && npm run -s build"
want go && step "go: build ma and fixture program" bash -c "cd go && ./scripts/build-monty.sh && mise exec -- go build -o .bin/ma ./cmd/ma && mise exec -- go build -o .bin/modular ./cmd/modular && mise exec -- go build -o .bin/modular-agent-fixtures ./modular/cmd/fixtures"
want python && step "python: uv sync" bash -c "cd python && uv sync --python 3.13 -q"

# ---------- lint and formatting ----------
want rust && step "rust: fmt and clippy" bash -c "cd rust && mise exec -- cargo fmt --all -- --check && mise exec -- cargo clippy -q --workspace --all-targets -- -D warnings"
want go && step "go: vet and gofmt" bash -c 'cd go && mise exec -- go vet ./... && test -z "$(mise exec -- gofmt -l .)"'
want python && step "python: ruff and strict mypy" bash -c "cd python && uv run --offline ruff check . && uv run --offline ruff format --check . && uv run --offline mypy"
step "docs: relative links resolve" node scripts/check-links.mjs

# ---------- suites ----------
if $quick; then
  want rust && step "rust: SDK tests" bash -c "cd rust && mise exec -- cargo test -q -p modular-agent -p standard -- --test-threads=1"
  want typescript && step "typescript: tests" bash -c "cd typescript && npm test"
  want go && step "go: SDK and ma tests" bash -c "cd go && mise exec -- go test -count=1 ./modular/... ./cmd/ma/..."
  want python && step "python: tests (transient)" bash -c "cd python && uv run --offline pytest -q --runtime transient"
else
  want rust && step "rust: workspace tests" bash -c "cd rust && mise exec -- cargo test -q --workspace --no-fail-fast -- --test-threads=1"
  want typescript && step "typescript: tests" bash -c "cd typescript && npm test"
  want typescript && step "typescript: tests with remote parts" bash -c "cd typescript && MA_REMOTE=provider-pi-ai,runtime-transient,tools-files,env-local npm test"
  want typescript && step "typescript: Claude sidecar tests" bash -c "cd typescript/sidecars/claude && npm ci --silent && npm test"
  want go && step "go: all tests" bash -c "cd go && mise exec -- go test -count=1 ./..."
  want go && step "go: race detector on SDK and ma" bash -c "cd go && mise exec -- go test -race -count=1 ./modular/... ./cmd/ma/..."
  for runtime in transient durable; do
    for binding in local process; do
      want python && step "python: tests ($runtime, $binding)" bash -c "cd python && uv run --offline pytest -q --runtime $runtime --binding $binding"
    done
  done
fi

# ---------- cross-language ----------
if $all; then
  export MODULAR_AGENT_SDK_REQUIRE=all MODULAR_AGENT_REF_REQUIRE=all
  step "scenarios: Rust runner, every placement" bash -c "cd rust && mise exec -- cargo test -q -p sdk-scenarios --test shared -- --test-threads=1"
  step "scenarios: TypeScript runner, every placement" bash -c "cd typescript && node --test packages/fixtures/dist/test/shared.test.js"
  step "scenarios: Go runner, every placement" bash -c "cd go && mise exec -- go test -count=1 ./modular/scenarios/"
  step "scenarios: Python runner, every placement" bash -c "cd python && uv run --offline python -m modular_agent._scenarios"
  step "reference checks: all four ma" node conformance/reference/run.mjs --all
  step "demo: project notes, including crash recovery" bash -c 'demos/project-notes/build.sh --sdk-built && demos/project-notes/run.py'
  unset MODULAR_AGENT_SDK_REQUIRE MODULAR_AGENT_REF_REQUIRE
else
  echo "(cross-language steps skipped: they need all four languages)"
fi

! $quick && want python && step "telemetry: Python runner, every placement" bash -c 'npm ci --silent --prefix conformance/telemetry && node conformance/telemetry/run.mjs python -- "$PWD/python/.venv/bin/python" -m modular_agent._scenarios'
# ---------- binding kits against each selected language ----------
if ! $quick; then
  want typescript && step "telemetry: TypeScript runner, every placement" bash -c "npm ci --silent --prefix conformance/telemetry && node conformance/telemetry/run.mjs typescript -- node typescript/packages/fixtures/dist/src/scenario-agent.js"
  want rust && step "rust: build history service example" bash -c "cd rust && mise exec -- cargo build -q -p modular-agent --example history_service"
  want rust && step "telemetry: Rust runner, every placement" bash -c 'npm ci --silent --prefix conformance/telemetry && (cd rust && mise exec -- cargo build -q -p sdk-scenarios --bin scenario-agent) && node conformance/telemetry/run.mjs rust -- "$PWD/rust/target/debug/scenario-agent"'
  want go && step "go: build history service" bash -c "cd go && mise exec -- go build -o .bin/modular-service ./cmd/modular-service"
  for language in rust typescript go python; do
    want "$language" || continue
    command=$(node -e "const a=require('./conformance/reference/agents/$language.json');console.log(a.command.map(x=>x.replaceAll('{repo}',process.argv[1])).join(' '))" "$repo")
    step "ACP kit: $language ma (crash, probe, job checks)" bash -c "cd conformance/acp && MODULAR_AGENT_CONFORMANCE=1 node run.mjs --crash-checks --probe-checks --job-checks -- $command --acp"
    step "kits over WebSocket: $language plugin and ma" scripts/websocket-kits.sh "$language"
    step "ADR 0030 kits: $language ACP and history" scripts/production-kits.sh "$language"
  done
  step "ADR 0030: erasure across languages (12 pairings)" scripts/erasure-matrix.sh
fi

echo
if [ ${#failures[@]} -eq 0 ]; then
  echo "All checks passed. Logs: $logs"
else
  echo "${#failures[@]} failed: ${failures[*]}"
  echo "Logs: $logs"
  exit 1
fi

# Progress

## Production edition 3

Target: production edition 3, including the question outcome clarification at `58928f0`. The kits include the late-question check at `5f07fac`.

Python now uses the configured stable ACP connection actor throughout the Interface. First receipts and erased reservations are scoped by submitter and attributed actor. Setup and join on open are recorded as operator grants, not self-grants. The shared record distinguishes an approval decline from an `allow` answer and a system closure from an actor answer.

A configured plugin startup failure stops the agent. The Provider sends the four response fields, and the host ignores unknown response callback members. A Runtime receives the committed result of a `tool.before` refusal. The host settles ineligible interrupted calls before handoff, records `modular-agent.stepAfter`, and restores the gate state from shared history. A Runtime reuses a committed decision, invokes a proven due gate, or refuses an unknown or mismatched checkpoint.

### Late questions with swapped Runtimes

The Python host commits `toolPending` before replying to `runToolCall`, so `step.after` can accept a step with an open call. The Runtime reports `completed` with the call in `openToolCalls` when leaving it open is why the turn ends. A later answer starts one linked continuation. The host no longer converts `limit: questions` to completion. It refuses the report and fails the turn. It also refuses open calls that disagree with the committed pending calls. A real step limit remains a limit. See G106 and the settled G107 in [GAPS.md](GAPS.md#production-edition-3).

Run from the repository root. The swap command uses TypeScript's served `provider,hooks` and selects each Runtime build and part in turn. All kits run one at a time.

```sh
export TMPDIR="$HOME/.cache/modular-agent-py-tmp" MA_OFFLINE_TEST=1
log="$TMPDIR/g107"
bash scripts/verify_round7.sh "$log/kits" self inbound
uv run --offline pytest -q --tb=short tests/test_plugin_binding.py \
  -k 'pending_tool_reply or continues_open_calls or turn_end_hook or cancellation'

cg="/sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/ma-g107-suite-$$"
mkdir "$cg"
export MA_CGROUP_ROOT="$cg"
for runtime in transient durable; do
  for placement in local process; do
    uv run --offline pytest -q --tb=short --runtime "$runtime" --binding "$placement" -k 'not kit'
  done
done
rmdir "$cg"
unset MA_CGROUP_ROOT
uv run --offline pytest -q --tb=short --runtime transient --binding local -k kit
```

| Runtime under the Python host | `runtime` | `durable-runtime` |
| --- | ---: | ---: |
| TypeScript | 190/190 | 190/190 |
| Elixir | 190/190 | 190/190 |
| Rust | 190/190 | 190/190 |

| Python kit | Checks passed |
| --- | ---: |
| Plugin | 139/139 |
| ACP with served `provider,hooks` | 207/207 |
| ACP adding served `durable-runtime` | 207/207 |
| ACP also adding served `tools,environment` | 207/207 |
| Portable transient | 152/152 |
| Portable durable | 153/153 |

The Rust swap uses the updated Runtime binary, which reports completion rather than a question limit. Earlier runs with the host workaround are in `$TMPDIR/late-step-after`.

The offline suite passed 298 tests in each of the four Runtime and placement combinations. The first durable process run timed out while shutting down the agent in the ACP parked-question test. The test passed on its own, and the full durable process rerun passed without a code change. The six embedded kit tests and the nine focused tests passed. Ruff lint, Ruff format and `git diff --check` passed.

The job-report checks skipped the parked disposition where reports start turns. The transient portable run also skipped queue execution after restart, as declared. No real inference was needed. Logs are in `$TMPDIR/g107`.

### Earlier verification commands

Run from the repository root. `verify_round7.sh` expands the commands for both Runtime C configurations, the Go Runtime E cell, the four F2 writer builds and the Python to Elixir F3 cell. It runs kits sequentially and uses a disposable history service for each portable cell. The script also runs the self kits, including portable runs with explicit Python Runtime flags. The ACP kit only forwards selected environment variables into its children, so the foreign agent commands in the portable cells may use their default Runtime.

```sh
export TMPDIR="$HOME/.cache/modular-agent-py-tmp" MA_OFFLINE_TEST=1
log="$TMPDIR/round7"
bash scripts/verify_round7.sh "$log/final" F3 F2 C E self
bash scripts/verify_round7.sh "$log/f3-recheck" F3

cg="/sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/ma-round7-units-$$"
mkdir "$cg"
export MA_CGROUP_ROOT="$cg"
for runtime in transient durable; do
  for placement in local process; do
    uv run --offline pytest -q --tb=short --runtime "$runtime" --binding "$placement" -k 'not kit'
  done
done
rmdir "$cg"
unset MA_CGROUP_ROOT
uv run --offline pytest -q --tb=short --runtime transient --binding local -k kit
```

The `not kit` suite passed 292 tests in each of the four Runtime and placement combinations. The six embedded kit tests passed in a separate invocation so that no kits ran at the same time. The durable runs were repeated after updating the old private question test to expect the normalized decline.

| Run | Checks passed |
| --- | ---: |
| Plugin kit against Python | 139/139 |
| ACP self, served `provider,hooks` | 206/206 |
| ACP self, adding served `durable-runtime` | 206/206 |
| ACP self, also adding served `tools,environment` | 206/206 |
| Portable self, transient | 152/152 |
| Portable self, durable | 153/153 |
| C, Elixir host with Python Provider and transient Runtime | 184/184 |
| C, Elixir host with Python Provider and durable Runtime | 184/184 |
| E, Go host with Python durable Runtime | 189/189 |
| F2, TypeScript, Rust, Go and Elixir writers reopened by Python | 152/152 each |
| F3, Python writer reopened by Elixir | 152/152 |

The first F3 run reached 143/146 before the approval decline fix. The F3 rerun in `f3-recheck` passed. An empty `MODULAR_AGENT_ACTOR` exited with status 1 and wrote no ACP reply.

The Python build is a history client, so the history service kit is not an agent-side test. No real inference was needed. See [GAPS.md](GAPS.md#production-edition-3) for the findings and the earlier questions this edition settled.

## Production edition 2

Target: `docs/SNAPSHOT` at `f59d2a8`. The tested composition speaks ACP
`/1` and `/2`, plugin `/1` as both host and served plugin, and history
HTTP `/1` as a client. Portable sessions, HTTP forking, rewind, keyed
inputs, approval, late text answers and job reports remain enabled.
Durable and transient recovery keep their distinct declarations. No
history service role or production deployment certification is claimed.

The HTTP client validates bounded lease values, measures the initial fork
batch before PUT and relays a retryable restart hold. Linux uses
`CLOCK_BOOTTIME`; a platform without it requires
`MODULAR_AGENT_HISTORY_LEASE_MARGIN_MS`. Rewind checks each required point
before saving or restoring. ACP checks for cancellation authority at
close, computes question eligibility after recipient gating and measures
history pages in the encoding it sends. The Provider callback commits the
transformed request before allowing a plugin to infer. Model recovery uses
recorded requests when safe, skips settled calls and keeps empty failed
and aborted responses out of model context. Refused turn results leave
feedback for the next attempt, not future turns. Job report delivery and
job wait now share one scheduling handoff, so they cannot consume the
same admission twice in a process Runtime. Durable recovery uses that
same handoff on reopen. Cancellation now observes an in-flight history
commit before releasing the writer slot. The Harness checks that a
question is still open at commit so concurrent answers cannot both win.

The Haiku 5.5 recovery demonstration passed after the recovery changes.
It killed the agent during `bash`, reopened the same turn, kept the
interrupted call as `outcome_unknown` and used `read` to find
`M2-RECOVERED-5831`. The report is in
`/var/tmp/ma-ed2-final.yzH1SB/live/summary.json`.

### Verification

| Kit | Checks passed |
| --- | ---: |
| Plugin | 139/139 |
| Local ACP with served `provider,hooks` | 199/199 |
| Local ACP adding served `durable-runtime` | 199/199 |
| Local ACP adding served `tools,environment` too | 199/199 |
| Portable ACP, transient | 150/150 |
| Portable ACP, durable | 151/151 |

All four suites passed 290 tests each, with no skips. Both suites and
kits were verified at code commit `8cbc2ed`. Earlier runs exposed the
process scheduling and question acceptance races, and occasional point
and heartbeat probe failures. The final logs are in
`/var/tmp/ma8.zz8Nq2/latest`.

The kit skips the parked-report check because reports start turns. It also
skips the recovered-queue execution assertion for the transient Runtime,
which hands back queued input on reopen.

Run from the repository root. The verification script starts a fresh
`/tmp/ma-tools/history-service/serve.mjs` for each portable run. Its
`UPDATED` marker names TypeScript build `f161432`.

```sh
log=/var/tmp/ma8.zz8Nq2/latest
export TMPDIR=/var/tmp/ma8lt.7qlC4R
bash scripts/verify_round6.sh "$log" kits
for r in transient durable; do
  bash scripts/verify_round6.sh "$log" suite "$r" local
done
for r in durable transient; do
  bash scripts/verify_round6.sh "$log" suite "$r" process
done
```

```sh
log=/var/tmp/ma-ed2-final.yzH1SB
env -u MA_OFFLINE_TEST -u MODULAR_AGENT_CONFORMANCE -u ANTHROPIC_API_KEY \
  TMPDIR="$log/temp" uv run --offline python scripts/milestone2_live.py \
  --confirm-live --output "$log/live"
uv run --offline ruff check .
uv run --offline ruff format --check .
bash -n scripts/verify_round6.sh
git diff --check
```

This matrix does not cover deployment-wide erasure, staged secrets,
independent principal configuration, cross-build swaps or all malformed
portable history. See [GAPS.md](GAPS.md#production-edition-2) for the new
approval-route finding and the previous findings settled in this edition.

## Production edition

Target: specification snapshot `1ad258f`, shared data and plugin `/1`,
ACP `/1` and `/2`, history HTTP client `/1`. This is a migration in
progress, not a production conformance claim.

1. The Harness now commits the turn start and first taken input in a
   single batch before Runtime work. The offline test covers both a good
   commit and a rejected batch that never reaches the Provider. A
   reopener no longer manufactures a missing first input for an
   interrupted admission-driven turn.
2. The history HTTP client reads ordered pages, requires numeric loopback
   for plaintext and checks a suspend-aware local lease cutoff on Linux.
   A late successful renewal cannot restore writer authority. The Harness
   closes the effect path on failed commits or lease loss. The portable
   verification was rerun after the service published its `UPDATED` marker.
3. ACP negotiates both versions, includes configured actor rights, refuses
   implicit representation after join, checks quiescent move targets, pages
   history and gates the load reply before replay. SQLite no longer restores
   transient closing or moving flags from disk. The supplied full local kit
   passes all 192 checks in each requested local composition. This does
   not establish validation of all ACP messages or independent principal
   and tenant isolation.
4. The plugin host now checks framing and call scope, latches host limits,
   records the offered tool names and commits the checked tool result
   before acknowledging dispatch. A failed catalog refresh keeps the
   triggering result and stops use of the invalidated catalog.
5. The served plugin passes all 133 checks for the fixture roles and both
   Runtimes. Runtime retries use fresh attempts, record failure first and
   do the final steering check. The transport regression checks parse
   errors, CRLF and reuse of a settled id.
6. The portable reader folds recorded departures and handles paged
   history and legacy hand-backs. HTTP forks without a guaranteed lease
   bound fail preflight before creating the destination. ACP declares
   `forking: false` with HTTP history and leaves local fork support in place.
   Full portable validation and exact interrupted model replay are not complete.
7. ACP refuses unconfigured representation and keeps narrower stored
   grants on reopen. This build does not yet supply a production
   multi-principal deployment profile.
8. Job reports are committed with their terminal job record. A plugin
   connection cannot resume the same job twice. Rewind records intent
   before file changes, then completion or a compensating restore. Erased
   keyed input keeps a content-free reservation.
9. Production acceptance is not claimed; see remaining failures below.

Real run: `env -u MA_OFFLINE_TEST -u MODULAR_AGENT_CONFORMANCE -u ANTHROPIC_API_KEY
uv run --offline python scripts/milestone2_live.py --confirm-live
--output /tmp/ma-r7-live.yslBpr/artifacts` passed with local Claude Code and
`claude-haiku-5-5`. The driver killed the agent by PID during `bash`,
reopened with the durable Runtime, and observed one `outcome_unknown`
followed by a completed `read` and the answer `M2-RECOVERED-5831`.
See `/tmp/ma-r7-live.yslBpr/artifacts/summary.json`. A separate short turn
used `read` before answering `R7-READ-67135`. Its JSON log is
`/tmp/ma-r7-live.yslBpr/read.jsonl`.

### Checkpoint verification

Run from the repository root:

```sh
bash scripts/verify_round6.sh /tmp/ma-r7-updated.dRNvQO kits
for runtime in transient durable; do
  for binding in local process; do
    bash scripts/verify_round6.sh /tmp/ma-r7-checkpoint.RML5sb suite "$runtime" "$binding"
    uv run --offline pytest -q tests/test_production_*.py --runtime "$runtime" --binding "$binding"
  done
done
```

The plugin kit passed 133/133. Local ACP passed 192/192 with
`provider,hooks`, 192/192 adding `durable-runtime`, and 192/192 also
adding `tools,environment`. Both HTTP runs passed 142/143 after the
service update. The remaining check attempts to close a seeded session
containing an unfinished job as an actor without `cancel`. The agent
refuses it, as required. The failure skips the rest of that attempt,
including the queue check. See G98. The earlier runs with HTTP forking
still advertised also passed the oversized-fork no-write probe.

All eight new production regression cases pass in each configuration.
The full runs at the checkpoint were:

| Runtime | Plugin placement | Passed | Failed |
| --- | --- | ---: | ---: |
| Transient | Local | 286 | 4 |
| Transient | Process | 283 | 7 |
| Durable | Local | 282 | 8 |
| Durable | Process | 282 | 8 |

The remaining failures cover ACP diagnostic gating, older late-approval
and close-time report expectations, and recovery of interrupted model
attempts, tool work, questions and child jobs. Process runs also saw a
background child timeout and one embedded plugin kit failure. The
standalone plugin kit passed. The failure names and traces are in the
suite logs. Do not enable this checkpoint where policy requires all
recipient diagnostics to pass the output gate.

This checkpoint does not certify production use. Outstanding work
includes exact interrupted model replay, late continuation without an
ordinary input admission, complete shared record validation and
recipient projection, multi-principal configuration, secret answer
staging, and coordinated erasure across agents. There was no
independent-build swap in this checkout. See [GAPS.md](GAPS.md#production-edition)
for the specification and fixture findings.

Baseline logs: `/tmp/ma-r7-baseline.7LyeUw`. The previous implementation
against the new kits passed 75/100 plugin checks, 99/142 on each local
ACP composition and 113/137 in portable transient mode. The first
transient/local suite had 276 passing tests and 6 failures with embedded
kit checks or revised fixture expectations. See the production section
in `GAPS.md` for rule and fixture issues, not a list of Python bugs.

## Round six

ACP declares session limits and tenants. Tenant selection and the session's
first record survive reopening. Effective authority narrows work when the
ceiling changes, including tool calls from a turn already in progress. Tenant
usage is counted across sessions, and exhausted turns return `tenantTokens`
without sending a model request. ACP lists and withdraws proposals, returns
`handedBack` for a declined release, and honors presence on `join`.

Remote output gates get shared event shapes and whole model and tool streams.
The conformance gate redacts a split secret without dropping the rest of the
stream. A blocked ACP reply returns `withheld` without undoing the request.
The host refuses duplicate plugin names before installing a registration.
Rewind saves and restores a rollback point when a history write fails and
reports open-world calls whose effects could not be undone. Job starts keep
the job's rights; job end accepts the report without waiting for its turn.
Reasoning only goes down to a level the selected model can use. The hosted
Runtime gives cancellation precedence over a failed callback, and a history
page can still return its first entry when only the cursor would exceed the cap.

Offline regressions are in `tests/test_round6.py` and the existing binding test
files. The verification commands are in `scripts/verify_round6.sh`. Run them
from the repository root with the pinned Python environment and the ACP kit's
Node dependencies. No real model runs were used. Neither `docs/` nor the kits
changed. See [Round six in GAPS.md](GAPS.md#round-six) for the binding
ambiguities and kit assertions. The next step is the cross-build swap matrix.

| Verification | Result |
| --- | --- |
| Plugin kit | 111/111 |
| Local ACP with served `provider,hooks` | 129/129 |
| Local ACP adding served `durable-runtime` | 129/129 |
| Local ACP adding served `tools,environment` too | 129/129 |
| Portable ACP, transient Runtime | 101/101 |
| Portable ACP, durable Runtime | 101/101 |
| Transient suite, local and process plugins | 282 passed each |
| Durable suite, local plugins | 282 passed |
| Durable suite, process plugins | 282 passed on isolated rerun |

The verification logs are in `/tmp/ma-r6-verified.FtrQNJ/`. The parallel
Durable/process suite failed one kit assertion about background processes.
The same kit then observed that the supposedly stopped process was still
running. See G87. The passing rerun is in `/tmp/ma-r6-durable-rerun.TjoKfs/`.
The earlier runs also caught an old fixture with two plugins of the same name
and a history conversion that blocked an otherwise valid redaction. Both were
fixed before the passing verification.

```sh
# From the repository root. The script uses absolute agent and plugin paths.
log=/tmp/ma-r6-verified.FtrQNJ
bash scripts/verify_round6.sh "$log" kits
for runtime in transient durable; do
  for binding in local process; do
    bash scripts/verify_round6.sh "$log" suite "$runtime" "$binding"
  done
done
bash scripts/verify_round6.sh /tmp/ma-r6-durable-rerun.TjoKfs suite durable process
```

Ruff lint, Ruff format, `bash -n scripts/verify_round6.sh` and `git diff --check`
all pass.

## After the round-five matrices

Job reports now pass the stored result through unchanged. A foreign job start
does not carry the old Python flag that selected the unframed path. That flag
is gone, so native and foreign jobs use the same path. Shared `turnStart`
entries use `data.startedBy` instead of the internal `data.source`.

The foreign-session regression reopens shared history with an unfinished
`conformance-jobs` job and runs the kit's jobs plugin. Before the fix, Echo
returned the extra framing. Now it returns
`echo: background: kit-survivor (taken up)`. The test also checks that
`jobEnded` comes before the report, the report matches the result, and
`startedBy` names the job.

| Check | Result |
| --- | --- |
| Transient suite, local and process plugins | 271 passed each |
| Durable suite, local and process plugins | 271 passed each |
| Plugin kit | 109/109 |
| Local ACP with the served `provider,hooks` plugin | 109/109 |
| Portable ACP with transient and durable runtimes | 86/86 each |
| Foreign-session regression on its own | 1 passed |

The first durable/process run failed
`test_cancel_during_request_send_still_cancels_remote_work` because the cleanup
file was missing. That test passed on its own, and all 271 passed on an
isolated rerun. Logs are in `/tmp/ma-job-report-verify.lqSL2b/`. No real model
runs and no new gaps.

From the repository root:

```sh
export MA_OFFLINE_TEST=1
agent="$PWD/.venv/bin/modular-agent"
plugin="$PWD/.venv/bin/modular-agent-plugin"
node conformance/plugin/run.mjs -- "$plugin"

(cd conformance/acp
 MODULAR_AGENT_PLUGINS=$(jq -cn --arg plugin "$plugin" \
   '[{command:[$plugin],env:{MODULAR_AGENT_PLUGIN_PARTS:"provider,hooks"}}]') \
   node run.mjs --crash-checks --plugin-checks --probe-checks --job-checks -- \
   "$agent" --mode acp --process-plugins '')

# For each runtime, start a fresh /tmp/ma-tools/history-service/serve.mjs
# as below and export MODULAR_AGENT_HISTORY_URL and MODULAR_AGENT_HISTORY_TOKEN_FILE.
# Set r to transient or durable.
(cd conformance/acp
 node run.mjs --crash-checks --portable-checks --job-checks -- \
   "$agent" --mode acp --runtime "$r" --process-plugins '' \
   --then "$agent" --mode acp --runtime "$r" --process-plugins '')

# Use a separate delegated cgroup per suite, as in the round-five loop below.
MA_CGROUP_ROOT="$group" uv run --offline pytest -q --tb=short --runtime "$r" --binding "$b"
uv run --offline pytest -q --tb=short tests/test_round5.py::test_foreign_job_report_runs_as_a_turn
```

## Round five

ACP now negotiates `/1` and `/2`. The connection can enroll actors, act for
actors with shared rights, and release or decline proposed input. The local
and served working environments support file snapshots and the host restores
points before moving the branch. External hooks can gate each completed output
stream. The host records and routes plugin jobs, including cancellation and
resumption. The history and Runtime read the shared admission, model request,
job, question, setting and erasure records. New coverage lives in
`tests/test_round5.py` and the existing binding regressions.

The plugin kit reported 109/109. Each local ACP composition reported 109/109:
served `provider,hooks`, adding served `durable-runtime`, then adding served
`tools,environment`. Portable ACP reported 85/85 with each Runtime and a fresh
history service. The tests and kits ran offline. There were no real model runs.
Logs for these kit runs are `/tmp/ma-r5-verified-*.log`.

From the repository root, with the existing venv and ACP kit dependencies:

```sh
agent="$PWD/.venv/bin/modular-agent"
plugin="$PWD/.venv/bin/modular-agent-plugin"
node conformance/plugin/run.mjs -- "$plugin"

base='[{"command":["'"$plugin"'"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"provider,hooks"}}'
durable=',{"command":["'"$plugin"'"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"durable-runtime"}}'
tools=',{"command":["'"$plugin"'"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"tools,environment"}}'
(cd conformance/acp
 for plugins in "$base]" "$base$durable]" "$base$durable$tools]"; do
   MODULAR_AGENT_PLUGINS="$plugins" node run.mjs \
     --crash-checks --plugin-checks --probe-checks --job-checks -- \
     "$agent" --mode acp --process-plugins ''
 done)

for r in transient durable; do (
  set -e
  work=$(mktemp -d /tmp/ma-r5-serve.XXXXXX)
  mkdir "$work/history"
  token=$(openssl rand -hex 24)
  (umask 077; printf '%s\n' "$token" > "$work/token")
  node /tmp/ma-tools/history-service/serve.mjs \
    "$(jq -cn --arg dir "$work/history" --arg token "$token" '{dir:$dir,token:$token,leaseMs:15000}')" \
    >"$work/service.log" 2>&1 &
  pid=$!
  trap 'kill "$pid" 2>/dev/null || true; wait "$pid" || true' EXIT
  for i in $(seq 1 50); do
    if [ -s "$work/service.log" ]; then break; fi
    sleep .1
  done
  url=$(jq -r .url "$work/service.log")
  cd conformance/acp
  MODULAR_AGENT_HISTORY_URL="$url" MODULAR_AGENT_HISTORY_TOKEN_FILE="$work/token" \
    node run.mjs --crash-checks --portable-checks --job-checks -- \
    "$agent" --mode acp --runtime "$r" --process-plugins '' \
    --then "$agent" --mode acp --runtime "$r" --process-plugins ''
); done
```

Each of the four full suites passed 270 tests: transient and durable,
with local and process plugins. Logs are in `/tmp/ma-r5-matrix.pOA9mo/`.
Earlier overlapping runs on the same delegated cgroup root interfered with
crash cleanup tests. The passing runs used one delegated cgroup per suite:

```sh
cg=${MA_CGROUP_ROOT:-/sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service}
for r in transient durable; do
  for b in local process; do (
    group="$cg/ma-round-five-$$-$r-$b"
    mkdir "$group" || exit
    trap 'rmdir "$group"' EXIT
    MA_CGROUP_ROOT="$group" uv run --offline pytest -q --tb=short --runtime "$r" --binding "$b"
  ); done
done
```

The output redaction kit can pass without detecting a missed split secret.
The portable ACP checker skips erased entries. See the round-five section of
`GAPS.md` for those observations and the rewind and job ownership limits.

## After the portable-session and Runtime swaps

ACP joins its connection's host actor before replay and recovery. Reopening
keeps earlier actors and does not add a second join for the same rights. The
public `turn.end` hook carries the same `outcome` and `result` objects as the
`turnEnd` entry. The Harness uses the shared rights names, and a started call
blocked from running again gets `outcomeUnknown`, not `refused`. A shared-shape
fixture covers foreign actor load and resume. Native and served durable Runtime
regressions check both outcome payloads and replay with and without `tools`.

The log and exact matrix script are in `/tmp/ma-round5.BqZkYO/`. From the repo
root with the existing Python environment and ACP kit dependencies installed:

```sh
agent="$PWD/.venv/bin/modular-agent"
plugin="$PWD/.venv/bin/modular-agent-plugin"
unset MODULAR_AGENT_PLUGINS MODULAR_AGENT_HISTORY_URL MODULAR_AGENT_HISTORY_TOKEN_FILE MA_PLUGIN_PROCESSES
node conformance/plugin/run.mjs -- "$plugin"

base='[{"command":["'"$plugin"'"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"provider,hooks"}}'
durable=',{"command":["'"$plugin"'"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"durable-runtime"}}'
tools=',{"command":["'"$plugin"'"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"tools,environment"}}'
(cd conformance/acp
 for plugins in "$base]" "$base$durable]" "$base$tools]" "$base$durable$tools]"; do
   MODULAR_AGENT_PLUGINS="$plugins" node run.mjs \
     --crash-checks --plugin-checks --probe-checks -- "$agent" --mode acp --process-plugins ''
 done)

# Start a fresh history service for each r in durable transient. Supply an
# absolute MA_HISTORY_DATA and a private MODULAR_AGENT_HISTORY_TOKEN_FILE.
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  process.argv[2] = JSON.stringify({ dir: process.env.MA_HISTORY_DATA,
    token: readFileSync(process.env.MODULAR_AGENT_HISTORY_TOKEN_FILE, "utf8").trim(), leaseMs: 1500 });
  await import("/tmp/ma-tools/history-service/serve.mjs");
'
# With MODULAR_AGENT_HISTORY_URL exported from the service JSON and the token
# file exported, run for that r, then stop the service by its PID:
(cd conformance/acp
 node run.mjs --crash-checks --portable-checks \
   -- "$agent" --mode acp --process-plugins '' --runtime "$r" \
   --then "$agent" --mode acp --process-plugins '' --runtime "$r")

unset MODULAR_AGENT_HISTORY_URL MODULAR_AGENT_HISTORY_TOKEN_FILE
for binding in local process; do
  for runtime in transient durable; do
    uv run --offline pytest -q --tb=short --runtime "$runtime" --binding "$binding"
  done
done
uv run --offline ruff check .
uv run --offline ruff format --check .
git diff --check
```

The plugin kit passed 105/105. The ACP crash, plugin and probe checks passed
73/73 in each of the four placements above. The two-process history service
checks passed 51/51 in each Runtime. The offline suite passed 265 tests in each
of the four Runtime and placement combinations. The first local durable run
found one test still expecting `refused` after a fresh gate blocks a repeat.
The assertion was updated for the refreshed binding. Its full rerun used the
same command and passed. Lint, formatting and diff checks passed.

A replay of the supervisor's original records showed that ACP history was
still exposing the private actor kind names, even though the store had the
right entries. The follow-up uses the shared encoding for those entries. It
passed 17 focused checks and reopened all four supplied histories, once with
each Runtime. Earlier actors stayed unchanged. In the interrupted histories,
the durable Runtime completed the turn, the transient Runtime ended it as
failed, and both kept exactly one `outcomeUnknown` for the bash call. The
follow-up kit logs are in `/tmp/ma-round5-final.NIopFn/`.

```sh
uv run --offline pytest -q --tb=short tests/test_round4_portable.py tests/test_acp_binding.py
uv run --offline python /tmp/ma-round5.BqZkYO/replay-evidence.py
```

No real inference was run, no other build's code was read, and the kits and
description snapshot were not changed. G75 to G77 describe the remaining
binding gaps. The next step is the supervisor's cross-language rerun.

## Round four: revised bindings and portable sessions

The public plugin host and served plugin follow the round-four handshake,
callback scope, paging, cancellation and environment lifetime rules. The host
owns the live model stream and the start and end of a turn. The public durable
Runtime reads standard entries over `host/history`; it does not need a Python
checkpoint. It records tools in completion order and the host builds model
context in call order. Both SQLite and the HTTP client write shared entry
shapes. The ACP declaration includes `portableSessions: true`.

Use `MODULAR_AGENT_HISTORY_URL` and `MODULAR_AGENT_HISTORY_TOKEN_FILE` to
select HTTP history. Do not pass a token on the command line. The writer renews
its lease, releases it on close and waits for a killed writer's lease to expire
before reopening. The supplied service omits `retryAfterMs`, so the client
polls within the advertised TTL when that field is missing. This is G66.
G67 through G74 record the remaining swap limits. No kit or snapshot was changed.

### Commands and results

From the repository root, after `uv sync --offline --python 3.13` and
`(cd conformance/acp && npm ci)`:

```sh
agent="$PWD/.venv/bin/modular-agent"
plugin="$PWD/.venv/bin/modular-agent-plugin"
node conformance/plugin/run.mjs -- "$plugin"

base='[{"command":["'"$plugin"'"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"provider,hooks"}}'
(cd conformance/acp
 MODULAR_AGENT_PLUGINS="$base]" \
   node run.mjs --crash-checks --plugin-checks --probe-checks -- "$agent" --mode acp
 MODULAR_AGENT_PLUGINS="$base,{\"command\":[\"$plugin\"],\"env\":{\"MODULAR_AGENT_PLUGIN_PARTS\":\"durable-runtime\"}}]" \
   node run.mjs --crash-checks --plugin-checks --probe-checks -- "$agent" --mode acp)

# With MODULAR_AGENT_HISTORY_URL and MODULAR_AGENT_HISTORY_TOKEN_FILE exported:
(cd conformance/acp
 for r in transient durable; do
   node run.mjs --crash-checks --portable-checks -- "$agent" --mode acp --runtime "$r" \
     --then "$agent" --mode acp --runtime "$r"
 done)

for binding in local process; do
  for runtime in transient durable; do
    uv run --offline pytest -q --tb=short --runtime "$runtime" --binding "$binding"
  done
done
```

Plugin: 105/105. ACP with local history and the provider and hooks plugin:
73/73 with the native transient Runtime and 73/73 with the external durable
Runtime. ACP with remote history and two processes: 51/51 for transient and
51/51 for durable. The offline suite passed 258 tests in each of the four
Runtime and placement combinations (1,032 passing executions, no skips).
The first local durable run exposed fixtures that did not set the new shared
repeat promise. After updating them, the full local durable run passed. The
first process durable run timed out during teardown of the ACP bootstrap
cancellation test; the full rerun passed without another code change.
Full logs are in `/tmp/ma-round4/`. The plugin kit seeds recovery with standard
history, and the offline tests also reopen a foreign standard record without
native entries.

### Haiku crash recovery on the history service

```sh
uv run --offline python scripts/round4_live.py --confirm-live --output /tmp/ma-round4/live-verified
```

This used only `claude-haiku-5-5` through the local Claude Code subscription.
In session `a34896b437474b40823e2aca7b4d34d5`, it read `proof.txt` and answered
`ROUND4-PORTABLE-FILE-7351`. In the next turn bash wrote its PID and slept.
The driver ran `kill -9 2365322` while bash PID 2365506 was running and verified
that bash stopped. A new durable process, PID 2365509, waited for the lease,
recorded exactly one `outcomeUnknown` for bash, did not rerun it and completed
the turn with the file text. The JSON evidence is in `/tmp/ma-round4/live-verified/`.
An initial run completed recovery but the driver waited on a regular stdin
file that the terminal could not poll. The proof driver now uses a closed pipe.

## After the Runtime matrix: turn-scoped history

The Python Harness now answers `host/history` during an external Runtime turn.
It uses the active `parentRequestId`, the turn's session and the turn's effective
`watch` authority. The existing raw reader serves the current branch by default,
or every branch with `all`, and keeps the same entry and byte page limits.
`host/runtime/*` still handles turn operations; other callbacks remain unavailable
under that parent.

Two offline regression cases reopen a persisted interrupted turn using a new
external Runtime process. `runtime/resumeTurn` reads the raw input one page at a
time, checks the branch and all-history views, and rejects invalid parents,
a mismatched session and unrelated callbacks. A turn whose input authority lacks
`watch` cannot read history. Before the fix, the authorized case failed with
`A Runtime turn can only call host/runtime/*`.

### Reproduce the checks

From the repository root after `uv sync --offline --python 3.13` and
`(cd conformance/acp && npm ci)`:

```sh
plugin="$PWD/.venv/bin/modular-agent-plugin"
agent="$PWD/.venv/bin/modular-agent"
uv run --offline pytest -q tests/test_plugin_binding.py -k reads_history_on_resume
node conformance/plugin/run.mjs -- "$plugin"
for part in runtime durable-runtime; do
  plugins=$(printf '[{"command":["%s"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"%s"}}]' "$plugin" "$part")
  MODULAR_AGENT_PLUGINS="$plugins" node conformance/acp/run.mjs \
    --crash-checks -- "$agent" --mode acp --process-plugins ''
done
parts=$(printf '[{"command":["%s"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"provider,hooks"}},{"command":["%s"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"tools,environment"}}]' "$plugin" "$plugin")
MODULAR_AGENT_PLUGINS="$parts" node conformance/acp/run.mjs \
  --plugin-checks -- "$agent" --mode acp --process-plugins ''
for binding in local process; do
  for runtime in transient durable; do
    uv run --offline pytest -q --runtime "$runtime" --binding "$binding"
  done
done
```

### Verification

| Kit | Result |
|---|---|
| Plugin | 84/84 |
| ACP `--crash-checks`, separate Python transient Runtime | 49/49 |
| ACP `--crash-checks`, separate Python durable Runtime | 49/49 |
| ACP `--plugin-checks`, split Provider/hooks and tools/environment | 46/46 |

Each crash run killed the agent with SIGKILL during a started bash call. The
command did not finish or run again, and there was exactly one unknown result.
The transient turn failed after reopening; the durable turn carried on and
completed.

The whole suite passed sequentially in all four configurations: 256
local/transient (83.66 s), 256 local/durable (84.01 s), 256 private-process/transient
(214.13 s) and 256 private-process/durable (201.67 s). That is 1,024 passing test
executions with no skips or retries. Ruff, formatting, lock and diff checks
passed. No test processes or command cgroups remained. Logs, including the red
and green regression and the cancellation probe, are in `/tmp/ma-runtime-history/`.

All runs were offline. No other build, real inference, credentials, coding
subagents or T3 Code settings were used. Frozen docs and kit sources are unchanged.

G58 records the now-available history read and the remaining recovery record
portability gap. G61 notes the still-open standard events mismatch. G64 records
an unanswered cancellation before callback dispatch (in-flight cancellation
replies correctly); G65 records the explicit Runtime replacement requirement.
These separate issues were not changed in the history correction.

The assigned correction is complete. The supervisor can rerun the affected swap
cell. The Stage 2 and earlier results below are historical.

## Stage 2: public Runtime binding

The conformance plugin serves `runtime` (transient) and `durable-runtime`, one
at a time. The public turn port uses only `host/runtime/*`. It shares the native
ordered tool-round executor, and keeps recovery information in the host journal,
not a file or memory retained by the plugin. The default serve parts are still
`provider,tools,environment,hooks`.

An external Runtime replaces the local turn runner. The Harness owns admission,
session lifecycle, actor authority, model selection, effects, gated output and
history. Each callback is scoped to the active turn by `parentRequestId`. On
reopening an interrupted turn the new plugin process receives `runtime/resumeTurn`.
Answered open calls use `runtime/continueOpenCalls`. The ACP history view exposes
assistant tool call parts and shared result status codes for both placements.

### Commands

After `uv sync --offline --python 3.13` and ACP kit dependency installation
(`cd conformance/acp && npm ci`), run from the repository root:

```sh
repo=/home/danballance/Code/modular-agent-py
plugin="$repo/.venv/bin/modular-agent-plugin"
agent="$repo/.venv/bin/modular-agent"
node conformance/plugin/run.mjs -- "$plugin"
node conformance/acp/run.mjs --crash-checks -- "$agent" --mode acp --process-plugins ''
runtime=$(printf '[{"command":["%s"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"durable-runtime"}}]' "$plugin")
MODULAR_AGENT_PLUGINS="$runtime" node conformance/acp/run.mjs --crash-checks -- "$agent" --mode acp --process-plugins ''
parts=$(printf '[{"command":["%s"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"provider,hooks"}},{"command":["%s"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"tools,environment"}}]' "$plugin" "$plugin")
MODULAR_AGENT_PLUGINS="$parts" node conformance/acp/run.mjs --plugin-checks -- "$agent" --mode acp --process-plugins ''
```

The standalone commands for the supervisor are the absolute `$plugin` and
`$agent --mode acp --process-plugins ''` above. Set `MODULAR_AGENT_PLUGIN_PARTS`
to `runtime` or `durable-runtime` in the Runtime subprocess environment.
Run the suite with `uv run --offline pytest -q`, or select `--runtime transient`
or `--runtime durable` and `--binding local` or `--binding process`. Run the
configurations sequentially. The suite includes both kits, each crash placement,
and a parked tool call completed in a new turn through the public Runtime.

G58 to G63 under **Bindings** record the missing portable restart checkpoint,
admission ownership, gate/end ordering, report event names, ordered publication
versus immediate receipts, and operations and settings outside this binding.
### Final verification

| Kit | Result |
|---|---|
| Plugin, including both Runtime variants | 84/84 |
| ACP `--crash-checks`, native transient | 49/49 |
| ACP `--crash-checks`, public durable Runtime in a separate process | 49/49 |
| ACP `--plugin-checks`, split Provider/hooks and tools/environment | 46/46 |

Both crash runs killed the agent during a started bash call. It did not finish
or run again, and both placements recorded exactly one unknown result. The
native transient turn ended as failed. The public durable one carried on and
completed. The first external ACP crash run passed 46/49: the ACP history view
omitted tool call parts and the shared status code needed to correlate results.
The final run used the corrected view.

The sequential whole suite passed in every configuration: 254 local/transient
(87.16 s), 254 local/durable (89.15 s), 254 private-process/transient (209.51 s)
and 254 private-process/durable (217.10 s). That is 1,016 passing test
executions. The new crash regressions also exercise the native durable outcome
in the durable configurations. Ruff, formatting, lock and diff checks passed,
and all 27 packages built source archives and wheels. No agent or test
processes or command cgroups remained. Logs are in `/tmp/ma-runtime-stage2/`.
No real inference, credentials, subagents, other builds or T3 Code settings
were used. Frozen docs and kit sources are unchanged.

Stage 2 is complete. Stop here. The next step is the supervisor's
cross-language Runtime swap matrix, not another implementation stage. Stage 1
and earlier results below are historical.

## Post-matrix correction: missing files use not_found

The 2026-11-17 plugin binding update is implemented. Native text and binary
reads now report `not_found` for a missing file. The served env/read uses that
same binary read path, and host/env/read preserves the code whether the working
environment is local, in a private process or an external public-wire plugin.
The prompt plugin skips missing AGENTS.md only by code, never by message text.
Other errors still fail preparation, even when their message says "No such file".
The plugin-kit test now relies on the exit code instead of a fixed check count.

Six offline regression cases were added. They cover native text/binary reads,
a completed turn with an external environment returning `not_found` with a French message,
a failed turn for an `internal` error with misleading English text, and
host/env/read forwarding from local and external environments. Before the fix,
five of these six cases failed and the plugin kit passed only 41/42 checks.
After the fix, all 24 plugin-binding cases pass in each full-suite configuration.

Final proof, sequential and without retries or skips:

- Plugin kit against `.venv/bin/modular-agent-plugin`: **42/42**.
- ACP kit with `--plugin-checks`: **46/46**, hosting our own plugin as two
  external processes, Provider/hooks in one and tools/environment in the other.
- Local/transient whole suite: **251 passed**, 77.97 seconds.
- Local/durable whole suite: **251 passed**, 67.42 seconds.
- Private-process/transient whole suite: **251 passed**, 181.96 seconds.
- Private-process/durable whole suite: **251 passed**, 181.15 seconds.

That is **1,004 passing test executions**. Ruff, formatting, diff checks and all
27 package source/wheel builds pass. No test-created processes or command cgroups
remain. All runs were offline; no real model run was needed. No subagents, other
builds or T3 Code settings were involved. Frozen docs and kit sources were not
changed. G57 under Bindings records the closed missing-file gap and swap test.
No further gap was found. Logs, including the red regressions and kit baseline,
are in `/tmp/ma-not-found/`; final kit logs are `plugin-final.log` and
`acp-final.log`, and full-suite logs are `suite-*.log`.

The existing kit commands below still reproduce both final kits. The earlier
round results below are historical. This correction is complete. The next step
is the supervisor's swap-matrix rerun, not another implementation stage. Stop here.

## Round three: shared plugin binding complete

The refreshed snapshot is 679dbd6. A separate `ma-plugin` package now serves
`modular-agent-plugin/1`; the private `ma-process` binding is unchanged.
The reusable JSON-RPC server takes registrations and method handlers. Its
conformance composition exports the chosen Provider, tools, working environment
and hook handlers. Tools call only `host/env/*`. The local working environment
retains strong Linux cgroup containment, including setsid descendants.

Final plugin kit: **39/39**. Final ACP kit with `--plugin-checks`: **46/46**,
with Provider/hooks in one external process and tools/working environment in
another. ACP also passes **46/46** with the durable Runtime and every native
plugin in its own private process. All runs are offline, with no inference. Registrations
adapt onto native capabilities and hooks. Explicit replacements unload the local
Provider and working environment and retract the local file-tool definitions.
Callbacks cover every host method, with parent/session/authority checks, raw
paged history, Provider-owned hooks, and routed environment streams.

Eighteen new offline binding cases cover local and private-process placement.
They include both kits, local omission evidence,
callback ownership, binary files, timeout output, dynamic tool-list refresh before
answering, transformed native operations, collision rejection, fail-closed gates,
lost-plugin unknown outcomes and nested-command cleanup, the real 64 MiB result
cap, active-command EOF cleanup, per-session list isolation, unknown response
fields/content/providerData surviving history and the next request, and external
Provider compaction. Two final regressions also prove that turn-result gates
compose changes before a later refusal and preserve accepted result changes, and
that tool gates cannot rewrite actor/authority lineage. The final code passes all
18 binding cases with private-process placement and the durable Runtime.
The first 245-case run exposed six erasure regressions: the newly journalled
accepted result was another copy but lacked source links. Step-end snapshots now
name their response/tool-result sources, and the gate regression also erases its
input and checks that no accepted-result copy remains. All 58 related regression
cases pass. The failing log is retained as `suite-erasure-failure.log`.
Final sequential, uninstrumented release matrix, with no test-level retries or skips:

- Local/transient: **245 passed**, 68.11 seconds.
- Local/durable: **245 passed**, 73.82 seconds.
- Private-process/transient: **245 passed**, 177.34 seconds.
- Private-process/durable: **245 passed**, 179.75 seconds.

That is **980 passing test executions**. Lint, formatting, diff checks and all
27 package source/wheel builds pass. No build-created processes or command cgroups
remain. Logs are `/tmp/ma-plugin-r3/suite-*.log`, `plugin-final.log`,
`acp-final.log`, `acp-all-durable.log` and `build.log`. No subagents, other builds,
real model calls or T3 settings were involved. Frozen docs and kit sources were
not changed.

One earlier process/transient run had an ACP parked-question shutdown timeout
(244 passed, 1 failed). Twelve isolated executions, a full task-stack-instrumented
245-case run and the final uninstrumented runs passed. No failing task stack was
captured and no timeout-specific fix was made. This intermittent failure is not
claimed fixed. The failed log is `suite-acp-stop-failure.log`; see the round three
section in `FLAKE-REVIEW.md`. Temporary instrumentation was removed.

G51 to G56 under Bindings record the stage 1 choices and limits: remote environment
session-close cleanup, item replacement, credential shapes and callback authority,
paged history, list-change barriers and response-hook timing. The remote environment
has strong agent-lifetime cleanup, but `/1` cannot express individual session-close
cleanup of background work. See G51 before relying on that unsupported operation.

ADR 0016 audit, outside this assignment: the existing parallel tool engine waits
in request order before journalling results, rather than recording each completed
result immediately. It also does not persist the complete starting model, tool
list and system prompt as one turn snapshot. Interrupted model replay checks
runs-tools safety but not the new rule requiring a stateless Provider as well.
These rules are not fixed here.
All other earlier boundaries below remain documented, not re-certified by this
round's work.

### Commands for the swap matrix

After `uv sync --python 3.13`, both executables below work from any directory.
The agent uses its launch cwd as project unless `--project` is supplied.
The kit creates its own project and supplies offline conformance/data-directory
settings. The server needs neither a model nor a login.

Exact serve command:

```sh
/home/danballance/Code/modular-agent-py/.venv/bin/modular-agent-plugin
```

Exact agent command:

```sh
/home/danballance/Code/modular-agent-py/.venv/bin/modular-agent --mode acp --process-plugins ''
```

Reproduce both final kits, from any directory:

```sh
repo=/home/danballance/Code/modular-agent-py
plugin="$repo/.venv/bin/modular-agent-plugin"
agent="$repo/.venv/bin/modular-agent"
(cd "$repo/conformance/plugin" && node run.mjs -- "$plugin")
plugins=$(printf '[{"command":["%s"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"provider,hooks"}},{"command":["%s"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"tools,environment"}}]' "$plugin" "$plugin")
MODULAR_AGENT_PLUGINS="$plugins" node "$repo/conformance/acp/run.mjs" \
  --plugin-checks -- "$agent" --mode acp --process-plugins ''
# Optional: same external split, every native part also moved, durable Runtime.
MODULAR_AGENT_PLUGINS="$plugins" node "$repo/conformance/acp/run.mjs" \
  --plugin-checks -- "$agent" --mode acp --runtime durable --process-plugins all
```

`MODULAR_AGENT_PLUGIN_PARTS` defaults to all four parts. Set it per external
process to select any subset of `provider,tools,environment,hooks`.
`MODULAR_AGENT_PLUGINS` is operator-controlled startup configuration, not project
trust. The Harness starts entries in order after native plugins, initializes each,
refuses collisions without explicit replacement, and never moves the public adapter
through `ma-process`. The reusable server accepts registration/method handlers;
the supplied executable exports the conformance composition, not an automatic
exporter for every possible native plugin. The next step is the supervisor's
cross-language swap matrix. No further implementation stage is assigned. Stop here.

## Status

**All five milestones, rounds two and three, Stage 2 of the public plugin
binding, and the missing-file and Runtime history corrections are complete.
Stop here.**
Milestone 5's private process binding and every
required item in `AGENTS.md` are built and proven, including the real run with
Provider, Runtime, tools and working environment each in its own process.
The optional milestone 4 full-screen UI remains skipped. No required item is skipped.

No subagents were started, no other build was read, no T3 Code settings changed,
and the frozen `docs/` are unchanged. Read `AGENTS.md` first if continuing later.
`MILESTONE-1.md` through `MILESTONE-5.md` map acceptance to evidence. `GAPS.md`
has 65 sourced decisions with swap tests. G44 to G65 are under **Bindings** and
record rounds two and three, Stage 2, and the post-matrix corrections, including
unresolved binding ambiguities.
`DESIGN.md` describes the architecture. `FLAKE-REVIEW.md` preserves reproduced
races, their fixes, and the reason whole suites must not run concurrently.

## Round two: shared ACP host binding

The ACP Interface exposes `modular-agent-acp/1`: namespaced initialization,
per-session and prompt metadata; every required declaration field; the fixed host
actor; stable keyed receipts and original-turn outcomes; model/thinking/approval
select options; exact allow/refuse options; and the required `history`, `input`,
`requests`, `answer` extensions. Optional `fork`, `move`, `erase`, `jobs` and
`cancel-job` use the binding's shapes. Pre-binding Python aliases remain additional
extensions for existing clients. Model choices are `claude/claude-haiku-5-5`,
`fake/fake` in scripted tests, and `conformance/echo` only in conformance mode.

`MODULAR_AGENT_CONFORMANCE=1` adds a stateless deterministic Provider. It returns
literal echoes, or a tool call followed by the first 200 Unicode characters of
its result, with zero usage. It goes through the normal Runtime, approval and
file/shell tools, locally or across plugin processes. It starts no Claude Code
process and needs no credentials or network. `MODULAR_AGENT_DATA_DIR` overrides
`--home` for internal state. ACP prompts are literal input; model-free slash
commands are still available through the command extension and terminal.

Questions without form support remain available through `requests` and `answer`.
Open calls end their turn with a pending tool update. Secret forms are never sent,
and a closed permission connection cannot authorize execution after restart.
Cancelled prompts return queued content before replying. Transient restart returns
untaken input in load/resume metadata; durable restart runs it. History defaults to
the current branch, with `all` for every branch, and rejects unknown cursors with
`-32602`. All updates, history, metadata and errors pass the output gate.

The kit initially passed 43/43 locally and 42/43 with all plugins moved. The latter
exposed a command startup cancellation race: killing an empty cgroup before its
child joined made the watcher wait until its five-second fallback. A deterministic
regression delays child admission, goes red before the fix, and passes with a pipe
acknowledgement before the watcher's kill. Final cancellation times are below.
Diagnostic and final logs are retained in `/tmp/ma-bindings-r2/`; no retries were
used in the final sequential release matrix.

| Placement | Runtime | Kit | Whole suite | Kit cancellation |
|---|---|---|---|---|
| local | transient | 43/43 | 227 passed | 16 ms |
| local | durable | 43/43 | 227 passed | 20 ms |
| all plugin processes | transient | 43/43 | 227 passed | 43 ms |
| all plugin processes | durable | 43/43 | 227 passed | 36 ms |

The process suite normally moves Runtime/files/local/MCP. Its kit test explicitly
moves **all** plugins, including the Provider and ACP Interface. The original 212
tests remain, with 14 binding regression cases and the deterministic command race
case added. No skips. All 908 test executions, lint, formatting, diff checks and all
26 package source/wheel builds pass. No new real model run was needed or performed.
No subagents, other builds or T3 settings were involved. The frozen description and
the kit source are unchanged. No build-created processes, zombies or command groups
remain. The history HTTP binding was read but is not part of this assignment.

### Run the kit

From the repository root, after `uv sync --python 3.13`:

```sh
(cd conformance/acp && npm ci)
# Keep this command absolute: the kit launches the agent in its fresh project.
agent="$PWD/.venv/bin/modular-agent"
node conformance/acp/run.mjs -- "$agent" --mode acp --process-plugins ''
node conformance/acp/run.mjs -- "$agent" --mode acp --process-plugins all
# Add --runtime durable to either command to use the other Runtime.
```

The kit supplies both conformance environment variables itself. Without the kit,
set them explicitly, select `conformance/echo` through ACP configuration, and use
an absolute `--project` or launch in the project's cwd. No model is run merely by
starting ACP. The startup project restriction remains explicit, as G49 records.
The official Python SDK is `agent-client-protocol==1.0.0`; the unchanged kit uses
`@agentclientprotocol/sdk==2.7.0`, now locked for reproducible `npm ci` installation.

### Binding gaps

`GAPS.md`, **Bindings**, has G44 to G50, with sources, choices and swap tests:
- G44: cancellation before a command child joins its cgroup.
- G45: the spontaneous-turn enum omits late-answer continuations.
- G46: restart hand-back has no specified response location.
- G47: admission versus visible input identity, and duplicate-result correlation.
- G48: provider identifiers in model option values are not standardized.
- G49: arbitrary cwd requests versus fixed trusted startup composition.
- G50: session-wide token budgets have no explicit stop-reason mapping.

These are not hidden by the passing kit. In particular, this build still binds
new/load/resume to the startup project, declares late-answer continuations beyond
the enum, and supplies additional hand-back metadata for transient recovery.
There is no further implementation work assigned. Stop here.

## Built across all five milestones

A uv workspace with 26 independently installable part packages plus the root
composition. The Harness hosts plugins, supplies the API and owns open sessions
and narrowing authority. It runs no turns, calls no models, executes no tools and
stores nothing durably itself. All features use addressed version 1 plugin calls.

1. Vanilla agent: transient Runtime, fake and Claude Providers, local file/shell
   tools and working environment, SQLite tree history, context/compaction, system
   prompt, configuration, credential store, model/thinking selection, guardrails,
   slash commands, terminal line/print/JSON Interfaces, keyed input and erasure.
2. Swap and crash recovery: independently replaceable durable Runtime, journalled
   effect decisions, conservative unknown outcomes, preserved limits, safe replay,
   concurrent tool execution with ordered results, cgroup-contained command
   descendants and stale cleanup after SIGKILL and watcher loss.
3. Interaction and delegation: recorded keyed questions, approval, authority,
   credential-only secret intake, late answers, jobs, independently replaceable
   transient/durable subagents, forwarded questions, result validation and checked
   UI tool calls. Process stop suspends work; explicit session close cancels jobs.
4. External hosts and tools: official ACP v1 Interface over stdio, declared
   support/configuration/permissions/elicitation/session lifecycle and extensions;
   official MCP stdio and Streamable HTTP clients with scoped tools and annotations;
   settings-loaded factories and options, project trust and fixed composition.
5. Process binding: `ma-process` execs unchanged plugins into independently chosen
   processes. Private full-duplex JSON frames carry addressed calls, hooks,
   commands, followers and acknowledged streams. Cancellation joins nested cleanup.
   Plugin loss fails all waiters, produces unknown tool results, withdraws lost
   tool contributions, reports gated session events and can let a turn continue.
   Startup/stop failures clean up and reap workers. Both Interfaces can move too.

Moving plugins also exposed an earlier jobs.wait/report-admission ordering race.
Its fix makes wait a delivery barrier, serializes keyed Runtime admission and
protects Harness appends across out-of-process store writes. G43 records it.

## Build and test

Python 3.13 is pinned with mise and `.python-version`.

```sh
uv sync --python 3.13
(cd conformance/acp && npm ci)
# Whole suites must run sequentially, not concurrently:
for binding in local process; do
  for runtime in transient durable; do
    uv run --offline pytest -q --runtime "$runtime" --binding "$binding"
  done
done
uv run ruff check .
uv run ruff format --check .
uv build --all-packages
```

The historical missing-file verification ran **251 offline tests in each of the
four configurations, no skips**, for 1,004 passing executions. See the latest
verification at the top for the current counts. Milestone 5 had 212 tests;
round two adds 15, round three adds 18 and the post-matrix correction adds six.
Process mode moves Runtime, file tools, local working environment and MCP independently. Additional black-box tests move every plugin, Provider
included, and both Interfaces. The kit uses all-process placement in the process
matrix. Pure internal unit tests remain unit tests in either matrix run.
Lint, formatting, diff checks and all 27 package source/wheel builds pass.
Missing-file correction logs: `/tmp/ma-not-found/`. Round three logs remain at
`/tmp/ma-plugin-r3/`. Round two logs are retained at
`/tmp/ma-bindings-r2/suite-*.log`, `kit-final-*.log` and `build.log`.
Earlier milestone 5 logs remain at `/tmp/ma-m5-release/`.

Tests never need credentials or inference. Network connections are disabled,
including in plugin workers. Official ACP clients use actual subprocess stdio;
MCP tests use real stdio servers and official ASGI servers with socket-free HTTP.
All-plugin tests check actual child PIDs, live streams and output gating, not
process-local stand-ins. Two-hop cancellation stops bash and its setsid descendant
before answering. Killing a plugin fails multiple waiters and produces exactly
one unknown result while the turn completes. File-source/environment death also
cleans nested commands. Other cases prove fail-closed gates, roles, large Unicode
frames, custom capability/hook/command reentrancy, keyed concurrency, cleanup
acknowledgement, cancellation during send, partial startup and forced shutdown.

An initial attempt to run all four suites concurrently failed the watcher-loss
assertion in one configuration: another suite legitimately cleaned the stale
cgroup before the test's own next startup. A controlled cleaner reproduced it;
eight isolated runs passed. The final matrix is sequential, without test retries.
The failed and diagnostic logs remain; see `FLAKE-REVIEW.md`.
Tests and live proofs leave no workers, MCP/SDK processes, command descendants,
zombies or command cgroups running.

## Run and placement

```sh
uv run modular-agent --project /path/to/project
uv run modular-agent --runtime durable --subagents durable --project /path/to/project
uv run modular-agent --session SESSION_ID -p "Continue"
uv run modular-agent --runtime durable \
  --process-plugins runtime,files,local,mcp,claude --project /path/to/project
# Every plugin, including the Interface:
uv run modular-agent --process-plugins all --project /path/to/project
# An ACP host launches this command with stdin/stdout pipes:
uv run modular-agent --process-plugins all --mode acp --runtime durable \
  --project /absolute/path/to/project
```

Only `claude-haiku-5-5` is allowed for real inference, through the existing Claude
Code subscription login and `claude-agent-sdk==0.2.183`. No API key is used.
Claude Code's tools, settings, hooks, memory and MCP servers stay off. The agent's
exact tool schemas are offered; the Runtime runs their calls. Native Provider
state is discarded on erasure, position changes, forks, compaction and cancellation.

`--process-plugins` accepts comma-separated plugin names or roles, or `all`.
Without it, `MA_PLUGIN_PROCESSES` applies. Empty placement is local. Embedding
passes `process_plugins` to build/Harness. A trusted settings factory can specify
`process: true|false`. Placement never requires changing the plugin implementation.
`MILESTONE-5.md` documents the wire protocol, bootstrap, errors and lifecycle.
That private plugin binding is local and same-version, for trusted installed plugins. Live
resources belong in start, not constructors. It is not a security sandbox,
network service, cross-language ABI or live plugin migration mechanism.

Default data directory: `~/.local/state/modular-agent-py`, never `~/.modular-agent`.
`MODULAR_AGENT_DATA_DIR` overrides it and `--home`, including settings and trust.
Global settings: `--home/settings.json`. Project defaults:
`.modular-agent/settings.json`. `plugins` entries name `module:factory` with JSON
`options`, optional explicit `replaces` and optional process placement.
`plugin_settings` supplies executable options. Project code and its plugin settings
require `--trust-project`; ordinary session defaults still apply without trust.
`--untrust-project` revokes trust at next startup. CLI reopen without `--project`
selects the saved project before choosing its composition. See `MILESTONE-4.md`.

Line controls include `/answer ID VALUE`, `/secret ID`, `/jobs`, `/job_cancel ID`,
`/cancel`, `/after TEXT`, `/steer TEXT` and the model/thinking/compact/tree/fork/erase
commands. Approval defaults to off; the other policies are `ask unless read-only`,
`ask always` and `never ask, refuse`. Default Runtime and subagents are transient;
each can be replaced independently. Cancelling a turn leaves jobs running.

Bash requires a writable delegated Linux cgroup v2 subtree, normally
`/sys/fs/cgroup/user.slice/user-UID.slice/user@UID.service`; `MA_CGROUP_ROOT`
overrides it. Missing containment refuses bash before startup. File tools work.
This is lifetime containment, not protection against hostile same-user programs.
External MCP servers do not claim the same cgroup-based crash guarantee.

## Real runs

### Milestone 5

One invocation on 2026-11-17 UTC, first attempt, two requests to
`claude-haiku-5-5`, thinking off, durable Runtime. Session
`579d025c65e941ffa6cfffcdb3d96878`. Harness PID 1294810; all 18 plugins ran in
separate processes. Provider 1294816, Runtime 1294818, file tools 1294815 and
working environment 1294814 were distinct direct children.

Haiku ran exactly one bash call, `cat proof.txt`. The marker came only from the
file. Bash output and model output streamed across the binding. Haiku answered:

> The marker is M5-PROCESS-PROOF-96427.

The offline validator confirms model identity, exact tool/result pairing,
execution routes, process placement, streams and complete process cleanup.
Evidence: `/tmp/modular-agent-py-m5-live/`. The complete command-line proof ran
offline immediately beforehand at `/tmp/modular-agent-py-m5-offline-verified/`.
No further inference was needed.

```sh
uv run python scripts/milestone5_live.py --verify-only \
  --output /tmp/modular-agent-py-m5-live
# Entire proof, no inference, use a new directory:
uv run python scripts/milestone5_live.py --offline --output /tmp/ma-m5-offline-new
# Deliberate new inference only if needed, new directory:
uv run python scripts/milestone5_live.py --confirm-live --output /tmp/ma-m5-new
```

### Earlier milestones

- M1: three invocations, five requests. Read a file, then reopened in another
  process and answered from history. Session `fe831273e72c4dd683745aceb9ff750f`,
  `/tmp/modular-agent-py-m1-live/`.
- M2: three invocations, five requests. SIGKILL during bash stopped the command;
  durable recovery marked it unknown, did not repeat it, checked files and
  completed the turn. Session `de8c4d3ac0cd44f2a815b8bc697a3b96`,
  `/tmp/modular-agent-py-m2-live-verified/`.
- M3: one invocation, five requests. A background subagent wrote a file using bash;
  its report started a parent turn describing the work. Parent
  `99e800e0c790469a8a14bed2532a776b`, child `545dd73f07484ddfbed968f8acd87254`,
  `/tmp/modular-agent-py-m3-live/`.
- M4: one invocation, two requests, entirely over the official ACP client. Host
  configuration and approval authorized a session-only MCP tool; its file marker
  reached Haiku's answer. Replay/resume and MCP PID cleanup were validated.
  Session `40c8e7cc7b9248b2b5f167652762b3e9`, `/tmp/modular-agent-py-m4-live/`.

All real runs used only the allowed Haiku model through the subscription login.
Milestones 2 to 5 have saved-evidence offline validators in their live scripts.

## Gaps and final boundaries

New milestone 5 entries:
- G39: placement, callback addressing and private binding/version contract.
- G40: stream backpressure and cancellation as confirmed cleanup.
- G41: process-loss errors, unknown outcomes, tool withdrawal and gated reporting.
- G42: trusted startup construction, exec isolation and descriptor ownership.
- G43: report admission, keyed concurrency and atomic history append boundaries.

The original 43 entries say the responsibilities are a useful and buildable description.
The seven round two entries add shared host-binding ambiguities and the admission race.
What most needs agreement for swapping independently written plugins is the
observable contract: exact data shapes and identifiers, hook composition,
authority and question liveness, effect/replay safety, cancellation completion,
ordering, and host fallback/declaration semantics. The wire format and internal
storage algorithms are properly left to each builder.

Known boundaries remain explicit: no same-user sandbox; no exactly-once arbitrary
hook effects; budgets checked between reported model steps; no ACP secret forms
or out-of-band URL service; no MCP sampling/resources/prompts/server elicitation
or legacy SSE; fixed startup composition and one bound project per runnable
agent. Losing a Provider, Runtime or history service can prevent continuation;
the binding reports it rather than inventing success or replaying unknown effects.

No required acceptance item is skipped. The only optional omission is the
full-screen UI, retained as skipped to focus on tested protocol and host paths.
The binding rounds and assigned corrections are also complete. No required
assigned item is skipped. Binding limits and ambiguities remain explicit above and
in G44 to G65. The next step is the supervisor's cross-language swap-matrix rerun,
not another implementation stage. Stop here.

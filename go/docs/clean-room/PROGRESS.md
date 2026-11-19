# Progress

## Milestone status

All five original milestones and both round two shared-binding assignments are complete. Round three stages 1 and 2, the missing-file follow-up and the B12 streaming fix are complete.

## Production edition 3

The Go host settles ineligible interrupted calls before `resumeTurn`. It restores the last answered step, passes a committed `step.after` decision or runs the due gate, and fails closed if the checkpoint cannot prove the state. The Go Runtime validates and reuses the decision. Both native and hosted step attempts write the shared marker and gate record. Tool refusals contain the committed result, and Provider response callbacks use the four standard fields.

ACP uses `MODULAR_AGENT_ACTOR` as the connection principal. Operator admissions have no granter, and duplicate keys are scoped to both the submitting and attributed actors, including erased receipts. Portable history now distinguishes a declined approval from an approval value and keeps a taken job report's attribution separate from its execution authority. Configured plugin registration failures now stop startup. See `GAPS.md` for the findings and limits. No real inference ran.

Run these commands from the repository root. The edition 3 kits at `b70c9f8` arrived during this round. The fixes did not change `docs/` or `conformance/`. Scratch and logs are under `$HOME/.cache/modular-agent-go-tmp/`, with logs in `edition3/`. The tests were run one kit at a time.

```sh
mkdir -p "$HOME/.cache/modular-agent-go-tmp"
export TMPDIR="$HOME/.cache/modular-agent-go-tmp"
export GOMAXPROCS=2 GORACE=atexit_sleep_ms=0
mise exec -- go build -o bin/modular ./cmd/modular
mise exec -- go build -o bin/modular-service ./cmd/modular-service
```

| Command | Result |
|---|---|
| `node conformance/plugin/run.mjs -- "$PWD/bin/modular" --serve-plugin` | 139/139, exit 0 |
| `bash scripts/round5-checks.sh local all` | 206/206, exit 0 |
| `bash scripts/round7-swaps.sh runtime go go` | 189/189, exit 0 |
| `bash scripts/round7-swaps.sh portable go go` | 153/153, exit 0 |
| `bash scripts/round7-history.sh restart 39179` | 42/42, exit 0 |
| `bash scripts/round7-history.sh restart-ttl 39180` | 42/42, exit 0 |
| `mise exec -- go test -p 2 -count=1 -timeout 15m ./...` | 29 test packages, exit 0; `cmd/modular` (including three kit tests) took 271.770 s |
| `mise exec -- go test -p 2 -count=1 -timeout 15m -skip 'Test(ACPBindingConformanceKit\|ACPWithSplitStdioPlugins\|PluginBindingConformanceKit)' ./...` | 29 test packages, exit 0 |
| `mise exec -- go test -count=25 ./acpinterface -run '^TestACPCancelsOutstandingPermission$'` | Exit 0 |
| `mise exec -- go vet ./...` | Exit 0 |

The swap script expands the exact agent and plugin commands in the round seven recipe. It adds `--runtime durable` for Go in portable cells. The optional fourth argument `runtime` selects a transient wire Runtime instead.

| Command | Result |
|---|---|
| `bash scripts/round7-swaps.sh runtime go ts` | 189/189, exit 0 |
| `bash scripts/round7-swaps.sh runtime go rs` | 189/189, exit 0 |
| `bash scripts/round7-swaps.sh runtime go py` | 189/189, exit 0 |
| `bash scripts/round7-swaps.sh runtime go ex` | 189/189, exit 0 |
| `bash scripts/round7-swaps.sh portable go ex` | 152/152, exit 0; same- and different-principal receipt checks passed |
| `bash scripts/round7-swaps.sh runtime ts go` | 189/189, exit 0 |
| `bash scripts/round7-swaps.sh runtime rs go` | 189/189, exit 0 on rerun with the rebuilt Rust executable |
| `bash scripts/round7-swaps.sh runtime py go` | 189/189, exit 0 on rerun |
| `bash scripts/round7-swaps.sh runtime ex go` | 184/184, exit 0 |
| `bash scripts/round7-swaps.sh portable ts go` | 153/153, exit 0 |
| `bash scripts/round7-swaps.sh portable rs go` | 153/153, exit 0 |
| `bash scripts/round7-swaps.sh portable py go` | 153/153, exit 0 |
| `bash scripts/round7-swaps.sh portable ex go` | 153/153, exit 0 |

The initial Rust and Python host runs scored 188/189 and 187/189 respectively, in standalone probes that replace the Go plugin with the kit's JavaScript fixture. The latest available binaries passed the reruns. The actual Go Runtime crash and normal-turn checks passed in both rounds.

## Production edition 2

The Go agent keeps both ACP versions, both native Runtimes, both served Runtime tiers, and the same optional session declarations. No capability was turned off to pass a kit. The history HTTP client verifies the final append size before creating a fork and fences work after late leases. Reopen reports a retryable hold when the lease wait would exceed its budget. Close checks membership and requires `cancel` only when work would be cancelled.

Hosted Providers commit the final request at the request hook, before inference. The host owns Runtime attempt limits, exact-call allowances and terminal settlement, and skips settled calls on resume. Refused results produce a feedback record used only on the next preparation in that turn. Approval views are checked against the exact call and get a recipient-specific answerability result after gating. Erasure keeps keyed duplicate receipts without returning erased identities or outcomes.

Rewind preflights later points without restoring, excludes other users of the project, and records restore intent and completion. On reopen it reconciles incomplete restores before project work. Job ends and report admissions commit together. Reopen folds terminal records and intake across branches, checks recorded authority, and takes ready inputs in admission or release order.

See `GAPS.md` for the settled first-edition findings and new migration and wire questions. The kits are not a production deployment audit. In particular, they do not prove recovery of every partially completed cross-session erasure or setup and question record from older builds.

The ACP watchdog and cancellation follow-up is in `GAPS.md`. The local store no longer decodes and re-encodes all previously verified records on every append, and the Harness no longer deep-copies snapshots through JSON on the turn and authority paths. A long-history regression makes both the command start and ACP cancellation observable. No deadlines changed and no real model ran for this follow-up.

Run from the repository root. `TMPDIR` keeps build and test scratch files off the RAM-backed `/tmp`. Run the kits one at a time. The Go suites below limit scheduler contention with `GOMAXPROCS`.

```sh
mkdir -p "$HOME/.cache/modular-ed2-suite/tmp"
export TMPDIR="$HOME/.cache/modular-ed2-suite/tmp"
mise exec -- go build -o bin/modular ./cmd/modular
mise exec -- go build -o bin/modular-service ./cmd/modular-service
```

| Command | Result |
|---|---|
| `node conformance/plugin/run.mjs -- "$PWD/bin/modular" --serve-plugin` | 139/139, exit 0 |
| `bash scripts/round5-checks.sh local provider,hooks` | 199/199, exit 0 |
| `bash scripts/round5-checks.sh local durable-runtime` | 199/199, exit 0 |
| `bash scripts/round5-checks.sh local tools,environment` | 199/199, exit 0 |
| `bash scripts/round5-checks.sh local all` | 199/199, exit 0 |
| `bash scripts/round5-checks.sh portable supplied transient` | 151/151, exit 0 |
| `bash scripts/round5-checks.sh portable supplied durable` | 151/151, exit 0 |
| `bash scripts/round5-checks.sh portable go transient` | 151/151, exit 0 |
| `bash scripts/round5-checks.sh portable go durable` | 151/151, exit 0 |
| `bash scripts/round7-history.sh restart 39179` | 42/42, exit 0 |
| `bash scripts/round7-history.sh restart-ttl 39180` | 42/42, exit 0 |
| `mise exec -- go vet ./...` | Exit 0 |
| `git diff --check` | Exit 0 |
| `GOMAXPROCS=2 GORACE=atexit_sleep_ms=0 mise exec -- go test -p 2 -count=1 -timeout 15m ./...` | 29/29 test packages, exit 0; `cmd/modular` took 258.394 s |
| `GOMAXPROCS=2 GORACE=atexit_sleep_ms=0 mise exec -- go test -race -p 2 -count=1 -timeout 15m ./...` | 29/29 test packages, exit 0; `cmd/modular` took 261.131 s |

The focused command was `GOMAXPROCS=2 GORACE=atexit_sleep_ms=0 mise exec -- go test -race -v -count=1 ./cmd/modular -run '^TestExternalDurableCancelsCommandWithLongLocalHistory$'`. A Go overlay supplied the four checkpoint implementation files for the baseline. It exited 1 before command start. A diagnostic overlay allowed more time to observe command start only. The prompt still missed the unchanged five-second settlement deadline. With the fix it exited 0: the command started after 0.63 seconds, the prompt settled after 0.59 seconds from cancellation, and the command never wrote its finish marker.

Both builds above exited 0. The supplied runs used `/tmp/ma-tools/history-service/serve.mjs`. `UPDATED` identifies the edition-2 service, TypeScript `195c958` from 2026-11-18 20:39 UTC, with 128-byte leases and retryable holds. Both supplied runs passed the delayed renewal check at a 15-second TTL. Logs for this follow-up are in `$HOME/.cache/modular-ed2-suite/`. The kit files were supplied separately in `eb00020`; this fix did not edit them or `docs/`.

`python3 scripts/round4-real.py` exited 0 with Haiku 5.5 and the gateway. The first turn read the marker `r4-saffron-71` and returned `38`. The agent was killed by PID after the bash marker appeared and reopened in 14.88 seconds. The recovered turn told the user the outcome was unknown and repeated the original marker. There was one bash start and one `outcomeUnknown` result. Log: `$HOME/.cache/modular-ed2-verified/real.log`.

## Production edition 1 checkpoint

1. Local turn recording: native requests now keep the offered names and source entries, and their responses link to the intent. The offline regression checks this link. `GORACE=atexit_sleep_ms=0 mise exec -- go test -race -count=1 ./turnrun ./portable ./harness` passed. Final Provider middleware, replay and host dispatch still need work; this is not a production conformance claim.

2. History service and recovery: the service now implements the production routes and validation order, exact opaque decimal equality, bounded pages, ordered tombstones and a durable restart exclusion across TTL changes. The Linux client checks the binding at ACP and CLI startup, follows cursors and fences late renewal replies with a suspend-aware clock. The Harness stops its writer on failed commits and checks it before native model and tool effects. The history kit passed **39/39** with the restart hold. `GORACE=atexit_sleep_ms=0 mise exec -- go test -race -count=1 ./historyhttp ./servicehttp ./harness` passed. Full uncertain-erase reconciliation and leased fork preflight are not finished.

3. ACP: negotiation validates both binding versions and reports the configured actor rights. `MODULAR_AGENT_ACP_REPRESENTS` lists trusted represented IDs for the connection; a grant does not create representation. Load gates the whole open reply before replay and reuses the writer on retry. Some ACP approval, authority, paging and admission rules are unfinished.
4. Plugin host: shared framing distinguishes syntax, envelope and method errors and refuses reused IDs. Host-side Runtime phase and settlement checks remain incomplete.
5. Plugin: the served Runtime echoes the exact prepared request rather than materializing absent settings. The fixture model rejects unoffered directives; fixture bash retains the exit line and forwards output. Both Runtime tiers still fail retry, limit and settlement cases.
6. Portability: ran the two Runtime tiers against both services. Incomplete standard record shaping, queue and job fold, erased receipts, fork preflight and rewind journal prevent a pass. The supplied service initially had no `UPDATED` marker. After the 2026-11-18 19:10 UTC refresh, both variants improved from 116/133 to 126/145, but still failed. Its configured 15-second TTL skips the delayed-renewal fixture; the Go runs pass it.
7. Actors, limits and tenants, jobs, rewind and production acceptance are not finished. Next work: move attempt and tool settlement ownership into the host, finish the portable fold and pending erasure intent, then add the rewind journal and check deployment boundaries. Do not use the inherited declarations as a claim of production conformance.

Latest kit commands and results. Run from the repository root after building with `mise exec -- go build -o bin/modular ./cmd/modular` and `mise exec -- go build -o bin/modular-service ./cmd/modular-service`:

| Command | Result |
|---|---|
| `bash scripts/round7-history.sh restart` | 39/39, exit 0 |
| `bash scripts/round7-history.sh restart-ttl 39080` | 39/39, exit 0 |
| `node conformance/plugin/run.mjs -- "$PWD/bin/modular" --serve-plugin` | 108/133, exit 1 |
| `bash scripts/round5-checks.sh local provider,hooks` | 164/192, exit 1 |
| `bash scripts/round5-checks.sh local durable-runtime` | 164/192, exit 1 |
| `bash scripts/round5-checks.sh local tools,environment` | 164/192, exit 1 |
| `bash scripts/round5-checks.sh portable supplied transient` | 126/145 after refresh, exit 1 |
| `bash scripts/round5-checks.sh portable supplied durable` | 126/145 after refresh, exit 1 |
| `bash scripts/round5-checks.sh portable go transient` | 127/146, exit 1 |
| `bash scripts/round5-checks.sh portable go durable` | 127/146, exit 1 |

The full suite ran in both modes using `GORACE=atexit_sleep_ms=0 mise exec -- go test -p 2 -count=1 -timeout 8m ./...` and the same command with `-race` after `test`. Both exited 1 because the three `cmd/modular` tests that invoke the ACP and plugin kits failed. The earlier normal run also hit a timing failure in `TestACPCancelsOutstandingPermission`; the later full race run passed `acpinterface`. With `-skip 'Test(ACPBindingConformanceKit|ACPWithSplitStdioPlugins|PluginBindingConformanceKit)'` added before `./...`, the normal and race runs passed all 29 test packages. The skipped tests are covered by the separate failing kit runs above, not counted as passing.

Each local wrapper runs from `conformance/acp` with `node run.mjs --crash-checks --plugin-checks --probe-checks --job-checks -- "$agent" --mode acp`. All load the served `provider,hooks`; the last two add the named served parts. Each portable wrapper runs `node run.mjs --crash-checks --portable-checks --job-checks -- "$agent" --mode acp --runtime "$runtime" --then "$agent" --mode acp --runtime "$runtime"`, with its own scratch store. Kit logs are under `/tmp/modular-round7/verified/`.

The real run used `python3 scripts/round4-real.py` with Haiku 5.5 and the Anthropic gateway. It exited 0. It read `fact.txt` and answered with `r4-saffron-71` and `38`, killed the agent by PID with `kill -9` after `bash` wrote its start marker, then reopened in 15.02 seconds. History kept one bash start and one `outcomeUnknown` result. The command was not rerun. The recovered model identified the interruption and repeated the previous marker. Log: `/tmp/modular-round7/real.log`.

## Round six

- ACP declares `sessionLimits` and `tenants`. Tenants come from `MODULAR_AGENT_TENANTS` and are fixed at creation. The history records tenant and limit entries, and effective rights apply to live work. Token budgets count recorded input and output across a tenant's sessions.
- ACP lists and withdraws proposals, reports a declined release as `handedBack`, and tracks whether a joined actor is present on the connection.
- Stdio output gates see the shared event shapes. The served hook redacts a split secret without changing event boundaries or unrelated data. A withheld ACP extension reply gets `-32000` with `data.code: "withheld"`, without undoing the request. Duplicate plugin names are refused during the handshake.
- Jobs record the rights they started with and accept a report before answering `host/jobs/end`. Rewinds restore the working environment before committing a position and report open-world calls as out of reach. Incompatible reasoning levels are lowered, cancellation takes precedence over a callback failure, and a first history entry that fits is sent even when adding its cursor exceeds the page cap.
- No real model ran. The description and kits are unchanged. Round-six gaps are B36 to B40 in `GAPS.md`.

Run from this repository's root:

```sh
mise exec -- go build -o bin/modular ./cmd/modular
mise exec -- go build -o bin/modular-service ./cmd/modular-service
GORACE=atexit_sleep_ms=0 mise exec -- go test -p 2 -count=1 -timeout 8m ./...
GORACE=atexit_sleep_ms=0 mise exec -- go test -race -p 2 -count=1 -timeout 8m ./...
bash scripts/round5-checks.sh plugin
bash scripts/round5-checks.sh local provider,hooks
bash scripts/round5-checks.sh local durable-runtime
bash scripts/round5-checks.sh local tools,environment
bash scripts/round5-checks.sh local all
bash scripts/round5-checks.sh portable supplied transient
bash scripts/round5-checks.sh portable supplied durable
bash scripts/round5-checks.sh portable go transient
bash scripts/round5-checks.sh portable go durable
bash scripts/round5-checks.sh history go
```

The normal and race suites passed all **29 test packages**. The plugin kit passed **111/111**. The four local ACP configurations passed **129/129** each, including limits and tenants. The four portable ACP configurations passed **101/101** each, with a fresh history service per run. The Go history kit passed **34/34**. Logs are in `/tmp/modular-round6/verified/`. The plugin command runs inside an isolated PID namespace for the unchanged setsid check (B40).

## Round five matrix follow-up

- Go now rewinds with a stdio working environment even if its tools mark `openWorld` or leave the hint out. The hint stays in the tool definition. The original points, Provider checks and refusal to rewind across jobs still apply. An independent wire fixture covers both hint forms and restores a file from its saved point.
- ACP returns `-32000` with `output gate withheld the response` when the output gate blocks or fails on a reply it handles. The `answer` acknowledgement goes through the gate, and the error does not include the hook's own error or say that the operation was undone. See B34 and B35 in `GAPS.md`.
- Job reports keep only the recorded result, including an empty result. They never replace a missing result with the job's error message. A reporting transient subagent records its unknown outcome warning as its result so the parent still sees it after a restart.

Build the binaries from this repository's root with the commands below. To reproduce the environment swap, run this from the root with either non-Go command in `environment`:

```sh
agent="$PWD/bin/modular"
environment='["node","/home/danballance/Code/modular-agent/packages/plugin-wire/dist/src/serve-cli.js"]'
# For Rust, use this instead:
# environment='["/home/danballance/Code/modular-agent-rs/target/debug/modular-agent","--serve-plugin"]'
# For the Go control, use: environment=$(jq -cn --arg agent "$agent" '[$agent,"--serve-plugin"]')
plugins=$(jq -cn --arg agent "$agent" --argjson env "$environment" \
  '[{command:[$agent,"--serve-plugin"],env:{MODULAR_AGENT_PLUGIN_PARTS:"provider,hooks"}},{command:$env,env:{MODULAR_AGENT_PLUGIN_PARTS:"tools,environment"}}]')
(cd conformance/acp && MODULAR_AGENT_PLUGINS="$plugins" node run.mjs --plugin-checks --probe-checks -- "$agent" --mode acp)
```

Before the fix, TypeScript and Rust each passed **90/91** and failed at `_modular-agent/move` with `Invalid params`; the Go control passed **93/93**. After the fix each passed **93/93**, including file restore and further turns. `GORACE=atexit_sleep_ms=0 mise exec -- go test -race -p 2 -count=1 -timeout 4m ./...` passed all **29 test packages**. The unchanged plugin kit passed **109/109**. All four local ACP configurations below passed **109/109** each, and all four portable configurations below passed **86/86** each. Logs are in `/tmp/modular-round5-matrix/`. No real model ran, and `docs/` and the kits are unchanged. Only the two reported cross-build environment swaps were rerun here, not the full matrix.

## Round five

- ACP now negotiates `/2`, which reports failed turns as JSON-RPC errors. The offline echo model supports `fail:`. Host and delegated actors can join, leave, propose, release and answer with the rights they share.
- The local and served stdio environments save file points. Rewinding restores a point before moving the branch and refuses work or points it cannot safely restore. A plain move still leaves the files alone.
- Stdio plugins can own, cancel, resume and report jobs. The host records portable job entries and runs reports as keyed input. Built-in subagents also use the shared job kinds.
- The stdio output gate holds each model or tool stream until its end. The served hook redacts `conformance-secret`, including when it crosses streamed pieces. Provider erasure sends entry IDs, tool-list changes can name their parent request, and history paging counts the compact JSON result.
- Portable history now records admissions and handbacks, model requests, turn context, plugins and question closure. Reopening honors the recorded approval and model, including an unavailable model. Refused tool repeats keep the original outcome unknown. Erased entries keep the execution identities needed for recovery.

Run from this repository's root:

```sh
mise exec -- go build -o bin/modular ./cmd/modular
mise exec -- go build -o bin/modular-service ./cmd/modular-service
mise exec -- go test -p 2 -count=1 ./...
mise exec -- go test -race -p 2 -count=1 ./...
bash scripts/round5-checks.sh plugin
bash scripts/round5-checks.sh local provider,hooks
bash scripts/round5-checks.sh local durable-runtime
bash scripts/round5-checks.sh local tools,environment
bash scripts/round5-checks.sh local all
bash scripts/round5-checks.sh portable supplied transient
bash scripts/round5-checks.sh portable supplied durable
bash scripts/round5-checks.sh portable go transient
bash scripts/round5-checks.sh portable go durable
bash scripts/round5-checks.sh history go
```

The normal and race suites each passed all **29 test packages**, including both native Runtimes and the served durable Runtime. The plugin kit passed **109/109**. The four local ACP runs passed **109/109** each with `--crash-checks --plugin-checks --probe-checks --job-checks`. The four portable runs passed **85/85** each with `--crash-checks --portable-checks --job-checks`, with the same Go agent on both sides of `--then` and an empty history service per run. The Go history service kit passed **34/34**. Logs are in `/tmp/modular-round5-checks/`. No real model ran and neither `docs/` nor the kits changed. The remaining binding gaps are B27 to B33 in `GAPS.md`. The unchanged plugin kit still probes an escapee PID in the wrong namespace; the wrapper isolates that probe.

## Round four follow-up: first portable session swaps

- The supplied Rust to Go history recorded `conformance/echo` at `low`. Go offered only `off`, so model selection failed before the Runtime could recover the interrupted turn. Echo now accepts every shared reasoning level and still ignores reasoning. A regression seeds the HTTP history service with shared JSON, including a foreign dotted entry, and checks the result and turn end through ACP.
- Native and hosted durable Runtimes now report `outcomeUnknown` when a started call does not run again, even if its repeat is safe but denied. A never-started call still goes through live checks and can be refused. Actor rights use the standard names. Unknown rights stay in history but authorize nothing, and starting a job requires `jobs`, not `tools`.
- The copied crash history, restored to the last `toolStarted` before the failed Go reopen, recovered on the supplied service. The original turn `cc39d464-fd39-4e1c-aa84-32a9e8dd13a8` got one `outcomeUnknown` result and a `completed` turn end. The ACP history view showed the same result and the command did not start again. Replay command: `timeout 20s python3 /tmp/modular-go-swap-replay.py "$PWD/bin/modular"`.
- Offline race suite: **161 top-level tests and 356 subtests** passed. The plugin kit passed **105/105** in five isolated runs. An initial run alongside the other suites missed one heartbeat check (**104/105**). ACP with `provider,hooks` passed **73/73**. The portable ACP self-swaps on the supplied service passed **51/51** with each Runtime. Logs are in `/tmp/modular-go-swap-checks/`.
- No real model run, other-build source reads or kit edits. The captured history replay and the two Go self-swaps were run here; another live cross-language matrix was not run. See B17, B22 and B26 in `GAPS.md`.

Commands from the repository root:

```sh
mise exec -- go build -o bin/modular ./cmd/modular
mise exec -- go test -race -count=1 -json ./...
bash scripts/round4-checks.sh plugin
bash scripts/round4-checks.sh local transient
bash scripts/round4-checks.sh portable supplied durable
bash scripts/round4-checks.sh portable supplied transient
```

The ACP wrapper changes to `conformance/acp` and uses the unchanged kit. Local mode runs `--crash-checks --plugin-checks --probe-checks` with the Go provider/hooks plugin. Portable mode runs `--crash-checks --portable-checks` with the same Runtime on both sides of `--then`.

## Round four: revised bindings and portable sessions

- Local storage, HTTP history and plugin history use the same shared entry codec. The agent replays branch movement, settings, actors, taken input keys, responses, results and questions from standard records, and declares `portableSessions: true`. The HTTP client no longer writes `go.session/1` checkpoints.
- `MODULAR_AGENT_HISTORY_URL` and `MODULAR_AGENT_HISTORY_TOKEN_FILE` select HTTP history for the command-line agent, including ACP. Reopening waits for the old lease. Our history service now supplies a retry hint. The supplied service does not, so its declared TTL is the fallback. Flags still take precedence.
- The plugin host rejects unusable registrations without removing its own items. Callbacks use live parents and session authority, while paging raw history is bounded. The conformance plugin uses session-scoped environment work, one complete response hook and the revised cancellation replies. Both served Runtimes recover the scripted foreign turn from standard history alone, and the host owns turn boundaries and standard events.
- Offline suite: **159 top-level tests and 352 subtests** pass normally and with `-race`. Both binaries build, and `go vet ./...` and `git diff --check` pass. Logs: `/tmp/ma-r4-results/confirmed.jsonl` and `/tmp/ma-r4-results/confirmed-race.jsonl`.
- Direct ACP checks: **73/73** with `provider,hooks`, and **73/73** with those parts plus the durable Runtime plugin. Portable ACP checks: **51/51** for each native Runtime on each history service. The history service kit passed **34/34**. The unchanged plugin kit passed **103/105**; two background PID probes run in the wrong namespace. A separate offline regression verifies the full session lifetime behavior without those probes. See B17 in `GAPS.md`.
- Real run: `python3 scripts/round4-real.py`, Haiku 5.5 through the Anthropic API gateway, on the supplied history service. It read `fact.txt` and gave `r4-saffron-71` and `38`. `kill -9 2232246` stopped the agent while its bash call was sleeping after writing one line. A new durable agent, PID 2232318, reopened the same session, waited for the lease, recorded exactly one `outcomeUnknown` result and completed without another bash call. It said the call was interrupted and repeated the marker. The entire reopen and reply took 15.75 seconds. Evidence: `/tmp/modular-go-r4-real.etppqy1q/summary.json`. An earlier short run reproduced the missing lease hint; it stopped before recovery and is not counted as a success.

Build both binaries with the commands below, then run:

```sh
bash scripts/round4-checks.sh plugin
bash scripts/round4-checks.sh local transient
bash scripts/round4-checks.sh local durable-runtime
bash scripts/round4-checks.sh portable supplied transient
bash scripts/round4-checks.sh portable supplied durable
bash scripts/round4-checks.sh portable go transient
bash scripts/round4-checks.sh portable go durable
bash scripts/round4-checks.sh history go
```

The script passes absolute commands to the unchanged kits. Its plugin run puts namespace-local PID probes in a separate PID namespace, and its portable runs start and stop a fresh service by PID. The actual cross-language agent matrix was not run here. Foreign, standard-only history is covered by offline fixtures and the plugin kit. Round-four gaps and resolved round-three entries are in `GAPS.md`.

## Round three stage 2: Runtime

- The conformance plugin serves both Runtimes through stdio. The unchanged plugin kit passes **84/84**.
- The Harness replaces its Runtime with the registered subprocess Runtime while preserving feature hooks. It binds callbacks to the live turn and derives interrupted calls from history on reopen. The hosted Runtime reconstructs checkpoints in a fresh process. Answered late calls keep their old identity and recorded authority. ACP translates recovered response calls and tool-result statuses to the shared data shapes.
- Direct kits: ACP `--crash-checks` **49/49** each with the native transient Runtime, native durable Runtime, and the hosted Go durable Runtime. ACP `--plugin-checks` **46/46** with the stage 1 split plugins. The Go suite runs the unchanged kits against race-instrumented executables and tests late answers across a real subprocess boundary.
- Final suites: **144 top-level tests and 345 subtests**, normally and with `-race`, with no race warnings. Both executables build, vet and diff checks pass. Direct kit logs: `/tmp/modular-go-stage2-direct-*.log`; suite logs: `/tmp/modular-go-stage2-final-{tests,race}.jsonl`.
- B12 reproduced and fixed: 10/250 short calls lost live output before the fix, 0/250 afterward. A single command-supervisor pipe now orders chunks before the exit frame. The regression is in `local/local_test.go`.
- B13 to B16 in `GAPS.md` cover recovery reads, safe-repeat proof, lifecycle/stream ownership and undeclared operations. No real inference, key access, other-build reads, subagents or T3 settings changes. Frozen docs and kits were not edited. No test-owned processes remain.

To run the crash kit from any directory (the kit sets the offline environment):

```sh
node /home/danballance/Code/modular-agent-go/conformance/acp/run.mjs --crash-checks -- \
  /home/danballance/Code/modular-agent-go/bin/modular --mode acp
# Add --runtime durable to exercise the native durable variant.

MODULAR_AGENT_PLUGINS='[{"command":["/home/danballance/Code/modular-agent-go/bin/modular","--serve-plugin"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"durable-runtime"}}]' \
node /home/danballance/Code/modular-agent-go/conformance/acp/run.mjs --crash-checks -- \
  /home/danballance/Code/modular-agent-go/bin/modular --mode acp
```

## Round three follow-up: missing files

- Followed the 2026-11-17 update to `docs/bindings/plugin.md`. Reproduced the original missing-file failure with the unchanged plugin kit: **41/42**. No other build was read.
- `env/read` and `host/env/read` now translate local missing-file errors to `not_found`. Existing external error codes are preserved when callbacks route to another plugin. Received `not_found` errors match `fs.ErrNotExist`, so all existing typed missing-file checks, including the optional system-prompt `AGENTS.md` read, work with local and external environments. Removed the remote read's `exists` preflight: the read's error code is authoritative, not a separate check or message text.
- Added `pluginrpc/missing_test.go`. Its real-process regression supplies an external environment answering `not_found` with message `archivo ausente` for `AGENTS.md`; a turn still completes with both Runtimes. A second plugin probes `host/env/read` against local and external environments. An `internal` error saying `No such file or directory` is not mistaken for absence and still fails the turn. These tests failed before the fix and pass afterward. The suite's plugin-kit assertion now requires exactly 42/42.
- Verification: plugin kit **42/42** against `bin/modular --serve-plugin`; ACP kit **46/46** with `--plugin-checks`, hosting this build's provider/hooks and tools/environment in separate plugin processes. Both normal and race suites also run the kits, with ACP checked under both Runtimes. Whole suite: **142 top-level tests and 344 subtests pass**, normally and with `-race`, with no race warnings. Both binaries build; vet and diff checks pass. Commands remain the same as below.
- Evidence: `/tmp/modular-go-not-found-tests.jsonl`, `/tmp/modular-go-not-found-race.jsonl`, `/tmp/modular-go-not-found-plugin-kit-repeat.log`, and `/tmp/modular-go-not-found-acp-kit.log`. The baseline and failing-regression logs are `/tmp/modular-go-not-found-plugin-before.log` and `/tmp/modular-go-not-found-regression-before.log`.
- Updated B11 for the closed missing-file contract. One concurrent direct kit run passed the new missing-file check but failed the unrelated streamed-output check; its unchanged rerun and both full suites passed. This issue was logged as B12 and left unchanged in the missing-file fix. Stage 2 reproduced and resolved it.
- No required work was skipped. No real inference, key access, subagents, other-build source reads or T3 setting changes were needed. No test-owned processes remain. Frozen docs and kits were not edited in that follow-up.

## Round three: cross-language plugins

- Read the refreshed snapshot, ADR 0016 rules, plugin/data bindings and both conformance kits. No other build was read.
- Added a general bidirectional JSON-RPC peer and capability server in `pluginrpc`. `bin/modular --serve-plugin` serves the conformance plugin, selected by `MODULAR_AGENT_PLUGIN_PARTS`. Its tools use only host callbacks. Local execution retains Linux namespace containment and now exposes real numeric exit status.
- Server verification: plugin kit **39/39**, including escaped-child cancellation. The Go suite includes the unchanged kit against a race-instrumented executable.
- Every vanilla Harness now starts `MODULAR_AGENT_PLUGINS` in order. Adapters register Providers, tool sources, environments, commands and standard hook handlers. Explicit replacements remove local items; they cannot shadow or replace an earlier external item. All `host/*` callbacks are handled, with parent-work authority and environment routing.
- Split-process ACP kit: **46/46** with both Runtimes, using separate provider/hooks and tools/environment processes. Added it to the suite. Additional offline subprocess tests show removed local Providers/tools/environments, tools routed to a different process's virtual environment, callback authority checks, commands, changed per-session lists, provider/turn hook payloads, unknown outcomes on loss, weak-containment declarations and EOF cleanup of escaped commands.
- Peer tests cover bidirectional request identities, linked cancellation, loss, the 64 MiB result limit and unknown shared-data fields. Final verification: **140 top-level tests and 332 subtests pass**, normally and with `-race`, with zero race warnings. Both executables build, vet and diff checks pass. Direct kit runs from `/tmp` pass **39/39** plugin checks and **46/46** ACP plugin checks. The suite repeats the ACP check with both Runtimes. Evidence: `/tmp/modular-go-plugin-{tests,race}.jsonl`, `/tmp/modular-go-plugin-kit.log`, and `/tmp/modular-go-plugin-acp-kit.log`.
- Refreshed-rule differences found in existing code: parallel batches wait for all workers before committing results, rather than committing each as it finishes; local command lifetime is process-scoped rather than session-scoped; ordinary in-process tool-name conflicts are detected at turn preparation rather than plugin load; observe-hook failures were discarded; native stateful Providers lack general navigation/erasure invalidation. This assignment needs load-time external-name checks and reported external-hook failures, so external-name checks were added at the binding boundary and observe failures now report their plugin and hook. The unrelated parallel-commit, local session-lifetime and stateful-Provider lifecycle differences are not changed in this stateless conformance assignment. The wire also lacks a session-close operation for an external environment, logged in B11. Internal hook names/rules differ, and the binding adapter must translate the standard rules, not expose those private shapes.

- Binding gaps B7 to B11 are logged under `GAPS.md`'s Bindings heading, each with source, choice and swap test. No real inference, experiment key access, subagents, other-build source reads or T3 setting changes were needed. No test-owned processes remain. Frozen `docs/` and the kits were not edited.

### Plugin binding commands

Build in this repository with the commands below. These resulting launch commands work from any directory:

- Serve command: `/home/danballance/Code/modular-agent-go/bin/modular --serve-plugin`
- Agent command: `/home/danballance/Code/modular-agent-go/bin/modular --mode acp`
- Add `--runtime durable` to the agent command to choose the durable Runtime.
- `MODULAR_AGENT_PLUGIN_PARTS` defaults to `provider,tools,environment,hooks`. It also accepts `runtime` or `durable-runtime` (not both together). Comma-separated selections register only the requested parts. The environment uses the handshake's home for its command registry; Runtime state is in the host's history.
- For standalone offline ACP, use `MODULAR_AGENT_CONFORMANCE=1` and a fresh `MODULAR_AGENT_DATA_DIR`. The ACP kit supplies both itself. An explicitly configured external Provider may also be the only Provider. Normal real inference still requires the model gateway and the allowed Haiku model.

```sh
# Run from any directory, after building bin/modular:
node /home/danballance/Code/modular-agent-go/conformance/plugin/run.mjs -- \
  /home/danballance/Code/modular-agent-go/bin/modular --serve-plugin

MODULAR_AGENT_PLUGINS='[{"command":["/home/danballance/Code/modular-agent-go/bin/modular","--serve-plugin"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"provider,hooks"}},{"command":["/home/danballance/Code/modular-agent-go/bin/modular","--serve-plugin"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"tools,environment"}}]' \
node /home/danballance/Code/modular-agent-go/conformance/acp/run.mjs --plugin-checks -- \
  /home/danballance/Code/modular-agent-go/bin/modular --mode acp
```

The plugin peer/server and host adapters are in `pluginrpc/`. `harness.LoadExternal` removes selected local registrations. `cmd/modular/plugin_test.go` and `plugin_host_test.go` run the unchanged kits; `pluginrpc/*_test.go` checks replacement, routing, callbacks, loss, framing and shared-data preservation through real stdio peers/processes. The public `pluginrpc.Server` can expose ordinary Go Providers, tool sources, environments, handlers and commands; the conformance server is one composition of it. Incoming plugin commands are trusted operator configuration, not project history. The HTTP service binding is unchanged.

## Round two: shared bindings

- History service and client now use `modular-agent-history/1`: resource paths, opaque entries, renewable leases, safe resends, and lease-guarded erasure. The service no longer understands Go snapshots or follows copies. The agent adapter stores metadata checkpoints as opaque entries and computes copy closure itself.
- Binding contract tests cover wire shapes, authentication, atomic/conflicting batches, key-order equality, listing/cursors, fencing, erasure and persistence. An independent binding peer tests the client, including a dropped committed answer and permanent lease loss.
- ACP now uses `modular-agent-acp/1`: complete honest declarations, connection-owned actor, namespaced model/config/input/outcome shapes, standard stop reasons, required history/input/requests/answer extensions and optional navigation/jobs methods. No-form and late questions use the extensions; approval changes apply next turn using recorded turn settings.
- `MODULAR_AGENT_CONFORMANCE=1` installs credential-free `conformance/echo`. `MODULAR_AGENT_DATA_DIR` isolates local history, command cleanup and settings, including project settings. `--history-url` and `--history-token-file` also work for terminal/ACP launches.
- ACP kit: **43/43 checks passed** against a race-instrumented executable. The Go suite now runs the unchanged official-client kit with both Runtimes; Node dependencies are installed once outside the tests. Additional tests cover limits/failures, cancelled handed-back inputs and retries, active/late extension answers, configuration timing, navigation, isolation, and CLI remote-history reopening.
- Final verification: **125 top-level tests and 323 subtests pass**, both normally and with `-race`. Both binaries build, vet and diff checks pass. Direct final kit runs also pass **43/43** with each Runtime. History expiry is checked after reading slow uploads, and the client accepts numeric millisecond TTLs, including fractional JSON encodings.
- Evidence: `/tmp/modular-go-bindings-tests.jsonl`, `/tmp/modular-go-bindings-race.jsonl`, and `/tmp/modular-go-acp-conformance-{transient,durable}.log`. `BINDINGS.md` maps requirements to tests. No required operation was skipped. Launch scope and other unresolved wire edges are logged as B1 to B6 under `GAPS.md`'s new Bindings heading.
- No real inference, subagents, other builds or T3 setting changes in this round. Use a fresh history service state folder; the old private service snapshot format is not migrated. The process still serves one declared canonical project. Services are interchangeable; private agent session encodings are not standardized.

1. Vanilla agent: complete, including file-based inference and reopening in a new process.
2. Swap test: complete, including durable Runtime replacement, SIGKILL and durable real inference recovery.
3. Questions, jobs and subagents: complete, including a real background child whose report started a parent turn.
4. Hosts and the wider world: complete, including ACP-driven real inference. The optional full-screen terminal UI was skipped.
5. Parts as services: complete, including every binding item in `AGENTS.md` and a real HTTP-driven run with the agent, history store, sandbox and gateway in separate processes. Nothing required was skipped.

The build follows only this repository's frozen `docs/` snapshot and `GLOSSARY.md`. No other build or `~/.modular-agent` was read. No subagents were started to implement the milestones and no T3 settings were changed. `docs/` was not edited. Go standard-library documentation, installed Bubblewrap help and the pinned protocol sources were used for implementation details.

`DESIGN.md` records boundaries. `GAPS.md` has **35 original decisions and 16 binding entries**, including the B12 implementation follow-up, each with its source, missing point, choice and swap test. `MILESTONE_1.md` through `MILESTONE_5.md` map acceptance to tests. `HOSTS.md` documents ACP/MCP and trust; `SERVICES.md` documents service APIs, startup, retry rules and limits.

## Build and checks

Go 1.27.4 is pinned with mise, in one module. MCP uses the official Go SDK v1.8.0. ACP uses the maintained Caelis Labs Go SDK v1.7.0 with stable wire v1, official schema 1.31.0. See `PROTOCOL_SOURCES.md`.

Linux with unprivileged user, PID and mount namespaces is required for bash. The service sandbox additionally requires Bubblewrap, tested here with version 0.12.0. Unsupported setup fails closed. No privileged daemon is needed.

```sh
mise exec -- go build -o bin/modular ./cmd/modular
mise exec -- go build -o bin/modular-service ./cmd/modular-service
(cd conformance/acp && npm ci) # one-time Node test dependency setup
mise exec -- go test -count=1 ./...
mise exec -- go test -race -count=1 ./...
mise exec -- go vet ./...
git diff --check
```

Milestone 5 baseline: **114 top-level tests and 296 subtests, all passing**. Both ordinary and race suites pass, as do vet and both builds. Milestone 5 adds 13 top-level tests and 6 subtests over the 101/290 milestone 4 baseline. Its in-process service tests were also repeated five times under the race detector. Runtime-facing cases run with both Runtimes.

Tests never use external inference or read the experiment key. Anthropic tests use dummy credentials and loopback vendor fixtures. MCP uses SDK fixture servers over subprocess stdio and local HTTP. ACP uses its maintained client library and actual executable stdio. Service tests build race-instrumented executables and launch history, environment, a fake gateway and two agent processes, driven only over HTTP. They test release/death takeover, agent SIGKILL, environment service death, unsafe unknown outcomes and recovery with each Runtime. A separate service deliberately drops committed mutation answers. Processes are stopped by exact handles and waited for; no command/service/MCP processes remain. Evidence: `/tmp/modular-go-m5-tests.jsonl` and `/tmp/modular-go-m5-race.jsonl`.

Existing secret tests now explicitly load their dummy credential-store fixture. Their assertions still pass. Production agent composition installs no credential-store plugin and no direct real Provider.

## What exists

- `api`: content, calls/results, actors, questions, jobs, history, usage, capability and turn contracts, plus fixed standard Runtime hook rules. Opaque vendor content and rich MCP data survive the binding. The Runtime cannot see credentials or choose a model.
- `harness`: identity-bound plugins, replacement, owner-only hooks and commands; sessions, actor authority, queues, keys, cancellation, navigation, forks, erasure and gated views. No model/tool loop. Reopen delegates interruption handling to the selected Runtime. Child ceilings intersect current ancestor authority. Plugins stay fixed while sessions are open.
- `history`: atomic synced JSON snapshots, immutable history trees, advisory writer ownership, lazy unused sessions, project filtering and erasure through transitive copy links.
- `transient`, `durable`, `turnrun`: swappable Runtimes using one protocol and checkpointed runner. Completed effects are reused; durable recovery repeats only declared-safe interrupted work and marks unsafe effects unknown. Transient repair settles calls and fails the turn. All-parallel batches overlap but commit results in request order. Model-free UI calls use the identical checks and recovery pipeline.
- `local`, `tools`: project-aware read/write/edit/bash with live output. Per-command Linux namespace supervisors kill descendants on agent death, including escaped/background processes. A synced registry cleans abandoned supervisors before recovery. Private namespace-correct `/proc` mounts support nested sandboxes; temporary namespace mount capabilities are cleared before command creation. The local environment is not a filesystem sandbox.
- `questions`, `approval`: keyed approval/choice/text/secret requests, answerability, authority, replay, deadlines and late continuation. Approval policies are off, ask-unless-read-only, ask-always and never. Approvals fail closed without a connected responder and revalidate final arguments/current authority. Named secrets use only an explicitly installed credential destination; no raw secret enters history, events or model context. Gateway-only agents decline secret collection.
- `jobs`, `subagents`, `resultcheck`: recorded keyed job starts/ends and reports, cancellation, accounting, owner-controlled recovery, independent transient/durable child recovery, remembered child sessions, narrowed authority, depth limits and question forwarding through parents. Background reports may start turns. Optional result checks can send the model back within the turn limit. Shutdown interrupts jobs before sessions; explicit close cancels work.
- `configuration`, `credentials`, `modelselect`, `systemprompt`: merged defaults, trusted compiled plugin factories, chosen model/thinking, project instructions and request-time credential access on the gateway. Global plugins load automatically; project plugins/options require explicit invocation trust. Defaults are `mcp` and `guardrail` factories. No source fetching or shared-object loading.
- `contextview`, `guardrail`: before-step views, provenance-aware compaction, one context-overflow retry, valid views for open/late calls, held split-secret output and recipient redaction. Raw history stays intact.
- `mcptools`, `acpinterface`: official MCP SDK tool sources over stdio/Streamable HTTP, rich results/annotations, updates/cancellation and session-scoped ACP attachments. Stable ACP v1 supplies declarations, session lifecycle, selectors, approvals/elicitation, UI tool updates and keyed-input/recorded-follow extensions. Wire input cannot forge internal actor or provenance. EOF interrupts; explicit close cancels. Secret forms are refused.
- `commands`, `terminal`: slash commands, line, print and JSON Interfaces, with approval/questions/jobs/usage/support controls.
- `anthropic`, `fake`: restricted real Haiku 5.5 Messages Provider and scripted offline Provider. Real Provider loading is now exclusive to the model gateway role.
- `servicehttp`, `historyhttp`: authenticated HTTP transport and shared `modular-agent-history/1` plugin/service. Opaque append-only entries, semantic JSON equality, atomic batches, lease fencing and safe resends. The service preserves data across restarts but invalidates tokens. Erasure guards each session's lease; the client computes copy closure and stores Go metadata as separate opaque checkpoints.
- `environmenthttp`: rooted file APIs and per-agent Bubblewrap workers, exposed through a normal working-environment plugin. Live NDJSON command output; per-command cancellation/disconnect cleanup; lifetime-stream closure kills every command and returned background descendant. Only the root is writable host storage. System binaries are read-only, virtual filesystems are private, environment is cleared and network is isolated.
- `gateway`: authenticated catalog and streamed model access, preserving usage, opaque content, error kinds and Provider declarations. The gateway alone reads the Anthropic key. Generation is not retried by the transport; interruption is unknown.
- `agenthttp`: authenticated host Interface for session lifecycle, input/answers/cancellation, support, settings, commands, checked UI tools, navigation, jobs and erasure. Entry-ID cursors replay every gated recorded entry in append order; missed live pieces are represented by their full records. Only an actual follower counts as an available approver.
- `vanilla`, `cmd/modular`, `cmd/modular-service`: composition and executable entry points. Service roles run independently. One configured agent process serves one canonical project. Either Runtime works with the service plugins unchanged.

## Running

See `SERVICES.md` for complete four-process startup and API examples. Create a private service token file outside the repository. Launch `bin/modular-service --role history`, `environment`, `gateway` and `agent` with their documented flags. Each prints one readiness JSON line with URL and PID, never tokens. Standalone HTTP listeners are loopback-only; use authenticated TLS proxies for remote access.

Only gateway role reads `~/.config/modular-agent-experiment/anthropic.key`, at request time. Agents have service-authentication tokens, but no model credentials. Never put key bytes on a command line or in this repository.

For terminal/ACP with local history and local commands, first launch the gateway, then:

```sh
bin/modular --project /path/to/project --model-gateway http://127.0.0.1:8303 \
  --service-token-file /tmp/modular-service.token
bin/modular --runtime durable --session SESSION_ID --mode print \
  --model-gateway http://127.0.0.1:8303 --service-token-file /tmp/modular-service.token
bin/modular --project /absolute/project/path --runtime durable --mode acp \
  --model-gateway http://127.0.0.1:8303 --service-token-file /tmp/modular-service.token

# Entirely offline, no gateway or credentials:
bin/modular --script examples/offline.json --state /tmp/modular-go-offline \
  --mode print --prompt hello
```

Defaults remain transient Runtime, transient subagents and approval off. Select the desired variants on each invocation. `/quit` explicitly closes a terminal session; Ctrl-C interrupts for recovery. `--wait-jobs` waits for parent report turns in print/JSON; otherwise one-shot close cancels jobs. Print/JSON have no answering actor, so new approvals fail closed. HTTP followers and negotiated ACP clients provide answer/approval presence.

Project session defaults apply without trust. Project plugins/options require `--trust-project` for the invocation. Global plugin entries load automatically. Reopening with project trust requires a matching explicit project. Launch another configured process for a different project.

## Real inference completed

- Milestone 1, 2026-11-17 UTC: two processes, three requests. Read a file and answered cerulean/7, then reopened and answered cerulean/14 without rereading. `REAL_RUN.md`.
- Milestone 2, 03:11 UTC: two processes, three requests. SIGKILL during bash; durable reopen continued without new input, received unknown for the unsafe call and inspected state instead of repeating it. `REAL_RUN_2.md`; `/tmp/modular-go-m2-real.ys_00haf`.
- Milestone 3, 04:25 UTC: one process, two sessions, five requests. Background child wrote `child-note.txt` with marker `m3-cobalt-73`; its report started a parent turn describing the work. `REAL_RUN_3.md`; `/tmp/modular-go-m3-real.sp2d2e8x`.
- Milestone 4, 05:16 UTC: ACP client, one session, two requests. Approved read and received marker `m4-saffron-91` and doubled count 26. Retried keyed input caused no extra turn/request. `REAL_RUN_4.md`; `/tmp/modular-go-m4-real.1124599924`.
- Milestone 5, 06:23 UTC: four separate processes, one session, two requests and one remote read. HTTP-driven answer: "The marker is m5-jade-47, and twice its count is 34." Key retry returned the same receipt; reconnect replay returned all seven later recorded entries. Only the gateway read the key. Every process stopped cleanly. `REAL_RUN_5.md`; `/tmp/modular-go-m5-real.rjaw9z0v`.

No other real model was used. No key was printed or copied here. To deliberately repeat milestone 5: build `bin/modular-service`, then run `python3 scripts/milestone5-real.py`. It is never part of offline tests and does not read the key itself. Earlier real drivers are historical evidence and need gateway-aware launch adaptation before reuse.

## Gaps, limits and whole-build conclusion

Milestone 5 logged G32 to G35: remote history fencing/retry/erasure, sandbox lifetime/exposure, moving credentials with the Provider, and HTTP host replay/identity/presence. No required milestone 5 item was skipped. The only optional omission across all milestones is the full-screen terminal UI.

The result covers the vanilla agent, interchangeable transient/durable execution, interruption-safe effects, authority/questions/jobs/subagents, external hosts/tool sources and a service-separated deployment, all through plugins. Both Runtimes pass the same ordinary behavior tests and differ only where interruption semantics require it.

The description most needs **observable behavioral contracts**, not fixed HTTP endpoints: ownership loss and retry scope; exact interruption/unknown-outcome boundaries; authority and approval revalidation; question/late-result lifecycle; output/replay coverage and responder presence; and erasure provenance/scope. Different choices there break plugins or hosts. Message encoding, storage layout, polling, goroutines and Bubblewrap are appropriately left to the builder.

This is an experiment, not a hardened multi-tenant service. The plugin API and MCP programs are trusted. Each configured agent has one project and the HTTP binding authenticates one operator-controlled host identity. Project folders must be locally visible to the agent/configuration at the same absolute path used by the sandbox. The sandbox root must not contain operator-mounted sensitive filesystems, host device nodes or sensitive hard-link aliases. There are no tenant-wide budgets, sandbox resource quotas, external identity service, arbitrary remote project mapping or protection against kernel exploits. TCP partitions cannot promise instantaneous agent-death detection. History ownership expiry is bounded by a three-second lease; slow stream writes have five-second deadlines. Unsafe model/tool effects are not retried automatically after unknown outcomes.

Moves/forks/erasure require finished work and refuse partial-turn boundaries. Project file effects and delivered output are outside history erasure. Arbitrary hook effects need plugin-owned idempotency. No ACP v2, client-owned file/terminal callbacks, sign-in flows, secret forms, MCP sampling, OAuth or legacy SSE transport is offered. Service generation supports request/response, not live or batch inference.

## Next work

Stop at round four. A supervisor can now swap Runtimes and portable sessions across builds. For the cross-language matrix, use the documented ACP `--then` option and point both agents at the same history service. If working on the kits next, replace their namespace-local PID probes with a liveness test that does not depend on a process ID.

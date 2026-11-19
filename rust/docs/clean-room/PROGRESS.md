# Progress

## Production edition 3

### Edition 3 OpenAI portable reasoning

The OpenAI Provider translates shared `off` to Responses API `none`. The other five shared levels keep their names. The model catalog advertises all six in order so ACP shows and accepts `off`, and reopening keeps it rather than raising it. The API spelling never enters history. See [GAPS.md](GAPS.md#pe3-05-openai-uses-a-different-name-for-reasoning-off).

Both new offline tests failed before the fix. The adapter test saw `off` instead of `none`; the ACP test reopened a foreign record with `off` selected but missing from the model's choices. The tests now cover all six request values, ACP model switching and explicit selection, and the saved portable spelling.

With `TMPDIR="$HOME/.cache/ma-rs-tmp"`, build with `mise exec -- cargo build --locked --offline -p modular-agent`. Point `MODULAR_AGENT_HISTORY_URL` and `MODULAR_AGENT_HISTORY_TOKEN_FILE` at a disposable History HTTP service (see below), then run `python3 scripts/real-portable-off.py`. The script writes a synthetic foreign checkpoint with a started bash call and `off` in both the session and turn settings. It opens that session using `--acp --runtime durable --provider-mode stateless`. It does not start or kill a writer. The single live gpt-6-luna request completed with `PORTABLE-OFF-OK`. Bash was recorded as `outcomeUnknown` without rerunning, and ACP and the store still showed `off`. The OpenAI credential was read only by the credential plugin. The result is in `$TMPDIR/portable-off/live.log`.

Run the offline workspace with `mise exec -- cargo test --workspace --locked --offline --no-fail-fast -- --test-threads=1`. The default and `--features modular-agent/stateful-provider-default` runs each passed 234 tests. With `modular-agent/durable-default` enabled, each Provider mode passed 233 tests. No tests failed or were ignored in any configuration. The standalone Plugin kit passed 139/139, and the History HTTP kit passed 39/39 without the optional restart checks. The local ACP kit used `--crash-checks --plugin-checks --probe-checks --job-checks` with `provider,hooks` and either served Runtime. Both passed 207/207. The portable kit used `--crash-checks --portable-checks --job-checks` with Rust as writer and reopener. It passed 152/152 in each Runtime. Use a fresh History HTTP store for each portable run. An initial run reused the History HTTP kit's store, hit a JSON depth error while reading its fixture records, and was stopped. Logs are in `$TMPDIR/portable-off`.

### Edition 3 late question outcomes

The served `runtime` and `durable-runtime` and their native counterparts now end a turn `completed` when its remaining calls were left open. The Harness accepts `step.after` for those calls after committing `toolPending`, validates the open ids in call order, and refuses a mismatched outcome instead of converting it to `completed`. The focused host regression showed the old reply was accepted before the fix. It now rejects a questions limit, an unsupported steps limit, and a completed reply missing its pending call. See [GAPS.md](GAPS.md#pe3-04-leaving-a-call-open-is-not-a-limit).

Set `TMPDIR="$HOME/.cache/modular-agent-rs-tmp"`, build with `mise exec -- cargo build --locked --offline -p modular-agent`, and use `a="$PWD/target/debug/modular-agent"`. The ACP runs use the two-plugin `MODULAR_AGENT_PLUGINS` setting below with the indicated Runtime part and `provider,hooks`. Run each host with `node conformance/acp/run.mjs --crash-checks --plugin-checks --probe-checks -- <host command>` using the host commands below. The standalone Plugin kit uses `node conformance/plugin/run.mjs -- "$a" --serve-plugin` with `MODULAR_AGENT_PLUGINS` unset. Kits ran one at a time.

| ACP host | `durable-runtime` | `runtime` |
| --- | --- | --- |
| TypeScript | 190/190 | 190/190 |
| Python | 190/190 | 190/190 |
| Go | 190/190 | 190/190 |
| Elixir | 184/184 | 184/184 |
| Rust | 190/190 | 190/190 |

All runs exited 0. Elixir did not declare the combination that enables late-question checks, so these runs do not verify late questions on that host. The other four hosts passed that check with both Runtime parts. Before the fix, TypeScript with `durable-runtime` passed 189/190 and reported `{"kind":"limit","limit":"questions"}` for the late question's original turn. The standalone Plugin kit passed 139/139. `mise exec -- cargo test --workspace --locked --offline --no-fail-fast -- --test-threads=1` passed 232 tests with none failed or ignored, both with the default Provider and with `--features modular-agent/stateful-provider-default` before the test argument separator. Matrix and workspace logs are under `$TMPDIR/late-question`, with the original TypeScript failure in `$TMPDIR/late-question-before.log`. No live inference ran. `docs/` and `conformance/` were not changed.

### Original edition 3 verification

Rust now writes operator grants and scoped receipts, keeps real source ids when it imports calls, and honors `MODULAR_AGENT_ACTOR`. The host returns its committed result on a tool gate refusal and accepts extra Provider response fields without treating them as hook inputs. Recovery commits the step gate and settles unsafe calls before handing off. The Runtime checks the handoff against history. See [GAPS.md](GAPS.md#production-edition-3).

Run from the repository root, with the kit snapshot at `c18907a`. The scratch directory and logs are under `$HOME/.cache/modular-agent-rs-tmp`. No real model calls were made.

```sh
export TMPDIR="$HOME/.cache/modular-agent-rs-tmp"
mkdir -p "$TMPDIR"
mise exec -- cargo build --locked --offline
mise exec -- cargo test --workspace --locked --offline --no-fail-fast -- --test-threads=1
a="$PWD/target/debug/modular-agent"
node conformance/plugin/run.mjs -- "$a" --serve-plugin
```

For each ACP Runtime run, set the two configured plugins and run the kit against the selected host:

```sh
export MODULAR_AGENT_PLUGINS=$(jq -nc --arg a "$a" --arg part durable-runtime '
  [{command:[$a,"--serve-plugin"],env:{MODULAR_AGENT_PLUGIN_PARTS:$part}},
   {command:[$a,"--serve-plugin"],env:{MODULAR_AGENT_PLUGIN_PARTS:"provider,hooks"}}]')
node conformance/acp/run.mjs --crash-checks --plugin-checks --probe-checks -- "$a" --acp
node conformance/acp/run.mjs --crash-checks --plugin-checks --probe-checks -- "$HOME/Code/modular-agent-go/bin/modular" --mode acp
```

For the transient self-test, set `part` to `runtime` in the same command. For portable runs, unset `MODULAR_AGENT_PLUGINS`. For each pair, create a new disposable history directory and token file, then run:

```sh
node /tmp/ma-tools/history-service/serve.mjs '{"dir":"<fresh store>","token":"<disposable token>","leaseMs":15000}'
```

With `MODULAR_AGENT_HISTORY_URL` set to the printed URL, `MODULAR_AGENT_HISTORY_TOKEN_FILE` set to the token file, and `MODULAR_AGENT_RUNTIME=durable`:

```sh
node conformance/acp/run.mjs --crash-checks --portable-checks --job-checks -- <writer command> --then <reopener command>
node conformance/history/run.mjs "$MODULAR_AGENT_HISTORY_URL" "$MODULAR_AGENT_HISTORY_TOKEN_FILE"
```

The portable kit sets both the shared and different principals itself. Commands used for the writer and reopener: Rust `"$a" --acp`; TypeScript `node "$HOME/Code/modular-agent/packages/agent/dist/src/cli.js" --acp`; Go `"$HOME/Code/modular-agent-go/bin/modular" --mode acp`; Python `"$HOME/Code/modular-agent-py/.venv/bin/modular-agent" --mode acp --process-plugins ''`; Elixir `"$HOME/Code/modular-agent-ex/bin/agent"`. The service for each run was stopped by PID before starting the next kit.

| Verification | Result | Log |
| --- | --- | --- |
| Rust workspace, serial | 231 passed, 0 failed, exit 0 | `round7-workspace.log` |
| ACP and restart tests after the final proposal projection fix | 18 passed, 0 failed, exit 0 | `complete-focused.log` |
| Plugin kit, Rust | 139/139, exit 0 | `plugin.log` |
| History HTTP kit, disposable supplied service | 39/39, exit 0; optional service restart not requested | `history.log` |
| ACP with Rust host and Rust durable plugin | 189/189, exit 0 | `verified-runtime-rust.log` |
| ACP with Rust host and Rust transient plugin | 189/189, exit 0 | `verified-runtime-rust-runtime.log` |
| Runtime E, Go host with Rust durable plugin | 189/189, exit 0 | `verified-runtime-go.log` |
| Portable Rust to Rust | 152/152, exit 0 | `complete-portable-rust-rust.log` |
| Portable TypeScript to Rust | 152/152, exit 0; originally 149/150 with virtual sources | `portable-ts-rust.log` |
| Portable Go to Rust | 152/152, exit 0 | `portable-go-rust.log` |
| Portable Elixir to Rust | 152/152, exit 0 | `portable-ex-rust.log` |
| Portable Rust to Elixir | 152/152, exit 0, including both key scopes and grant provenance | `job-input-portable-rust-ex.log` |
| Portable Python to Rust | 152/152, exit 0 | `complete-portable-py-rust.log` |

The focused rerun used `mise exec -- cargo test --locked --offline -p modular-agent --test acp_binding --test m3_restarts -- --test-threads=1`.

The first Python run was 110/119. On rerun the writer-side errors were gone. The remaining 151/152 result exposed a Rust projection error: ACP proposals showed the internal job identity for an imported parked report. The last run passed with the same portable actor in the report and proposal.

## Production edition 2

This round updates the lease bound and deadline, wire JSON framing, ACP close and question gating, remote Provider checkpoints, Runtime tool settlement, result feedback, restart filtering and rewind journaling. Portable reopen now keeps job cleanup markers, parked report attribution and tombstoned hand-back identities. The declarations were not narrowed to skip checks. See [GAPS.md](GAPS.md) for the specification choices and resolved findings.

### Workspace follow-up

The Rust wrappers now check the edition 2 totals and run the supplied kits one at a time. A concurrent command no longer blocks its tracer by inheriting a locked command journal descriptor. The regression command in [GAPS.md](GAPS.md) failed before the fix and passed afterward. The ACP kit refresh arrived as `4fa141d`. The Harness still leaves unauthorized tools out of its offer. No new live model run was needed.

The follow-up exports `TMPDIR="$PWD/target/pe2-green/tmp"` from the repository root, with Cargo output still under `target/`. Build with `mise exec -- cargo build --locked --offline -p modular-agent` (exit 0). Set `a="$PWD/target/pe2-green/modular-agent"` and `cp target/debug/modular-agent "$a"`. The following standalone and portable checks passed both before and after the kit refresh. The log paths below are from the refreshed runs. Run with `MODULAR_AGENT_PLUGINS` and `MODULAR_AGENT_PLUGIN_PARTS` unset:

- From the root, `node conformance/plugin/run.mjs -- "$a" --serve-plugin`: 139/139, exit 0 (`target/pe2-green/plugin.log`).
- For each portable run, create a fresh `scratch` directory and a disposable token, write it to `$scratch/token`, and start `node /tmp/ma-tools/history-service/serve.mjs "{\"dir\":\"$scratch/store\",\"token\":\"$token\",\"leaseMs\":15000}"`. Set `MODULAR_AGENT_HISTORY_URL` to the printed URL and `MODULAR_AGENT_HISTORY_TOKEN_FILE` to `$scratch/token`. From `conformance/acp`, run `node run.mjs --crash-checks --portable-checks --job-checks -- "$a" --acp --runtime "$runtime" --then "$a" --acp --runtime "$runtime"`. With `runtime=transient`, 150/150, exit 0 (`target/pe2-green/portable-transient.log`). With `runtime=durable`, 150/150, exit 0 (`target/pe2-green/portable-durable.log`). Each service was stopped by PID before the next run.

With the refreshed kit, `node run.mjs --crash-checks --plugin-checks --probe-checks --job-checks -- "$a" --acp` from `conformance/acp` passed 199/199 and exited 0 in each local configuration. Set `MODULAR_AGENT_PLUGINS` to an array containing `{"command":["<absolute agent path>","--serve-plugin"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"provider,hooks"}}`. The other two runs added a second object with `durable-runtime` and `tools,environment`, respectively. Logs are `target/pe2-green/refreshed-local-*.log`. The refreshed ceiling and Runtime probes and the remote point preflight all passed.

The default full-suite baseline at `6b8586e` exited 101 with 222 passed and six failed (`target/pe2-green/baseline-default.log`). Five failures were stale wrapper counts. After the Rust fixes and before the kit refresh, all four runs had one failed Rust test, `supplied_acp_kit_with_two_external_plugins_is_mandatory`, because the unrefreshed ACP kit passes 118/120 and fails just the two ceiling checks in PE2-01. The earlier rewind failures did not recur. All nested Plugin kits passed. No workspace test was skipped or ignored.

| Workspace command | Before kit refresh | On `4fa141d` | Log suffix |
| --- | --- | --- | --- |
| `mise exec -- cargo test --workspace --locked --offline --no-fail-fast` | 228 passed, 1 failed, exit 101 | 229 passed, 0 failed, exit 0 | `TS.log` |
| `mise exec -- cargo test --workspace --locked --offline --no-fail-fast --features modular-agent/durable-default` | 227 passed, 1 failed, exit 101 | 228 passed, 0 failed, exit 0 | `DS.log` |
| `mise exec -- cargo test --workspace --locked --offline --no-fail-fast --features modular-agent/stateful-provider-default` | 228 passed, 1 failed, exit 101 | 229 passed, 0 failed, exit 0 | `TF.log` |
| `mise exec -- cargo test --workspace --locked --offline --no-fail-fast --features modular-agent/durable-default,modular-agent/stateful-provider-default` | 227 passed, 1 failed, exit 101 | 228 passed, 0 failed, exit 0 | `DF.log` |

Logs are `target/pe2-green/workspace-*.log` before the kit refresh and `target/pe2-green/refreshed-workspace-*.log` afterward. `mise exec -- cargo fmt --all -- --check` and `git diff --check` passed. This follow-up did not edit `docs/` or `conformance/`; the kit changes came from the synced commit.

### Checkpoint at `6b8586e`

Verification uses a disposable `TMPDIR` under `target/`, since the machine's `/tmp` reached its user quota during the first runs. `docs/` and `conformance/` were not changed. Recovery changed enough to repeat the live crash check. `TMPDIR="$PWD/target/pe2/tmp" python3 -u scripts/real-crash.py` passed with `gpt-6-luna`: bash stopped after the agent was killed by PID, its interrupted result was unknown, and the reopened turn read the receipt without dispatching the command again. See `target/pe2/real-crash.log`.

From the repository root, build with `mise exec -- cargo build --locked --offline -p modular-agent` and copy `target/debug/modular-agent` to an absolute path `a`. For the Plugin kit run `node conformance/plugin/run.mjs -- "$a" --serve-plugin`. The isolated rerun passed 139/139 (`target/pe2-done/plugin-standalone.log`).

For the local kit, from `conformance/acp`, run `node run.mjs --crash-checks --plugin-checks --probe-checks --job-checks -- "$a" --acp`. Set `MODULAR_AGENT_PLUGINS` to an array with `{"command":["<absolute agent path>","--serve-plugin"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"provider,hooks"}}`. For the second and third runs add another such object, with `durable-runtime` and `tools,environment` respectively. Each configuration passed 195/199 in `target/pe2-done/local-*.log` after optional project instructions stopped blocking a point-only environment. The four remaining checks are two ceiling outcomes, refusal of a registered but unoffered tool, and the latched limit at prepare. See PE2-01 and PE2-03.

For each portable run, unset `MODULAR_AGENT_PLUGINS`, start `node /tmp/ma-tools/history-service/serve.mjs '{"dir":"<fresh store>","token":"<disposable test token>","leaseMs":15000}'`, and set `MODULAR_AGENT_HISTORY_URL` and `MODULAR_AGENT_HISTORY_TOKEN_FILE` to the printed URL and the test token file. From `conformance/acp` run `node run.mjs --crash-checks --portable-checks --job-checks -- "$a" --acp --runtime "$runtime" --then "$a" --acp --runtime "$runtime"`. Both `runtime=transient` and `runtime=durable` passed 150/150 against the refreshed service (`target/pe2-report/kits-*.log`). The service for each run was stopped by PID. The matrix did not run an independent build.

The workspace commands use `mise exec -- cargo test --workspace --locked --offline --no-fail-fast`, alone, then with `--features modular-agent/durable-default`, `--features modular-agent/stateful-provider-default` and `--features modular-agent/durable-default,modular-agent/stateful-provider-default`. All four workspace runs exited 101. The runs in `target/pe2/workspace-*.log`, in the order above, finished with 215 passed and 13 failed, 214 and 13, 219 and 9, and 219 and 8. The latter two compiled after the fix to preserve tool registration on load. A focused rerun after that fix passed all 22 tests: `mise exec -- cargo test --locked --offline -p modular-agent --test crashes --test m3_restarts --test swap --test rewind_journal --test portable_sessions -- --test-threads=1`. The focused approval expiry, remote point, ACP depth and typed read-error tests also passed. A later full rerun in `target/pe2-done/workspace-*.log` exited 101 in each configuration, with 221 passed and 7 failed, 220 and 7, 222 and 6, and 221 and 6 respectively. The first two included the too-broad optional read fallback; the later two compiled after it was narrowed. The nested ACP kit failures remain. The standalone Plugin kit passed 139/139 in isolation but timed out in a background-command case when run alongside the workspace and local matrices.

## Production edition

This is a committed implementation checkpoint, not a production conformance claim. `docs/` and `conformance/` are unchanged. See the Production edition section of [GAPS.md](GAPS.md) for the specification and kit findings, the choices, and the swap tests.

- Local Harness: the fake-Provider read test checks the order and identity of the model and tool checkpoints. The initial focused core run passed 25 checks across `turns`, `recovery_boundaries` and `history`.
- History client: uses a suspension-aware local lease cutoff on Linux, rejects late renewal success, follows page cursors, and preflights fork size. `mise exec -- cargo test --locked --offline -p history-http` passed. The production service refresh marker arrived after the first portable verification. Both portable selections were rerun on the refreshed service. This checkout does not serve the history wire, so the history service kit was not used as a client test.
- ACP: both versions negotiate, and the minimum and crash selections pass on local history. Recorded actor rights no longer reset on open. Joining does not confer representation. ACP rejects a non-quiescent move, gates load before replay and reports erased duplicate keys without old admission metadata.
- Plugin: all served selections, including both Runtimes, pass the standalone kit. The Runtime plugin pairs retries with new ids and uses the final steering checkpoint. On the host side, the host records model offers and tool settlements and records an unsafe recovered call before fresh inference. The full host probe selection still fails.
- Portable: both Runtimes reopen the tested crash case, preserve keyed erasure in that scenario and pass the fork size refusal. The refreshed service passes the tombstoned hand-back check. The rewind journal, off-branch cleanup and parked report checks still fail. No independent cross-build swap was run under the clean-room restriction.
- Production deployment acceptance, complete authority and resource limits, and the outstanding host checkpoint work are not done. The current declarations are under test, not production assurances.

### Verification

Build command: `mise exec -- cargo build --locked --offline -p modular-agent`. I copied the binary to `/home/danballance/Code/modular-agent-rs/target/r7/modular-agent`; `a` below is that absolute path.

| Command or selection | Result |
| --- | --- |
| `node conformance/plugin/run.mjs -- "$a" --serve-plugin` from the root | 133/133 |
| `node run.mjs -- "$a" --acp` from `conformance/acp` | 100/100 |
| `node run.mjs --crash-checks -- "$a" --acp` from `conformance/acp` | 107/107 |
| Local full ACP, served `provider,hooks` | 177/186 |
| Local full ACP, adding served `durable-runtime` | 177/186 |
| Local full ACP, adding served `tools,environment` instead | 177/186 |
| `node run.mjs --plugin-checks --job-checks -- "$a" --acp`, served `provider,hooks` and `tools,environment` | 116/116 |
| Portable full ACP before the service refresh, both Runtime selections | 139/144 each |
| Portable full ACP on the refreshed service, transient to transient | 140/144 |
| Portable full ACP on the refreshed service, durable to durable | 140/144 |

The local full command from `conformance/acp` was:

```sh
node run.mjs --crash-checks --plugin-checks --probe-checks --job-checks -- "$a" --acp
```

Set `MODULAR_AGENT_PLUGINS` to one launch object per selection: `{"command":["<absolute path to a>","--serve-plugin"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"<selection>"}}`. Each run used its own kit workspace. All three local full runs missed the same nine assertions: the refresh barrier, discovery of the refreshed tool, visibility of the in-turn and late questions, acknowledgement of a matching committed result, dispatch registration provenance, refusal of a registered but unoffered tool, the latched limit at prepare, and preserving a result across failed refresh.

For each portable run I unset `MODULAR_AGENT_PLUGINS`, created a fresh disposable store and 32-character hex test token, and started `node /tmp/ma-tools/history-service/serve.mjs "{\"dir\":\"$scratch/store\",\"token\":\"$token\",\"leaseMs\":15000}"`. I set `MODULAR_AGENT_HISTORY_URL` to the printed URL and `MODULAR_AGENT_HISTORY_TOKEN_FILE` to the token file. From `conformance/acp` I ran the following command with `runtime=transient` and then `runtime=durable`, on separate services, and stopped each service by PID.

```sh
node run.mjs --crash-checks --portable-checks --job-checks -- "$a" --acp --runtime "$runtime" --then "$a" --acp --runtime "$runtime"
```

The refreshed service fixed the tombstoned batch hand-back assertion. The four remaining portable failures are the two-record rewind journal, the off-branch cleanup marker, and listing and releasing the parked report. These remain failures on the refreshed service. The 15-second TTL did not exercise the kit's delayed-renewal case; the offline lease test exercises that cutoff. The refreshed runs are in `target/r7/refreshed-transient.log` and `target/r7/refreshed-durable.log`.

For the offline workspace suite the four commands and exit results were:

| Command | Passed | Failed |
| --- | ---: | ---: |
| `mise exec -- cargo test --workspace --locked --offline --no-fail-fast` | 204 | 8 |
| `mise exec -- cargo test --workspace --locked --offline --no-fail-fast --features modular-agent/durable-default` | 203 | 8 |
| `mise exec -- cargo test --workspace --locked --offline --no-fail-fast --features modular-agent/stateful-provider-default` | 202 | 10 |
| `mise exec -- cargo test --workspace --locked --offline --no-fail-fast --features modular-agent/durable-default,modular-agent/stateful-provider-default` | 203 | 8 |

All four exited 101. The eight common failures are the old approval-lifetime assertion, the failed-refresh assertion, the exact served bash output assertion, both served Runtime cancellation fixtures, the served portable recovery rights case, the legacy handed-back receipt shape, and the reused-id transport test. The transient stateful run also failed a proposal test with broken pipe and a plugin kit test that did not finish the environment section or shut down within its limits. Standalone plugin verification passed. Logs and the disposable test launcher are under `target/r7/`. `mise exec -- cargo fmt --all --check` and `git diff --check` passed.

### Real run

`python3 -u scripts/real-crash.py` passed with `gpt-6-luna` on 2026-11-18. The durable Runtime recorded a bash dispatch, and the script killed only the agent PID with `kill -9` after observing bash running. The managed bash stopped. Reopening without input committed `outcomeUnknown` for that call, did not repeat it, read `receipt.txt`, and completed the original turn with “The receipt contains `copper-river-83`; this turn recovered from interruption.” The retained evidence is [evidence/production-real-crash.json](../../evidence/production-real-crash.json). Earlier script attempts failed on obsolete history entry names and interactive EOF behavior; the successful run used the shared history shapes and noninteractive reopen.

## Round six follow-up: proposal content and refused calls

ACP lists proposals as shared content parts. The original admission and the release both record that shape as `inputAccepted`. Older text receipts are mapped to the same shape, and turn hooks still contribute context when an input is taken. Refused tool results say the call did not run and give the reason. An offline test checks what both the in-process and served Runtimes put in history and send to the model.

| Verification | Result |
| --- | --- |
| Workspace, transient Runtime and stateless Provider | 212 passed |
| Workspace, durable Runtime and stateless Provider | 211 passed |
| Workspace, transient Runtime and stateful Provider | 212 passed |
| Workspace, durable Runtime and stateful Provider | 211 passed |
| Plugin kit | 111/111 |
| Local ACP kit, served `provider,hooks` | 130/130 |
| Local ACP kit, also served `durable-runtime` | 130/130 |
| Local ACP kit, also served `tools,environment` | 130/130 |
| Local ACP kit, all three selections | 130/130 |
| Portable ACP kit, transient to transient | 102/102 |
| Portable ACP kit, durable to durable | 102/102 |

Run the four locked, offline workspace commands below. Build in `target/` with `mise exec -- cargo build -p modular-agent --locked --offline`, then again with `--features modular-agent/durable-default`. Save a copy of each binary. Use the plugin and ACP commands in the Round six section with the new binary paths. Both portable runs use a fresh local history service and pass `--crash-checks --portable-checks --job-checks`. The commands and logs for this run are under `target/r6-content/`.

Formatting and diff checks passed. Strict Clippy stopped on two existing lints in `crates/agent-api/src/portable.rs`. No real model ran, no new specification gaps were found, and the kits and frozen snapshot are unchanged. The supervisor can rerun the cross-build matrix with these fixes.

## Round six follow-up: gate echoes and redacted entries

The output gate now compares numbers by value and keeps the host's original JSON wherever the gate did not change a string. The captured wire showed 2,865 `response` entries and 2,021 `turnEnd` entries that came back equal by value, with their cost written as `0` rather than `0.0`. The fake echo gate also reorders object keys and verifies that both entry kinds stay in ACP history and that the response replays. A second fake gate redacts text inside a live `turnEnd` entry. The Interface gets the redaction without losing details such as the step count, and the record is unchanged.

| Verification | Result |
| --- | --- |
| Workspace, transient Runtime and stateless Provider | 211 passed |
| Workspace, durable Runtime and stateless Provider | 210 passed |
| Workspace, transient Runtime and stateful Provider | 211 passed |
| Workspace, durable Runtime and stateful Provider | 210 passed |
| Plugin kit | 111/111 |
| Local ACP kit, served `provider,hooks` | 129/129 |
| Local ACP kit, also served `durable-runtime` | 129/129 |
| Local ACP kit, also served `tools,environment` | 129/129 |
| Local ACP kit, all three selections | 129/129 |
| Portable ACP kit, transient to transient | 101/101 |
| Portable ACP kit, durable to durable | 101/101 |

Set `CARGO_TARGET_DIR=/tmp/ma-rs-r6fix-target` for all Cargo commands. Run the four locked, offline workspace commands below. Build with `mise exec -- cargo build -p modular-agent --locked --offline` and again with `--features modular-agent/durable-default`. Save the builds as `debug/modular-agent-transient` and `debug/modular-agent-durable` under the isolated target directory. Run the plugin and ACP commands in the Round six section with these paths. The exact commands and results are in `/tmp/ma-rs-r6fix-target/verify.sh` and `/tmp/ma-rs-r6fix-target/verified/`.

No live model ran. The follow-up adds no specification gaps and does not change the kits, frozen docs, or the supervisor's `target/` build. A new cross-build matrix is for the supervisor.

## Round six

ACP declares `sessionLimits` and `tenants`. Session and tenant ceilings narrow effective rights, including the next action of running work. Tenant membership is the first entry and is checked on reopen. Budgets count recorded usage across sessions and stop a turn before a new model request when the budget is spent. ACP also lists and withdraws proposals, accepts explicit presence on join, and returns `handedBack` for declined releases.

External gates receive the shared event shapes. The served gate redacts a secret across pieces of a stream and in nested strings, including in a plugin's own event type. ACP uses `-32000` with `data.code: "withheld"` for a blocked reply. A duplicate plugin name is refused during registration. The round also covers recorded job rights, report admission before job acknowledgement, rewind order and rollback, open-world calls, lowered reasoning, cancellation after a callback failure, and the history page size boundary. Offline regressions exercise the edges the kits do not cover. See the Round six section of GAPS.md, including the kit assertion that checks for a response when it claims to check for a request.

| Verification | Result |
| --- | --- |
| Workspace, transient Runtime and stateless Provider | 206 passed |
| Workspace, durable Runtime and stateless Provider | 205 passed |
| Workspace, transient Runtime and stateful Provider | 206 passed |
| Workspace, durable Runtime and stateful Provider | 205 passed |
| Plugin kit | 111/111 |
| Local ACP kit, served `provider,hooks` | 129/129 |
| Local ACP kit, also served `durable-runtime` | 129/129 |
| Local ACP kit, also served `tools,environment` | 129/129 |
| Local ACP kit, with all three served selections | 129/129 |
| Portable ACP kit, transient to transient | 101/101 |
| Portable ACP kit, durable to durable | 101/101 |

From the root, run the four locked, offline workspace commands below. Build with `mise exec -- cargo build -p modular-agent --locked --offline` and again with `--features modular-agent/durable-default`, copying the artifacts to `/tmp/ma-r6-transient` and `/tmp/ma-r6-durable` respectively. Run `node conformance/plugin/run.mjs -- /tmp/ma-r6-transient --serve-plugin`.

From `conformance/acp`, run `node run.mjs --crash-checks --plugin-checks --probe-checks --job-checks -- /tmp/ma-r6-transient --acp`. Set `MODULAR_AGENT_PLUGINS` to an array with one launch object for each selection in that run. Each launch object uses `command: ["/tmp/ma-r6-transient", "--serve-plugin"]` and `env: {"MODULAR_AGENT_PLUGIN_PARTS": "<selection>"}`.

For each portable run, unset `MODULAR_AGENT_PLUGINS`, run `node /tmp/ma-tools/history-service/serve.mjs '{"dir":"<empty folder>","token":"round-six-test-token","leaseMs":15000}'`, and put that token in a file. Set `MODULAR_AGENT_HISTORY_URL` to the printed URL and `MODULAR_AGENT_HISTORY_TOKEN_FILE` to the token file. From `conformance/acp`, run `node run.mjs --crash-checks --portable-checks --job-checks -- "$agent" --acp --then "$agent" --acp` with each binary. Stop each service by PID at the end of its run.

No live model was run. The kits and frozen description are unchanged. A cross-build swap run is outside this Rust-only round.

## Round five follow-up: unused sessions after an external rewind

The failure reported under the ACP kit's unused-session check was in `session/new`, before the close. A working environment can restore a saved point by replacing the project directory. The agent then has no usable process working directory, even though the project path still works. Plugin loading and its hook payload now use the project path from the composition. The regression uses a fake environment, keeps the point with `_` and `-` unchanged in history and on restore, and checks that an unused session closes without leaving a history file. See GAPS.md, R5-04.

| Verification | Result |
| --- | --- |
| Workspace, transient Runtime and stateless Provider | 199 passed |
| Workspace, durable Runtime and stateless Provider | 198 passed |
| Workspace, transient Runtime and stateful Provider | 199 passed |
| Workspace, durable Runtime and stateful Provider | 198 passed |
| Plugin kit | 109/109 |
| Local ACP with `provider,hooks`, alone and with `durable-runtime`, `tools,environment`, or both | 109/109 each |
| Portable ACP, durable to durable and transient to transient | 86/86 each |
| Local ACP replay with the directory-replacing fake environment | 100/100; before the fix, the unused-session check returned OS error 2 |

The focused command is `mise exec -- cargo test --locked --offline -p modular-agent --test plugin_binding unused_acp_session_closes_after_an_external_rewind_replaces_the_project -- --exact`. Run the four locked, offline workspace commands below. Build with `mise exec -- cargo build -p modular-agent --locked --offline` and again with `--features modular-agent/durable-default`, saving a separate copy of each binary.

Run `node conformance/plugin/run.mjs -- "$agent" --serve-plugin` from the root with the transient binary. From `conformance/acp`, run `node run.mjs --crash-checks --plugin-checks --probe-checks --job-checks -- "$agent" --acp` with that binary and each plugin selection in the table. Set `MODULAR_AGENT_PLUGINS` to the launch objects for the same binary with `--serve-plugin` and `MODULAR_AGENT_PLUGIN_PARTS` set per object. For portable runs, unset `MODULAR_AGENT_PLUGINS`, start the supplied history service with an empty store and 15-second lease per run, and set `MODULAR_AGENT_HISTORY_URL` and `MODULAR_AGENT_HISTORY_TOKEN_FILE`. Run `node run.mjs --crash-checks --portable-checks --job-checks -- "$agent" --acp --then "$agent" --acp` with each binary.

The kits and frozen docs are unchanged. No real model ran and no other build was used. A cross-build rerun belongs to the supervisor.

## Round five

Implemented ACP /2 failed-turn errors and the several-actor extensions. Proposed input waits for release and does not inherit the releaser's stronger tool rights. The working environment records saved points and the Harness uses them for rewind. The external plugin host routes jobs, gates output by complete stream and honors parent-linked tool changes. The served conformance plugin adds saved points, output redaction and the `fail:` model response. Shared history now covers admission, handback, model requests, context, active plugins, jobs, question closure, approval and erased identities. Reopening with an unavailable recorded model does not silently select another.

| Verification | Result |
| --- | --- |
| Workspace, transient Runtime and stateless Provider | 198 passed |
| Workspace, durable Runtime and stateless Provider | 197 passed |
| Workspace, transient Runtime and stateful Provider | 198 passed |
| Workspace, durable Runtime and stateful Provider | 197 passed |
| Plugin kit | 109/109 |
| Local ACP kit, served `provider,hooks` | 109/109 |
| Local ACP kit, also served `durable-runtime` | 109/109 |
| Local ACP kit, also served `tools,environment` | 109/109 |
| Portable ACP kit, transient Runtime in both agents | 85/85 |
| Portable ACP kit, durable Runtime in both agents | 85/85 |

Run the four locked, offline Cargo commands below. The plugin kit command is `node conformance/plugin/run.mjs -- /tmp/ma-rs-round5-transient --serve-plugin`. From `conformance/acp`, the local command is `node run.mjs --crash-checks --plugin-checks --probe-checks --job-checks -- /tmp/ma-rs-round5-transient --acp`. In each run, `MODULAR_AGENT_PLUGINS` loads that executable with `--serve-plugin` and the parts listed in the table. For each portable run, start the supplied history service with an empty data folder and a 15-second lease. From `conformance/acp`, set `MODULAR_AGENT_HISTORY_URL` and `MODULAR_AGENT_HISTORY_TOKEN_FILE` and run `node run.mjs --crash-checks --portable-checks --job-checks -- "$agent" --acp --then "$agent" --acp`, with `agent` set to `/tmp/ma-rs-round5-transient` or `/tmp/ma-rs-round5-durable`.

The binaries are workspace builds with no extra feature for transient and with `--features modular-agent/durable-default` for durable. No live model run was made. This matrix uses only the Rust build and the supplied fixtures. The round-five gaps and choices are in GAPS.md. Point portability and history service erasure remain separate from the successful same-build swap checks.

## After the supervisor's full matrix

The plugin host accepts null history cursors and other optional fields. The served durable Runtime accepts a null final page cursor. Optional shared history fields now take the same defaults when null or missing. Rust's served Runtime sends the result beside the outcome in `turn.end`, and the host passes both to observers. ACP records the connection's actor before recovery or new input, without replacing actors that another agent wrote. The host no longer records a failed turn when a cancelled callback leads a Runtime to report failure during a host-requested cancel. See GAPS.md, R5-01 through R5-03.

| Verification | Result |
| --- | --- |
| Cargo workspace, transient default, each Provider mode | 193 passed each |
| Cargo workspace, durable default, each Provider mode | 192 passed each |
| Plugin kit | 105/105 |
| ACP with Provider and hooks plugin | 73/73 |
| ACP with Provider and hooks plus served durable Runtime | 73/73 |
| ACP with Provider and hooks plus external tools and environment | 73/73 |
| ACP with all three external plugins above | 73/73 |
| ACP with Provider and hooks plus served transient Runtime, repeated | 73/73 in all 12 runs |
| ACP HTTP history, durable to durable | 51/51 |
| ACP HTTP history, transient to transient | 51/51 |

Commands, from the repository root:

```sh
mise exec -- cargo test --workspace --locked --offline
mise exec -- cargo test --workspace --locked --offline --features modular-agent/durable-default
mise exec -- cargo test --workspace --locked --offline --features modular-agent/stateful-provider-default
mise exec -- cargo test --workspace --locked --offline --features modular-agent/durable-default,modular-agent/stateful-provider-default
mise exec -- cargo build -p modular-agent --locked --offline

# The kits used a copy so Cargo feature changes could not replace the binary.
check_dir=$(mktemp -d /tmp/ma-rs-round5.XXXXXX)
agent="$check_dir/modular-agent"
cp target/debug/modular-agent "$agent"
mkdir "$check_dir/home"
export HOME="$check_dir/home"
unset MODULAR_AGENT_HISTORY_URL MODULAR_AGENT_HISTORY_TOKEN_FILE MODULAR_AGENT_PLUGINS MODULAR_AGENT_PLUGIN_PARTS

node conformance/plugin/run.mjs -- "$agent" --serve-plugin

cd conformance/acp
part() {
  printf '{"command":["%s","--serve-plugin"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"%s"}}' "$agent" "$1"
}
base=$(part provider,hooks)
durable=$(part durable-runtime)
tools=$(part tools,environment)
for plugins in "$base" "$base,$durable" "$base,$tools" "$base,$durable,$tools"; do
  MODULAR_AGENT_PLUGINS="[$plugins]" node run.mjs --crash-checks --plugin-checks --probe-checks -- "$agent" --acp
done

transient=$(part runtime)
for run in {1..12}; do
  MODULAR_AGENT_PLUGINS="[$base,$transient]" node run.mjs --crash-checks --plugin-checks --probe-checks -- "$agent" --acp
done

# Still in conformance/acp. Start a separate supplied service for each Runtime.
http_dir=$(mktemp -d /tmp/ma-rs-http.XXXXXX)
for runtime in durable transient; do (
  umask 077
  token_file="$http_dir/token-$runtime"
  openssl rand -hex 32 > "$token_file"
  service_log="$http_dir/history-$runtime.log"
  node /tmp/ma-tools/history-service/serve.mjs "$(node -e 'const fs=require("fs"); console.log(JSON.stringify({dir:process.argv[1],token:fs.readFileSync(process.argv[2],"utf8").trim(),leaseMs:15000}));' "$http_dir/store-$runtime" "$token_file")" > "$service_log" 2>&1 &
  service_pid=$!
  trap 'kill "$service_pid" 2>/dev/null; wait "$service_pid" 2>/dev/null; rm -f "$token_file"' EXIT
  for _ in {1..100}; do [[ -s $service_log ]] && break; sleep 0.05; done
  export MODULAR_AGENT_HISTORY_URL=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).url' "$service_log")
  export MODULAR_AGENT_HISTORY_TOKEN_FILE="$token_file"
  node run.mjs --crash-checks --portable-checks -- "$agent" --acp --runtime "$runtime" --then "$agent" --acp --runtime "$runtime"
); done
```

The kits and snapshot were not changed. There was no live inference or new cross-build run. The foreign history and adverse Runtime replies came from local fixtures. Next: if the supervisor sees another failed cancel, compare the failing trace with the callback regression in R5-01.

## After the first portable-session swaps

A started call that does not run again gets one `outcomeUnknown` result, even when the actor no longer has `tools`. An eligible retry and a first run still go through the current checks. The standard-history regression covers both the native and served durable Runtimes: an unsafe bash call is not repeated, a safe retry is blocked, and a never-started call is refused. Actor records preserve unknown right names without granting authority for them.

The refreshed supplied history service now returns `retryAfterMs` with `409 held`. The client still accepts the older reply. See GAPS.md, R4-01 and R4-03.

| Verification | Result |
| --- | --- |
| Workspace suite, transient default | 190 passed in each Provider mode |
| Workspace suite, durable default | 189 passed in each Provider mode |
| Plugin kit | 105/105 |
| ACP local history, Provider and hooks plugin, crash and probe checks | 73/73 |
| ACP HTTP history, durable to durable | 51/51 |
| ACP HTTP history, transient to transient | 51/51 |

Use the four locked, offline Cargo commands below. Build the kit binary with `mise exec -- cargo build -p modular-agent --locked --offline`. With `agent` set to the absolute path to that binary, run these commands:

```sh
# From the repository root
node conformance/plugin/run.mjs -- "$agent" --serve-plugin

# From conformance/acp
MODULAR_AGENT_PLUGINS="$(printf '[{"command":["%s","--serve-plugin"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"provider,hooks"}}]' "$agent")" \
  node run.mjs --crash-checks --plugin-checks --probe-checks -- "$agent" --acp

# From conformance/acp, with MODULAR_AGENT_HISTORY_URL and
# MODULAR_AGENT_HISTORY_TOKEN_FILE exported for the supplied service
for runtime in durable transient; do
  node run.mjs --crash-checks --portable-checks -- "$agent" --acp --runtime "$runtime" \
    --then "$agent" --acp --runtime "$runtime"
done
```

No kit changes or live inference. The HTTP runs use fresh stores from `/tmp/ma-tools/history-service/serve.mjs` with a 15-second lease. Both agents in each pair use this Rust build. The test of a foreign record is the offline fixture, not a new cross-language swap.

## Round four

The served durable Runtime pages through `host/history`, recovers from standard entries written by another host, and does not send standard event reports. The host records the turn boundaries and emits the Provider stream itself. The local store writes the shared entry shapes, ACP declares `portableSessions: true`, and setting both `MODULAR_AGENT_HISTORY_URL` and `MODULAR_AGENT_HISTORY_TOKEN_FILE` selects the HTTP history store. The original supplied service omitted `retryAfterMs`. The client uses it when present and otherwise polls within the declared lease lifetime. Neither kit was changed.

| Verification | Result |
| --- | --- |
| Workspace suite, transient default | 189 passed in each Provider mode |
| Workspace suite, durable default | 188 passed in each Provider mode |
| Plugin kit, including fresh-process Runtime recovery | 105/105 |
| ACP local history, Provider and hooks plugin, crash and probe checks | 73/73 |
| ACP local history, also with the served durable Runtime | 73/73 |
| ACP HTTP history, transient to durable and durable to transient | 51/51 in each direction |

Run the four locked, offline Cargo commands below. The Rust suite also tests a record containing only standard entries, HTTP lease waiting and loss, oversized plugin history pages, and stateful external Provider erasure. The separate kit commands are `node conformance/plugin/run.mjs -- <agent> --serve-plugin` from the root and `node run.mjs --crash-checks --plugin-checks --probe-checks -- <agent> --acp` from `conformance/acp` with the indicated plugins. For HTTP, start the supplied history service with a fresh directory and a 15-second lease, export the URL and token file, and run `node run.mjs --crash-checks --portable-checks -- <first-agent> --acp --then <second-agent> --acp` in both directions. The full matrix used two Rust binaries and a separately authored standard history fixture, not another clean-room build.

Live proof: `python3 scripts/real-portable-crash.py` used only stateless OpenAI gpt-6-luna and the supplied HTTP service with a 15-second lease. It read proof.txt and answered indigo-acorn-47. The next turn started bash; the script ran `kill -9 2300291` against the agent PID while bash PID 2300329 was live. PID 2300332 reopened the same session with the served durable Runtime. Reopening and recovery took 16.61 seconds. Bash was not repeated and had one outcomeUnknown result. The model read proof.txt again and completed the same turn: “indigo-acorn-47. The command was interrupted before finishing, so its outside effects are unknown.” An earlier attempt reached the live bash call but reopening with stdin at EOF hit an unopened-session error. The recorded proof used noninteractive `--history` to reopen without new input. See `evidence/r4-real-portable-crash.json`.

Next: a supervised cross-build swap can exercise model and actor identity, suspended questions, and more of the portability gaps in `GAPS.md`. This round stops here.

## Status

**Plugin binding stage 2 and the Rust host cancellation correction are complete.** The conformance server offers the transient and durable Runtimes. The Harness can use a separate-process Runtime in place of its native turn runner. Runtime callbacks are scoped to their pending turn request and use the selected model, hook handlers, tools, history and output gate. Runtime checkpoints are in the host's history. ACP reopening starts a fresh plugin process and sends resumeTurn for the interrupted turn. Direct UI tool calls keep their existing local mediated path because the wire binding has no request for them.

| Offline proof | Result |
| --- | --- |
| Plugin kit, all parts | **84/84** |
| ACP crash checks, native Runtime | **49/49** |
| ACP crash checks, separate-process durable Runtime | **49/49** |
| ACP crash checks, separate-process transient Runtime | **49/49** |
| ACP plugin checks, separate Provider/hooks and tools/environment | **46/46** |

The proofs are required integration tests. The full suite passes **185/185** with the transient default and **184/184** with the durable default, in each Provider mode. No live inference, credentials, other-build inspection, subagents or T3 Code changes were used. The earlier milestones, stage 1, and the timeout, ACP history and missing-file swap fixes remain intact.

## Runtime matrix cancellation correction

The supervisor's real kill -9 and restart matrix passed 30 of 32 cells. In the cell assigned to Rust, the Python Runtime cancelled its own in-flight tool.before hook request and waited for a reply that the Rust host did not send. The host now answers a cancelled host/* request with a result or the error cancelled. It signals cooperative cleanup before replying where needed, cancels nested RPCs when it stops waiting for them, and still lets a cancelled Runtime make cleanup requests.

The regression in `crates/modular-agent/tests/plugin_binding.rs` uses the local stdio fixture to cancel a blocked host/runtime/hook and a blocked host/runtime/prepareStep. Before the fix the turn hit the timer at 5.004 seconds. After the fix the fixture receives both cancelled replies, can read host/history and can record turnEnd, and the host sees a cancelled turn within the test's three-second bound. A transport regression checks that dropping an in-flight outgoing call sends its own cancel. Run the turn regression with `mise exec -- cargo test -p modular-agent --test plugin_binding --locked --offline runtime_cancels_in_flight_host_callbacks_and_the_turn_ends_promptly`.

Commit `75e4c6b` contains the correction. The direct plugin and ACP kits and the four workspace configurations passed. The supplied kits and frozen docs were not edited. No test, plugin, fixture or command process remains. GAPS.md B-24 records the cancellation policy; B-18 and B-20 note the remaining Runtime recovery and streaming differences under the clarified binding. The cross-language matrix was not rerun in this Rust-only follow-up.

## Missing-file swap correction

The served env/read now returns not_found for a nonexistent file. The host's host/env/read returns the same code whether the working environment is local, this build's plugin or another external plugin. External env/read not_found errors become the same typed missing-file error as local I/O at the adapter boundary. Readers use that type, never the message. The system prompt reads AGENTS.md directly and ignores only a missing file, avoiding the earlier existence-check race.

Three added regressions pass. A turn completes with missing AGENTS.md under both local and external environments, including an external error with no English filesystem wording and an existence check that would report true. Other local or external read failures still fail the turn, even when the external message says "No such file". A separate tool plugin gets not_found from host/env/read through local, served and fixture environments. The external-AGENTS.md regression failed before the fix and passed afterward.

The direct plugin kit first reproduced the failure at 41/42, then passed 42/42 against target/debug/modular-agent --serve-plugin. The ACP kit passed 46/46 with --plugin-checks, hosting this build's provider/hooks and tools/environment in two processes. Both remain mandatory offline integration tests. All four full-suite configurations passed at 178 tests with the transient default and 177 with the durable default, with zero failed or ignored. Build, all-feature clippy, formatting and diff checks passed. The supplied kits and frozen docs were not edited. No test, plugin, fixture or command process from this run remains. No subagents, T3 Code settings changes, other-build inspection or live inference were used. B-17 records the clarified binding and internal normalization choice; no additional ambiguity was found.

## Earlier swap-matrix corrections

Both env/exec receivers now treat timeoutMs: 0 as no limit, just like null or omission. This covers the served environment and host/env/exec callbacks, whether the host selects a local or separate-process working environment. Positive values still stop commands and report timedOut: true. Native tools and the served conformance tools already omit the timeout for no limit; the native environment only receives cancellation tokens.

ACP _modular-agent/history now emits arguments on toolCall content blocks, retaining input as a legacy alias and the original stored data. Three new tests first reproduced the bugs, then passed: served exec, host forwarding with local and remote environments, and ACP history arguments. That follow-up updated the mandatory plugin-kit test from 39 to 41 checks; the missing-file correction above raises it to 42. No supplied kit or frozen docs were edited. No additional binding ambiguity was found beyond the already clarified zero timeout; B-16 records the separate implementation correction.

That follow-up passed the then-current plugin kit at 41/41 against --serve-plugin. ACP --plugin-checks passes 46/46 while hosting this build's plugin in two processes, provider/hooks and tools/environment. All four full-suite configurations and the static checks below pass. No test, plugin or command process remains. No subagents, T3 Code settings changes, other-build source inspection or live inference were used.

Refreshed ADR 0016 audit: existing local commands stop background children when a call ends, not at session close as the refreshed rule says. Existing local observe-hook failures still propagate. External observers now report and skip failures, including loss. Usage now adds cost and cache-write counters without changing old zero-usage serialization. Static tool-name conflicts are now refused at load, and per-session names are checked during preparation. The Runtime's step-after and turn-result hooks now use the required gate rule. The background-process lifetime policy is retained and declared, not expanded in this round. A full retrospective rules audit beyond the touched boundaries has not been claimed.

## Plugin commands for the swap matrix

Build once in this repository with the pinned Rust toolchain:

```sh
cd /home/danballance/Code/modular-agent-rs
mise exec -- cargo build --workspace --locked --offline
```

Exact serve command, runnable from any directory:

```sh
/home/danballance/Code/modular-agent-rs/target/debug/modular-agent --serve-plugin
```

`MODULAR_AGENT_PLUGIN_PARTS` selects from provider, tools, environment, hooks, runtime and durable-runtime. Unset means the first four. Select no more than one Runtime. The server never reads real credentials or invokes a model of its own. Stdio contains NDJSON JSON-RPC only. The reusable Endpoint runner can serve other adapters, but automatic export of every in-process Plugin is not provided.

Exact agent command, runnable from any directory:

```sh
/home/danballance/Code/modular-agent-rs/target/debug/modular-agent --acp
```

Set `MODULAR_AGENT_PLUGINS` on that command to host other builds' servers. The ACP client selects conformance/echo through the model configuration option. Each project-bound Harness starts its configured plugins in order after the local plugins. ACP already uses one Harness per open session; its child sessions share that composition. Plugin homes are under DATA_DIR/plugins. Processes receive shutdown, stdin closes and children are reaped before the composition finishes.

Exact proof commands, also runnable from any directory:

```sh
node /home/danballance/Code/modular-agent-rs/conformance/plugin/run.mjs -- /home/danballance/Code/modular-agent-rs/target/debug/modular-agent --serve-plugin

MODULAR_AGENT_PLUGINS='[{"command":["/home/danballance/Code/modular-agent-rs/target/debug/modular-agent","--serve-plugin"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"provider,hooks"}},{"command":["/home/danballance/Code/modular-agent-rs/target/debug/modular-agent","--serve-plugin"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"tools,environment"}}]' node /home/danballance/Code/modular-agent-rs/conformance/acp/run.mjs --plugin-checks -- /home/danballance/Code/modular-agent-rs/target/debug/modular-agent --acp
```

The first returns 84/84. The second returns 46/46, including the external gate's recorded refusal. The crash checks both return 49/49:

```sh
node /home/danballance/Code/modular-agent-rs/conformance/acp/run.mjs --crash-checks -- /home/danballance/Code/modular-agent-rs/target/debug/modular-agent --acp

MODULAR_AGENT_PLUGINS='[{"command":["/home/danballance/Code/modular-agent-rs/target/debug/modular-agent","--serve-plugin"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"durable-runtime"}}]' node /home/danballance/Code/modular-agent-rs/conformance/acp/run.mjs --crash-checks -- /home/danballance/Code/modular-agent-rs/target/debug/modular-agent --acp
```

The crash proof also passes 49/49 with MODULAR_AGENT_PLUGIN_PARTS set to runtime instead. These run as required tests in `crates/modular-agent/tests/plugin_binding.rs`. The self-authored Python fixture exercises host callbacks; it is not source from another build. No plugin, command, test or fixture process remains after checks.

## Earlier ACP round

The previous round implemented modular-agent-acp/1 only, not the HTTP history service. The unchanged supplied conformance kit passes **43/43 checks** with each of the four Runtime/Provider-mode combinations. It is also a required offline integration test in the workspace suite. Eight new ACP tests cover the kit, data-directory isolation, stateless conformance selection from stateful OpenAI without credentials, zero usage and Unicode result truncation, pending/duplicate input, cancellation and handed-back content, all stop-reason mappings, branch history, optional erasure/fork/move/jobs, and gated reasoning/replay. Existing ACP assertions follow the new metadata and open-call mapping; unsupported forms wait for extension answers rather than declining automatically. All four full-suite configurations and static checks pass. No live inference was run for this round.

Install the pinned kit dependency once with `cd conformance/acp && npm ci`. Node.js is now required for the full test suite. The kit runs with `node conformance/acp/run.mjs -- /absolute/path/to/target/debug/modular-agent --acp` after a workspace build.

All required work across milestones 1 through 5 is implemented. Stop at this milestone. The optional full-screen terminal UI is not built. Read AGENTS.md first, then ACCEPTANCE.md, GLOSSARY.md and the relevant frozen docs/. No other independent build was read. No helper subagents were started. No T3 Code settings were changed. Subagents exercised by tests are part of the built agent.

There are now 26 workspace crates, one per part. Local parts still call each other in process. The plugin-stdio crate adapts external Providers, tool sources, working environments, standard hook handlers, commands and Runtimes. The wire turn runner lives in runtime-engine and has no direct access to the host's services. External MCP servers and local commands remain subprocesses, not agent services. The Harness hosts plugins and owns sessions; it still does not run turns, inference or tools.

MILESTONE-1.md through MILESTONE-5.md map each milestone to acceptance evidence. ACP-BINDING.md describes this round's shared host surface, compatibility routes and test commands. DESIGN.md explains the implementation layout. SOURCES.md records library and published API sources. GAPS.md contains the description's missing or ambiguous contracts, decisions and swap tests.

## Build and check

Requires Linux, mise, pinned Rust 1.100.0, Python 3 for earlier fixtures, and Node.js/npm for the supplied ACP kit. Rust dependencies are pinned in Cargo.lock; the kit's official JavaScript SDK 2.7.0 is pinned in conformance/acp/package-lock.json. Install once with `cd conformance/acp && npm ci`. The first setup on another machine needs dependency downloads; test runs themselves stay offline.

```sh
mise exec -- cargo build --workspace --locked --offline
mise exec -- cargo test --workspace --locked --offline
mise exec -- cargo test --workspace --locked --offline --features modular-agent/durable-default
mise exec -- cargo test --workspace --locked --offline --features modular-agent/stateful-provider-default
mise exec -- cargo test --workspace --locked --offline --features modular-agent/durable-default,modular-agent/stateful-provider-default
mise exec -- cargo clippy --workspace --all-targets --locked --offline --all-features -- -D warnings
mise exec -- cargo fmt --all -- --check
```

All four full workspace test configurations pass: **185 tests** with the transient default, and **184** with the durable default, each with either Provider default. Zero failed or ignored. Counts include three existing self-exec helpers. The one-test difference is the old transient-only restart test. Stage 2 updates the mandatory plugin kit and adds five integration tests. The Runtime matrix correction adds two cancellation tests. The fifteen milestone 5 tests still exercise the actual OpenAI adapter against a fake endpoint. No automated test requires external network access, the real key or a live model. HTTP fixtures bind loopback only. Build, all-feature clippy, formatting and diff checks pass. The frozen docs and supplied kits are unchanged.

## What the ACP binding round added

- Shared modular-agent metadata, every declaration field with explicit policy values, a fixed host actor and session-specific Provider truth.
- Qualified model IDs, thinking levels and the four approval values as ACP select options. Only explicit allow/allow_once grants permission.
- Keyed prompt receipts, original outcomes on retries, correct stop reasons, open-call IDs and durable cancellation hand-back identities.
- Required history/input/requests/answer methods and the optional fork/move/erase/jobs/cancel-job methods under _modular-agent/. History adapts the fixed kinds and message/identity/time fields without changing the store.
- A session-local, joined input driver, including late answers and job reports. No Harness or Runtime turn engine was replaced. Shared movement refuses all unfinished work.
- Gated readable reasoning and configuration updates, plus no-form questions kept open for extension answers. Opaque reasoning and secrets are not rendered through forms.
- MODULAR_AGENT_CONFORMANCE=1 adds conformance/echo without credentials or network. MODULAR_AGENT_DATA_DIR keeps all owned state, settings and trust under one folder and overrides conflicting path flags.
- The supplied kit runs as an ordinary, mandatory Rust integration test. Its source and the frozen description are unchanged. Only the npm dependency lock was added beside the kit.

See ACP-BINDING.md for launch commands and GAPS.md B-01 through B-07 for binding choices. Legacy _modular/ routes remain accepted but are not advertised.

## What milestone 5 added

- Stateless and stateful OpenAI composition modes, selected by --provider-mode. The default remains stateless; stateful-provider-default changes that compile-time default. Runtime selection is independent.
- Accurate Provider catalog, model-access and agent declarations. The Runtime still gets no credentials and never chooses the model.
- Responses API store=true and previous_response_id. A successful continuation sends only new input items. Instructions and tools are sent each time, as OpenAI documents.
- Per-session caches shared across fresh bindings. Middleware sees the complete request. Only an exact extension of cached input plus raw output can continue a remote chain; other views start fresh.
- Reset proofs for position movement, forks, erasure, compaction, changed instructions and explicit discard. Restart always seeds from surviving history rather than restoring a pointer.
- Asynchronous erasure that deletes every known remote response ID for affected sessions before returning success, including abandoned chains, summaries and failed streams with received IDs.
- An atomic inventory of response IDs and uncertain-request markers under DATA_DIR/openai, containing no prompts or keys. It survives restarts. Failed deletion leaves a retry barrier. History erasure-ID reconciliation closes the crash window before the separate Provider cleanup-intent commit.
- Explicit out-of-reach reporting for delivered output, unknown response IDs and vendor-side retention/logs. A cancelled or failed stream cannot advance cached state. Interrupted stateful requests still fail closed instead of being replayed.
- A three-request live continuation and erasure demonstration, with safe evidence and cleanup.

No Runtime implementation was changed in milestone 5. The existing shared turn engine already uses declared Provider state to decide whether interrupted inference is safe to repeat. The plugin API's erasure return is now an asynchronous ErasureReport; terminal /erase and ACP _modular/erase both return erased IDs and out-of-reach copies.

## Run

```sh
# Stateful OpenAI with either Runtime.
mise exec -- cargo run -p modular-agent --locked --offline -- --provider-mode stateful --runtime transient --project /path/to/project
mise exec -- cargo run -p modular-agent --locked --offline -- --provider-mode stateful --runtime durable --project /path/to/project

# ACP stdio. The client supplies sessions, cwd and session-local MCP servers.
mise exec -- cargo run -p modular-agent --locked --offline -- --acp --provider-mode stateful --runtime durable

# Original stateless behavior remains available.
mise exec -- cargo run -p modular-agent --locked --offline -- --provider-mode stateless --project /path/to/project

# JSON/print/line modes and recorded-project reopening are unchanged.
mise exec -- cargo run -p modular-agent --locked --offline -- --provider-mode stateful --session SESSION_ID -p "Continue."
```

Cargo's --offline only prevents dependency downloads. Intentional real inference contacts OpenAI. The real Provider allows only gpt-6-luna. Only the credential plugin reads ~/.config/modular-agent-experiment/openai.key, at request time. Never print or copy the key. --credential-file takes a path, never a key value. Offline OpenAI fixtures use a synthetic credential and a loopback-only endpoint.

Data defaults to ~/.local/state/modular-agent-rs. --data-dir DIR selects DIR/sessions, DIR/commands and DIR/openai. MODULAR_AGENT_DATA_DIR overrides these paths and also places global settings and the trust ledger in that directory. Keep this directory when reopening: the OpenAI response-ID inventory is needed for later remote erasure, even if a later process uses stateless mode. Continuation caches themselves are deliberately not restored after process exit; the next request carries full surviving context. A stored-state-capable OpenAI account is required for stateful mode.

Global settings: ~/.config/modular-agent-rs/settings.json. Project settings: PROJECT/.modular-agent.json. Trust ledger: trusted-projects.json beside the global file. A terminal user explicitly trusts with --trust-project; an ACP host uses _modular-agent/trust-project with sessionId, cwd and confirm=true. Ordinary project defaults apply before trust, but executable plugin declarations/options do not. Trust affects new or reopened compositions, not running ones. Recorded ordinary session settings survive reopening.

ACP is local stdio, not an authenticated multi-user service. The launching OS user's host acts as user. Each session has an isolated project-bound composition. Full extensions, configuration examples and limitations are in MILESTONE-4.md. Provider mode is selected by the launching composition, not an untrusted session setting.

Terminal commands include /model, /thinking, /compact, /move, /fork, /erase, /questions, /answer, /jobs, /cancel-job and /tool. Parent Runtime defaults to transient unless built with durable-default. Subagent durability is independent and defaults to durable.

## Real runs

All successful runs use only gpt-6-luna through OpenAI:

- Milestone 1: read a file and continue after a new-process reopen. Evidence: evidence/m1-real-run.json.
- Milestone 2: SIGKILL during bash, command containment and durable same-turn recovery. Evidence: evidence/m2-real-run.json.
- Milestone 3: a background child wrote a file with bash; its report started a parent turn. Evidence: evidence/m3-real-run.json. Two earlier attempts failed; the retained authority diagnosis is in evidence/m3-failed-authority-run.json and MILESTONE-3.md. The first failed attempt's telemetry was not retained, as that report states.
- Milestone 4: one successful run on 2026-11-17. An official ACP client approved a read of proof.txt. The answer contained the correct proof token. A new process replayed the saved session without more inference. Two requests, 899 input and 41 output tokens. Evidence: evidence/m4-real-run.json.
- Milestone 5: one successful run on 2026-11-17, using the durable Runtime and stateful OpenAI. The model acknowledged a fresh private code, recalled it through a one-item suffix and previous_response_id, then answered UNKNOWN after erasure. The post-erasure request had no pointer and only the surviving questions. Ten original/derived entries and both earlier stored responses were erased. Exactly three requests, 356 input and 82 output tokens. The final response was also deleted and temporary state removed. The private code is not in the evidence. Evidence: evidence/m5-real-run.json.

To intentionally repeat the milestone 5 live check:

```sh
mise exec -- cargo run -p modular-agent --example real-state --locked --offline
```

The example never reads the key itself and attempts remote cleanup on failure. It preserves recovery metadata if cleanup fails. No further live inference is needed.

## Gaps, limits and skipped work

GAPS.md has **58 entries**, with twenty-four under Bindings. B-24 records the host callback cancellation correction after the Runtime matrix. Stage 2 adds:

- B-18: writing Runtime checkpoints without a standard way to read them at resume. The Rust endpoints negotiate an optional recovery payload and fall back to the required call list.
- B-19: turnStart, tool-start and turn-end ownership, and when callbacks stop.
- B-20: step correlation and model stream report conventions.
- B-21: Provider state discard and step preparation on retry, and usage for auxiliary work.
- B-22: open-call IDs, answer origin and the absence of a standalone tool RPC.
- B-23: ACP history's recovery status spellings.

The stage 1 swap-matrix follow-ups add:

- B-15: zero command timeout semantics, now settled by the refreshed binding.
- B-16: correcting ACP tool-call content blocks to use arguments rather than only input.
- B-17: missing-file not_found errors, local/remote normalization and optional AGENTS.md reads. This supersedes the missing-file portion of B-13.

Stage 1 added B-08 through B-14:

- B-08: item replacement versus whole-plugin replacement, absent local targets and rollback.
- B-09: unspecified credential object fields, using apiKey for this store's strings.
- B-10: callback authority without a parent and history pagination edges.
- B-11: no wire operation for deleting a stateful Provider's remote copies.
- B-12: complete-message Provider observations and undeclared custom hook rules.
- B-13: environment errors, process/session lifecycle and early background cleanup.
- B-14: conformance per-turn behavior without turn/input identity in ModelRequest.

Earlier ACP entries remain:

- B-01: conformance thinking levels, extra Provider and directory precedence.
- B-02: admission timing, unfinished duplicates and asynchronous scheduling.
- B-03: mixed movement/restart policies that one declaration choice cannot express.
- B-04: question deadlines mapped to completed turns with pending calls.
- B-05: history block vocabulary, erased entries, branch cursors and readable reasoning.
- B-06: the binding's failed-to-refusal mapping versus ACP's context semantics.
- B-07: awaited erasure, partial progress and remote cleanup failures.

Milestone 5's earlier additions remain:

- M5-01: state identity, reconciliation and auxiliary requests. Discard must reach all bindings, and every changed view must reconcile Provider context, even when moving does not rewind files.
- M5-02: remote erasure acknowledgement and uncertain requests. Pointer invalidation is not deletion; network failures need retry semantics, durable ID inventory and honest reporting of unknown IDs and vendor retention.

The description most needs precise behavioral boundaries for recovery and keyed effects, authority propagation, provenance/erasure, cache/reset lifetimes and asynchronous host/tool lifetimes. Different choices there can break a plugin or host. Concrete Rust signatures, file encodings and vendor transport details can remain builder decisions.

No required milestone item was skipped. The optional full-screen terminal UI was not built, to keep milestone 5 focused on its required state/erasure proofs. Line, print, JSON and ACP Interfaces work. Skills and prompt templates were outside the assigned acceptance lists and remain unbuilt.

Existing limits remain: trusted in-process plugins are not sandboxed; Linux command containment requires ptrace and pidfd support; arbitrary unkeyed hook effects are not exactly-once; cancellation needs runner cooperation; movement/forking with unsettled work can refuse. MCP OAuth/auth UI, sampling/elicitation, ACP v2, host system prompts/additional roots and client filesystem/terminal delegation are not offered. ACP secret forms fail closed. External HTTP servers and their effects are not owned by the agent. No hot plugin loading during a session is offered.

Stateful-specific limits: restarting sends full context; known IDs must retain their inventory for later deletion; unknown IDs and vendor logs cannot be erased through the response API. Remote response deletion is not a claim about backup or abuse-log retention. After an interrupted stateful request, the Runtime records failure rather than blindly repeating an unknown outside effect.

## Next assignment

Stop after the Rust host cancellation correction and its proofs. A cross-language retest of the failed Rust-host cell belongs to the supervisor. No other binding changes or live inference were part of this assignment. Never switch to another real model, edit the frozen docs snapshot or inspect another independent build.

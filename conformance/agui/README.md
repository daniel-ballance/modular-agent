# AG-UI conformance kit

This kit checks [the Modular Agent AG-UI binding](../../docs/bindings/agui.md). It sends HTTP requests and checks SSE before handing JSON to the assertions. Two cases also run the official `@ag-ui/client` `HttpAgent` without a cursor or a presence stream. The app replaces provisional messages with each final snapshot. It waits for the terminal outcome before reporting a frontend result. It does not run anything from a snapshot.

Use Node.js 22.12 or later. The TLS self-test also uses OpenSSL 3 to generate a disposable CA and certificates. Use a disposable agent, tokens and store. Do not point the kit at a production listener.

```sh
export TMPDIR="$HOME/.cache/ma-std-tmp"
mkdir -p "$TMPDIR"
npm ci
npm test
node run.mjs --list
node run.mjs -- /absolute/path/to/agui-fixture
node run.mjs --only history --url http://127.0.0.1:39211 --token-file /path/to/disposable.token
```

The first invocation of `run.mjs` with a command runs every case, with a fresh fixture per case. Use `--only case,case` to select cases. A URL selects one case and assumes the listener is already configured for it. The URL is the origin, not `/agui/v1/run`. Cleartext is allowed only on numeric loopback. The kit uses normal certificate and hostname verification for HTTPS. Use `NODE_EXTRA_CA_CERTS` when launching the runner to trust a test CA. Never disable verification. Supply token files, not token values. Use `--rotated-token-file`, `--sibling-token-file`, `--foreign-token-file`, `--watch-token-file`, `--tenant-token-file` and `--project-token-file` as required by the case.

When a session declares `approvalCoversNested`, the approval cases check the marker in the interrupt metadata and in the recorded request. In `waiting-restart`, have `bump` increment the counter through a nested tool instead of incrementing it directly. The kit checks that the child's start names that parent and request. Without the declaration the coverage assertions are skipped with a reason.

## Waiting approval checks

Eight `waiting-*` cases run by default; use `--list` or select cases with `--only`. Each case creates a thread, reads its declaration and skips with a reason unless `approvalsOutlastTurns` is true. The two mixed cases also require `interfaceTools`. In the SDK fixture set a finite `maxApprovalWaitMs`, keep history, load the approval gate and opt the session in with `approvalWait: "untilDeadline"` in trusted setup. Use the same composition but `live` for `waiting-live`. Never set the lifetime from a run POST.

Register the server-side `bump` counter. Use a stopped test clock and a 5,000 ms approval limit. Ask about the exact name and complete input in the approval prompt. For mixed cases use `ask`, with a trusted read-only definition for the frontend fixture: only the server counter needs consent. The model calls `bump` before `pick_color`. For other waiting cases use `all`. Keep the ordinary `kit-primary` and sibling routes eligible on return; neither is present before it opens presence.

| Case | What the kit observes |
|---|---|
| `waiting-live` | A forged setting on the POST does not enable waiting. The call is refused without presence. |
| `waiting-restart` | No early start, result, counter effect or executable ID. The offline listing counts one question and no running turn. After process loss the old view has no authority. A new presence and snapshot give the same request, call, prompt, arguments and deadline. A reconciled resume starts one continuation without another input. |
| `waiting-decline`, `waiting-expiry` | Cancelled resume gives one refusal. At the saved deadline the system closes the question and settles the call as not started. Neither path increments the counter. |
| `waiting-routes` | A listing, missing presence, a replaced stream, another client's delivery, missing approve or a changed view cannot authorize the call. An independently eligible sibling can still answer. |
| `waiting-race` | A real ACP connection polls on the same listener and races a decline against the AG-UI allow. Refresh after conflict. Check the winning decision, result and counter. |
| `waiting-mixed-report-first`, `waiting-mixed-answer-first` | Report the one released frontend call and answer the parked approval on different clients, in both orders. The first commitment cannot start a turn. The last makes exactly one continuation ready; it does not repeat the handoff. |

Use the [fixture control endpoint](#fixture-controls). For waiting cases `inspect` also returns the integer `counter` read from the tool's file (zero if absent), and `project`, the absolute project for ACP resume. Implement latch names `answerCommitted`, `reportCommitted`, `continuationEnded` and `presenceLost`. `approvalGate` with `client: "kit-primary", mode: "redact"` changes the approval output gate for just that route. Keep the clock, records and counter across restart, but no delivered views. The in-kit fake and its faulty variants test the checks, not an SDK.

## Wait-closure checks

Seven `closure-*` cases check [wait closures](../../docs/bindings/agui.md#wait-closures). The kit reads the thread snapshot first. If it omits `waitCursor`, the case skips and says why. An offered read is tested, not skipped for missing fixture controls. Use kept history, a stopped clock and the existing actor and client setup. ACP polls and answers on a second authenticated socket on the same listener. The kit does not use a control reply as the closure.

| Case | What the fixture supplies |
|---|---|
| `closure-order` | Start a real choice on `openWait`. ACP answers after the snapshot and before the GET. A second choice is declined while following. While disconnected the kit expires a third; after reconnect it revokes the last eligible answerer's grant on a fourth. Keep that actor a watching member. |
| `closure-routes` | Open a **live** server-tool approval with two eligible routes: primary AG-UI presence and the sibling ACP connection. The primary drops presence but keeps its feed. It cannot answer; the ACP poll and decline still work. |
| `closure-presence` | As for `approval-absent`, use live approval for the offered call. Only the feed is open. The call is refused. |
| `closure-left-open` | Ask from a call that can return pending and start a continuation. The 5,000 ms `leaveOpen` timeout ends its synchronous wait. ACP can still answer. |
| `closure-interface` | As for `frontend`: release `pick_color` to the primary and accept the tool report. The feed carries the call ID and terminal status, not the result. |
| `closure-buffered` | Hold one closure before delivery. Block its opening or decision at the source gate, change the final notice, or revoke watch. The next visible decline fences the omitted item; on watch loss the stream ends. No sleep is evidence of omission. |
| `closure-cursor` | Require authentication and `after`. Reject an unknown, expired or sibling-client cursor. |

Use the [fixture controls](#fixture-controls). All new operations are on the **control port only**:

- `openWait {kind}` returns `{requestId}` once the real Harness has recorded the request. Start the ask in the fixture, not by writing entries. For `choice`, `deadline`, `revocable` and `leaveOpen` offer `yes` and `no`; for `deadline` use 5,000 ms and decline on expiry; for `revocable` restrict answerers to `kit-owner`. For `approval` drive a live call through the approval gate. Each new ask must be ready for the kit to poll or advance; do not await the answer in this control. `inspect.project` is the absolute path for ACP resume.
- `hold {name:"beforeWaitDelivery"}` pauses the next queued visible notice before the final authority/gate check or socket write. `barrier {name}` observes the pause; `release {name}` resumes it. `waitFollowing` is a barrier at installation of the follower (before draining replay); `presenceLost` waits for actual disconnect and route reconciliation. Latch boundaries even if reached before the control arrives.
- `waitGate {requestId,mode}` changes policy for that ID and primary client only. `opening` blocks the opening request view, `decision` blocks the closing answer view, `notice` changes the reason in the final `modular-agent.waitClosed` output event. Do not filter the feed in the fixture.
- `revokeRight {right}` removes the owner actor's named session grant (`answer` or `watch`) and waits for the change to commit. `expireWaitCursor {cursor}` evicts or expires the specified cursor. `advance` runs the due timers, not a wall clock sleep.

## Run-receipt checks

Seven `receipt-*` cases run only if the thread snapshot offers `runReceipts: 1`. Keep history in the fixture. Use the supplied scripted Provider, never a real model. These cases check the HTTP reply and actual admissions, decisions, turns, results and handoff releases from `inspect`. A terminal class is not a turn outcome. A stored outcome is not evidence of terminal delivery.

| Case | Boundary and expected observation |
|---|---|
| `receipt-before-admission` | Prime a kept thread. Stop the second POST after validation but before its first accepted operation. No receipt before or after process loss. With actual non-admission established, the same ID is still usable. |
| `receipt-after-admission`, `receipt-durable` | Stop after input admission and its `turnStart`, before the model step and `turnEnd`. The receipt is `unknown/unsettled`. Reopen normally; the transient Runtime fails, the scripted durable Runtime completes. Compare the receipt to that turn's committed end, including after a later turn. |
| `receipt-before-terminal` | Stop after the turn's completed end commits, before the gated terminal group reaches the transport. Even after restart the terminal class is `unknown`. |
| `receipt-interrupt` | Use the in-turn choice from `questions`. Finish the first exchange with an interrupt. The answer-only exchange completes the original turn. The first receipt stays `interrupt`, the second is `success`. |
| `receipt-result` | Release the frontend call in the first exchange. In the result-only POST stop after its result commits but before its continuation starts. On reopening, the scripted Provider fails in that continuation. The result-only receipt has work `failed`; the opening receipt still has work `completed`. |
| `receipt-visibility` | A known owner sees only two strings. Mask a missing ID or thread, another actor, sibling client, other tenant, blocked settlement and pending or finished erasure. Block the complete reply separately. Repeat GETs and retry POSTs, also with current history, and compare the recorded work. |

Use the same `hold`, `barrier`, `release`, `inspect` and `erase` controls as above. For crash cases, `hold {name,runId}` arms a **one-shot pause for that POST only**. The names are `beforeAdmission`, `afterAdmission`, `beforeTerminal` and `afterResult`. Signal `barrier {name,runId}` at the boundary, with the store readable; do not hold the store lock while paused. The kit then kills and relaunches the whole fixture. Do not rearm the pause on restart. Keep the token assignments and all durable data. Reopening the thread (not a receipt GET) may start normal recovery. Signal `recoveryEnded` for the interrupted exchange when its linked work has settled. Signal `terminalRecorded` for an ordinary exchange after its released terminal class is durable. Both barriers take `runId` and work after the event.

`receiptGate {mode}` selects the primary client's current output policy: `settlement` blocks the linked turn's settlement view; `reply` blocks the final `agui.runReceipt` reply only; `allow` removes both blocks. For `hold {name:"pendingErasure"}`, pause the next real `erase` after its intent commits but before reconciliation. Keep the read path available until `release {name:"pendingErasure"}`. No control supplies a receipt or makes up its expected status.

## Launching a fixture

The fixture is an SDK app, not a replacement AG-UI adapter. Use the real listener, Harness, Runtime, output gate and history store. For TypeScript, build the workspace and run `node conformance/agui/run.mjs -- "$(command -v node)" "$PWD/typescript/scripts/agui-ma.mjs"` from the repository root. The launcher uses `ma --agui --acp` for listener, thread listing, encoding, history and stock conversation. Its SDK fixture supplies the registered frontend tool and the test controls for the other cases. See [Serving AG-UI](../../docs/sdk/placement.md#serving-ag-ui) for the setup. `fake-agent.mjs` is only a launch-mode self-test for the basic cases. The Go launcher is `go.mjs`. From the repository root, `go/scripts/check-agui.sh` builds Go `ma` and the fixture, installs the pinned kit dependencies in scratch, and runs every case. Five Go cases launch `ma`; cases that need operator-only setup launch the test executable. See [Serving AG-UI](../../docs/sdk/placement.md#serving-ag-ui) for the proposed setup. `fake-agent.mjs` is only a launch-mode self-test for the basic cases. Run `conformance/agui/rust.sh` for Rust. It builds `ma` and the separate `sdk-scenarios` example `agui_fixture`. The launcher runs ordinary conversations against `ma` and uses the example for cases that need operator configuration or controls. All applicable cases run; no reference manifest fields are needed. See [Serving AG-UI](../../docs/sdk/placement.md#serving-ag-ui) for the proposed setup. `fake-agent.mjs` is only a launch-mode self-test for the basic cases.

To run the Python implementation, run `(cd python && uv sync --python 3.13)` and `npm ci --prefix conformance/agui` from the repository root, then run:

```sh
node conformance/agui/run.mjs -- "$PWD/python/.venv/bin/python" "$PWD/python/scripts/agui_fixture.py"
```

The launcher uses the Python `ma --agui --acp` command for history, encoding and the stock conversation. For the other cases it starts a scripted SDK agent with the kit's actors, plugin, controls and disposable TLS files. Both use the SDK listener and the standard configuration's scripted Provider.


The kit starts the command in a new process group, with a fresh home, working directory and data directory, and without the inherited environment except `PATH`. It sets:

| Variable | Meaning |
|---|---|
| `MA_AGUI_LISTEN` | `127.0.0.1:0`; bind an ephemeral port. |
| `MODULAR_AGENT_SCRIPT` | Path to the [model script](../../docs/sdk/testing.md#the-model-script). Use only `scripted/script`, with the same indexing as the reference Provider. The scripts are in `cases.mjs` and `advanced.mjs`. |
| `MODULAR_AGENT_SCRIPT_LOG` | Log model requests in the [reference format](../../docs/reference/standard-configuration.md#hooks-for-testing). |
| `MODULAR_AGENT_DATA_DIR` | Keep the same store across a restart. Do not erase or truncate it on startup. |
| `MA_AGUI_FIXTURE` | JSON file with `{ name, tokenFiles, offer, project, controlTokenFile }`. `name` identifies the case. `offer` is the browser's exact tool offer. The other fields supply disposable config paths. |

Print one line to stdout when the listener is ready. For a basic case print its origin, or `{"url":"http://127.0.0.1:PORT"}`. For a controlled case print `{"url":"http://127.0.0.1:PORT","control":"http://127.0.0.1:OTHER_PORT/fixture"}`. Send diagnostics to stderr. The kit keeps stdout and stderr in files on failure. It kills the fixture's group and waits for surviving processes before starting a replacement. Use a fresh port on restart.

Configure `acp: true` on the same listener, at the root WebSocket path. Use default same-origin browser policy. Enable attachment of the fixture's in-scope actors. Set the creation project and tenant on the operator side. The token roles are:

| File key | Actor and scope |
|---|---|
| `owner` | Actor `kit-owner`, client `kit-primary`, full fixture rights in the test project and tenant; trace context is trusted. |
| `rotated` | Same actor, client ID, rights and scope as `owner`, different token. The kit uses it to reconnect as the same executor route. |
| `sibling` | Same actor and scope, different client ID. No Interface tool registered on this route. |
| `foreign` | Another admitted actor in the same scope; allow `input`, `watch`, `tools`, `answer` and `approve`, but do not trust its trace context. |
| `watch` | `kit-owner` with a distinct client ID and a connection ceiling of `watch` only. |
| `tenant`, `project` | Tokens for a different tenant and a different project respectively, otherwise qualified to watch. |

Register `pick_color` from `offer` for actor `kit-owner`, route `kit-primary`, with `callers: ["model"]` and 60,000 ms result timeout. Do not register a handler. The fixture's `tool.before` changes `{"color":"draft-blue"}` to `{"color":"dispatch-blue"}` on the first pass; subsequent passes leave it unchanged. On successful reports `tool.after` replaces the report text with `Checked frontend result.`. Keep the error description on failed reports. Default to approval off except in the approval cases. Do not enable another answer route for those cases.

The `thread-listing` case starts with an empty store. It checks scoped discovery, change order, opaque paging, invalid parameters and the absence of conversation content. The frontend, approval and crash-before-handoff cases also inspect the counts and turn state before opening the thread.

## Fixture controls

The control URL is a separate loopback-only, bearer-authenticated test endpoint. Never enable it on a deployed agent. It accepts `POST` JSON `{ operation, threadId, ...args }` and responds `200` with a JSON object (normally `{}`). In URL mode pass it with `--control URL --control-token-file FILE`. Basic cases do not use it. Crash cases require command mode. Do not use AG-UI requests for administrative fixture actions.

| Operation | Behavior |
|---|---|
| `tls` | Return `{ ca, cert, key, servername }` for the disposable test client only. This operation has no `threadId`. |
| `inspect` | Flush captured telemetry. Return `{ batches, model, dispatches, warnings, spans, erasure }`. `batches` contains committed shared entries grouped in store-write order; `model` is the parsed request log; `dispatches` lists executable handoff call IDs at release. `warnings` is a list of field names. `spans` contains `{ name, traceId, spanId, parentSpanId?, attributes, links }` with links `{ traceId, spanId }`. `erasure` is the last erasure report (or `{ outOfReach: [] }`). Inspect actual records and spans, not a fixture's predicted result. |
| `barrier` | Wait for the named boundary on this session, even if it has already happened. Use a latch in the relevant store, gate or fixture hook. |
| `advance` | Advance a controlled clock by `milliseconds`; run resulting closures, settlements and ready work to completion before responding. Do not wait for a wall clock timeout. |
| `release` | Release the pause at `beforeRelease`. |
| `revoke` | Remove the route's `tools` right without removing `watch`. |
| `move` | Move away from the just-completed conversation using another Interface. |
| `erase` | Erase the just-completed conversation or open handoff and its lineage using another Interface. Wait for the committed intent and reconciliation. |

Controlled cases add these behaviors:

| Case | Fixture behavior |
|---|---|
| `tls` | Use HTTPS with a disposable server certificate and mandatory client authentication. A trusted client certificate alone must not authorize discovery. The kit checks unknown CA and mismatched server name as well. |
| `approval*` | Ask for approval of the transformed call, with a closing deadline in 5,000 ms. In `approval-redacted`, change the arguments in the intended approval view. Signal `presenceLost` after disconnect and approval reconciliation. |
| `questions` | Ask the choice `yes` or `no` with a 5,000 ms closing deadline before completing the first turn. Record declines and time limits. |
| `mixed` | Stage the frontend tool and open an in-turn choice before `turnEnd`. The answer completes that turn, then the adapter can release the handoff. |
| `release-gate` | Pause at `beforeRelease` after the start/checkpoint and originating turn end commits, before executable framing. |
| `state-and-gate` | Use one state plugin with `{counter:0}`, valid patch to 1, stale patch to 2, and a patch to 3 that the output gate withholds. Suppress any replacement snapshot before `{counter:4}`, then deliver a patch to 5. Include a same-named event from an unconfigured plugin with `wrong-plugin-sentinel`. Offer visible `kit.visible` and a visible nonstandard entry, a withheld `withheld-extension-sentinel`, and a raw foreign event `{type:"fixture.foreign"}` from source `kit`. Give the Provider private data containing `provider-only-sentinel`. Redact the scripted output to `Gated text.` for the owner; withhold sibling snapshot replies. |
| `output-size` | Offer a gated optional custom event named `kit.oversized` whose encoded size exceeds 64 MiB. Configure a sibling snapshot view that would exceed 64 MiB and cannot be delivered as a complete snapshot; refuse it with `result_too_large`. Keep the owner's ordinary conversation deliverable. |
| `error-gate` | Block discovery and the scripted Provider diagnostic at the output gate. |
| `trace` | Capture real OpenTelemetry spans with an always-on sampler and metadata-only export. Allow the vendor key `kit` and ignore the other trace state and all baggage. |
| `crash-before-handoff` | Pause at `beforeHandoff` before committing `toolStarted`. Use a transient Runtime for interrupted turns. |
| `crash-after-handoff` | End the first run with a live handoff, then let the kit kill the process. Restore the open call without dispatching it. |
| `crash-after-result` | Pause at `afterResult` after the result commits, before the continuation starts. |
| `crash-continuation` | Pause at `duringContinuation` after committing its `turnStart` and trace checkpoint but before the model step. Use durable recovery and the original checkpoint. |

The fake checks whether the runner recognizes known good and deliberately wrong behavior. It does not show that an SDK enforces the gates, stores the records atomically, exports real spans, or recovers from a process death. The fake's recovery cases drop transport connections and reopen in-memory state. Run the managed kit with an SDK fixture to test a real crash.

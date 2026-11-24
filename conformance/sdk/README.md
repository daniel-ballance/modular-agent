# Shared SDK scenarios

Scenarios every SDK runs against itself and against the other SDKs' fixture plugins. The format, the fixture plugins and how a runner places them are in [Testing](../../docs/sdk/testing.md#the-shared-scenarios). Each SDK lists its fixture program in [`fixtures/`](fixtures/).

A scenario that turns out to be wrong is fixed here first, then in the SDKs.

| Scenario | Checks |
|---|---|
| [`first-turn`](scenarios/first-turn.json) | One prompt, one turn, the standard records in order |
| [`tool-call`](scenarios/tool-call.json) | A tool call and its result |
| [`gate-refusal`](scenarios/gate-refusal.json) | A `tool.before` refusal settles the call without running it |
| [`tool-refusal`](scenarios/tool-refusal.json) | A tool's own refusal settles `refused` with its reason |
| [`invalid-input`](scenarios/invalid-input.json) | Input that does not match the schema ends `failed`; the tool never runs |
| [`nested-call`](scenarios/nested-call.json) | A nested call is recorded as its own call and is not listed as the turn's result |
| [`question-answered`](scenarios/question-answered.json) | A tool's question answered by the app's handler |
| [`question-answered-later`](scenarios/question-answered-later.json) | With no handler, the app answers a waiting question from its own UI |
| [`decline-is-not-text`](scenarios/decline-is-not-text.json) | A decline and the text `declined` are different answers |
| [`actor-rights`](scenarios/actor-rights.json) | An actor without `input` cannot prompt |
| [`approval-without-handler`](scenarios/approval-without-handler.json) | With no handler, an approval is refused rather than left waiting |
| [`read-only-approval`](scenarios/read-only-approval.json) | Under `ask`, a read-only tool runs without asking |
| [`ephemeral-crash`](scenarios/ephemeral-crash.json) | An ephemeral session cannot be reopened after a crash |
| [`ephemeral-file-history`](scenarios/ephemeral-file-history.json) | Composition refuses explicit file history under `ephemeral` and names `kept` |
| [`ephemeral-history-service`](scenarios/ephemeral-history-service.json) | Composition refuses a history service under `ephemeral` and names `kept` |
| [`kept-crash`](scenarios/kept-crash.json) | A crash under `kept`: the turn fails, the call is not repeated |
| [`durable-crash`](scenarios/durable-crash.json) | A crash under `durable`: the turn carries on, the call is not repeated |

## Results

These results are from before [ADR 0029](../../docs/adr/0029-sdk-decisions-after-four-builds.md) and do not include its three ephemeral scenarios.

SDK specification 0.1 after the fifth build round. Each runner ran all seventeen scenarios in process, served by each SDK's fixture program on stdio, and served by each as a WebSocket service, with `MODULAR_AGENT_SDK_REQUIRE=all`:

| Runner | In process | Rust | TypeScript | Go | Python | Rust service | TypeScript service | Go service | Python service |
|---|---|---|---|---|---|---|---|---|---|
| Rust | 17/17 | 17/17 | 17/17 | 17/17 | 17/17 | 17/17 | 17/17 | 17/17 | 17/17 |
| TypeScript | 17/17 | 17/17 | 17/17 | 17/17 | 17/17 | 17/17 | 17/17 | 17/17 | 17/17 |
| Go | 17/17 | 17/17 | 17/17 | 17/17 | 17/17 | 17/17 | 17/17 | 17/17 | 17/17 |
| Python | 17/17 | 17/17 | 17/17 | 17/17 | 17/17 | 17/17 | 17/17 | 17/17 | 17/17 |

612 runs, all passed. The crash scenarios killed the agent's whole process group, and each service's group, with `SIGKILL` in every cell. Earlier rounds passed the same matrix with fewer scenarios or placements: 140 runs with the first seven scenarios, 220 with eleven, 280 with fourteen and no services, 504 with fourteen and services.

## Waiting approval scenarios

The [28 waiting fixtures](fixtures/waiting-approval/) use the [shared format](../../docs/sdk/testing.md#the-format). In a full run, require the [waiting fixture manifest](waiting-scenarios.json), every fixture it lists and the ordinary scenarios. An absent or empty group fails the run. Do not treat them as plugin launch manifests. [waiting.mjs](waiting.mjs) provides a reference interpreter for the new steps and expectations. Run `npm test` here to check the fixture contracts. This is not a result from a language runner.

Run each fixture on its specified composition, with no handler or initial polling presence. Assert the actual session declaration with `checkWaitingDeclaration`; a missing capability on a positive fixture fails the case. Exercise unsupported settings and invalid compositions directly.

| Group | Cases |
|---|---|
| Session and policy | Happy path (including a plain listing and duplicate decision); default and explicit live; unsupported opt-in; invalid maximum and incompatible composition; off, never and ask/read-only |
| Cutoffs | Decline, shorter requested deadline, clamped deadline, timely allow whose dispatch reaches the deadline |
| Rechecks | Changed source, whole definition or final input; changed display after allow; worker loses tools; approver loses approve; separate minimal approver; redacted delivery on just one handle |
| Reopen | Each of kept and durable at origin end, answer commit and after effect; expiry while stopped |

Use the normal in-process, process and service tool placements. Keep the clock, saved request, count file, store and committed batch boundaries across restarts. The Harness clock starts frozen at a representable epoch in milliseconds. Supply `agent.maxApprovalWaitMs` as an **operator** option, never a session setting. Set `agent.settings` at session creation. `fixture.requestedApprovalMs` supplies the approval gate's requested interval, absent for no shorter limit. `expectDeclaration` checks the actual case's declaration (omission counts as false for optional booleans). For `expectCreateError` compare its code and any supplied message substring. Never inject declarations or write a question, decision or start on behalf of the tested Harness.

### Additional runner step kinds

Retain one authenticated Session handle per `as` actor (`user` by default). Use `session.as(actorId)` for the fixture members. Reopen invalidates every old handle. Keep the immutable ID in the driver, **not** its right to answer. Never install a question handler to implement a step.

| Step | Operation and expected observation |
|---|---|
| `poll: {present: boolean}` | Call ordinary `questions()` if false, `questions({present:true})` if true, on this handle. `expect.view` is `listed` (matching ID only), `exact` (one matching request, kind, call ID, exact name, full input, immutable text, wait marker and absolute deadline), `empty`, or `notAnswerable` (redacted, absent, withheld, or explicitly non-actionable). Never treat a listing as a delivery. |
| `decide: "allow"\| "decline"` | Call `answer` on that handle with the saved request ID and the tagged answer, **without polling**. Compare `expect.accepted`. Normalize only an explicit negative acknowledgement or an SDK denial for this decision to false, not a timeout or fixture failure. An acknowledgment need not wait for dispatch. |
| `clock: {deadlineOffsetMs: integer}` | Advance to the saved absolute deadline plus this signed offset. Never read wall time. Serialize due timers on the writer; do not wait for a held handoff. While stopped, only advance the test clock; the next writer reconciles. |
| `barrier: {arm\|reached\|release: boundary}` | Arm a latch before starting the operation, await its observation, or release it. `afterAnswer` is after the answer commit, before taking ready work. `beforeGates` precedes re-running the original gate chain. `beforeHandoff` precedes the final checks and first start. `afterEffect` observes the counter write while the held invocation has no committed result. Keep controls independent of the held work. Never sleep in place of a latch. |
| `change: object` | `setting` calls setSetting for the supplied key/value. `registration: "source"` refreshes the source ID for the same name/input/definition; `"definition"` changes only its description. Keep the tool available. `gateInput` makes a test hook return this different valid input on the continuation. `gateView: {actor,mode:"redact"}` changes only this recipient's approval output view. `removeRight: {actor,right}` narrows the recorded grant while the continuation waits. Do not bypass the SDK's rights, refresh or gate code. |
| `stop: "close"\| "kill"` | Close the otherwise idle kept session and writer normally, or kill the agent and fixture process groups as in the existing crash scenarios. Reap before returning. Preserve the independent count file, frozen clock and store. A later `reopen: true` uses a new agent and fresh handles, not an old callback. |

Check existing `count` against the actual counter file, including while a writer is stopped. New expectations:

- `recordCounts: {kind:n,...}` is exact across the committed session, including zero. `openToolCalls` compares the PromptResult IDs in order, resolving `$call` to the bound original call. `toolResults: []` forbids a provisional result.
- `parked: {timeLimitMs:n}` captures the immutable request, response and origin associations from the store. Check the request and pending checkpoint share a commit, the original call and registration match, the deadline equals ask time plus n, and the origin ended completed with the call open. There is no start, result, handoff or decision. On subsequent checks compare the request to the saved one **including IDs and deadline**.
- `settled: {status,decision,actor?}` checks the one answer and result for that call. System expiry has no actor. An allow has the private proof and its ceiling. Exactly one continuation names the origin and last closure; no substitute question or new admission/input. A dispatched call starts once under that continuation with its old step/call IDs and both sources. For a refusal or expiry, check the factual pre-dispatch status, lineage and zero starts. Run these against the actual store, not a projected history or the model. [Shared assertions](../waiting/records.mjs) give the ID comparisons.

## Proposed, not yet written

- **queued-cancel:** an input queued `after` a held call, then cancel, then a retry with the same key returns `handedBack` without another turn. Needs receipt expectations in the format.

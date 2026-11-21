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

## Proposed, not yet written

- **queued-cancel:** an input queued `after` a held call, then cancel, then a retry with the same key returns `handedBack` without another turn. Needs receipt expectations in the format.

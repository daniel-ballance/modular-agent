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
| [`kept-crash`](scenarios/kept-crash.json) | A crash under `kept`: the turn fails, the call is not repeated |
| [`durable-crash`](scenarios/durable-crash.json) | A crash under `durable`: the turn carries on, the call is not repeated |

## Results

SDK specification 0.1 after the second build round, before the last three scenarios were added. Each runner ran all eleven scenarios in process and served by each SDK's fixture program, with `MODULAR_AGENT_SDK_REQUIRE=all`:

| Runner | In process | Rust | TypeScript | Go | Python |
|---|---|---|---|---|---|
| Rust | 11/11 | 11/11 | 11/11 | 11/11 | 11/11 |
| TypeScript | 11/11 | 11/11 | 11/11 | 11/11 | 11/11 |
| Go | 11/11 | 11/11 | 11/11 | 11/11 | 11/11 |
| Python | 11/11 | 11/11 | 11/11 | 11/11 | 11/11 |

220 runs, all passed. The crash scenarios killed the agent's whole process group with `SIGKILL` in every cell. After the first round, with the first seven scenarios, the same matrix passed 140 runs.

## Proposed, not yet written

- **queued-cancel:** an input queued `after` a held call, then cancel, then a retry with the same key returns `handedBack` without another turn. Needs receipt expectations in the format.

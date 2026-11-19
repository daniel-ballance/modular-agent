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
| [`approval-without-handler`](scenarios/approval-without-handler.json) | With no handler, an approval is refused rather than left waiting |
| [`read-only-approval`](scenarios/read-only-approval.json) | Under `ask`, a read-only tool runs without asking |
| [`kept-crash`](scenarios/kept-crash.json) | A crash under `kept`: the turn fails, the call is not repeated |
| [`durable-crash`](scenarios/durable-crash.json) | A crash under `durable`: the turn carries on, the call is not repeated |

## Results

SDK specification 0.1, with the first seven scenarios (the four added later are not yet run). Each runner ran every scenario in process and served by each SDK's fixture program, with `MODULAR_AGENT_SDK_REQUIRE=all`:

| Runner | In process | Rust | TypeScript | Go | Python |
|---|---|---|---|---|---|
| Rust | 7/7 | 7/7 | 7/7 | 7/7 | 7/7 |
| TypeScript | 7/7 | 7/7 | 7/7 | 7/7 | 7/7 |
| Go | 7/7 | 7/7 | 7/7 | 7/7 | 7/7 |
| Python | 7/7 | 7/7 | 7/7 | 7/7 | 7/7 |

140 runs, all passed. The crash scenarios killed the agent's whole process group with `SIGKILL` in every cell.

## Proposed, not yet written

These need step kinds the format does not have yet (`send`, `cancel`, and answering with a tagged decline):

- **queued-input-after-crash:** a held tool from the first input, a second input queued behind it, a crash; on reopen the second input is handed back.
- **queued-cancel:** an input queued `after` a held call, then cancel, then a retry with the same key returns `handedBack` without another turn.
- **decline-is-not-text:** a text question answered once with the string `declined` and once with a decline; the tool sees two different answers.

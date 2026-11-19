# Shared SDK scenarios

Scenarios every SDK runs against itself and against the other SDKs' fixture plugins. The format, the fixture plugins and how a runner places them are in [Testing](../../docs/sdk/testing.md#the-shared-scenarios).

These are drafts written with [SDK specification 0.1](../../docs/sdk/README.md). No runner exists yet; the Rust SDK writes the first. A scenario that turns out to be wrong is fixed here first, then in the SDKs.

| Scenario | Checks |
|---|---|
| [`first-turn`](scenarios/first-turn.json) | One prompt, one turn, the standard records in order |
| [`tool-call`](scenarios/tool-call.json) | A tool call and its result |
| [`gate-refusal`](scenarios/gate-refusal.json) | A `tool.before` refusal settles the call without running it |
| [`question-answered`](scenarios/question-answered.json) | A tool's question answered by the app's handler |
| [`approval-without-handler`](scenarios/approval-without-handler.json) | With no handler, an approval is refused rather than left waiting |
| [`kept-crash`](scenarios/kept-crash.json) | A crash under `kept`: the turn fails, the call is not repeated |
| [`durable-crash`](scenarios/durable-crash.json) | A crash under `durable`: the turn carries on, the call is not repeated |

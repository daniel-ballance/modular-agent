# modular-agent: the Rust SDK

The Rust SDK described in [`docs/sdk/`](../../../docs/sdk/README.md), first of the four ([ADR 0024](../../../docs/adr/0024-five-layers.md#choices)). It is a layer over the Rust base build (`agent-api`, `agent-harness` and the plugin crates) and keeps the base out of its API.

```rust
use modular_agent::{Tool, ToolContext, testing::test_agent};

let agent = test_agent()
    .tool(tide())
    .script(json!([
        { "toolCalls": [{ "name": "tide", "input": { "harbour": "Whitby" } }] },
        { "text": "High tide is at 14:02." }
    ]))
    .build()
    .await?;
let turn = agent.session().await?.prompt("When is high tide at Whitby?").await?;
```

## What is checked

From `rust/`:

```sh
mise exec -- cargo test -p modular-agent -p sdk-scenarios
```

- **Placement rules** (`crates/sdk-scenarios/tests/placement.rs`): a program that cannot start or exits before registering fails `build` with `invalid_composition`; an embedded agent ignores `MODULAR_AGENT_PLUGINS` and a plugin host reads it; a served tool's result matches the in-process one.
- **Guides:** the Rust examples in guides [01](../../../docs/sdk/guides/01-first-agent.md) and [02](../../../docs/sdk/guides/02-add-a-tool.md) that need no real model run as tests in `tests/guides.rs`.
- **Shared scenarios:** all seven in [`conformance/sdk/scenarios`](../../../conformance/sdk/README.md) pass with the fixtures in process and with each fixture served from its own process by `modular-agent-fixtures`, through the runner in `crates/sdk-scenarios`. A deliberately changed fixture program fails only the served placement, so the served runs do cross the wire. The two crash scenarios run the agent in its own process group and kill it with `SIGKILL` once the counter fixture has counted. A `durable` reopen completes the turn, a `kept` reopen fails it, and in both the held call is settled `outcomeUnknown` and never runs again. The runner was checked by breaking expectations: it reports a wrong outcome, status, record kind and count.

## Built so far

| Specification | State |
|---|---|
| `Agent::builder()`: project, data_dir, durability, provider, tool, model, setting, approval, on_question | built |
| Durability: `Ephemeral` (memory history), `Kept`, `Durable` (files under `data_dir`), with `invalid_composition` for a missing `data_dir` | built |
| `Session`: `prompt`, `prompt_stream`, `last_turn`, `history`, `close`; `PromptResult` with `tool_results()` | built |
| `Tool::new(..).run(..)`: input type to `parameters` through `schemars`, hints sent as set, `refuse`, `ask` for choice and text | built |
| Questions: the app's handler; with none, an approval is refused | built |
| Errors with codes | built; the base's own errors carry no code, so most map to `internal` |
| `testing`: `scripted_provider`, `test_agent`, `answers`, the four fixtures | built |
| `Plugin` and `Registrar`: tools, `tool.before`, `replaces`, `config`, `setup` | built; every item is servable |
| `serve(plugin)`: tools, `tool.before`, `host/ask` from a served tool | built, over the base's `plugin-stdio` RPC |
| `process_plugin`, `plugin_host`, `MODULAR_AGENT_PLUGINS`; the fixture program | built |
| Other hook points, commands, jobs, nested calls from a served tool, `inProcessOnly` | not yet |
| `overWire`, an in-memory pipe for tests | not yet; the base host only spawns processes |
| Provider API and the OpenAI and Anthropic Providers | not yet |
| `serveAcp`, `serveHistory`, `httpHistory`, `memoryEnvironment`, `send`, `cancel`, `fork`, actors | not yet |

## Where the base and the specification differ

Found while building this slice. Each is either handled in the SDK or a change the base needs.

| Finding | Where it goes |
|---|---|
| The base treats a fixed actor id, `user`, as the local person: full rights and the default answerer. | The SDK specification now names the local actor `user`. |
| The base's approval plugin treats an unrecorded policy as `off`; the specification requires `all`. Reopening a session does apply `all`. | The SDK always records a policy when approval is on. The base should fix its default. |
| The base's approval policies have their own names (`ask_always` and so on), mapped only in the portable settings. | The SDK maps them. |
| In process, the base replaces whole plugins by name; the specification and the wire replace items. | The SDK uses the base's `load_replacing`, which replaces items. Not yet tested. |
| The base's plugin binding code serves only its own conformance plugin. | The SDK has its own endpoint over the base's `rpc::Peer`. |
| The base does not validate tool input against `parameters`. | The SDK's typed input catches type errors; full schema validation is a base change. |
| The base's errors are untyped strings. | Only lost parts and missing files map to a code; the rest are `internal` until the base types them. |
| The local environment needs a folder for command state even when nothing else is kept. | An ephemeral agent uses a scratch folder removed with the agent; the specification now says so. |
| The base records a tool-calling response with stop `tools`. | Handled inside the scripted Provider. |

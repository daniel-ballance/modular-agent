# A tool in another process

Run the `tide` tool from [Add a tool](02-add-a-tool.md) in a process of its own, then load it into an agent written in a different language. The tool's code does not change. This is the [plugin binding](../../bindings/plugin.md) at work, and the SDK hides all of it.

## Serve the plugin

A plugin program wraps its tools in a plugin and calls `serve`. `serve` speaks the binding on stdin and stdout until the agent closes the connection. Here the program is in TypeScript and uses the `tide` tool from the previous guide.

```ts
// tides.ts (compile to tides.js)
import { serve } from "@modular-agent/core";
import { tide } from "./tide.js";

await serve({ name: "tides", tools: [tide] });
```

The call in each SDK:

| Language | Serve a plugin |
|---|---|
| Rust | `modular_agent::serve(plugin).await` |
| TypeScript | `await serve(plugin)` |

A program must write nothing else to stdout: the binding owns it. Log with the context's `log`, which goes to stderr.

## Load it into an agent

Name the program in the agent's process plugins. The command is an argument vector, not a shell line. The program starts with a [minimal environment](../placement.md#a-plugin-in-another-process), so give Node's full path. Build and deploy the plugin with its SDK dependencies.

**Rust**

```rust
use modular_agent::ProcessPlugin;

let agent = Agent::builder()
    .provider(openai())
    .model("openai/gpt-6-luna")
    .process_plugin(ProcessPlugin::new(["/usr/bin/node", "/srv/tides/tides.js"]))
    .build()
    .await?;
```

**TypeScript**

```ts
const agent = await createAgent({
  providers: [openai()],
  model: "openai/gpt-6-luna",
  processPlugins: [{ command: ["/usr/bin/node", "/srv/tides/tides.js"] }],
});
```

The model sees `tide` exactly as it would in process. The call passes the same gates, is recorded the same way and returns the same result.

## Test it without a model

A test loads a plugin program the same way, with the scripted Provider in place of a real one. Use the `tide` fixture from your SDK so the test needs no installation of another SDK and no key.

In Rust, put the test in the [SDK scenario crate](../../../rust/crates/sdk-scenarios/tests/guide03.rs) so Cargo supplies the fixture executable path:

```rust
use modular_agent::{Agent, ProcessPlugin, Result, testing::scripted_provider};
use serde_json::json;

#[tokio::test]
async fn loads_the_tide_plugin_as_a_program() -> Result<()> {
    let agent = Agent::builder()
        .provider(scripted_provider(json!([
            {"toolCalls":[{"name":"tide","input":{"harbour":"Whitby"}}]},
            {"text":"High tide is at 14:02."}
        ])))
        .model("scripted/script")
        .process_plugin(ProcessPlugin::new([
            env!("CARGO_BIN_EXE_modular-agent-fixtures"),
            "tide",
        ]))
        .build()
        .await?;
    let turn = agent
        .session()
        .await?
        .prompt("When is high tide at Whitby?")
        .await?;
    assert_eq!(
        turn.tool_results()[0].text(),
        "High tide at Whitby is 14:02."
    );
    agent.close().await
}
```

In TypeScript, set `program` to the absolute path of the built [fixture program](../../../typescript/packages/fixtures/test/integrations.test.ts). Import `testAgent` from `@modular-agent/core/testing`, `assert` from `node:assert/strict`, and `test` from `node:test`.

```ts
test("guide 03 loads the tide from a fixture program", async () => {
  const node = process.execPath;
  const agent = await testAgent({
    script: [
      { toolCalls: [{ name: "tide", input: { harbour: "Whitby" } }] },
      { text: "High tide is at 14:02." },
    ],
    processPlugins: [{ command: [node, program, "tide"] }],
  });
  try {
    const turn = await (await agent.session()).prompt("When is high tide at Whitby?");
    assert.equal(turn.toolResults()[0].text(), "High tide at Whitby is 14:02.");
  } finally {
    await agent.close();
  }
});
```

## Or keep it in process

The TypeScript agent can import the tool from `tide.js` and include it in `tools: [tide]` instead of starting the process plugin.

Which placement to use is a deployment choice. In process is faster. In its own process the tool can be written in another language, and a crash in it does not take the agent down. Neither is a sandbox: the program runs with the agent's permissions.

## When serving is refused

`serve` refuses a plugin that uses something the binding cannot carry, such as a hook point the plugin defines itself, a model-using command, or a tool flagged `inProcessOnly` because it reads a named credential. It fails at startup with `not_supported` and names what it could not serve. It does not serve the rest and drop the feature. See [Plugins](../api.md#plugins) for what is servable.

## If the program dies

If the plugin's process exits while the agent runs, the agent treats the part as [lost](../../contracts.md#parts-that-are-lost). A call that may have been dispatched is settled `outcomeUnknown`, because it may have had its effect, and is not repeated. A call that had not been dispatched is settled `notStarted`. If the program fails to start, `createAgent` fails: an agent never runs without a part it was configured to have.

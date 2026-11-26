# Add a tool

Write a tool, give it to an agent, and test that the model's call reaches it. The tool here looks up a high tide. A real one would ask a tide service; this one always answers 14:02.

## Write the tool

A tool is a name, a description, a typed input and a function. The input type becomes the JSON Schema the model sees, and the SDK checks the model's input against it before the function runs.

**Rust**

```rust
use modular_agent::{Tool, ToolContext};
use schemars::JsonSchema;
use serde::Deserialize;

#[derive(Deserialize, JsonSchema)]
struct TideInput {
    /// The harbour to look up.
    harbour: String,
}

pub fn tide() -> Tool {
    Tool::new("tide", "Today's high tide at a harbour.")
        .read_only()
        .run(|input: TideInput, _cx: ToolContext| async move {
            Ok(format!("High tide at {} is 14:02.", input.harbour))
        })
}
```

**TypeScript**

```ts
import { tool } from "@modular-agent/core";
import { z } from "zod";

export const tide = tool({
  name: "tide",
  description: "Today's high tide at a harbour.",
  input: z.object({ harbour: z.string().describe("The harbour to look up.") }),
  readOnly: true,
  run: async ({ harbour }) => `High tide at ${harbour} is 14:02.`,
});
```

Marking the tool read-only tells the agent it changes nothing. An approval policy of `ask` then lets it run without asking. Leave it off for any tool that writes, sends or spends; the [defaults](../api.md#tools) assume a tool is destructive and reaches outside the project.

The function returns text, so the result is `completed` with that text as its content. Raising an error makes it `failed` with the error's message; `cx.refuse(reason)` makes it `refused`. See [Tools](../api.md#tools) for structured results.

## Give it to an agent

**Rust**

```rust
let agent = Agent::builder()
    .provider(openai())
    .model("openai/gpt-6-luna")
    .tool(tide())
    .build()
    .await?;
```

**TypeScript**

```ts
const agent = await createAgent({ providers: [openai()], model: "openai/gpt-6-luna", tools: [tide] });
```

Ask "When is high tide at Whitby?" and the model can call `tide` before it answers.

## Test it

The script's first response asks for the tool; the second is the answer the model gives after seeing the result. The test checks both the answer and the recorded call. This is the [`tool-call` scenario](../../../conformance/sdk/scenarios/tool-call.json) the SDKs share.

**Rust**

```rust
#[tokio::test]
async fn looks_up_the_tide() -> modular_agent::Result<()> {
    let agent = test_agent()
        .tool(tide())
        .script(json!([
            { "toolCalls": [{ "name": "tide", "input": { "harbour": "Whitby" } }] },
            { "text": "High tide is at 14:02." }
        ]))
        .build()
        .await?;
    let turn = agent.session().await?.prompt("When is high tide at Whitby?").await?;
    assert_eq!(turn.text, "High tide is at 14:02.");
    let results = turn.tool_results();
    assert_eq!(results[0].status, ToolStatus::Completed);
    assert_eq!(results[0].text(), "High tide at Whitby is 14:02.");
    Ok(())
}
```

**TypeScript**

```ts
test("looks up the tide", async () => {
  const agent = await testAgent({
    tools: [tide],
    script: [
      { toolCalls: [{ name: "tide", input: { harbour: "Whitby" } }] },
      { text: "High tide is at 14:02." },
    ],
  });
  const turn = await (await agent.session()).prompt("When is high tide at Whitby?");
  assert.equal(turn.text, "High tide is at 14:02.");
  const [result] = turn.toolResults();
  assert.equal(result.status, "completed");
  assert.equal(result.text(), "High tide at Whitby is 14:02.");
});
```

`tool_results()` reads the turn's recorded results from history, in the order the calls were made.

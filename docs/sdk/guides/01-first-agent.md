# Your first agent

Build an agent with one Provider, ask it something, and stream its answer as it arrives. Then test it without a model.

## Ask a question

Set `OPENAI_API_KEY` in the environment first. The agent's default credential store reads it there.

**Rust**

```rust
use modular_agent::{Agent, Result};
use modular_agent_openai::openai;

#[tokio::main]
async fn main() -> Result<()> {
    let agent = Agent::builder()
        .provider(openai())
        .model("openai/gpt-6-luna")
        .build()
        .await?;
    let session = agent.session().await?;
    let turn = session.prompt("Name a harbour in Yorkshire.").await?;
    println!("{}", turn.text);
    agent.close().await
}
```

**TypeScript**

```ts
import { createAgent } from "@modular-agent/core";
import { openai } from "@modular-agent/openai";

const agent = await createAgent({ providers: [openai()], model: "openai/gpt-6-luna" });
const session = await agent.session();
const turn = await session.prompt("Name a harbour in Yorkshire.");
console.log(turn.text);
await agent.close();
```

What happened:

- The agent started with its [defaults](../concepts.md#defaults): history in memory, the transient Runtime, a local working environment rooted at the current directory and no approval plugin.
- `session` created a session. `prompt` admitted the input as the local actor, `user`, ran one turn and returned its outcome. `turn.outcome` says how it ended; `turn.text` is the answer.
- No session history was written to disk. When the process ends, the session is gone. [Sessions that survive a crash](05-sessions-that-survive-a-crash.md) shows how to keep it.

## Stream the answer

`promptStream` returns the turn's events as they happen. Model text arrives as `text` events.

**Rust**

```rust
use futures_util::StreamExt;
use modular_agent::Event;

let mut events = session.prompt_stream("Describe Whitby harbour in two sentences.").await?;
while let Some(event) = events.next().await {
    if let Event::Text { delta, .. } = event? {
        print!("{delta}");
    }
}
```

**TypeScript**

```ts
for await (const event of session.promptStream("Describe Whitby harbour in two sentences.")) {
  if (event.type === "text") process.stdout.write(event.data.delta);
}
```

The stream ends with the turn's `turnEnded` event, which carries the same outcome `prompt` returns.

## Test it

The testing kit's scripted Provider answers from a [script](../testing.md#the-model-script) instead of a model, so a test needs no network and no key.

**Rust**

```rust
use modular_agent::testing::test_agent;
use serde_json::json;

#[tokio::test]
async fn says_hello() -> modular_agent::Result<()> {
    let agent = test_agent().script(json!([{ "text": "Hello." }])).build().await?;
    let turn = agent.session().await?.prompt("Say hello.").await?;
    assert_eq!(turn.text, "Hello.");
    Ok(())
}
```

**TypeScript**

```ts
import { testAgent } from "@modular-agent/core/testing";
import { test } from "node:test";
import assert from "node:assert/strict";

test("says hello", async () => {
  const agent = await testAgent({ script: [{ text: "Hello." }] });
  const turn = await (await agent.session()).prompt("Say hello.");
  assert.equal(turn.text, "Hello.");
});
```

`modulartest.Agent` closes the agent when the test ends.

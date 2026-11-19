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

**Go**

```go
package main

import (
	"context"
	"fmt"
	"log"

	"github.com/OWNER/modular-agent/go/modular"
	"github.com/OWNER/modular-agent/go/modular/openai"
)

func main() {
	ctx := context.Background()
	agent, err := modular.New(ctx,
		modular.WithProvider(openai.New()),
		modular.WithModel("openai/gpt-6-luna"))
	if err != nil {
		log.Fatal(err)
	}
	defer agent.Close(ctx)

	session, err := agent.Session(ctx)
	if err != nil {
		log.Fatal(err)
	}
	turn, err := session.Prompt(ctx, "Name a harbour in Yorkshire.")
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(turn.Text)
}
```

**Python**

```python
from modular_agent import create_agent, run
from modular_agent.openai import openai


async def main() -> None:
    async with create_agent(providers=[openai()], model="openai/gpt-6-luna") as agent:
        session = await agent.session()
        turn = await session.prompt("Name a harbour in Yorkshire.")
        print(turn.text)


run(main())
```

What happened:

- The agent started with its [defaults](../concepts.md#defaults): history in memory, the transient Runtime, a local working environment rooted at the current directory and no approval plugin.
- `session` created a session. `prompt` admitted the input as the local actor, `user`, ran one turn and returned its outcome. `turn.outcome` says how it ended; `turn.text` is the answer.
- Nothing was written to disk. When the process ends, the session is gone. [Sessions that survive a crash](README.md) changes that with one option.

## Stream the answer

`promptStream` returns the turn's events as they happen. Model text arrives as `text` events.

**Rust**

```rust
use futures::StreamExt;
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

**Go**

```go
for event, err := range session.PromptStream(ctx, "Describe Whitby harbour in two sentences.") {
	if err != nil {
		log.Fatal(err)
	}
	if text, ok := event.(modular.TextEvent); ok {
		fmt.Print(text.Delta)
	}
}
```

**Python**

```python
async for event in session.prompt_stream("Describe Whitby harbour in two sentences."):
    if event.type == "text":
        print(event.data.delta, end="", flush=True)
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

**Go**

```go
func TestSaysHello(t *testing.T) {
	ctx := context.Background()
	agent := modulartest.Agent(t, modulartest.Script(`[{"text": "Hello."}]`))
	session, err := agent.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	turn, err := session.Prompt(ctx, "Say hello.")
	if err != nil {
		t.Fatal(err)
	}
	if turn.Text != "Hello." {
		t.Fatalf("got %q", turn.Text)
	}
}
```

**Python**

```python
from modular_agent.testing import test_agent


async def test_says_hello() -> None:
    async with test_agent(script=[{"text": "Hello."}]) as agent:
        turn = await (await agent.session()).prompt("Say hello.")
        assert turn.text == "Hello."
```

`modulartest.Agent` closes the agent when the test ends.

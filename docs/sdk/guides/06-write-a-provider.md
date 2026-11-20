# Write a Provider

Build a Provider with one model, stream its reply, and test a rejected credential without a network call. The examples use a stand-in for a model service: it returns two fixed chunks and accepts only the dummy key `offline-key`.

## List the models and answer one request

A Provider has an id and returns its full current catalog from `models()`. Each model has its own id within that Provider, so the model below is `beacon/demo`. List the model's real input types and limits; the agent uses them to prepare the request. See [Models](../../bindings/data.md#models).

Where implemented, `available()` is a readiness check, not a promise that a request will succeed. Use it to report whether you can accept requests now. The example is always ready to simulate a reply. Rust exposes the check on the trait and in its plugin server, but the embedded adapter does not use it to gate requests. TypeScript uses it for the ACP model offer and forwards it over the plugin binding. Go exposes an `Available` callback but its adapters don't consult it. Python's SDK Provider protocol has no readiness callback. Handle unavailable or rejected credentials inside `request` in every language.

`request` receives the selected model, the prepared request (including messages, tools and settings) and a call-scoped context. A real Provider passes the context's cancellation signal to its client and sends the prepared request to the selected model. It gets the key through the context, not from plugin config or the prompt. The dummy below ignores the model and request and simulates a reply instead.

**Rust**

```rust
use futures_util::StreamExt;
use modular_agent::{
    Agent, AssistantMessage, Code, CredentialStore, Error, ModelError, ModelErrorKind, ModelInfo,
    ModelRef, ModelRequest, Piece, Provider, ProviderContext, ProviderSupport, Result,
};

struct Beacon;

#[modular_agent::async_trait]
impl Provider for Beacon {
    fn id(&self) -> &str {
        "beacon"
    }

    fn models(&self) -> Vec<ModelInfo> {
        vec![ModelInfo {
            model: ModelRef {
                provider: self.id().into(),
                id: "demo".into(),
            },
            context_window: 4096,
            max_output: 256,
            thinking: vec![],
            extra: serde_json::from_value(serde_json::json!({"input":["text"],"reasoning":false}))
                .unwrap(),
        }]
    }

    fn available(&self) -> bool {
        true
    }

    fn supports(&self) -> ProviderSupport {
        ProviderSupport {
            keeps_state: false,
            safe_to_repeat: true,
        }
    }

    async fn request(
        &self,
        _model: ModelRef,
        _request: ModelRequest,
        cx: ProviderContext,
    ) -> Result<AssistantMessage> {
        let key = cx.credential().await?;
        if key != "offline-key" {
            return Ok(ModelError::new(ModelErrorKind::Credentials, "Key rejected").failed());
        }
        cx.piece(Piece::Text, "Beacon ", None).await?;
        cx.piece(Piece::Text, "ready.", None).await?;
        Ok(AssistantMessage::text("Beacon ready."))
    }
}
```

**TypeScript**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgent, environmentCredentials, ModelFailure, type Provider } from "@modular-agent/core";

const beacon: Provider = {
  id: "beacon",
  models: () => [{
    provider: "beacon", id: "demo", contextWindow: 4096, maxOutput: 256,
    input: ["text"], reasoning: false,
  }],
  available: () => true,
  supports: { keepsState: false, safeToRepeat: true },
  async request(_model, _request, cx) {
    const key = await cx.credential();
    if (key !== "offline-key") {
      throw new ModelFailure({ kind: "credentials", message: "Key rejected" });
    }
    cx.piece("text", "Beacon ");
    cx.piece("text", "ready.");
    return { role: "assistant", stop: "finished", content: [{ type: "text", text: "Beacon ready." }] };
  },
};
```

**Go**

```go
var beacon = modular.Provider{
	ID: "beacon",
	Models: func() []modular.ModelInfo {
		return []modular.ModelInfo{{
			ModelRef:      modular.ModelRef{Provider: "beacon", ID: "demo"},
			ContextWindow: 4096, MaxOutput: 256, Input: []string{"text"},
		}}
	},
	Available: func() bool { return true },
	Supports:  modular.ProviderSupport{SafeToRepeat: true},
	Request: func(_ context.Context, _ modular.ModelRef, _ modular.ModelRequest, cx *modular.ProviderContext) (modular.AssistantMessage, error) {
		key, err := cx.Credential()
		if err != nil || key != "offline-key" {
			return modular.AssistantMessage{}, &modular.ModelError{
				Kind: modular.Credentials, Message: "Key unavailable or rejected",
			}
		}
		cx.Piece("text", "Beacon ")
		cx.Piece("text", "ready.")
		return modular.AssistantMessage{Content: modular.Text("Beacon ready."), Stop: "finished"}, nil
	},
}
```

**Python**

```python
from modular_agent import (
    ModelFailure,
    ModelInfo,
    ModelRef,
    ProviderContext,
    ProviderSupports,
    create_agent,
)
from modular_agent import JsonObject


class Beacon:
    id = "beacon"
    supports = ProviderSupports(safe_to_repeat=True)

    def models(self) -> list[ModelInfo]:
        return [
            {
                "provider": self.id,
                "id": "demo",
                "contextWindow": 4096,
                "maxOutput": 256,
                "input": ["text"],
                "reasoning": False,
            }
        ]

    async def request(
        self, _model: ModelRef, _request: JsonObject, cx: ProviderContext
    ) -> JsonObject:
        key = cx.credential()
        if key != "offline-key":
            raise ModelFailure({"kind": "credentials", "message": "Key unavailable or rejected"})
        await cx.piece("text", "Beacon ")
        await cx.piece("text", "ready.")
        return {
            "role": "assistant",
            "stop": "finished",
            "content": [{"type": "text", "text": "Beacon ready."}],
        }
```

## Stream pieces and settle the attempt

Call `piece` as output arrives. A text piece is a delta, not the whole answer so far; a tool-input piece also names its tool call id. Return a complete [AssistantMessage](../../bindings/data.md#messages) even when you already streamed all its text: the pieces are live output, not history. If the model asks for tools, include the complete tool calls in the message and use stop `toolUse`. The agent, not this Provider, decides which calls can run.

An admitted model failure is an AssistantMessage with stop `failed` and a ModelError. Use the kind that describes the failure: `temporary`, `contextTooLarge`, `credentials`, `refused` or `other`. Rust's `ModelError::failed()` constructs the message; TypeScript and Python turn `ModelFailure` into it, and Go does the same for a returned `*ModelError`. An untyped error after admission is recorded as kind `other`. An unknown model is instead refused before the request is admitted. Keep secrets out of pieces, results, errors and logs; tell the operator what failed without quoting the key or raw upstream response.

`keepsState` is false because the Provider keeps nothing between requests. `safeToRepeat` is true only because this simulated request has no side effects. It means an interrupted request can be repeated with the same prepared input under the [recovery rules](../../contracts.md#recovery-and-repeating-work). Stateless does not mean repeatable: a real request can disclose data, charge money or leave a record at the service. Leave the flag false unless repeating is safe. See the [Provider API](../api.md#providers) and [model request and response contract](../../contracts.md#model-request-and-response).

## Test a scripted request

Send a fixed prompt through a fresh session, then repeat in a separate session with a rejected key. Check the live deltas separately from the recorded answer. For the rejected key, check the failed **turn** and its recorded **model attempt**; there is no input error. These tests exercise the Provider you just wrote, not a real service. In Go, put both blocks in a `package modular_test` file and import `context`, `encoding/json`, `slices`, `testing`, and the SDK's `modular` and `modulartest` packages. In Python, add `import pytest`.

**Rust**

```rust
struct TestKey(&'static str);

impl CredentialStore for TestKey {
    fn read(&self, name: &str) -> Result<String> {
        if name == "beacon" {
            Ok(self.0.into())
        } else {
            Err(Error::new(Code::NotFound, "No test key for that Provider"))
        }
    }
}

#[tokio::test]
async fn beacon_streams_and_records_failures() -> Result<()> {
    for key in ["offline-key", "rejected"] {
        let agent = Agent::builder()
            .provider(Beacon)
            .credentials(TestKey(key))
            .build()
            .await?;
        assert_eq!(agent.models()?[0].model.to_string(), "beacon/demo");
        let session = agent.session().await?;
        let mut events = session.prompt_stream("Check the beacon.").await?;
        let mut pieces = Vec::new();
        while let Some(event) = events.next().await.transpose()? {
            if event.event_type == "text" {
                pieces.push(event.data["delta"].as_str().unwrap().to_owned());
            }
        }
        let turn = session.last_turn()?.expect("prompt settled");
        if key == "offline-key" {
            assert_eq!(pieces, ["Beacon ", "ready."]);
            assert_eq!(turn.text, "Beacon ready.");
        } else {
            assert!(pieces.is_empty());
            assert!(matches!(
                turn.outcome,
                Some(modular_agent::Outcome::Failed { .. })
            ));
            let history = session.history()?;
            let response = history.iter().find(|e| e["kind"] == "response").unwrap();
            assert_eq!(response["message"]["stop"], "failed");
            assert_eq!(response["message"]["error"]["kind"], "credentials");
        }
        agent.close().await?;
    }
    Ok(())
}
```

**TypeScript**

```ts
test("beacon streams and records failures", async t => {
  for (const key of ["offline-key", "rejected"]) {
    await t.test(key, async () => {
      const agent = await createAgent({
        providers: [beacon],
        credentials: { ...environmentCredentials(), read: async name => name === "beacon" ? key : undefined },
      });
      try {
        assert.equal(agent.models()[0].id, "demo");
        const session = await agent.session();
        const pieces: string[] = [];
        for await (const event of session.promptStream("Check the beacon.")) {
          if (event.type === "text") pieces.push(event.data.delta);
        }
        const turn = await session.lastTurn();
        if (key === "offline-key") {
          assert.deepEqual(pieces, ["Beacon ", "ready."]);
          assert.equal(turn?.text, "Beacon ready.");
        } else {
          assert.deepEqual(pieces, []);
          assert.equal(turn?.outcome?.kind, "failed");
          const message = (await session.history()).find(e => e.kind === "response")?.message;
          assert.equal(message?.role, "assistant");
          assert.equal(message.stop, "failed");
          assert.equal(message.error?.kind, "credentials");
        }
      } finally {
        await agent.close();
      }
    });
  }
});
```

**Go**

```go
func TestBeaconStreamsAndRecordsFailures(t *testing.T) {
	for _, key := range []string{"offline-key", "rejected"} {
		t.Run(key, func(t *testing.T) {
			t.Setenv("BEACON_API_KEY", key)
			ctx := t.Context()
			agent := modulartest.Agent(t, modular.WithProvider(beacon), modular.WithModel("beacon/demo"))
			session, err := agent.Session(ctx)
			if err != nil {
				t.Fatal(err)
			}
			var pieces []string
			for event, err := range session.PromptStream(ctx, "Check the beacon.") {
				if err != nil {
					t.Fatal(err)
				}
				if text, ok := event.(modular.TextEvent); ok {
					pieces = append(pieces, text.Delta)
				}
			}
			turn, err := session.LastTurn(ctx)
			if err != nil || turn == nil {
				t.Fatalf("last turn: %+v, %v", turn, err)
			}
			if key == "offline-key" {
				if !slices.Equal(pieces, []string{"Beacon ", "ready."}) || turn.Text != "Beacon ready." {
					t.Fatalf("pieces %q, final text %q", pieces, turn.Text)
				}
				return
			}
			if len(pieces) != 0 || turn.Outcome == nil || turn.Outcome.Kind != "failed" {
				t.Fatalf("pieces %q, outcome %+v", pieces, turn.Outcome)
			}
			history, err := session.History(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if !slices.ContainsFunc(history, func(entry modular.HistoryEntry) bool {
				var message modular.AssistantMessage
				data, _ := json.Marshal(entry["message"])
				return entry["kind"] == "response" && json.Unmarshal(data, &message) == nil &&
					message.Stop == "failed" && message.Error != nil && message.Error.Kind == modular.Credentials
			}) {
				t.Fatal("no recorded credentials failure")
			}
		})
	}
}
```

**Python**

```python
@pytest.mark.parametrize("key", ["offline-key", "rejected"])
async def test_beacon_streams_and_records_failures(
    key: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("BEACON_API_KEY", key)
    async with create_agent(providers=[Beacon()]) as agent:
        assert (await agent.models())[0]["id"] == "demo"
        session = await agent.session()
        pieces = [
            event.data.delta
            async for event in session.prompt_stream("Check the beacon.")
            if event.type == "text"
        ]
        turn = await session.last_turn()
        assert turn is not None
        if key == "offline-key":
            assert pieces == ["Beacon ", "ready."]
            assert turn.text == "Beacon ready."
        else:
            assert pieces == []
            assert turn.outcome.kind == "failed"
            response = next(
                entry for entry in await session.history() if entry["kind"] == "response"
            )
            assert response["message"]["stop"] == "failed"
            assert response["message"]["error"]["kind"] == "credentials"
```

## Serve it from another process

Wrap a request/response Provider in a plugin, register it at setup, and run `serve` on stdio, just as for [a tool in another process](03-tool-in-another-process.md). The host loads the program as a process plugin and selects a model from its catalog. Keep stdout for the binding. Choose the executable and arguments yourself; model output and project files should not choose what you launch.

Rust and TypeScript can fetch the Provider's own credentials through the host with the same context call. Go can serve a Provider but its served SDK context does not fetch credentials from the host: keep a Provider that needs that lookup in process. Python's SDK can use a Provider in process, but its SDK server cannot register one. See [Placement](../placement.md#a-plugin-in-another-process) and [the Provider binding](../../bindings/plugin.md#the-host-asks-a-provider).

These offline process tests use the testing kit's keyless scripted Provider. Rust's existing fixture program reads the script from registrar config, calls `r.provider(scripted_provider(script))` in setup, then runs `modular_agent::serve(plugin).await`. In TypeScript the test gives Node the plugin program inline; in Go the same test executable runs the plugin in a separate process. Add `fmt` and `os` to the Go imports for this block.

**Rust**

```rust
use modular_agent::{Agent, ProcessPlugin, Result};
use serde_json::json;

#[tokio::test]
async fn load_a_served_provider() -> Result<()> {
    let agent = Agent::builder()
        .process_plugin(
            ProcessPlugin::new([
                env!("CARGO_BIN_EXE_modular-agent-fixtures"),
                "provider-script",
            ])
            .config(json!({"script": [{"text": "Beacon ready."}]})),
        )
        .model("scripted/script")
        .build()
        .await?;
    let turn = agent.session().await?.prompt("Check the beacon.").await?;
    assert_eq!(turn.text, "Beacon ready.");
    agent.close().await
}
```

**TypeScript**

```ts
test("loads a Provider from another process", async () => {
  const program = `
    import { definePlugin, serve } from ${JSON.stringify(import.meta.resolve("@modular-agent/core"))};
    import { scriptedProvider } from ${JSON.stringify(import.meta.resolve("@modular-agent/core/testing"))};
    await serve(definePlugin({ name: "beacon-demo", setup(r) {
      r.provider(scriptedProvider([{ text: "Beacon ready." }]));
    }}));
  `;
  const agent = await createAgent({
    processPlugins: [{ command: [process.execPath, "--input-type=module", "--eval", program] }],
    model: "scripted/script",
  });
  try {
    const turn = await (await agent.session()).prompt("Check the beacon.");
    assert.equal(turn.text, "Beacon ready.");
  } finally {
    await agent.close();
  }
});
```

**Go**

```go
// The test executable doubles as the plugin program.
func TestBeaconPluginProgram(t *testing.T) {
	if os.Getenv("BEACON_PLUGIN_TEST") != "1" {
		t.Skip("only run in the plugin child")
	}
	p := modulartest.ScriptedProvider([]modulartest.Reply{{Text: "Beacon ready."}})
	plugin := modular.Plugin{Name: "beacon-demo", Setup: func(r *modular.Registrar) error {
		return r.Provider(p)
	}}
	if err := modular.Serve(t.Context(), plugin); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Exit(0)
}

func TestLoadServedBeaconProvider(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("MODULAR_AGENT_PLUGINS", "")
	ctx := t.Context()
	agent, err := modular.New(ctx,
		modular.WithProcessPlugin(modular.ProcessPlugin{
			Command: []string{exe, "-test.run=^TestBeaconPluginProgram$"},
			Env:     map[string]string{"BEACON_PLUGIN_TEST": "1"},
		}),
		modular.WithModel("scripted/script"))
	if err != nil {
		t.Fatal(err)
	}
	defer agent.Close(ctx)
	session, err := agent.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	turn, err := session.Prompt(ctx, "Check the beacon.")
	if err != nil || turn.Text != "Beacon ready." {
		t.Fatalf("turn: %+v, %v", turn, err)
	}
}
```

# Hooks

Add a plugin that gives the model directions, checks tool calls and observes how the turn ends. Run the same plugin in process and over the [plugin binding](../../bindings/plugin.md#from-core-hooks-to-wire-hooks). Put both blocks for your language in the same test file.

## Register the hooks

The tide preview plugin uses five points from the [SDK hook table](../api.md#hooks):

| Point | Kind | What the plugin does |
|---|---|---|
| `turn.before` | Collect | Adds three instructions to the system prompt. This point can also add context. |
| `tool.before` | Gate | Refuses a closed station, or rewrites the alias `old-town` to `Whitby` before dispatch. |
| `tool.after` | Transform | Labels a completed result as a preview. Only content and value may change, not status or call identity. |
| `step.after` | Gate | Ends the turn after the first model step. The step's calls settle before the gate runs; an end decision produces a failed turn, not a successful short answer or an undo of the calls. |
| `turn.end` | Observe | Records the outcome in the app's test sink. An observer does not change that outcome. |

Handlers run in `first`, `normal` (the default), then `last` order. Within a group they run in plugin load order, then registration order within each plugin. The plugin registers its prompt contributions out of order so the test can check how they are combined. A gate stops at a refusal; transforms pass the current value to the next handler. If any `tool.before` handler changes input, the agent runs the chain again on the new input. A second change is refused. Make a rewrite that has nothing left to change on that second pass. See [Hook execution](../../contracts.md#hook-execution) and [Gates and registration](../../contracts.md#gates-and-registration).

**Rust**

```rust
use std::time::Duration;

use modular_agent::{
    Gate, Order, Outcome, Plugin, Result, Tool, ToolChange, ToolStatus, TurnAddition,
    testing::test_agent,
};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::mpsc;

#[derive(Deserialize, JsonSchema)]
struct Harbour {
    harbour: String,
}

fn tide_preview(ended: mpsc::UnboundedSender<String>) -> Plugin {
    Plugin::new("tide-preview")
        .on_turn_before(|_| async {
            Ok(TurnAddition {
                system: Some("Give the local time.".into()),
                ..Default::default()
            })
        })
        .on_turn_before_with(Order::Last, |_| async {
            Ok(TurnAddition {
                system: Some("Keep the report short.".into()),
                ..Default::default()
            })
        })
        .on_turn_before_with(Order::First, |_| async {
            Ok(TurnAddition {
                system: Some("Report high tides.".into()),
                ..Default::default()
            })
        })
        .on_tool_before(|call| async move {
            if call.name != "preview_tide" {
                return Ok(Gate::Allow);
            }
            Ok(match call.input["harbour"].as_str() {
                Some("closed") => Gate::Refuse("That station is closed.".into()),
                Some("old-town") => Gate::Change(json!({"harbour": "Whitby"})),
                _ => Gate::Allow,
            })
        })
        .on_tool_after(|call| async move {
            if call.call.name == "preview_tide" && call.result.status == ToolStatus::Completed {
                let text = call.result.content[0]["text"]
                    .as_str()
                    .unwrap_or_default();
                return Ok(ToolChange {
                    content: Some(json!([{"type": "text", "text": format!("Preview: {text}")}])),
                    ..Default::default()
                });
            }
            Ok(ToolChange::default())
        })
        .on_step_after(|_| async { Ok(Gate::Refuse("Preview stops after one step.".into())) })
        .on_turn_end(move |turn| {
            let ended = ended.clone();
            async move {
                let _ = ended.send(turn.outcome.kind().into());
                Ok(())
            }
        })
}
```

**TypeScript**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { definePlugin, tool } from "@modular-agent/core";
import { overWire, testAgent } from "@modular-agent/core/testing";
import { z } from "zod";

function tidePreview(recordEnd: (kind: string) => void) {
  return definePlugin({
    name: "tide-preview",
    setup(r) {
      r.on("turn.before", () => ({ add: { system: "Give the local time." } }));
      r.on("turn.before", () => ({ add: { system: "Keep the report short." } }), "last");
      r.on("turn.before", () => ({ add: { system: "Report high tides." } }), "first");
      r.on("tool.before", ({ call }) => {
        if (call.name !== "preview_tide") return;
        if (call.input.harbour === "closed") return { refuse: "That station is closed." };
        if (call.input.harbour === "old-town") return { change: { harbour: "Whitby" } };
      });
      r.on("tool.after", ({ call, result }) => {
        if (call.name !== "preview_tide" || result.status !== "completed") return;
        const text = result.content[0]?.text;
        return { change: { content: [{ type: "text", text: `Preview: ${text}` }] } };
      });
      r.on("step.after", () => ({ end: "Preview stops after one step." }));
      r.on("turn.end", ({ outcome }) => recordEnd(outcome.kind));
    },
  });
}
```

## Test both placements

The scripted Provider requests two calls. The test checks the rewritten input through the tool's result, the transformed text, the refusal, the failed turn the observer sees and the order of the recorded prompt additions. The second scripted model response must not run.

First register the plugin directly. Then register it through the [testing kit's wire helper](../testing.md#the-testing-kit), which runs the real host and server over a local transport without starting another program. No model or network service is needed for either run.

**Rust**

```rust
#[tokio::test]
async fn previews_tides_in_process_and_served() -> Result<()> {
    for served in [false, true] {
        let (ended, mut observed) = mpsc::unbounded_channel();
        let plugin = tide_preview(ended);
        let builder = test_agent()
            .tool(
                Tool::new("preview_tide", "Find a high tide.")
                    .read_only()
                    .run(
                        |input: Harbour, _| async move { Ok(format!("{}: 14:02", input.harbour)) },
                    ),
            )
            .script(json!([
                {"toolCalls": [
                    {"name": "preview_tide", "input": {"harbour": "old-town"}},
                    {"name": "preview_tide", "input": {"harbour": "closed"}}
                ]},
                {"text": "This step must not run."}
            ]));
        let agent = if served {
            builder.over_wire(plugin)
        } else {
            builder.plugin(plugin)
        }
        .build()
        .await?;
        let session = agent.session().await?;
        let turn = session.prompt("Preview the high tides.").await?;
        let results = turn.tool_results();
        assert_eq!(results[0].status, ToolStatus::Completed);
        assert_eq!(results[0].text(), "Preview: Whitby: 14:02");
        assert_eq!(results[1].status, ToolStatus::Refused);
        assert!(results[1].text().contains("That station is closed."));
        assert!(
            matches!(&turn.outcome, Some(Outcome::Failed { error })
            if error.contains("Preview stops after one step.")),
            "served={served}: {:?}",
            turn.outcome
        );
        assert!(turn.text.is_empty());
        let history = session.history().await?;
        let start = history
            .iter()
            .find(|entry| entry["kind"] == "turnStart")
            .unwrap();
        let expected = [
            "Report high tides.",
            "Give the local time.",
            "Keep the report short.",
        ];
        let lines: Vec<_> = start["data"]["system"]
            .as_str()
            .unwrap()
            .lines()
            .filter(|line| expected.contains(line))
            .collect();
        assert_eq!(lines, expected);
        let kind = tokio::time::timeout(Duration::from_secs(5), observed.recv())
            .await
            .unwrap();
        assert_eq!(kind.as_deref(), Some("failed"));
        agent.close().await?;
    }
    Ok(())
}
```

**TypeScript**

```ts
test("previews tides in process and served", { timeout: 5000 }, async () => {
  for (const served of [false, true]) {
    const ended: string[] = [];
    const plugin = tidePreview(kind => { ended.push(kind); });
    const agent = await testAgent({
      plugins: [served ? overWire(plugin) : plugin],
      tools: [tool({
        name: "preview_tide", description: "Find a high tide.", readOnly: true,
        input: z.object({ harbour: z.string() }),
        run: async ({ harbour }) => `${harbour}: 14:02`,
      })],
      script: [
        { toolCalls: [
          { name: "preview_tide", input: { harbour: "old-town" } },
          { name: "preview_tide", input: { harbour: "closed" } },
        ] },
        { text: "This step must not run." },
      ],
    });
    try {
      const session = await agent.session();
      const turn = await session.prompt("Preview the high tides.");
      const [completed, refused] = turn.toolResults();
      assert.equal(completed.status, "completed");
      assert.equal(completed.text(), "Preview: Whitby: 14:02");
      assert.equal(refused.status, "refused");
      assert.match(refused.text(), /That station is closed\./);
      assert.equal(turn.outcome?.kind, "failed");
      assert.match(turn.outcome.error, /Preview stops after one step\./);
      assert.equal(turn.text, "");
      const start = (await session.history()).find(entry => entry.kind === "turnStart");
      assert.deepEqual((start?.data as { system: string }).system.split(/\n+/),
        ["Report high tides.", "Give the local time.", "Keep the report short."]);
      assert.deepEqual(ended, ["failed"]);
    } finally {
      await agent.close();
    }
  }
});
```

To deploy the same plugin separately, pass it to the SDK's `serve` function in its own program. Replace the direct registration with that program's command in the agent's process plugins, as in [A tool in another process](03-tool-in-another-process.md). In that program, send diagnostics to stderr, not the stdout used by the binding.

## If a handler fails

The [core rules](../../contracts.md#hook-execution) treat a raised error or an invalid answer according to the kind of point:

| Kind | Required behavior |
|---|---|
| Observe | Report the failure and continue the operation. |
| Gate | Treat the failure as a refusal. For example, a failed `tool.before` handler prevents dispatch. |
| Transform, collect, first answer | Fail the operation and identify the failed handler. If `tool.after` fails after the tool ran, keep a safe result with the confirmed status rather than claiming the tool never ran or running it again. See [Settlement](../../contracts.md#settlement). |

A failed `turn.end` observer is reported without replacing the turn's outcome or failure reason.

## Keep local hooks local

The [binding's hook table](../../bindings/plugin.md#from-core-hooks-to-wire-hooks) lists what a served plugin can register. The core has some points the binding does not carry: `session.prepare`, `session.join`, `session.leave`, `provider.piece` and plugin-defined points. `session.end` is servable; it is not the same point as `session.prepare`.

Some points cross the wire with fewer fields or answers:

- Served `tool.before` can pass, refuse or change input, but cannot return `pending(question)`. That restriction is for the gate; a served **tool** can still ask from its tool context.
- Served `input` can handle input, but cannot handle it by running a command.
- Served `turn.before` does not get the project and callable tool-definition snapshot; served `step.before` does not get the history and usage snapshot and cannot change the Provider-tool allowance. Where the SDK exposes a hook context with history access, read history through that context.

Mark a registration that needs an in-process-only feature as such. The SDK rejects it when serving the plugin rather than silently dropping it. See [Plugins](../api.md#plugins) for how this refusal works.

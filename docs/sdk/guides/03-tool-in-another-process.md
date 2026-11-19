# A tool in another process

Run the `tide` tool from [Add a tool](02-add-a-tool.md) in a process of its own, then load it into an agent written in a different language. The tool's code does not change. This is the [plugin binding](../../bindings/plugin.md) at work, and the SDK hides all of it.

## Serve the plugin

A plugin program wraps its tools in a plugin and calls `serve`. `serve` speaks the binding on stdin and stdout until the agent closes the connection. Here the program is in Python; any of the four would do.

```python
# tides.py
from modular_agent import Plugin, serve, tool


@tool(read_only=True)
async def tide(harbour: str) -> str:
    """Today's high tide at a harbour.

    Args:
        harbour: The harbour to look up.
    """
    return f"High tide at {harbour} is 14:02."


serve(Plugin("tides", tools=[tide]))
```

The same call in the other languages:

| Language | Serve a plugin |
|---|---|
| Rust | `modular_agent::serve(plugin).await` |
| TypeScript | `await serve(plugin)` |
| Go | `modular.Serve(ctx, plugin)` |
| Python | `serve(plugin)` |

A program must write nothing else to stdout: the binding owns it. Log with the context's `log`, which goes to stderr.

## Load it into an agent

Name the program in the agent's process plugins. The command is an argument vector, not a shell line. The program starts with a [minimal environment](../placement.md#a-plugin-in-another-process), so give the interpreter's full path. Here it is a virtual environment that has `modular-agent` installed.

**Rust**

```rust
use modular_agent::ProcessPlugin;

let agent = Agent::builder()
    .provider(openai())
    .model("openai/gpt-6-luna")
    .process_plugin(ProcessPlugin::new(["/srv/tides/.venv/bin/python", "/srv/tides/tides.py"]))
    .build()
    .await?;
```

**TypeScript**

```ts
const agent = await createAgent({
  providers: [openai()],
  model: "openai/gpt-6-luna",
  processPlugins: [{ command: ["/srv/tides/.venv/bin/python", "/srv/tides/tides.py"] }],
});
```

**Go**

```go
agent, err := modular.New(ctx,
	modular.WithProvider(openai.New()),
	modular.WithModel("openai/gpt-6-luna"),
	modular.WithProcessPlugin(modular.ProcessPlugin{
		Command: []string{"/srv/tides/.venv/bin/python", "/srv/tides/tides.py"},
	}))
```

The model sees `tide` exactly as it would in process. The call passes the same gates, is recorded the same way and returns the same result.

## Or keep it in process

The Python agent can use the same plugin directly, with no second process:

```python
from tides import tide  # move serve() under `if __name__ == "__main__":` first

agent = await create_agent(
    providers=[openai()],
    model="openai/gpt-6-luna",
    plugins=[Plugin("tides", tools=[tide])],
)
```

Which placement to use is a deployment choice. In process is faster. In its own process the tool can be written in another language, and a crash in it does not take the agent down. Neither is a sandbox: the program runs with the agent's permissions.

## When serving is refused

`serve` refuses a plugin that uses something the binding cannot carry, such as a hook point the plugin defines itself, a model-using command, or a tool flagged `inProcessOnly` because it reads a named credential. It fails at startup with `not_supported` and names what it could not serve. It does not serve the rest and drop the feature. See [Plugins](../api.md#plugins) for what is servable.

## If the program dies

If the plugin's process exits while the agent runs, the agent treats the part as [lost](../../contracts.md#parts-that-are-lost). A call that may have been dispatched is settled `outcomeUnknown`, because it may have had its effect, and is not repeated. A call that had not been dispatched is settled `notStarted`. If the program fails to start, `createAgent` fails: an agent never runs without a part it was configured to have.

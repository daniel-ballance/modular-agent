# Example: vanilla Pi as a set of plugins

**Status:** first use of the description, 2026-11-16.

This describes vanilla Pi 1.5.2 in the terms of the [architecture](../architecture.md): which plugins it is made of, what it declares, and which of its extension events match our hook points. It is a test of the description. Each place where Pi doesn't fit is listed at the end, with the [swap test](../architecture.md): would the difference break a plugin or a host?

Sources: Pi's `docs/how-pi-works.md`, `docs/extensions.md`, `docs/providers.md`, `docs/slash-commands.md` and `docs/mcp.md`, and our [Pi reference](../research/pi-reference.md). The `/tree` behaviour comes from [round 2, rung 1](../pressure-test/round-2/rung-1-pi.md).

## The plugins

Pi builds all of these in. In our terms, each is a plugin.

| Plugin | Provides | Pi today |
|---|---|---|
| Runtime | Runtime (transient) | `pi-agent-core` |
| Providers | Provider, one per vendor | `pi-ai` and its providers |
| Terminal UI | Interface | interactive mode |
| Print and JSON modes | Interface | `pi -p`, `--mode json` |
| RPC mode | Interface | `--mode rpc` |
| SDK | Interface | `createAgentSession` |
| Built-in tools | tool source | read, bash, edit, write and others |
| MCP client | tool source | `pi mcp`, `/mcp` |
| Local machine | working environment | tools use the operating system directly |
| Session files | history store | JSONL files, one tree per session |
| Auth storage | credential store | `auth.json`, `/login`, `/logout` |
| Context management | adds behaviour | compaction |
| System prompt | adds behaviour | base instructions, `AGENTS.md` and other context files |
| Agent Skills | adds behaviour | skills |
| Prompt templates | adds behaviour | prompt templates |
| Commands | adds behaviour | about 30 slash commands |
| Model selection | adds behaviour | `/model`, `/thinking`, the model registry |

Pi has no approval, guardrail, subagent, goal or scheduling plugin. Pi users add those as extensions. An extension is a plugin in our terms.

## What this setup declares

| Feature | Vanilla Pi |
|---|---|
| Taking input during a turn | yes. Steering input is taken after the current response and its tool calls. |
| Waiting for an answer through a restart | no. A pending dialog is lost if Pi stops. |
| Rewinding | no. `/tree` moves the position but doesn't restore files. |
| Forking | yes |
| Keeping state at the Provider | no, for Pi's own Providers. claude-subscription does keep state. |
| Running tools at the Provider | not checked |
| Live sessions | no |
| Several actors in one session | no |
| Holding output for the output gate | no |
| Output that bypasses the agent | none |
| Starting turns nobody asked for | only through extensions, for example `sendMessage` with `triggerTurn` |
| Cancelling a turn also cancels its jobs | Pi has no jobs built in |

## Hook points

Our standard hook points, and the Pi extension event that plays each one. Pi's "turn" is our step, and its "agent run" is our turn.

| Our hook point | Pi event |
|---|---|
| plugin about to load | `project_trust`, for project extensions as a group |
| session starts, ends | `session_start`, `session_shutdown` |
| input arrives | `input`. Registered commands are handled before it. |
| before a turn | `before_agent_start` |
| turn starts, turn ends | `agent_start`, `agent_end`, `agent_settled` |
| before each step | `context`, `context_with_system` |
| after each step | `turn_end`, which can add entries and ask to continue |
| before a tool call | `tool_call` |
| after a tool call | `tool_result` |
| a model request failed | none. Pi retries, and compacts after a context overflow, without a hook point. `session_before_compact` reports `willRetry`. |
| the turn's result is ready | `agent_before_settle`, which can add entries and ask for one more continuation |
| before output reaches a recipient | none. Markdown transformers change what the terminal shows, but RPC clients get raw events. |
| Provider: before a model request | `before_provider_headers`, `before_provider_request` |
| Provider: as the response arrives | `after_provider_response`, `provider_stream_event`, `message_update` |

Pi has more events than our standard set: `session_before_fork`, `session_before_tree`, `session_before_compact`, `model_select`, `thinking_level_select`, `resources_discover`, `user_bash` and `cache_warming_decision`. In our terms these are hook points that feature plugins define. Commands define fork and tree, context management defines compaction, model selection defines the model events, and skills and templates define resource discovery. That supports the decision that plugins can define hook points.

Pi's dialogs (`ctx.ui.confirm`, `select`, `input`, `editor`) are input requests. Its `ui_prompt_start` and `ui_prompt_end` events are "input request opened" and "closed".

## Where Pi doesn't fit

| Difference | Breaks a plugin or a host? | Verdict |
|---|---|---|
| `/tree` moves the position without recording it, so a restart doesn't reopen the session there. | A host that follows the position would see it jump back after a restart. | Pi is described as not keeping its position across restarts, as [decided](../pressure-test/round-2/synthesis.md#decisions). No change to the description. |
| No output gate. RPC clients receive output before any plugin can redact it. | A guardrail plugin couldn't work over RPC. | Pi lacks a standard hook point. A Pi-based agent would need it added before it offers guardrails. No change to the description. |
| Retrying a failed model request is built in, not a hook point. | A plugin that wants its own retry policy can't have one. | Pi lacks a standard hook point. No change to the description. |
| Aborting returns queued input to the editor. | No. The contract lets an Interface withdraw queued input. | Fits. What cancelling does to queued input is still [open](../open-questions.md#cancellation), and Pi is one answer. |
| Extensions run inside Pi's process with its full permissions, so "plugins stay within the plugin API" is a convention, not enforced. | An extension that reaches past the API wouldn't survive a swap to another Harness. | Known. The guarantee describes the design, not enforcement. |
| Amazon Bedrock and Google Vertex can use ambient cloud credentials from the environment, not `auth.json`. | No. The Runtime still never sees them. | Fits, with the environment acting as a second credential store. Worth noting under [How many of each capability](../open-questions.md#how-many-of-each-capability). |
| No approval plugin, so every tool call runs. | No. "Approval fails closed" applies only when approval is asked for. | Fits. |

## What this showed

- **Pi can be described in our terms without changing the description.** Every built-in feature is either a capability or a feature plugin, and most of our hook points have a Pi event.
- **Two of our standard hook points are missing in Pi:** "a model request failed" and "before output reaches a recipient". A Pi-based implementation of this description would need to add both. That is a real gap between Pi and our standard set, not a flaw in the description.
- **Pi's extra events are all plugin-defined hook points in our terms.** That confirms that plugins need to be able to define hook points.
- **One open question gains an answer from prior art:** cancelling a turn can hand queued input back to the Interface, as Pi does.

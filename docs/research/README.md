# Research and prior art

Notes on other systems, gathered to inform the [architecture](../architecture.md). Each note records its sources and the date it was checked. They describe how others do things, including how they wire things; our own description stays at the level of what.

## The notes

| Note | What it covers |
|---|---|
| [Pi](pi-reference.md) | Our reference implementation: its loop, extensions, tools, and how it waits for the user |
| [Implementation concerns](implementation-concerns.md) | Questions the pressure tests raised about how individual parts work inside, kept out of the architecture |
| [Pi's built-in features as plugins](pi-builtins-as-plugins.md) | How the plugin API was worked out, one Pi feature at a time |
| [DeepSeek Harness](deepseek-harness-reference.md) | Everything is a plugin, including the loop; approval that fails closed; timed questions; "model-visible means logged" |
| [Pydantic AI](pydantic-ai-reference.md) | A lean core with a large plugin library; three ways to resolve a waiting call; durability is not storage |
| [PiG](pig-reference.md) | Pi ported to Go, hosting extensions in Go, Rust, Python and Node over one subprocess wire; how it keeps four SDKs consistent |
| [T3 Code](t3-code-reference.md) | A layer above whole agents: how it drives Pi, and how agents delegate to and message each other |
| [SDK findings](sdk-findings.md) | Decisions from the four SDK builds and the disposition of the other findings |
| [API-key reasoning](sdk-api-key-reasoning.md) | OpenAI and Anthropic request settings and the research behind the shared catalog |
| [Grok with The X Subscription](grok-x-subscription.md) | Grok Build sign-in and model access, the existing `ma` path, and what the SDKs can support |
| [Protocol landscape](protocol-landscape-2026-11.md) | MCP, MCP Apps, AG-UI, A2A, ACP, A2UI and OpenTelemetry |
| [Codemode engines](codemode-engines.md) | One sandbox for all four `ma` builds; Monty, QuickJS, Starlark, Lua, and Go worker tests |
| [ChatGPT conversation](chatgpt-conversation.md) | Where the project started, and what we kept, changed or dropped |

## How each agent fills our parts

This is the first attempt at the [acceptance test](../architecture.md#how-we-will-know-the-description-is-right): saying which piece of each system plays each of our parts. Tau and PiG have not been examined yet.

| Our part | Pi | DeepSeek Harness | Pydantic AI | T3 Code |
|---|---|---|---|---|
| Harness | `pi-coding-agent`, with most features built in | its plugin host and core packages | the `Agent`, which combines plugins; the application owns sessions | sits above whole agents ([open](../open-questions.md#a-layer-above-the-agent)) |
| Plugin | extension | plugin | capability | the extension it injects into Pi |
| Runtime | `pi-agent-core` | the agent-loop plugin | the agent graph | each agent it drives |
| Provider | `pi-ai` | model adapters | models and providers | none: each agent brings its own |
| Interface | terminal UI, print, JSON and RPC modes, SDK | web UI, SDK server, ACP server | CLI, web chat, AG-UI, Vercel AI, ACP, A2A | itself: web, desktop and mobile apps |
| Tool source | built-in tools, extension tools, MCP | tool registry with swappable executors | toolsets, MCP | its MCP server |
| History store | session files | a persistence plugin | left to the application | its own database |
| Approval | an extension | closed outcomes that fail closed | tools that need approval | permission modes, applied by a Pi plugin |
| Waiting for the user | waits in place, lost if Pi stops | waits for a set time, then leaves the question open | answers in place, hands out a resume token, or ends the run | marks each request live or no longer answerable |
| Surviving interruptions | none | marks unfinished tool calls "outcome unknown" or "not started" | nine durable engines | records intent before acting; checkpoints in Git |
| Subagents | not built in | one operation for local and external agents | a plugin | child threads on any provider |

## How units of work line up

| Ours | Pi | DeepSeek Harness | Pydantic AI | T3 Code |
|---|---|---|---|---|
| Session | session | session | conversation | thread |
| Turn | agent run | turn | agent run | run |
| Step | turn | step | model request and its tool calls | inside the agent |
| Tool call | tool execution | tool call | tool call | tool item |
| Input request | extension UI request | approval or user question | deferred tool call | runtime request |

| Ours | AG-UI 1.0 | A2A 1.0 | ACP | OpenTelemetry GenAI |
|---|---|---|---|---|
| Session | thread | context | session | conversation ID |
| Turn | run | task, roughly | prompt turn (v1); foreground work (v2) | `invoke_agent` span |
| Step | step, though not always a model call | none | none | `chat` span |
| Tool call | tool call events | none | tool call | `execute_tool` span |
| Turn waiting for the user | run ends with an interrupt, resumed by a later run | `INPUT_REQUIRED`, `AUTH_REQUIRED` | `requires_action` (v2) | none |

## Where each protocol sits among our parts

| Protocol | Our part |
|---|---|
| MCP | a tool source, through an MCP client plugin |
| MCP Apps | how a tool result is shown; tool calls started by a UI ([open](../open-questions.md#tool-calls-outside-a-turn)) |
| AG-UI | an Interface for web UIs |
| ACP | an Interface for editors and automation. ACP's "agent" is our whole agent. Driving another agent over ACP makes it a tool source. |
| A2A | an Interface when other agents use ours, and a tool source when we use theirs |
| A2UI | a content type passed through intact |
| OpenTelemetry | what a telemetry plugin reports |

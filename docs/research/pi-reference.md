# Pi as reference implementation

These notes come from Pi v1.5.2, read on 2026-11-14 from the local install:
- `docs/how-pi-works.md`, `docs/extensions.md`, `docs/compaction.md`, `docs/rpc-extension-ui.md` and `docs/usage.md` under `~/.local/share/mise/installs/pi/1.5.2/pi/`
- `examples/extensions/question.ts` and `examples/extensions/permission-gate.ts` in the same install
- for tools, the compiled source in `~/Code/pi-packages/node_modules/@earendil-works/`: `pi-agent-core/dist/agent-loop.js`, `pi-coding-agent/dist/core/agent-session.js` and `pi-coding-agent/dist/core/tools/tool-definition-wrapper.js`
- the `@earendil-works/pi-agent-core` README, at `~/Code/pi-packages/node_modules/@earendil-works/pi-agent-core/README.md`

## Vocabulary

| Pi | Ours |
|---|---|
| turn (one model call plus its tool calls) | step |
| agent run (`agent_start` … `agent_end`) | turn |
| session | session |
| `pi-agent-core` | Runtime (Pi has no Core/Runtime split) |
| `pi-coding-agent` | Harness |
| `pi-ai` | Provider |
| `pi-tui`, print mode, JSON mode, RPC mode, SDK | Interfaces |
| extension | plugin |
| `ExtensionAPI` | plugin API |
| slash command | command |

## Layer 1: `pi-agent-core` (the loop)

Each slot holds one function, set when the agent is created. Nothing is advertised or discovered, and nothing manages lists of handlers.

| Slot | When it fires | What it can do |
|---|---|---|
| `transformContext` | before every model call | prune or inject messages |
| `convertToLlm` (required) | before every model call | turn the app's own message types into model messages |
| `prepareRequest` | before every model call | rebuild the context from the canonical store |
| `beforeToolCall` | after the arguments are validated | block the call, optionally with `terminate` |
| `afterToolCall` | after the tool runs | modify the result, or set `terminate` |
| `finishTurn` | after the model call and its tools | end, or continue (guarantees one more request) |
| `streamFn` | each model call | the Provider handle |
| `getApiKey` | each model call | fetch credentials from above, on demand (for expiring OAuth tokens) |

- Everything else is notification-only, through `subscribe`: `agent_*`, `turn_*`, `message_*` and `tool_execution_*`.
- Tool execution can be parallel (the default) or sequential. Results are reported in the order the model requested them.
- **Steering** messages enter after the current model response. **Follow-up** messages enter after the run finishes.

## Layer 2: `pi-coding-agent` (the Harness)

Fills each of those slots and exposes about 40 extension events, many of which can be stacked.

**Ways handlers combine:**
- notification
- in-place mutation
- chained transformation
- gate
- actionable boundary (`turn_end` and `agent_before_settle` can propose entries and request a continuation)
- last override

**Order of hooks around a model request:**
1. `context` (modify messages)
2. `context_with_system` (modify the full transcript)
3. `before_provider_headers`
4. `before_provider_request` (replace the payload)
5. `after_provider_response`
6. `provider_stream_event`

**Order of hooks around a tool:**
1. `tool_execution_start`
2. `tool_call` (block or modify the input)
3. `tool_execution_update`
4. `tool_result` (modify)
5. `tool_execution_end`

**Hook points the Harness owns itself:** `session_start`/`session_shutdown`, `input`, `before_agent_start` (system prompt and injected messages), `model_select`, `session_before_compact`, `session_before_tree`.

## Context and history

- The session is an append-only JSONL **tree**. The active branch provides the history. What the model sees is a *view* of that branch, rebuilt before every request.
- **Compaction** triggers when `contextTokens > contextWindow - reserveTokens` (16384 by default). It is checked between steps inside a run, after tool results are added. It keeps roughly the most recent `keepRecentTokens` (20k by default), uses a model call to summarize the older span, then **appends** a compaction entry with `firstKeptEntryId`. Nothing is deleted.
- Extensions can adjust context per request (`context`) or replace summarization (`session_before_compact`).

## Tools

The Runtime calls tools directly, but every tool it calls is a function the Harness built. It never asks the Harness to run one.

- **The Runtime knows only tool objects.** An `AgentTool` is `{ name, description, parameters, executionMode, execute(toolCallId, args, signal, onUpdate) }`, held in `agent.state.tools`. The Runtime does not know whether a tool is built in, from an extension, or from MCP.
- **The Harness builds the list.** It gathers built-in, extension and MCP tools and wraps each with `wrapToolDefinition`, which creates the extension context (`ctx`, with `ctx.ui`, `ctx.executeTool` and so on) when the tool is called. It applies which tools are active and lets extensions rewrite descriptions (`prepareLoadout`), then sets `agent.state.tools`. Before each model request the Runtime compares that list with the tools the transcript has declared, and adds a system message announcing any change.
- **The Runtime runs each call** in `agent-loop.js`:
  1. Find the tool by name. An unknown name becomes an error result.
  2. Validate the arguments against the schema. Invalid arguments become an error result.
  3. Call the `beforeToolCall` slot, which can block the call.
  4. Call `tool.execute(...)`. A thrown error becomes an `isError` result.
  5. Call the `afterToolCall` slot, which can replace the result.
  6. Append `toolResult` messages in the order the model requested the calls, even when they ran in parallel.
- **The Harness fills the two slots.** `_installAgentToolHooks()` points `beforeToolCall` and `afterToolCall` at functions that run the extensions' `tool_call` and `tool_result` handlers. The `afterToolCall` function also resizes images. A permission gate is therefore Harness code running inside a slot the Runtime calls.
- **Tools that call tools** use `ctx.executeTool()`, which codemode relies on. The call goes back into the Harness, which sends it through the Runtime's tool pipeline with the same hooks, tagged with a `parentToolCallId`.

**For our design:** this is the Provider-handle pattern ([ADR 0005](../adr/0005-provider-handles-from-the-harness.md)) applied to tools. In one process, a handle is a closure, so "the Runtime calls the tool" and "the Harness's code runs" are both true. Over a wire, calling a tool handle becomes a request to the Harness and a result back, which is what [Contracts](../contracts.md#harness-and-runtime) describes. See open question [Direct tool access](../open-questions.md#direct-tool-access).

## Waiting for the user

Pi pauses a turn in place. It has no turn-level suspended state: the wait is an `await` inside the agent loop.

- **Approval is not built in.** An extension adds it: a `tool_call` handler awaits `ctx.ui.confirm(...)` and returns `{ block: true, reason }` if the user declines.
- **Questions to the user are tools.** The tool's `execute` awaits `ctx.ui.select()`, `input()`, `editor()` or `custom()`, and the answer goes back to the model as an ordinary tool result. From the model's side nothing is interrupted.
- **In the TUI**, `ctx.ui.custom()` replaces the input editor with the prompt component until `done()` is called. The transcript and the pending tool call stay visible above it.
- **Extras:**
  - Escape cancels a prompt.
  - A `timeout` option shows a countdown, then resolves to a default (`undefined` for `select` and `input`, `false` for `confirm`). An `AbortSignal` can dismiss a prompt too.
  - `ui_prompt_start` and `ui_prompt_end` are notification-only events, so a status bar can show "waiting for user" instead of "running". Nested prompts are combined into one waiting span.
- **In RPC mode** the same wait travels over stdin and stdout. Pi emits an `extension_ui_request` with an `id` and a `method` (`select`, `confirm`, `input` or `editor`), and blocks until the client sends an `extension_ui_response` with the same `id`, carrying `value`, `confirmed` or `cancelled: true`. Other methods (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`) are fire-and-forget. `custom()` returns `undefined` in RPC mode.
- **Without a UI** (print and JSON modes), `ctx.hasUI` is false and nothing can wait. The `question` example returns an error result instead.
- **Input typed during a run does not suspend anything.** A steering message (Enter) enters after the current response and its tool calls finish. A follow-up (Alt+Enter) enters after the run finishes. Aborting returns queued messages to the editor.

**Consequence (our inference, not stated in Pi's docs):** the pending wait is a promise held in memory. If the process dies or an RPC client disconnects, the question is lost, and the session file records only the tool result once it arrives. This works for Pi because its Interface, Harness and Runtime share one process.

## Wire protocol

Pi's only wire protocol is **RPC mode**: JSONL commands on stdin, and responses and events on stdout. That is prior art for our Interface ↔ Harness boundary. Every other boundary in Pi is an in-process TypeScript call.

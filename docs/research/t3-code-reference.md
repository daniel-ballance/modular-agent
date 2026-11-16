# T3 Code as a reference: driving agents, and agents working together

T3 Code is the app this project's conversations run in. It is a GUI (web, desktop and mobile) and a server that drives coding agents such as Codex, Claude Code, OpenCode and Pi. These notes look at two things:
- how it exposes its own features to an agent it is driving
- how it lets agents and threads work with each other

Sources, read on 2026-11-16:
- the repository <https://github.com/pingdotgg/t3code> at commit `222288b` (2026-11-16), server version `0.1.9`, cloned to `~/Code/_ref/t3code`. The same version runs locally.
- the Pi extension that the running T3 Code injects into Pi, at `~/.t3/caches/pi-t3-mcp-extension.ts`
- docs: `docs/internals/overview.md`, `glossary.md` and `providers.md`; `docs/orchestration-v2/README.md`, `provider-capability-system.md`, `orchestrator-mcp-server.md`, `thread-lineage-and-context-transfer.md`, `provider-switching-and-context.md`, `feature-lifecycles.md` and `core-graph-and-data-model.md` (in part); `docs/user/permission-modes.md` and `outside-agents.md`
- source, briefly: `apps/server/src/mcp/McpToolExposure.ts`, `packages/contracts/src/orchestratorMcp.ts`, `packages/provider-pi/src/server/adapter.ts`

The orchestration-v2 documents describe a target design. Where they differ from the code, these notes follow the code or say so.

## Where it sits

T3 Code sits *above* a whole agent. In its vocabulary a **provider** is an agent runtime such as Codex or Pi, which is our Harness and Runtime together. That makes its terms clash with ours:

| T3 Code | Ours |
|---|---|
| provider (Codex, Claude Code, Pi, …) | a whole agent: Harness plus Runtime |
| driver / adapter | the code that drives one kind of agent |
| provider instance | one configured agent, with its own account |
| thread (app thread) | session, as the person sees it |
| provider session / provider thread | the agent's own session, attached to a T3 thread. A thread can have several over time. |
| run | turn |
| provider turn, run attempt | the agent's native turn. One run can hold several (see [Input during a turn](#input-during-a-turn)). |
| execution node | a node in the tree of work in a run: tool call, approval, subagent |
| runtime request | an approval or question the agent asks |
| environment | one T3 server and the machine it owns |

So T3 Code is not a peer of Pi in our model. It is what our model would call an Interface, plus more: it also coordinates several agents, keeps its own durable record of every thread, and moves context between agents.

## How it drives Pi

T3 runs the user's own `pi` in RPC mode, with one extra plugin:

```text
pi --mode rpc --extension <T3 home>/caches/pi-t3-mcp-extension.ts
```

It hands the extension, through environment variables, the URL of T3's MCP server, a bearer token scoped to this session, and the thread's permission mode. T3 then plays **three of our roles at once** toward Pi:

1. **Interface.** It drives turns over Pi's RPC protocol: it prompts, steers, queues, aborts, forks and resumes. It answers Pi's `extension_ui_request` dialogs. A `confirm` becomes an approval in T3's UI, and `select`, `input` and `editor` become questions (`packages/provider-pi/src/server/adapter.ts`).
2. **Tool source.** It serves an MCP server named `t3-code` with tools for orchestration, threads, previews, worktrees, pull requests and scheduling.
3. **Plugin.** The injected extension uses only Pi's public extension API:
   - **Permission gate.** A `tool_call` handler enforces T3's permission mode. Outside full access, it lets read-only tools through, and in auto-accept-edits mode also `edit` and `write`. Otherwise it awaits `ctx.ui.confirm(...)`, which travels over RPC to T3's approval UI, and blocks the call if the user declines. As the [Pi reference](pi-reference.md#waiting-for-the-user) notes, Pi has no approval built in. T3 adds it as a plugin and answers it as an Interface.
   - **Tools.** It connects to T3's MCP server over HTTP and registers each T3 tool as a Pi tool named `mcp__t3-code__<name>`. It keeps this bridge instead of Pi's native MCP support because Pi's MCP config can override registrations and its default 60-second timeout would cut off long-running T3 tools.
   - **Progressive disclosure.** On Pi 0.99 and later, only `orchestrator_capabilities`, `delegate_task` and `task_status` are declared to the model up front. The rest are deferred, and the model finds them with Pi's built-in `tool_search`. The server keeps the same split for clients that search (`McpToolExposure.ts`).
   - **Instructions.** A `before_agent_start` handler adds a "T3 Code orchestration" section to the system prompt. It says when to use T3's tools rather than the agent's own subagents.
   - **Input.** An `input` handler expands each `$skill` chip from the composer into the skill's text, because Pi expands only one leading `/skill:` command.
   - **Provider request.** A `before_provider_request` handler sets the service tier T3 chose, which Pi has no setting for. T3 sets it through a command, `/t3-service-tier`, that the extension registers.

T3 deliberately leaves the rest to Pi: "Pi … owns native extension, package, and project trust discovery. T3 injects only its namespaced MCP bridge, so a Pi session behaves as it does in the Pi TUI."

Other agents get the same MCP server through their own mechanism: Codex in its thread config, Claude through the Agent SDK's `mcpServers`, ACP agents through `session/new`. Codex gets it twice, so that its two blocking tools stay out of Codex's code mode.

## Agents declare what they can do

Every adapter reports a set of capability flags, and orchestration decides what to do from those flags, never from the provider's name (`provider-capability-system.md`). The groups:
- **sessions:** can the model change within a session; do pending requests survive a restart
- **threads:** read a snapshot, roll back, fork, fork from a turn or from a subagent's thread
- **turns:** native turn IDs, interrupt, steering an active turn, steering by interrupt-and-restart, queued messages, how reliable the "turn ended" signal is
- **streaming, tools, approvals:** which kinds of approval exist; whether approval callbacks are "live only"; whether subagents can ask for approval
- **planning:** to-do lists, proposed plans, structured questions
- **subagents:** native subagents, their thread IDs, lifecycle events, wait, close
- **context:** can the agent accept injected context, and of which kinds; can it summarize
- **checkpointing and identity:** can it roll back its conversation; how strong its IDs are (`strong`, `weak` or `none`)

**Each missing capability has a declared fallback.** For example:
- no active steering: interrupt the turn and restart it with the new message
- no native fork: build the fork from T3's own record
- no conversation rollback: restore the files, then restart the agent's context and mark it as diverged
- no structured approvals: run under the configured sandbox, with no approval UI

The UI is told which actions are available instead of meeting provider-specific errors.

**Provider IDs are references, not identities.** T3 allocates its own IDs for threads, runs, nodes and requests, and keeps the agent's IDs only as references. An agent that has no IDs gets T3-allocated ones by position.

## Waiting for the person

- Every approval or question from an agent becomes a **runtime request** with a T3-owned ID, attached to the node that asked. Kinds: command, file read, file change, dynamic tool call, user input, auth refresh.
- **Each request records whether it can still be answered:** `responseCapability` is either `live` (the agent's callback is still waiting) or `not_resumable` (it is gone, for example after a restart). A request can stay visible after a restart, but it is answerable only while live. This is "paused in place" with the loss made explicit.
- **Codex's asynchronous questions work the other way.** They arrive as notifications and are answered with a new user message, so they survive the turn ending, the agent exiting and a server restart. Answering commits the resolution and the message in one transaction, and retrying does not post the answer twice. This is "ended, then resumed".
- Pi's prompts are always the first kind: they are lost if Pi's process dies.
- Approvals that a subagent raises appear in the parent thread's conversation, so the person can answer without switching threads.

## Input during a turn

T3 separates the person's intent from what the agent can do (`feature-lifecycles.md`). There are four ways to deliver a message:
- **start** a run, if none is active
- **steer** the active run in place, if the agent supports it
- **restart:** interrupt the active run and start it again with the message included
- **queue** a new run after the active one

`auto` picks among them. Because a **run** (the person's turn) is separate from the agent's native turns, one run can hold several attempts, such as the interrupted one and its restart. Only the final attempt completes the run. Codex's `/goal` mode also puts several native turns in one run.

## Agents working together

All of this goes through T3's MCP tools. They are T3 operations, not the agent's own subagent features, so they work the same across agents and across providers.

**Delegation** (`delegate_task`, `task_status`, `task_cancel`):
- A delegated task always creates a **child thread** in T3, linked to the parent's node. It can run on any provider and model, chosen with `orchestrator_capabilities`.
- **The child gets only the task prompt,** plus an optional role instruction. None of the parent's history is copied.
- **Privilege can only narrow.** A child's permission mode must be equal to or narrower than its parent's, and plan mode cannot widen to default.
- **The child can share the parent's checkout, or get its own** worktree from the parent's commit (`isolation: "worktree"`).
- **Waiting.** `mode: "wait"` blocks until the result arrives or a timeout. A timeout does not cancel the child. `mode: "async"` returns at once.
- **Completion wakes the parent.** When a result includes `next`, the parent should not poll. The finished task's result is delivered to the parent thread as new input and starts a parent turn if one isn't running.
- **Questions from children are routed to the parent.** People rarely watch child threads, so when a child asks the person something, the parent gets a message telling it to answer through the pending-request tools or to ask the person. If the parent's turn is running and its agent can take steering, the message steers into that turn.
- **Results move as recorded context transfers:** one for the spawn and one for the result.
- **Retrying is safe.** A `clientRequestId` makes each call idempotent: retrying returns the same durable work.
- **Cancelling** stops everything the child delegated in turn, then the child itself.

**Threads as peers.** Any agent can list, read, rename, message, wait on or interrupt any thread in the environment. The same four delivery modes apply. A tool that changes another thread needs the caller's own run to be live, and the target's permission mode may not be wider than the caller's. Agents refer to threads by a link (`t3-thread://v2/<environment>/<thread>`), never by a title, which can go stale.

**Across machines.** A linked environment is another T3 server. Tools take an `environmentId` and are forwarded there, so a task can be delegated to another machine.

**Without a turn.** Scheduled tasks run a prompt on an interval, at a fixed time, or on each qualifying webhook request, with no active turn. They post into a bound thread or start a new one.

**Outside agents.** Agents that T3 did not start, such as Claude Code in a terminal or ChatGPT, can connect to the same MCP server with OAuth. The person chooses an access level, such as read-only.

## Moving context between agents

Forks, provider switches, merging a fork back, and subagents share one model (`thread-lineage-and-context-transfer.md`):

```text
thread relationship + source point + optional context transfer
```

- A **context transfer** is a cheap, recorded link from a source point (a thread and a completed run or checkpoint) to a target. It stays pending until a run actually needs it.
- When the target's first run starts, the transfer is **resolved**. If the same agent can fork natively, it does. Otherwise T3 builds a **context handoff**: an explicit, auditable summary artifact, never "hidden prompt concatenation".
- **Switching provider mid-thread** is a transfer within one thread. When the thread returns to an agent it used earlier, T3 resumes that agent's old session and hands it a summary of only the runs it missed. It falls back to a fresh session with a full summary when resuming fails or the old context is stale. Each agent session records which runs it saw natively and which it received as handoffs.
- **This project's own conversation shows it.** After the Pi process was restarted, this thread's next turn began with a "Provider context handoff" preamble, either a delta since Pi last saw the thread or a full summary, with instructions for recovering omitted history through `t3_thread_read`.

## Durability

- **The thread is T3's, and it outlives the agent's process.** T3's record is the source of truth for the person's conversation. Each agent's own session is a resumable handle attached to it.
- **Intent is recorded before anything happens.** A command is decided into events with no I/O. The events, the updated state, a receipt for the command and the side effects to perform (an "outbox") are committed in one transaction. A worker then performs the side effects, such as starting an agent turn or capturing a checkpoint, and reports the results back as new commands. An acknowledgement means the intent is committed, not that the work is done. Receipts make retries idempotent.
- **Checkpoints are T3's.** Each run's files are captured as hidden Git refs. Rolling back has to match the files with the agent's conversation, so an agent that cannot roll back its conversation rejects the revert before any file changes.
- **The event log is pruned after about a day.** Replay depends on the stored state, not on the full log. That is the opposite of DeepSeek Harness's "model-visible means logged".
- Credentials for T3's MCP server are scoped to one environment, thread, provider instance and agent session. They expire, and they are revoked when the session ends. The raw token is never stored in orchestration state.

## Ideas worth taking

1. **A whole agent can be a part.** T3 treats Pi, Codex and Claude Code as interchangeable agents, each reached through an adapter. This bears on open question [Agents working together](../open-questions.md#agents-working-together), and suggests a layer above the agent (open question [A layer above the agent](../open-questions.md#a-layer-above-the-agent)).
2. **An outside system can join an agent purely through its plugin API.** T3 enters Pi as an Interface, a tool source and a plugin at the same time, using only Pi's public RPC and extension APIs. That supports [ADR 0011](../adr/0011-minimal-harness-everything-is-a-plugin.md), and it shows that approval can be a plugin that an Interface answers.
3. **Capability flags with declared fallbacks.** An agent, or a Runtime, declares what it supports, and the host has a stated fallback for each gap. This bears on open questions [Plugins building on plugins](../open-questions.md#plugins-building-on-plugins) and [Transient and durable Runtimes](../open-questions.md#transient-and-durable-runtimes), and on making transient and durable Runtimes fit one description.
4. **"Can this still be answered?" is recorded on each request** (`live` or `not_resumable`). That gives open question [Waiting for the user](../open-questions.md#waiting-for-the-user) an honest way to show which waits were lost.
5. **Person intent versus agent mechanics in steering:** steer in place, restart, queue or start, chosen by what the agent supports (open question [Input during a turn](../open-questions.md#input-during-a-turn)).
6. **A recorded context transfer, resolved lazily,** for forks, provider switches, merging back and subagents. Subagents start from the task prompt alone.
7. **Privilege only narrows** across delegation and messaging between threads. Retry keys make agent-initiated work idempotent.
8. **Completion wakes the parent,** and questions from children are routed to the parent, instead of either one polling (open questions [Work outside a turn](../open-questions.md#work-outside-a-turn) and [Agents working together](../open-questions.md#agents-working-together)).
9. **Record intent and side effects together, then act** (the outbox). That is a pattern for the durable Runtime in open questions [What history records](../open-questions.md#what-history-records) and [Transient and durable Runtimes](../open-questions.md#transient-and-durable-runtimes).

## Cautions

- The orchestration-v2 documents call themselves "target architecture". Some parts, such as the outbox, are described as follow-up work in one place and as done in another. The code was only spot-checked.
- The extension and the system-prompt section are tuned to steer today's models, for example "Do not poll it". That is product guidance, not architecture.
- T3 keeps only about a day of its event log, so its durability rests on stored state, not on replaying history.

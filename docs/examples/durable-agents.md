# Example: two durable agents

**Status:** 2026-11-16.

This describes two durable agents in the terms of the [architecture](../architecture.md): Pi Durable, and Pydantic AI running on a durable engine such as Temporal. It tests the weakest claim in the description, that a transient and a durable Runtime fit one description. Each difference is checked with the [swap test](../architecture.md): would it break a plugin or a host?

## Sources

- **Pi Durable:** `packages/durable` in the Pi repository, version 1.5.2, commit `e03dca7`, cloned to `~/Code/_ref/pi`. Read: `README.md` and the opening of `docs/suspendable/book.md`. Also Earendil's announcement, <https://earendil.com/posts/pi-durable/> (2026-10-01). The README marks the package experimental.
- **Pydantic AI:** commit `c7586d7`, `docs/durable_execution/overview.md`, `backends.md` and `temporal.md`, `docs/capabilities/handle-deferred-tool-calls.md`, and our [Pydantic AI notes](../research/pydantic-ai-reference.md).

## Pi Durable

Earendil built it for "long-running, durable, and malleable agents that can run anywhere", that "multiple humans" can steer. It is a library, not an app. Pi the coding agent stays as it is.

### How it fills our parts

| Our part | Pi Durable |
|---|---|
| Harness | its `Harness`: one open storage plus the machinery that runs conversations on it |
| Session | conversation. Entries never change once committed. |
| Turn | run: the turns from an input to its final answer |
| Step | turn: one model response and its tool calls |
| Runtime | the built-in `pi.generation` and `pi.tool` tasks. Every step of a run is a task that saves a checkpoint before it moves on. |
| Provider | `pi-ai` models |
| History store | storage backends: memory, SQLite, JSONL, IndexedDB, Cloudflare Durable Objects |
| Working environment | `env`, built per tool call from the conversation's working directory. It can be local or remote. |
| Tool source | tools in extensions, such as `CodingTools` |
| Plugin | extension: tools, prompt sections, hooks, wrappers and tasks |
| Job | a task created with `background: true`, which survives the conversation being stopped |
| Subagent | a conversation owned by a task. A few lines of code, not built in. |
| Input request | a parked tool call or a parked `beforeTool` gate, woken by a signal |
| Interface | the host's own code. It submits input and watches conversations. |

### What it declares

| Feature | Pi Durable |
|---|---|
| Taking input during a turn | yes. Steering joins after the current tool round. Follow-ups wait for the answer. |
| Waiting for an answer through a restart | yes. A parked call holds no process, and a restart runs no tool code while it is parked. |
| Rewinding | no. A reset starts a new context, and the old entries stay. |
| Forking | yes, from any entry |
| Keeping state at the Provider | a session identity is kept for prompt caching. No conversation state. |
| Several actors in one session | not built in. The host records who wrote each input, for example in the entry's data. |
| Starting turns nobody asked for | yes, through tasks: schedules, a job's report, a subagent's answer |
| Cancelling a turn also cancels its jobs | no. Background tasks survive. A separate option stops them too. |
| Plugins added during a session | yes. Running work keeps the old code, and the next step uses the new code. |
| Erasure | no |

### Hook points

| Our hook point | Pi Durable |
|---|---|
| before each step | `beforeRequest` |
| Provider: before a model request | `beforeProviderRequest` |
| after each step | `afterTools`, which can end the run |
| before a tool call | `beforeTool`: block, rewrite the arguments, or park until an answer arrives |
| after a tool call | `afterTool` |
| the turn's result is ready | `onYield`, which can send the agent back to work |
| turn ends | `afterRun`, which can start work before the run ends |
| session starts | `conversationCreated`, a host option |
| input arrives, before a turn, a model request failed, before output reaches a recipient | none in the hook list. Retrying a failed request is a setting. |

### How it survives interruptions

These match the architecture's [requirements](../architecture.md#surviving-interruptions):
- A tool declares `replay: "safe"` if it may run again after a crash. Otherwise the model is told the call was interrupted. This is our "outcome unknown".
- A model request cut off by a crash is sent again, and its partial answer stays in the transcript, marked aborted.
- A late approval is checked again. Every wake reruns all the `beforeTool` gates from the top, and an approval is bound to the arguments it saw.
- A `requestId` makes giving the same input twice harmless, even across a restart.

## Pydantic AI on a durable engine

Pydantic AI runs one agent definition on nine engines. The agent loop runs as deterministic workflow code. Everything that touches the outside world runs as a recorded unit that the engine can replay or retry: model requests, tool calls, MCP calls, tool discovery, compaction, token counting, and operations a plugin declares.

### How it fills our parts

| Our part | Pydantic AI with Temporal |
|---|---|
| Harness | the `Agent` plus the durability capability, inside a workflow |
| Session | a conversation, stored by the application |
| Turn | agent run |
| Runtime | the agent graph, replayed by the engine |
| Provider | models, called inside recorded units |
| History store | left to the application. The engine's journal records progress, not the conversation. |
| Plugin | capability. A plugin's outside work is a `@durable_operation` with a stable name. The name is stored, so it can't change later. |
| Input request | a deferred tool call. A handler hands a resume token to whoever will answer, and the engine records the wait and the answer. |
| Job | a model request that runs as a server-side job, or a batch request. Both are polled with durable timers. |

### What it declares

| Feature | Pydantic AI with Temporal |
|---|---|
| Waiting for an answer through a restart | yes |
| Cancelling | yes, through a signal to the workflow |
| Keeping state at the Provider | per Provider |
| Plugins added during a session | no. Plugins that add tools or durable operations must be attached when the agent is built. |
| Plugin hooks that touch the outside world | only as declared durable operations. Workflow code must not do I/O. |
| Several actors in one session | not built in |
| Erasure | no |

## What this showed

**The claim holds.** Both durable agents can be described with our parts, and so can Pi. The differences between transient and durable show up as declared features, which is what the description says should happen.

**Storage can be arranged either way.** Pi Durable keeps the history, plugin state and Runtime progress in one store, and changes all of them in one atomic commit. Pydantic AI keeps progress in the engine's journal and leaves the conversation to the application. Our description separates the history store from how a durable Runtime records progress. That fits both, which confirms leaving progress records as an implementation concern.

**Four points would break a plugin or a host, so they belong in the description:**

| Finding | Evidence | Proposed change |
|---|---|---|
| Changing several things together. A Pi Durable plugin can check its own state, admit an input and write its own state in one commit, so either all are kept or none. A plugin written to depend on that breaks on an agent without it. | Pi Durable README, "Busy Conversations" (`submit(tx, draft)`) | Add to the plugin API: a plugin can make several changes to a session together, so either all are kept or none are. |
| Input with a key. Hosts retry with the same `requestId` after a crash or dropped connection. Round 2 put this under [implementation concerns](../research/implementation-concerns.md#hosts-and-reconnecting), but a host depends on it. | Pi Durable README, "Persist and Resume"; [round 2, rung 3](../pressure-test/round-2/rung-3-multi-agent.md) | Move back into the contracts: input can carry a key, and the same key is taken once. |
| Adding plugins during a session. Pi Durable allows it. Pydantic AI on Temporal does not. A plugin that expects to load mid-session works on one and not the other. | Pydantic AI `temporal.md`, "Capabilities at Runtime" | Add to the declaration list. |
| Erasure. Neither agent supports it, but the architecture says a history store "must" be able to erase. | Pi Durable README, "Reset and Handoff": entries stay in storage | Make erasure a declared feature, not a requirement. |

**Two smaller observations:**
- Neither agent records actors. Both leave several users to the application, as a host or the entry's own data. Our "every input records its actor" is something an implementation of this description would add. It needs no change.
- Pi Durable lacks the same hook points as Pi: input arriving, before output reaches a recipient, and a failed model request.

# Open questions

These are undecided. Each has a stable name, so other documents link to it by name rather than by number. When one is settled, update [Architecture](architecture.md) or [Contracts](contracts.md), add a decision record if it meets the bar, and move the question to [Settled](#settled).

The questions are about **what** the system does. Questions about **how** it is built or wired are kept apart under [Parked: how](#parked-how).

**Deferred on 2026-11-16** until the first build needs them: whether an approval can outlast its turn, how several actors are granted authority, whether a job can outlive its session, the word "capability", and who sets turn limits.

## The Harness and plugins

### How many of each capability

**Settled** by the clean-room builds ([ADR 0016](adr/0016-rules-from-three-clean-room-builds.md)). A session has one Runtime, history store, working environment, credential store and configuration; a second is refused unless it names what it replaces. Two tools, commands or Providers with one name: the second is refused, never shadowed. See [Plugins and capabilities](contracts.md#plugins-and-capabilities).

Still open: what happens when two plugins both replace the same one.

### Plugin scope

Does every session, and every subagent, get the same plugins? Can the model itself load a plugin partway through a session when it asks for it, and is that loading a plugin or only revealing tools that were already there?

Prior art: Pydantic AI's on-demand plugins stay hidden until the model asks for them, as Agent Skills do.

### Plugin lifecycle

What does a plugin hand over when the agent reloads, and what is lost? How far is a plugin trusted, given that it can see prompts, files and credentials? Trust is checked before a plugin loads, as settled below.

Prior art: Pi reloads extensions with `/reload`, checks project trust before loading project extensions, and runs extensions with its own full permissions.

### Naming "capability"

We use "capability" for a named job a plugin does, such as Runtime. Pydantic AI uses the word for what we call a plugin, and T3 Code for what we now call a declaration. Do we keep it, or choose another word, such as role, slot or seam?

## Turns

### Waiting for an answer

[Architecture](architecture.md#waiting-for-an-answer) proposes requirements: the user answers in context; a tool call can stay open past its turn, and its answer arrives later as its result; every request says who may answer it and how; approval fails closed; a session can be set never to ask; a subagent's requests go to its parent. When to stop waiting is now settled: the asker's time limit decides, and the asker chooses to decline or leave the call open ([Questions](contracts.md#questions)). Still open:
- Can an approval stay open past its turn? The clean-room builds split: two let it, one refused.

Prior art: Pi waits in place, and the wait is lost if Pi stops. DeepSeek Harness waits for a set time, then leaves the question open. Pydantic AI hands a resume token to whoever will answer, or ends the run with the calls still open. T3 Code marks each request live or no longer answerable.

### Input during a turn

**Settled** ([ADR 0016](adr/0016-rules-from-three-clean-room-builds.md)). Steering joins the running turn after the current round of tool calls, before the next model request; input for after the turn starts its own turn. A Runtime that can't take input during a turn declares so, and the input waits. See [Input](contracts.md#input).

### Cancellation

Settled: jobs keep running, queued input is handed back, and a pending permission request answered as cancelled counts as a refusal ([Input](contracts.md#input), and the [ACP binding](bindings/acp.md)). Still open: can an actor cancel only its own work in a shared session?

Prior art: in ACP, cancelling answers every pending permission request as cancelled. Pi returns queued input to the user's editor.

### Turn limits

Who sets step limits, time limits and token budgets: the session's settings, the Runtime's defaults, or both? What happens when a limit is reached in the middle of a tool call? How do a tenant's budgets interact with a session's limits?

### Changing the model mid-turn

**Settled** ([ADR 0016](adr/0016-rules-from-three-clean-room-builds.md)). A settings change never alters a running turn; it applies from the next turn, and a turn records the model it started with. Falling back to another model after a failure is a new request under a new setting, not a change inside a request. See [Settings](contracts.md#settings).

### Work outside a turn

[Architecture](architecture.md#jobs) proposes jobs: session-owned work that can be cancelled on its own, reports back as input, and counts toward usage. Cancelling a turn leaves jobs running, and closing the session stops them. Still open: can a job outlive its session, for example a remote task the user wants to continue?

Prior art: ACP v2 separates foreground work from background work, which the session lists and can cancel item by item. T3 Code starts turns from schedules and webhooks, and when a subagent finishes.

### Live sessions

In a voice session, the Provider decides when someone has finished speaking. Is the whole voice session one turn, or a turn for each thing the user says? How does steering differ from interrupting?

Prior art: Pydantic AI treats a realtime session as one run.

### Partial output

Users see text, reasoning and audio as the model produces them. [Contracts](contracts.md#event) proposes that this partial output is live only. Must the record of what was actually delivered be kept, for example what a user heard before interrupting?

## Actors

### Several actors

Several actors in one session are optional, and an agent declares whether it supports them ([Architecture](architecture.md#actors-and-authority)). Settled by the clean-room builds: authority is a set of named rights; an actor grants only rights it has; work keeps the authority of everyone who contributed, or mixed input is refused (declared); anyone present with the authority may answer an approval ([Authority](contracts.md#authority)). Still open:
- How do budgets that span sessions, per tenant, work with a transient Runtime?

Prior art: DeepSeek Harness LiveShare has an owner and viewers. T3 Code lets guests propose input and outside agents sign in with an access level, under an administrator's cap.

## Tools

### Tools run by an Interface

Can an Interface offer tools, such as an editor offering file access or a web page offering a browser action? If so, the tool call stays open while the Interface runs it.

Prior art: AG-UI's frontend tools stop the run until the page answers. ACP clients offer file and terminal access to the agent.

### Tool calls outside a turn

A UI can now call a tool directly, as MCP Apps allow, and the same checks apply. Does the model ever learn of such a call?

### Parallel tool calls

**Settled** ([ADR 0016](adr/0016-rules-from-three-clean-room-builds.md)). Calls run together only when every call's tool allows it; otherwise the whole round runs one at a time. Results are recorded as they finish and reach the model in the order asked. See [Recovery and repeating work](contracts.md#recovery-and-repeating-work).

### Direct tool access

Must every tool call go through the Harness, so that approval, other plugins and recording all apply? Tools a Provider runs itself are already an exception. May a Runtime also reach a tool source directly, as it reaches a Provider?

Prior art: in Pi, every tool the Runtime calls was built by the Harness. An ACP agent connects to MCP servers directly.

## History and durability

### What history records

Settled in part: a turn records the model, tools and system prompt it started with, and recovery uses that record ([Settings](contracts.md#settings)). None of the clean-room builds recorded the exact bytes sent to a vendor. Still open: must the history hold enough to rebuild exactly what the model saw on every step? With a Provider that keeps state, part of what the model saw is outside our history.

Prior art: DeepSeek Harness's rule is "model-visible means logged".

### Transient and durable Runtimes

**Settled** ([ADR 0016](adr/0016-rules-from-three-clean-room-builds.md)). A model response is recorded before its tools start, and a call's start before it runs. A finished call never runs again. An unfinished call runs again only on two promises, the tool's and the working environment's. Hook handlers may run again and must make their effects safe to repeat. See [Recovery and repeating work](contracts.md#recovery-and-repeating-work).

### Erasure scope

**Settled** ([ADR 0016](adr/0016-rules-from-three-clean-room-builds.md)). What counts as a copy is listed in [Erasure](contracts.md#erasure): responses copy their requests, results their calls, summaries what they summarize, forks their originals, job records their calls and results. Erasure follows copies transitively and prefers erasing too much. Who may erase is the "erase" right ([Authority](contracts.md#authority)).

## Beyond one agent

### The agent from outside

What does the agent offer the outside world, and how does it describe itself? [Contracts](contracts.md#interface-and-harness) proposes sessions, input, cancelling, rewinding, commands, following along, answering requests, jobs and erasure, plus the agent's declaration.

Prior art: ACP and AG-UI for interactive clients. A2A for handing a task to an agent that works on its own, with an Agent Card describing it.

### Agents working together

[Architecture](architecture.md#working-with-other-agents) separates tool sources, actors, subagents and peers. Do subagents need anything beyond this? Can a subagent's subagent ask the top-level user directly?

Prior art: ACP gives each subagent its own session, which the parent can message again. DeepSeek Harness starts local and external subagents the same way, and has peer teams. T3 Code gives a child only its task, narrows its permissions, and wakes the parent when it finishes.

Building answered part of this ([build notes](build-notes.md#subagents)). Subagents needed nothing beyond jobs, a parent session, and the parent agent as an actor in the child. A subagent's subagent reaches the top-level user one level at a time: each parent asks its own session again, and a test covers two levels. A parent can message a finished subagent again, as ACP allows, and the follow-up is a new job on the same child session. Still open: whether peers need anything beyond this.

### Content model

Which content types must every part understand: text, image, audio, files, reasoning, values only a Provider can read? [Contracts](contracts.md#content) proposes that everything else is passed on intact unless policy forbids it.

<a id="settled"></a>

## Settled

These were open before the [pressure test](pressure-test/synthesis.md). The anchors are kept so older links still work.

<a id="plugins-building-on-plugins"></a>
- **Plugins building on plugins.** Yes: plugins can define capabilities and hook points for other plugins. See [Architecture](architecture.md#capabilities).

<a id="working-environment"></a>
- **Working environment.** It is a capability, separate from the project. See [Architecture](architecture.md#working-environment).

<a id="a-layer-above-the-agent"></a>
- **A layer above the agent.** A host that coordinates several whole agents is outside this system, but must be able to drive it fully. See [ADR 0012](adr/0012-one-agent-is-the-scope.md) and [Being driven by a host](architecture.md#being-driven-by-a-host).

<a id="waiting-for-the-user"></a>
- **Waiting for the user** is now [Waiting for an answer](#waiting-for-an-answer), since agents and programs can answer too.

- **History only grows.** It grows in normal use. Keeping it is the history store's job, and deletion happens only by retention or erasure. See [Architecture](architecture.md#history).
- **Exchanges.** Dropped as a unit. Every turn records what started it, and Interfaces group turns for display from that. See [round 2](pressure-test/round-2/synthesis.md#decisions).
- **Jobs when a turn is cancelled.** They keep running. Closing the session stops them, unless the agent declares otherwise.
- **Holding streamed output.** The output gate may hold it, and the agent declares that it does.
- **Moving the current position.** It is recorded, so a restart reopens the session where it was. Moving is separate from rewinding.
- **One user.** Every input records its actor.

Settled on 2026-11-16 before the first build:
<a id="what-the-harness-keeps"></a><a id="configuration"></a><a id="how-handlers-combine"></a>
- **What the Harness keeps:** hosting plugins, the plugin API, and sessions with their history while open.
- **Configuration:** a capability provided by a plugin. The first reads global and project files.
- **How handlers combine:** each hook point has one fixed rule, chosen by its owner. Plugins run in load order, and can ask to run first or last. See [Contracts](contracts.md#hook-points).
- **Plugin trust:** global plugins load; project plugins load once the project is trusted. No sandbox in the first build.
- **Cancelling:** queued input is handed back to the Interface, as in Pi.
- **Who sets how long a turn waits for an answer:** the plugin that asks, when it asks. When the limit passes, the question either declines or stays open past its turn (settled while building). Several actors in one session are optional, and declared. See [Several actors](#several-actors).

<a id="parked-how"></a>
<a id="parked-wiring"></a>

## Parked: how

Set aside until the what is settled ([ADR 0010](adr/0010-describe-parts-not-wiring.md)). Each is about how the system is built or wired, not what it does. Questions about how individual parts work inside are in [Implementation concerns](research/implementation-concerns.md).

- **Protocols.** Do we define our own messages between parts, or reuse existing ones, such as a chat-completions format between Runtime and Provider? The withdrawn [ADR 0009](adr/0009-own-protocol-south-adapters-north.md) proposed our own messages for Harness ↔ Runtime and adapters to existing standards everywhere else.
- **Translation.** Can our events be turned into AG-UI, ACP, A2A and OpenTelemetry without losing anything?
- **Identity, errors and versions.** How identities are formed, how errors are reported, how declarations are exchanged and versioned.
- **Conventions proposed earlier:** trace context on every message, as MCP does; unknown fields passed on and malformed known fields refused, as AG-UI does; extensions named by URI, as A2A and MCP do.
- **Events and hook points.** Is a hook point where plugins can only observe just an event?
- **Combining handlers.** The mechanism behind [How handlers combine](#how-handlers-combine): ordered lists, nesting, fixed rules per hook point.
- **Recording progress.** How a durable Runtime records its progress: checkpoints, journals, recording intent before acting.
- **Loading plugins.** How plugins are found, ordered and started.
- **Keys for repeated input.** How long a key is remembered.

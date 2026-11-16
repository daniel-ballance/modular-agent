# Open questions

These are undecided. Each has a stable name, so other documents link to it by name rather than by number. When one is settled, update [Architecture](architecture.md) or [Contracts](contracts.md), add a decision record if it meets the bar, and move the question to [Settled](#settled).

The questions are about **what** the system does. Questions about **how** it is built or wired are kept apart under [Parked: how](#parked-how).

**Worth deciding first,** because many others depend on them:
1. [What the Harness keeps](#what-the-harness-keeps)
2. [Waiting for an answer](#waiting-for-an-answer)
3. [Transient and durable Runtimes](#transient-and-durable-runtimes)
4. [Several actors](#several-actors)
5. [Work outside a turn](#work-outside-a-turn)

## The Harness and plugins

### What the Harness keeps

The proposal is three things: hosting plugins, the plugin API, and sessions with their history while they are open ([Architecture](architecture.md#the-harness)). A history store keeps history beyond that, and without one a session is ephemeral. Is that the whole list? What does a user get out of the box, and who chooses the first set of plugins?

Prior art: DeepSeek Harness keeps its session log in its core and lets plugins store it, and ships sets of plugins as profiles. Pydantic AI keeps in its core only what needs deep access to the loop or the model. Pi builds everything in. See the [prior-art map](research/README.md).

### How many of each capability

Is there one Runtime per session, or can it change between turns? Providers, tool sources and Interfaces can be many, but what happens when two plugins offer the same thing, such as two tools with one name? A plugin can now replace another deliberately; what happens when two replace the same one?

Prior art: DeepSeek Harness refuses a duplicate model route, and lets a tool registered for one agent hide a global tool of the same name.

### Plugin scope

Does every session, and every subagent, get the same plugins? Can the model itself load a plugin partway through a session when it asks for it, and is that loading a plugin or only revealing tools that were already there?

Prior art: Pydantic AI's on-demand plugins stay hidden until the model asks for them, as Agent Skills do.

### Plugin lifecycle

What does a plugin hand over when the agent reloads, and what is lost? How far is a plugin trusted, given that it can see prompts, files and credentials? Trust is now checked before a plugin loads; who decides it?

Prior art: Pi reloads extensions with `/reload`, checks project trust before loading project extensions, and runs extensions with its own full permissions.

### Configuration

Every plugin has settings. Are settings part of the Harness, or a capability? Who can change them while a session runs, and is each change recorded in the history?

### Naming "capability"

We use "capability" for a named job a plugin does, such as Runtime. Pydantic AI uses the word for what we call a plugin, and T3 Code for what we now call a declaration. Do we keep it, or choose another word, such as role, slot or seam?

## Turns

### Waiting for an answer

[Architecture](architecture.md#waiting-for-an-answer) proposes requirements: the user answers in context; a tool call can stay open past its turn, and its answer arrives later as its result; every request says who may answer it and how; approval fails closed; a session can be set never to ask; a subagent's requests go to its parent. Still open:
- Can an approval stay open past its turn, or does it only wait or fail?
- Who sets the time limit?
- When does the agent decide to stop waiting and end the turn with the call open?

Prior art: Pi waits in place, and the wait is lost if Pi stops. DeepSeek Harness waits for a set time, then leaves the question open. Pydantic AI hands a resume token to whoever will answer, or ends the run with the calls still open. T3 Code marks each request live or no longer answerable.

### Input during a turn

Can new input join a turn that is running? A Runtime declares whether it can. If it can't, does the input wait for the turn to end, or is the turn restarted with it, and who chooses?

Prior art: Pi takes "steering" input before the next model request, and "follow-up" input after the turn. ACP v2 accepts a prompt as soon as it joins the conversation. T3 Code chooses between steering, restarting and queueing by what the agent supports.

### Cancellation

What does cancelling leave behind: open input requests and input queued for after the turn? Jobs keep running ([Architecture](architecture.md#jobs)). Can an actor cancel only its own work in a shared session?

Prior art: in ACP, cancelling answers every pending permission request as cancelled. Pi returns queued input to the user's editor.

### Turn limits

Who sets step limits, time limits and token budgets: the session's settings, the Runtime's defaults, or both? What happens when a limit is reached in the middle of a tool call? How do a tenant's budgets interact with a session's limits?

### Changing the model mid-turn

Can the model change between steps of one turn, or between attempts of one request, for example to fall back to another model when one fails? A setting change now records the step from which it applies.

Prior art: DeepSeek Harness fixes the model for each step and won't let a plugin switch it for one request, because that silently loses the provider's cache. Pydantic AI can fall back to another model when a request fails.

### Work outside a turn

[Architecture](architecture.md#jobs) proposes jobs: session-owned work that can be cancelled on its own, reports back as input, and counts toward usage. Cancelling a turn leaves jobs running, and closing the session stops them. Still open: can a job outlive its session, for example a remote task the user wants to continue?

Prior art: ACP v2 separates foreground work from background work, which the session lists and can cancel item by item. T3 Code starts turns from schedules and webhooks, and when a subagent finishes.

### Live sessions

In a voice session, the Provider decides when someone has finished speaking. Is the whole voice session one turn, or a turn for each thing the user says? How does steering differ from interrupting?

Prior art: Pydantic AI treats a realtime session as one run.

### How handlers combine

When several plugins handle one hook point, what is the result? [Contracts](contracts.md#hook-points) proposes that a refusal wins and that changes apply one after another. In what order, and can a plugin insist on being first or last?

Prior art: Pi names six ways handlers combine. DeepSeek Harness gives each hook point one fixed rule, and has guards that can refuse but never allow. Pydantic AI nests plugins like middleware, and lets a plugin say where it must sit.

### Partial output

Users see text, reasoning and audio as the model produces them. [Contracts](contracts.md#event) proposes that this partial output is live only. Must the record of what was actually delivered be kept, for example what a user heard before interrupting?

## Actors

### Several actors

Several actors in one session are optional, and an agent declares whether it supports them ([Architecture](architecture.md#actors-and-authority)). Still open:
- How is authority granted, and by whom?
- What happens when two actors give input or steer at once?
- Does an approval need the actor who started the turn, or anyone with the authority?
- How do budgets that span sessions, per tenant, work with a transient Runtime?

Prior art: DeepSeek Harness LiveShare has an owner and viewers. T3 Code lets guests propose input and outside agents sign in with an access level, under an administrator's cap.

## Tools

### Tools run by an Interface

Can an Interface offer tools, such as an editor offering file access or a web page offering a browser action? If so, the tool call stays open while the Interface runs it.

Prior art: AG-UI's frontend tools stop the run until the page answers. ACP clients offer file and terminal access to the agent.

### Tool calls outside a turn

A UI can now call a tool directly, as MCP Apps allow, and the same checks apply. Does the model ever learn of such a call?

### Parallel tool calls

When one step asks for several tool calls, may they run at the same time, and in what order do their results reach the model?

Prior art: Pi runs them together but reports results in the order the model asked. A tool can insist on running alone.

### Direct tool access

Must every tool call go through the Harness, so that approval, other plugins and recording all apply? Tools a Provider runs itself are already an exception. May a Runtime also reach a tool source directly, as it reaches a Provider?

Prior art: in Pi, every tool the Runtime calls was built by the Harness. An ACP agent connects to MCP servers directly.

## History and durability

### What history records

Must the history hold enough to rebuild exactly what the model saw on every step, including the model, settings and tool definitions? That makes every request checkable and explains changes in cost, but records more. With a Provider that keeps state, part of what the model saw is outside our history.

Prior art: DeepSeek Harness's rule is "model-visible means logged".

### Transient and durable Runtimes

[Architecture](architecture.md#surviving-interruptions) now treats durability as a promise many parts make. What exactly must each part declare or record, and when, so that a durable Runtime fits the same description as a transient one?

Prior art: Pydantic AI runs one agent on nine durable engines by treating model requests, tool calls and declared plugin operations as the recordable steps. DeepSeek Harness marks unfinished tool calls "outcome unknown" or "not started". T3 Code records what it intends to do before doing it.

### Erasure scope

Erasure reaches every copy the agent controls ([Architecture](architecture.md#history)). What counts as a copy: summaries that paraphrase the data, a Provider's stored state, telemetry already exported? Who may ask for erasure?

## Beyond one agent

### The agent from outside

What does the agent offer the outside world, and how does it describe itself? [Contracts](contracts.md#interface-and-harness) proposes sessions, input, cancelling, rewinding, commands, following along, answering requests, jobs and erasure, plus the agent's declaration.

Prior art: ACP and AG-UI for interactive clients. A2A for handing a task to an agent that works on its own, with an Agent Card describing it.

### Agents working together

[Architecture](architecture.md#working-with-other-agents) separates tool sources, actors, subagents and peers. Do subagents need anything beyond this? Can a subagent's subagent ask the top-level user directly?

Prior art: ACP gives each subagent its own session, which the parent can message again. DeepSeek Harness starts local and external subagents the same way, and has peer teams. T3 Code gives a child only its task, narrows its permissions, and wakes the parent when it finishes.

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
- **One user.** Every input records its actor. Several actors in one session are optional, and declared. See [Several actors](#several-actors).

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

# Open questions

These are undecided. Each has a stable name, so other documents link to it by name rather than by number. When one is settled, update [Architecture](architecture.md) or [Contracts](contracts.md), add a decision record if it meets the bar, and remove the question.

The questions are about **what** the system does. Questions about **how** it is built or wired are kept apart at the end, under [Parked: how](#parked-how).

**Worth deciding first,** because many others depend on them:
1. [What the Harness keeps](#what-the-harness-keeps)
2. [Waiting for the user](#waiting-for-the-user)
3. [Transient and durable Runtimes](#transient-and-durable-runtimes)
4. [Plugins building on plugins](#plugins-building-on-plugins)
5. [A layer above the agent](#a-layer-above-the-agent)

## The Harness and plugins

### What the Harness keeps

The proposal is three things: hosting plugins, the plugin API, and sessions with their history ([Architecture](architecture.md#the-harness)). Is history part of the Harness, or a plugin like everything else? Keeping it in the Harness means "every interaction can be recorded" never depends on a plugin being present. And what does a user get out of the box: who chooses the first set of plugins?

Prior art: DeepSeek Harness keeps its session log in its core and lets plugins store it, and ships sets of plugins as profiles. Pydantic AI keeps in its core only what needs deep access to the loop or the model. Pi builds everything in. See the [prior-art map](research/README.md).

### How many of each capability

Is there one Runtime per session, or can it change between turns? Is there one history store, and one credential store? Providers, tool sources and Interfaces can be many, but what happens when two plugins offer the same thing, such as two tools with one name?

Prior art: DeepSeek Harness refuses a duplicate model route, and lets a tool registered for one agent hide a global tool of the same name.

### Plugins building on plugins

Can a plugin define new capabilities and hook points for other plugins? For example, an approval plugin could define "approval requested", and Interface plugins could answer it. If so, Runtimes could offer hook points beyond the standard set the same way.

Prior art: DeepSeek Harness does this. Pydantic AI plugins publish named events that others react to, including decision events another plugin can veto. Our [plugin API derivation](research/pi-builtins-as-plugins.md#what-the-walkthrough-shows) found plugins building on each other all the time.

### Plugin scope

Does every session, and every subagent, get the same plugins? Can a plugin be loaded partway through a session, or by the model itself when it asks for it?

Prior art: DeepSeek Harness lets a plugin's additions belong to one agent only. Pydantic AI's on-demand plugins stay hidden until the model asks for them, as Agent Skills do.

### Plugin lifecycle

Can plugins be added or removed while a session is running? Can a plugin require another to be present? How far is a plugin trusted, given that it can see prompts, files and credentials?

Prior art: Pi reloads extensions with `/reload` and runs them with its own full permissions. Pydantic AI lets a plugin say which plugins it needs.

### Working environment

Tools, context files, skills and prompt templates need a working directory and project, and tools need files and processes. Is the environment something the Harness knows about, or a capability a plugin provides? If it is a capability, a sandbox can be swapped in under every tool at once.

Prior art: DeepSeek Harness and Pydantic AI make it swappable, with many sandbox options. Pi's tools use the operating system directly.

### Configuration

Every plugin has settings. Are settings part of the Harness, or a capability? Who can change them while a session runs, and is each change recorded in the history?

### Naming "capability"

We use "capability" for a named job a plugin does, such as Runtime. Pydantic AI uses the word for what we call a plugin, and T3 Code for flags that say what an agent can do. Do we keep it, or choose another word, such as role, slot or seam?

## Turns

### Waiting for the user

[Architecture](architecture.md#waiting-for-the-user) proposes requirements: the user answers in context and the turn carries on; a question can outlast its turn; it's always clear whether a request can still be answered; approval fails closed; a session can be set never to ask; subagents' requests reach the user through the parent. Still open:
- When a durable Runtime is present, should a late answer resume the original turn instead of starting a new one?
- Can an approval outlast its turn, or does it only wait or fail?
- Who sets the time limit?
- What does the history show while a request is open?

Prior art: Pi waits in place, and the wait is lost if Pi stops. DeepSeek Harness waits for a set time and then leaves the question open, to be answered in a later turn. Pydantic AI can also hand a resume token to whoever will answer, while a durable engine holds the turn. T3 Code marks each request as live or no longer answerable. A2A and ACP wait in place; AG-UI and MCP end the turn and resume later.

### Input during a turn

Can new input join a turn that is running? Taking input mid-turn weakens the rule that a turn ends when the agent needs outside input, but users expect to steer. If a Runtime can't take it, what happens: queue it, or stop the turn and start again with the input included?

Prior art: Pi takes "steering" input before the next model request, and "follow-up" input after the turn. ACP v2 accepts a prompt as soon as it joins the conversation. T3 Code chooses between steering, restarting and queueing by what the agent supports.

### Cancellation

What does cancelling leave behind: the history so far, open input requests, input queued for after the turn?

Prior art: in ACP, cancelling answers every pending permission request as cancelled. Pi returns queued input to the user's editor.

### Turn limits

Who sets step limits, time limits and token budgets: the session's settings, the Runtime's defaults, or both? What happens when a limit is reached in the middle of a tool call?

### Changing the model mid-turn

Can the model change between steps of one turn, for example by a plugin at "before each step"?

Prior art: DeepSeek Harness fixes the model for each step and records every change, and won't let a plugin switch it for one request, because that silently loses the provider's cache.

### Work outside a turn

Agents now leave work running after they answer: background commands, watchers, subagents, scheduled wake-ups. Does that work belong to a turn, to the session, or to something else? Can finished background work start a turn on its own?

Prior art: ACP v2 separates foreground work from background work, which the session lists and can cancel item by item. T3 Code starts turns from schedules and webhooks, and when a subagent finishes.

### How handlers combine

When several plugins handle one hook point, what is the result? [Contracts](contracts.md#hook-points) proposes that a refusal wins and that changes apply one after another. In what order, and can a plugin insist on being first or last?

Prior art: Pi names six ways handlers combine. DeepSeek Harness gives each hook point one fixed rule, and has guards that can refuse but never allow. Pydantic AI nests plugins like middleware, and lets a plugin say where it must sit.

### Partial output

Users see text, reasoning and tool-call input as the model produces them. [Contracts](contracts.md#event) proposes that this partial output is live only and never kept in the history. Does any plugin other than an Interface need it?

## Tools

### Tools run by an Interface

Can an Interface offer tools, such as an editor offering file access or a web page offering a browser action? If so, the turn waits while the Interface runs the call.

Prior art: AG-UI's frontend tools stop the run until the page answers. ACP clients offer file and terminal access to the agent.

### Tool calls outside a turn

Some tools are called by a UI, not the model, as MCP Apps allow. Who runs those calls, are they recorded, and do approval and other plugins apply to them?

### Parallel tool calls

When one step asks for several tool calls, may they run at the same time, and in what order do their results reach the model?

Prior art: Pi runs them together but reports results in the order the model asked. A tool can insist on running alone.

### Direct tool access

Must every tool call go through the Harness, so that approval, other plugins and recording all apply? Or may a Runtime sometimes reach a tool source directly, as it reaches a Provider?

Prior art: in Pi, every tool the Runtime calls was built by the Harness. An ACP agent connects to MCP servers directly.

## History and durability

### What history records

Must the history hold enough to rebuild exactly what the model saw on every step, including the model, settings and tool definitions? That makes every request checkable and explains changes in cost, but records more.

Prior art: DeepSeek Harness's rule is "model-visible means logged". T3 Code keeps a day of its event log and relies on stored state after that.

### Transient and durable Runtimes

What must the description of the Runtime say so that a durable Runtime fits it as well as a transient one? [Architecture](architecture.md#surviving-interruptions) proposes requirements, but leaves open what the Runtime records, where, and when.

Prior art: Pydantic AI runs one agent on nine durable engines by treating model requests, tool calls and declared plugin operations as the recordable steps, and separates surviving a crash from saving a conversation. DeepSeek Harness marks unfinished tool calls "outcome unknown" or "not started". T3 Code records what it intends to do before doing it.

### Branching history

Pi's history is a tree: a user can go back to an earlier point and continue from there. Is branching part of the system, or something a plugin does by forking sessions?

## Beyond one agent

### The agent from outside

What does the agent offer the outside world, and how does it describe itself? [Contracts](contracts.md#interface-and-harness) proposes sessions, input, cancelling, commands, following along and answering requests.

Prior art: ACP and AG-UI for interactive clients. A2A for handing a task to an agent that works on its own, with an Agent Card describing it.

### Agents working together

Our agent can use another agent as a tool source and be used by one through an Interface. Do subagents need anything beyond that? [Architecture](architecture.md#working-with-other-agents) proposes four requirements.

Prior art: ACP gives each subagent its own session, which the parent can message again. DeepSeek Harness starts local and external subagents the same way. T3 Code gives a child only its task, narrows its permissions, and wakes the parent when it finishes.

### A layer above the agent

T3 Code drives whole agents (Pi, Codex, Claude Code) as interchangeable parts. It keeps its own record of each conversation, moves context between agents, and lets agents delegate to and message each other across providers and machines. Toward Pi it acts as an Interface, a tool source and a plugin at once. Is that layer outside our system, a set of plugins inside it, or a part of its own? Where does the record of a conversation that spans several agents belong?

### Content model

Which content types must every part understand: text, image, audio, files, reasoning, values only a Provider can read? [Contracts](contracts.md#content) proposes that everything else is passed on intact.

<a id="parked-how"></a>
<a id="parked-wiring"></a>

## Parked: how

Set aside until the what is settled ([ADR 0010](adr/0010-describe-parts-not-wiring.md)). Each is about how the system is built or wired, not what it does.

- **Protocols.** Do we define our own messages between parts, or reuse existing ones, such as a chat-completions format between Runtime and Provider? The withdrawn [ADR 0009](adr/0009-own-protocol-south-adapters-north.md) proposed our own messages for Harness ↔ Runtime and adapters to existing standards everywhere else.
- **Translation.** Can our events be turned into AG-UI, ACP, A2A and OpenTelemetry without losing anything?
- **Identity, errors and versions.** How identities are formed, how errors are reported, how parts agree which features each supports.
- **Conventions proposed earlier:** trace context on every message, as MCP does; unknown fields passed on and malformed known fields refused, as AG-UI does; extensions named by URI, as A2A and MCP do.
- **Events and hook points.** Is a hook point where plugins can only observe just an event?
- **Combining handlers.** The mechanism behind [How handlers combine](#how-handlers-combine): ordered lists, nesting, fixed rules per hook point.
- **Recording progress.** How a durable Runtime records its progress: checkpoints, journals, recording intent before acting.
- **Loading plugins.** How plugins are found, ordered and started.

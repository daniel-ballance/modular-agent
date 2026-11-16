# Architecture

**Status:** draft, revised 2026-11-16 after the [pressure test](pressure-test/synthesis.md). Items marked **decided** link to the decision that settled them. Everything else is **proposed** and can change. Open points link to [open questions](open-questions.md).

This document describes **what** the system is: its parts, what each is responsible for, and what must always be true. It does not describe **how** the parts are built or wired together ([ADR 0010](adr/0010-describe-parts-not-wiring.md)). The same description should fit an agent that runs in one process and one split across services.

Two companion documents complete it:
- [Contracts](contracts.md): what passes between the parts. It gives enough detail to build the system in any form.
- [Scenarios](scenarios.md): the parts working together in specific situations.

Terms are defined in the [glossary](../GLOSSARY.md).

## Purpose

Modular Agent is an AI agent built from parts that can each be swapped out and studied on its own. A small **Harness** holds everything together, and every feature is a **plugin**, including the part that runs the agent loop.

The project is for understanding how an agent is put together. Production performance is not a goal.

## Goals

1. **Every part can be swapped.** That includes the Runtime (for example, a transient one for a durable one), Providers, Interfaces, tool sources, the working environment, and where history is kept.
2. **Every part can be studied on its own.** Each part has one stated responsibility, and anything that passes between parts can be observed and recorded.
3. **The base does the minimum.** Anything that can be a plugin is a plugin.
4. **The description doesn't depend on wiring.** One process, several processes or separate services can all follow it.
5. **Existing agents fit it.** Pi, DeepSeek Harness, Pydantic AI and others can each be described by saying which of their pieces plays each of our parts.
6. **A host can drive it.** A system that coordinates several whole agents, as T3 Code does, can drive this agent from outside and learn what it supports. **Decided** ([ADR 0012](adr/0012-one-agent-is-the-scope.md)).

## Out of scope for now

- How parts talk to each other: transports, message formats, protocols and process layout.
- How each part works inside, such as how a durable Runtime records its progress or how plugins are loaded. Questions like these are kept under [Parked: how](open-questions.md#parked-how).
- Features of any one kind of agent, such as coding tools or a particular UI. They are plugins.
- Coordinating several whole agents. That is a host's job, outside this system. This system only has to make it possible ([Being driven by a host](#being-driven-by-a-host)). **Decided** ([ADR 0012](adr/0012-one-agent-is-the-scope.md)).
- Production performance.

## The parts at a glance

An **agent** is the Harness plus a chosen set of plugins. **Decided** ([ADR 0011](adr/0011-minimal-harness-everything-is-a-plugin.md)).

```
   users · editors · other agents · hosts · webhooks · schedules
                              │
                       Interface plugins
                              │
  ┌────────────────────────── Harness ───────────────────────────┐
  │   hosts plugins · offers the plugin API · keeps sessions      │
  └────┬───────────┬────────────┬─────────────┬─────────────┬────┘
       │           │            │             │             │
    Runtime    Providers   Tool sources    Working      History store,
                                         environment   credential store
                   (each is provided by a plugin)

  Feature plugins add behaviour: approval, guardrails, context
  management, skills, commands, subagents, goals, …
```

Plugins come in two kinds:
- A plugin can **provide a capability**: a named job the agent needs done, such as Runtime or Provider.
- A plugin can **add behaviour** without providing a capability, such as approval or context management.

One plugin can do both.

## The Harness

The Harness is the only part that is always present. It holds the agent together and does nothing else. **Decided** ([ADR 0011](adr/0011-minimal-harness-everything-is-a-plugin.md)).

It is responsible for three things. The exact list is **proposed** ([open question](open-questions.md#what-the-harness-keeps)):
1. **Hosting plugins:** checking that they may load, starting them, giving each the capabilities it needs from other plugins, and stopping them.
2. **The plugin API:** everything a plugin can do. A plugin can act only through it.
3. **Sessions:** each session's identity, settings, actors and their authority, active plugins, current position, and history while the session is open. A history store keeps the history beyond that. Without one, a session is **ephemeral**: its history is gone when the process stops. **Decided** ([pressure test](pressure-test/synthesis.md#decisions)).

It does not run turns, call models, run tools, show anything to a user, or store anything durably itself. With no plugins, it does nothing useful.

The Harness is also where the outside world is turned into a small set of standard forms (messages, tool definitions, tool calls and results, access to a model), so the Runtime never sees which vendor, tool source or Interface is involved. Plugins do that adapting. **Decided** ([ADR 0002](adr/0002-harness-is-the-standardizing-boundary.md)). Vendors stay hidden, but differences in what parts can do do not: each part [declares what it supports](#declared-support).

## Capabilities

| Capability | What it does | How many |
|---|---|---|
| [Runtime](#runtime) | Runs turns | one at a time per session ([open](open-questions.md#how-many-of-each-capability)) |
| [Provider](#provider) | Makes models available | any number |
| [Interface](#interface) | Lets the outside world use the agent | any number |
| [Tool source](#tool-source) | Offers tools and runs them | any number |
| [Working environment](#working-environment) | Where files live and commands run | one per session, or none |
| [History store](#history-store) | Keeps session history beyond the process | one, or none |
| [Credential store](#credential-store) | Keeps credentials and hands them out | one, or none |

Plugins can also define new capabilities for other plugins to provide. **Decided** ([pressure test](pressure-test/synthesis.md#8-add-the-working-environment-and-let-plugins-define-capabilities)). Whether to keep the word "capability" is [open](open-questions.md#naming-capability).

### Runtime

Runs a turn from start to finish. It decides when to make the next model request, asks for tool calls to be run, lets plugins step in at the agreed points, reports what it is doing, and ends the turn with an outcome and a result. **Decided** ([ADR 0003](adr/0003-session-turn-step-ownership.md), [ADR 0004](adr/0004-merge-core-into-runtime.md)).

It never:
- chooses the model, or holds credentials ([ADR 0005](adr/0005-provider-handles-from-the-harness.md))
- runs a tool or another plugin's code itself. It asks for that to be done ([ADR 0006](adr/0006-hook-points-belong-to-the-operation-owner.md)).
- keeps the session's history. The Harness does.

There are two kinds, and both must fit this description:
- A **transient** Runtime keeps a turn only while its process runs.
- A **durable** Runtime can carry on with a turn after its process stops and starts again.

A Runtime declares what it supports, such as taking input during a turn, waiting for an answer through a restart, or rewinding.

### Provider

Makes one model, or one vendor's models, available. It offers a catalog (which models, their limits, what kinds of input they accept), answers model requests, and gets credentials from the credential store when it needs them. It never decides which model is used. **Decided** ([ADR 0005](adr/0005-provider-handles-from-the-harness.md)).

A Provider may also:
- **keep its own conversation state** between requests, as claude-subscription does with a Claude Agent SDK session. It then says when that state must be discarded, for example after a fork, a rewind, compaction or a change of model.
- **run some tools itself**, such as server-side web search. Those calls come back in its response, with their results, and are recorded like any other tool call.

It declares both. Model access comes in three shapes: one request and its response; a live two-way session, such as voice; and a request whose answer arrives much later, such as a batch.

### Interface

Lets someone or something outside use the agent. Through an Interface, an actor can:
- start, find, open, join and fork sessions, and move to an earlier point in one
- give the agent input, withdraw input that hasn't been taken yet, and cancel what it is doing
- run commands
- follow what the agent does as it happens, from any point
- answer the agent's questions and approval requests
- see and cancel jobs
- learn what the agent supports

An Interface always acts for an actor, and that actor's [authority](#actors-and-authority) decides what it may do. Examples: a terminal UI, a web UI, an editor (as ACP clients do), another agent (as A2A clients do), a host such as T3 Code, an incoming webhook. To the outside world the system looks like one agent, whatever plugins are inside it. What exactly an agent offers the outside world is [open](open-questions.md#the-agent-from-outside).

### Tool source

Offers tools and runs calls to them. A tool has a name, a description, the input it takes, and hints such as "read-only", "destructive" or "safe to repeat". Examples: built-in file and shell tools, an MCP server, another agent.

A tool call can be started by the model, by a UI with no model involved (as MCP Apps allow), or by a plugin. Each call records who started it, and the same checks apply whoever starts it. Tools a Provider runs itself are the exception: they come back already done ([Provider](#provider)). Whether an Interface can also offer tools is [open](open-questions.md#tools-run-by-an-interface).

### Working environment

Where files live and commands run: the local machine, a remote host or a sandbox. Tools use it, so swapping it moves every tool at once. It is separate from the **project**: the folder the user is working on, which context files, skills and prompt templates read.

A working environment can be lost, for example when a sandbox expires. It says so, and work that depended on it fails or is marked as having an unknown outcome.

### History store

Keeps session history beyond the process, and gives it back. In normal use it never changes what was recorded. It may keep history for a limited time, and it must be able to erase when erasure is required ([History](#history)). It refuses a second writer for a session that is already open elsewhere.

### Credential store

Keeps credentials, gives them to the Providers, tool sources and working environments that ask for them, and runs sign-in with the user's help. Credentials never reach the Runtime. **Decided** ([ADR 0005](adr/0005-provider-handles-from-the-harness.md)).

## Feature plugins

These provide no capability. They add behaviour through the plugin API. Most are features that Pi builds in, or that Pi users add as extensions, so Pi's out-of-the-box experience can be described as one set of plugins.

| Feature | What it does | In Pi |
|---|---|---|
| Approval | Asks before a tool call runs, according to the session's policy and the actor's authority | not built in; an extension adds it |
| Guardrails | Checks input and output, and redacts or blocks it before it reaches anyone | not built in |
| Context management | Decides what the model sees before each step, and summarizes older history when it grows too large ([ADR 0007](adr/0007-context-management-is-a-hook.md)) | compaction |
| System prompt | Builds the system prompt from parts that other plugins contribute, including context files such as `AGENTS.md` | base instructions and context files |
| Agent Skills | Lists skills for the model, and loads a skill's instructions when the model or user asks | skills |
| Prompt templates | Expands a short command into prepared text | prompt templates |
| Commands | Lets the user act directly, without the model: new session, fork, rewind, compact, change model | about 30 slash commands |
| Model selection | Chooses the model and reasoning level for a session, from every Provider's catalog | model selection |
| Telemetry | Follows events and reports them elsewhere, for example as OpenTelemetry traces | not built in |
| Subagents | Lets the agent hand a task to another agent, as a job, and get the result back | not built in |
| Goals | Keeps the agent working toward an objective across turns without new input | not built in |
| Scheduling | Gives the agent input on a schedule or from a webhook, with no user present | not built in |

## What plugins can do

This is the plugin API, described by what it lets a plugin do. It is **proposed**. It was worked out by asking what each of Pi's built-in features would need as a plugin ([derivation](research/pi-builtins-as-plugins.md)), then completed by the [pressure test](pressure-test/synthesis.md#9-complete-the-plugin-api).

**Capabilities and hook points**
- Provide a capability, or use one that another plugin provides. For example, context management uses a Provider to write a summary.
- Define a new capability or hook point for other plugins.
- Change what it offers over time, such as tools appearing as an MCP server connects.
- Offer something to one agent or session only, or only while the plugin is active. When the plugin stops, what it offered goes with it.
- Replace another plugin deliberately, saying which one, as mcp-client replaces Pi's built-in MCP support.

**Sessions, input and work**
- Start, list, open, join, fork and close sessions.
- Give a session input, and say when it should be taken: now, into the turn that is running, or after it. Withdraw input that hasn't been taken yet.
- Cancel the turn that is running.
- Move a session to an earlier point, or to another branch.
- Change a session's settings, such as its model.
- Start a job, report on it, and cancel it.

**History and what the model sees**
- Read a session's history.
- Add to it: something the model will see (extra context, a summary) or something it won't (the plugin's own state, a record of an approval). Some facts can be kept live only, never recorded.
- Erase from it, given the authority.
- Add to the system prompt, and decide what the model sees before each step.
- Choose which of the available tools the model is told about.

**Tools and commands**
- Offer tools, and have a tool call run on its behalf, with the same checks as any other call.
- Offer commands, and change input before it reaches the model.

**Stepping in, and following along**
- Step in at a [hook point](#where-plugins-can-step-in) to observe, change or stop an operation.
- Check a turn's result before it is returned.
- Follow events, and report its own.

**Actors**
- Know which actor gave each input, started each turn and answered each request.
- Ask an actor something: approve, choose, type, open a link, give a secret. Interfaces, and agents such as a subagent's parent, can answer.
- Tell an actor something that needs no answer, and show status.
- Say how what it produced should be shown. An Interface that doesn't understand that falls back to a plain display.

**Its own lifecycle and surroundings**
- Be checked before it loads, for example whether the project is trusted.
- Hand over its state when the agent reloads, so work can carry on.
- Read its own settings ([open](open-questions.md#configuration)).
- Know the project, and use the working environment.

## Units of work

**Decided** ([ADR 0003](adr/0003-session-turn-step-ownership.md)), as amended by the pressure test.

| Unit | What it is | Owned by |
|---|---|---|
| Session | Exchanges, turns and jobs that share a history | the Harness |
| Exchange | Everything the agent does in response to one input from an actor: one or more turns | the Harness |
| Turn | The agent working until it has nothing more to do for now, or it stops | the Runtime |
| Step | One model request and its response, or one stretch of a live session, plus the tool calls it asks for | nobody: it is a concept, not a part |
| Job | Work the session owns that runs outside any turn and can outlive the turn that started it | the plugin that started it, for the session |

A turn can **wait** for an answer: waiting is a state inside a turn, not its end. A turn ends with an **outcome** (completed, cancelled, failed, or stopped at a limit) and a **result** for whoever started it: text, structured data, or the tool calls still open. A plugin can require the result to have a certain shape, and a result that fails the check sends the model back to try again inside the same turn.

An exchange can hold several turns: a turn restarted with new input, retries, turns a goal continues, and turns started when a job reports back. Whether new input can join a running turn is [open](open-questions.md#input-during-a-turn).

## Actors and authority

An **actor** is whoever acts on the agent: a user, another agent, a host, or a program such as a scheduler. Every input, answer, approval, command and setting change records which actor it came from. **Decided** ([pressure test](pressure-test/synthesis.md#decisions)).

**Several actors in one session are optional.** Most agents have one user per session, and a single actor is always valid. An agent that supports several, such as an owner and viewers or a guest who may only propose input, declares that it does. A durable Runtime may make that easier, but nothing requires one.

**Authority** is what an actor may do in a session, such as watch, propose input, give input, answer requests, approve, change settings, or erase. It sits under limits that only narrow:

```
administrator  ⊇  tenant  ⊇  session  ⊇  actor
```

- An agent that starts or messages another agent passes on no more authority than it has.
- Budgets can apply at any level, including a tenant across sessions.
- Approval fails closed.

How authority is granted and checked is [open](open-questions.md#several-actors).

## The Runtime and the Harness

This is the heart of the design. **Decided** ([ADR 0006](adr/0006-hook-points-belong-to-the-operation-owner.md)), except where marked.

- To start a turn, the Runtime is given the input, the tools the model may use, access to the chosen model without its credentials, and settings and limits ([open](open-questions.md#turn-limits) who sets them).
- During the turn, it asks for only two things: **run this tool call**, and **let plugins step in here** (a hook point). Deciding what the model sees before each step is one of these hook points.
- At the end, it reports the outcome, the result, what happened, and how much was used.
- Throughout, it reports what it is doing, so Interfaces can show it as it happens.

Tool calls a Provider ran itself arrive in the model response already done. The Runtime records them; it does not ask for them to be run.

The full list of what passes between them is in [Contracts](contracts.md#harness-and-runtime). Whether every tool call must go through the Harness, or a Runtime may sometimes reach a tool source directly, is [open](open-questions.md#direct-tool-access).

## Where plugins can step in

A **hook point** is a moment in an operation where plugins can observe, change or stop it. Whoever owns the operation defines its hook points, and that includes plugins. **Decided** ([ADR 0006](adr/0006-hook-points-belong-to-the-operation-owner.md), [pressure test](pressure-test/synthesis.md#8-add-the-working-environment-and-let-plugins-define-capabilities)).

Every Runtime offers the same standard set, so plugins keep working when the Runtime is swapped. The **proposed** set covers:
- the start and end of each session, exchange and turn
- input arriving: change it, or handle it as a command
- the start of a turn: add to the system prompt and the context
- before each step: decide what the model sees, and whether tools the Provider runs itself are allowed. After each step: continue or end.
- before a tool call: allow, refuse or change it. After it: change the result.
- a failed model request: retry or give up
- the turn's result: accept it, or send the model back
- **before output reaches a recipient**: let it through, redact it or block it. A guardrail needs this point; a check after delivery is too late.
- around the model request itself, inside the Provider

The full table, with what plugins are given and can answer at each one, is in [Contracts](contracts.md#hook-points).

## Waiting for an answer

The agent sometimes needs something only an actor can give: an approval, an answer, a choice, a sign-in, a secret. This is an **input request**. When there is a tool call behind it, it is tied to that tool call.

These requirements are **proposed** ([open question](open-questions.md#waiting-for-an-answer)):
1. **The user answers in context, and the turn carries on.** The user sees what the agent was doing when it asked. In the common case the turn waits and continues once the answer arrives, as it does in Pi.
2. **A tool call can stay open past its turn.** If no answer comes in time, or the agent has to stop, the turn ends with the call still open. The answer arrives later as that call's own result, and the agent carries on from it. Input becomes new input only when nothing is waiting for it.
3. **Every request says who may answer it,** such as the user, the parent agent or a program, **and how it can be answered:** while something is still waiting, later as the call's result, or no longer. A request lost when a process stopped is shown as unanswerable, not silently dropped.
4. **Approval fails closed.** Only an explicit "allow" from an actor with the authority lets a tool call run. If nobody can answer, the call does not run.
5. **A session can be set never to ask,** for unattended work. Every approval is then refused without asking.
6. **A subagent's requests go to its parent,** which can answer them itself or pass them to its own user.

## Jobs

A **job** is work the session owns that runs outside any turn. Examples: a background command or dev server, a watcher, a subagent, a workflow, a task handed to a remote agent, a model request whose answer arrives much later.

These requirements are **proposed**:
- A plugin starts a job for the session, on behalf of an actor, within an exchange.
- Every job has states, can be cancelled on its own, and reports back with progress and a result.
- A job's usage counts toward the session's limits and budgets.
- A job's report can start a turn. That turn belongs to the exchange that started the job.
- Closing a session stops its jobs. Whether cancelling a turn also cancels the jobs it started is [open](open-questions.md#work-outside-a-turn).

Schedules and webhooks are not jobs. They are actors that give the agent input.

## History

History is the session's record. What the model sees is a view of it, worked out before each step. **Decided** ([ADR 0007](adr/0007-context-management-is-a-hook.md)), as amended by the pressure test.

These requirements are **proposed**, except where marked:
- **History grows in normal use.** Nothing recorded is changed or deleted.
- **Compaction changes the view, not the record.** It adds a summary, and the model sees the summary instead of what it covers.
- **Rewinding and branching add entries.** A session has a current position in a tree of entries. Moving it is recorded, and the view leaves out what is not on the current branch. Files in the working environment can be rewound with it. A Runtime or Provider that can't rewind refuses before anything changes.
- **Keeping history is the history store's job.** Without one, the session is ephemeral. A store may keep history for a limited time. **Decided** ([pressure test](pressure-test/synthesis.md#decisions)).
- **Erasure reaches every copy the agent controls** when deletion is required: entries, summaries, forks and exports. A Provider that keeps state is asked to discard it. A record that something was erased may remain, without the erased content. Where a copy is out of reach, such as something already sent to a recipient, the agent says so.
- **Some facts are live only,** such as output as it streams or a goal being armed. They are not recorded, and a restart must not turn them into new work.
- **What the model sees is the view plus whatever a Provider keeps or adds.** A Provider that keeps state declares it ([Provider](#provider)).

How much the history must record, for example enough to rebuild exactly what the model saw on every step, is [open](open-questions.md#what-history-records).

## Surviving interruptions

These requirements are **proposed** ([open questions](open-questions.md#transient-and-durable-runtimes)):
- **A session outlives a process only if it has a history store.**
- **With a transient Runtime,** a turn whose process stops simply ends. Its record shows which tool calls finished, which never started, and which have an unknown outcome. Nothing with an unknown outcome is retried automatically.
- **With a durable Runtime,** the turn carries on after a restart, without repeating outside work that already happened.
- **Durability is a promise many parts make, not the Runtime alone:**
  - Tools declare whether they are safe to repeat.
  - Plugins name the outside work they do, so a restart doesn't repeat it.
  - Providers declare whether they keep state.
  - A working environment can be lost, and says so.
- **Repeating a model request is harmless only when the Provider keeps no state and runs no tools.** Then it costs tokens and changes nothing outside the system. Tool calls are what need care ([ADR 0005](adr/0005-provider-handles-from-the-harness.md)).
- **Any request between parts can go unanswered.** The asker then assumes the worst: a tool call's outcome is unknown.
- **Cancelling reaches the Provider and any jobs that are to be cancelled.**
- **Surviving a crash is a different need from saving and continuing a conversation.** The second needs only a history store.

## Who sees what

These requirements are **proposed**:
- Output passes the **output gate** before it reaches any recipient, so a guardrail can redact it in time.
- Different recipients may see different views of the same session: a viewer may see less than the owner, and a recipient may receive only content it can handle.
- Content is passed on intact unless policy forbids passing it on.
- Everything can be observed by those allowed to see it, for as long as it is kept.

## Working with other agents

- **Another agent as a tool source.** Our agent can use another agent's tools or hand it work.
- **Another agent as an actor.** Another agent can use ours through an Interface, with its own authority.
- **Subagent.** A subagent is started by a job. Its session belongs to the parent's.
  - It starts from its task alone, and does not inherit the parent's history unless it is given it.
  - It has no more authority than the parent.
  - Its result comes back as the job's report, so the parent does not have to keep checking.
  - Its input requests go to the parent ([Waiting for an answer](#waiting-for-an-answer)).
- **Peer.** A peer is another agent this one can message, with no parent relationship. Each message records its actor.

Whether subagents need anything beyond this is [open](open-questions.md#agents-working-together).

## Being driven by a host

A host, such as T3 Code, coordinates several whole agents. It is outside this system ([ADR 0012](adr/0012-one-agent-is-the-scope.md)), but the agent must let a host drive it fully through an Interface. These requirements are **proposed**:
- **The agent declares what it supports** ([Declared support](#declared-support)).
- **It starts no turn the host didn't ask for,** unless it has declared that it can, for example because a job reports back or a schedule fires.
- **The host can give input with a key,** so giving the same input twice has no further effect.
- **The host can follow a session from any point,** including after reconnecting.
- **The host can rewind or fork at a point,** or the agent refuses before anything changes.
- **The host can give the agent context from elsewhere,** such as a summary of what another agent did, as recorded input.
- **Every input request says whether it can still be answered**, so the host can show it or mark it lost.
- **The host is an actor,** with its own authority.
- **The agent can also be used as a tool source,** for example as a subagent of something else.

## Declared support

Runtimes, Providers, working environments and the agent as a whole declare what they support. For each feature a part lacks, the description says what happens instead, so a missing feature is never a silent difference. **Proposed** ([Contracts](contracts.md#declaration)). Examples:

| Feature | What happens without it |
|---|---|
| Taking input during a turn | the input waits for the turn to end, or the turn is restarted with it |
| Waiting for an answer through a restart | the tool call stays open, and the answer arrives later as its result |
| Rewinding | rewinding is refused before anything changes |
| Forking | a fork starts from a copy of the history |
| Keeping state at the Provider | every request carries the whole model context |
| Running tools at the Provider | those tools are offered by a tool source instead |
| Several actors in one session | the session has one actor |
| Live sessions, such as voice | not available |

## Guarantees

These always hold. They are **proposed** unless a decision is linked.

1. **Everything can be identified.** Every session, exchange, turn, step, tool call, job and actor can be identified, and everything that happens can be traced to the ones it belongs to.
2. **Everything can be observed** by those allowed to see it, for as long as it is kept ([ADR 0010](adr/0010-describe-parts-not-wiring.md)).
3. **History grows in normal use.** Compaction, rewinding and branching add entries. History is deleted only by retention or erasure, and the deletion is recorded without the deleted content ([ADR 0007](adr/0007-context-management-is-a-hook.md)).
4. **Every tool call ends with exactly one result,** even when it is refused, cancelled or interrupted, and even when the result arrives after its turn.
5. **Credentials never reach the Runtime, and the Runtime never chooses the model** ([ADR 0005](adr/0005-provider-handles-from-the-harness.md)).
6. **Nothing is lost in passing.** Content a part doesn't understand is kept and passed on intact, unless policy forbids passing it on.
7. **Plugins stay within the plugin API** ([ADR 0011](adr/0011-minimal-harness-everything-is-a-plugin.md)).
8. **Approval fails closed.**
9. **Authority only narrows,** from administrator to actor, and from one agent to any agent it starts or messages.
10. **Differences are declared.** A part that lacks a feature says so, and what happens instead.

## How we will know the description is right

It is good enough when all of these hold:
- Pi, DeepSeek Harness, Pydantic AI, Tau and PiG can each be described in its terms, by saying which of their pieces plays each part. The [prior-art map](research/README.md) is the first attempt.
- A transient Runtime and a durable Runtime both fit the description of the Runtime.
- An agent in one process and one split across services could both follow it unchanged.
- A host such as T3 Code could drive it as it drives Pi today.
- Each [scenario](scenarios.md) can be told using only the parts and guarantees above.
- A fresh run of the [pressure test](pressure-test/README.md) finds no assumption false.

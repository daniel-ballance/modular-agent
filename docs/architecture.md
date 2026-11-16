# Architecture

**Status:** draft, revised 2026-11-16 after two rounds of [pressure testing](pressure-test/README.md). Items marked **decided** link to the decision that settled them. Everything else is **proposed** and can change. Open points link to [open questions](open-questions.md).

This document describes **what** the system is: its parts, what each is responsible for, and what must always be true. It does not describe **how** the parts are built or wired together ([ADR 0010](adr/0010-describe-parts-not-wiring.md)). The same description should fit an agent that runs in one process and one split across services.

**What belongs here.** A point belongs in this description if swapping one implementation for another that disagrees on it would break a plugin or a host. If only the inside of one part would behave differently, it is an implementation concern. Those are collected in [Implementation concerns](research/implementation-concerns.md).

Two companion documents complete it:
- [Contracts](contracts.md): what passes between the parts.
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
6. **A host can drive it.** A system that coordinates several whole agents, as T3 Code does, can drive this agent from outside. **Decided** ([ADR 0012](adr/0012-one-agent-is-the-scope.md)).

## Out of scope for now

- How parts talk to each other: transports, message formats, protocols and process layout.
- How each part works inside. See [Implementation concerns](research/implementation-concerns.md) and [Parked: how](open-questions.md#parked-how).
- Features of any one kind of agent, such as coding tools or a particular UI. They are plugins.
- Coordinating several whole agents. That is a host's job, outside this system ([ADR 0012](adr/0012-one-agent-is-the-scope.md)).
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

A plugin can **provide a capability**, which is a named job the agent needs done, such as Runtime or Provider. A plugin can also **add behaviour** without providing a capability, such as approval or context management. One plugin can do both.

## The Harness

The Harness is the only part that is always present. It holds the agent together and does nothing else. **Decided** ([ADR 0011](adr/0011-minimal-harness-everything-is-a-plugin.md)).

It is responsible for three things. **Decided** ([decided 2026-11-16](open-questions.md#settled)):
1. **Hosting plugins:** checking that they may load, starting them, giving each the capabilities it needs from other plugins, and stopping them.
2. **The plugin API:** everything a plugin can do. A plugin can act only through it.
3. **Sessions:** each session's identity, settings, actors and their authority, active plugins, current position, and history while the session is open. A history store keeps the history beyond that. Without one, a session is **ephemeral**: its history is gone when the process stops. **Decided** ([pressure test](pressure-test/synthesis.md#decisions)).

It does not run turns, call models, run tools, show anything to a user, or store anything durably itself. With no plugins, it does nothing useful.

The Harness is also where the outside world is turned into a small set of standard forms (messages, tool definitions, tool calls and results, access to a model), so the Runtime never sees which vendor, tool source or Interface is involved. Plugins do that adapting. **Decided** ([ADR 0002](adr/0002-harness-is-the-standardizing-boundary.md)). Vendors stay hidden, but differences in what the agent can do are [declared](#declared-support).

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
| [Configuration](#configuration) | Supplies settings to the Harness and plugins | one, or none |

Plugins can also define new capabilities for other plugins to provide. **Decided** ([pressure test](pressure-test/synthesis.md#8-add-the-working-environment-and-let-plugins-define-capabilities)). Whether to keep the word "capability" is [open](open-questions.md#naming-capability).

### Runtime

Runs a turn from start to finish. It decides when to make the next model request, asks for tool calls to be run, lets plugins step in at the agreed points, reports what it is doing, and ends the turn with an outcome and a result. **Decided** ([ADR 0003](adr/0003-session-turn-step-ownership.md), [ADR 0004](adr/0004-merge-core-into-runtime.md)).

It never:
- chooses the model, or holds credentials ([ADR 0005](adr/0005-provider-handles-from-the-harness.md))
- runs a tool or another plugin's code itself. It asks for that to be done ([ADR 0006](adr/0006-hook-points-belong-to-the-operation-owner.md)).
- keeps the session's history. The Harness does.

A **transient** Runtime keeps a turn only while its process runs. A **durable** Runtime can carry on with a turn after its process stops and starts again. Both must fit this description. When a session is reopened after its process stopped mid-turn, the Harness finds the interrupted turn in the history and hands it to the Runtime, which decides what happens to it.

### Provider

Makes one model, or one vendor's models, available. It offers a catalog (which models, their limits, what kinds of input they accept), answers model requests, and gets credentials from the credential store when it needs them. It never decides which model is used. **Decided** ([ADR 0005](adr/0005-provider-handles-from-the-harness.md)).

A Provider may keep its own conversation state between requests, as claude-subscription does with a Claude Agent SDK session. It may also run some tools itself, such as server-side web search. Those calls come back in its response, with their results, and are recorded like any other tool call. A Provider declares both.

Model access comes in three shapes: one request and its response; a live two-way session, such as voice; and a request whose answer arrives much later, such as a batch.

### Interface

Lets someone or something outside use the agent. Through an Interface, an actor can:
- start, find, open, join and fork sessions, and move to an earlier point in one
- give the agent input, withdraw input that hasn't been taken yet, and cancel the running turn
- run commands
- follow what the agent does as it happens, from any point
- answer the agent's questions and approval requests
- see and cancel jobs
- learn what the agent supports

An Interface always acts for an actor, and that actor's [authority](#actors-and-authority) decides what it may do. Examples: a terminal UI, a web UI, an editor (as ACP clients do), another agent (as A2A clients do), a host such as T3 Code, an incoming webhook. To the outside world the system looks like one agent, whatever plugins are inside it. What exactly an agent offers the outside world is [open](open-questions.md#the-agent-from-outside).

### Tool source

Offers tools and runs calls to them. A tool has a name, a description, the input it takes, and hints such as "read-only", "destructive" or "safe to repeat". Examples: built-in file and shell tools, an MCP server, another agent.

A tool call can be started by the model, by a UI with no model involved (as MCP Apps allow), or by a plugin. Each call records who started it, and the same checks apply whoever starts it. Tools a Provider runs itself are the exception: they come back already done. Whether an Interface can also offer tools is [open](open-questions.md#tools-run-by-an-interface).

### Working environment

Where files live and commands run: the local machine, a remote host or a sandbox. Tools use it, so swapping it moves those tools with it. It is separate from the **project**, which is the folder the user is working on. Context files, skills and prompt templates read the project.

A working environment can be lost, for example when a sandbox expires, and it says so.

### History store

Keeps session history beyond the process, and gives it back. In normal use it never changes what was recorded. It may keep history for a limited time. It may also support erasure, and declares whether it does ([History](#history)). It refuses a second writer for a session that is already open elsewhere.

### Credential store

Keeps credentials, gives them to the Providers, tool sources and working environments that ask for them, and runs sign-in with the user's help. Credentials never reach the Runtime. **Decided** ([ADR 0005](adr/0005-provider-handles-from-the-harness.md)).

### Configuration

Supplies settings: defaults for new sessions, and each plugin's own settings. The first one reads global and project files, as Pi does. A change that affects a session is recorded in its history. **Decided** ([decided 2026-11-16](open-questions.md#settled)).

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

This is the plugin API, described by what it lets a plugin do. It is **proposed**. It was worked out by asking what each of Pi's built-in features would need as a plugin ([derivation](research/pi-builtins-as-plugins.md)), then extended by the [pressure test](pressure-test/synthesis.md#9-complete-the-plugin-api).

**Capabilities and hook points**
- Provide a capability, or use one that another plugin provides. For example, context management uses a Provider to write a summary.
- Define a new capability or hook point for other plugins.
- Change what it offers over time, such as tools appearing as an MCP server connects.
- Offer something to one session only, or only while the plugin is active.
- Replace another plugin deliberately, saying which one, as mcp-client replaces Pi's built-in MCP support.

**Sessions, input and work**
- Start, list, open, join, fork and close sessions.
- Give a session input, and say when it should be taken: now, into the running turn, or after it. Withdraw input that hasn't been taken yet.
- Cancel the running turn.
- Move a session to another point in its history, and rewind outside state with it.
- Change a session's settings, such as its model.
- Start a job, report on it, and cancel it.
- Make several changes to a session together, such as checking its own state, giving input and updating its state, so that either all of them are kept or none are.

**History and what the model sees**
- Read a session's history.
- Add to it: something the model will see (extra context, a summary) or something it won't (the plugin's own state, a record of an approval).
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
- Ask an actor something: approve, choose, type, open a link, give a secret.
- Tell an actor something that needs no answer, and show status.
- Say how what it produced should be shown. An Interface that doesn't understand that falls back to a plain display.

**Its own lifecycle and surroundings**
- Be checked before it loads. Plugins installed globally load. Plugins that come with a project load only once the user trusts that project. Plugins run with the agent's full permissions. **Decided** ([decided 2026-11-16](open-questions.md#settled)).
- Read its own settings ([open](open-questions.md#configuration)).
- Know the project, and use the working environment.

## Units of work

**Decided** ([ADR 0003](adr/0003-session-turn-step-ownership.md)), as amended by the pressure tests.

| Unit | What it is | Owned by |
|---|---|---|
| Session | Turns and jobs that share a history | the Harness |
| Turn | The agent working until it has nothing more to do for now, or it stops | the Runtime |
| Step | One model request and its response, or one stretch of a live session, plus the tool calls it asks for, up to their results | nobody: it is a concept, not a part |
| Job | Work the session owns that runs outside any turn and can outlive the turn that started it | the plugin that started it, for the session |

A turn can **wait** for an answer. Waiting is part of a turn, not its end. A turn ends with an **outcome** (completed, cancelled, failed, or stopped at a limit) and a **result** for whoever started it: text, structured data, or the tool calls still open. A plugin can require the result to have a certain shape, and a result that fails the check sends the model back to try again inside the same turn.

Every turn records what started it: an actor's input, a job's report, or a plugin such as a goal. Interfaces and hosts can group turns for display from that record. Whether new input can join a running turn is [open](open-questions.md#input-during-a-turn).

## Actors and authority

An **actor** is whoever acts on the agent: a user, another agent, a host, or a program such as a scheduler. Every input, answer, approval, command and setting change records which actor it came from. **Decided** ([pressure test](pressure-test/synthesis.md#decisions)).

**Several actors in one session are optional.** Most agents have one user per session, and a single actor is always valid. An agent that supports several, such as an owner and viewers, declares that it does.

**Authority** is what an actor may do in a session, such as watch, propose input, give input, answer requests, approve, change settings, or erase. It sits under limits that only narrow:

```
administrator  ⊇  tenant  ⊇  session  ⊇  actor
```

- Work that an action causes gets the narrowest authority of everyone involved. That covers a host acting for its user, an owner releasing a guest's proposed input, and an agent starting or messaging another agent.
- A message from a peer or a subagent is not a command or an approval from the user.
- Budgets can apply at any level, including a tenant across sessions.

How authority is granted and checked is [open](open-questions.md#several-actors).

## The Runtime and the Harness

This is the heart of the design. **Decided** ([ADR 0006](adr/0006-hook-points-belong-to-the-operation-owner.md)), except where marked.

- To start a turn, the Runtime is given the input, the tools the model may use, access to the chosen model without its credentials, and settings and limits ([open](open-questions.md#turn-limits) who sets them).
- During the turn, it asks for only two things: **run this tool call**, and **let plugins step in here** (a hook point). Deciding what the model sees before each step is one of these hook points.
- At the end, it reports the outcome, the result, what happened, and how much was used.
- Throughout, it reports what it is doing, so Interfaces can show it as it happens.

Tool calls a Provider ran itself arrive in the model response already done. The Runtime records them and does not ask for them to be run.

The full list of what passes between them is in [Contracts](contracts.md#harness-and-runtime). Whether a Runtime may sometimes reach a tool source directly is [open](open-questions.md#direct-tool-access).

## Where plugins can step in

A **hook point** is a moment in an operation where plugins can observe, change or stop it. Whoever owns the operation defines its hook points, and that includes plugins. **Decided** ([ADR 0006](adr/0006-hook-points-belong-to-the-operation-owner.md), [pressure test](pressure-test/synthesis.md#8-add-the-working-environment-and-let-plugins-define-capabilities)).

Every Runtime offers the same standard set, so plugins keep working when the Runtime is swapped. The **proposed** set covers:
- the start and end of each session and turn
- input arriving: change it, or handle it as a command
- the start of a turn: add to the system prompt and the context
- before each step: decide what the model sees, and whether tools the Provider runs itself are allowed. After each step: continue or end.
- before a tool call: allow, refuse or change it. After it: change the result.
- a failed model request: retry or give up
- the turn's result: accept it, or send the model back
- before output reaches a recipient: let it through, redact it, block it, or hold it until it can decide
- around the model request itself, inside the Provider

The full table is in [Contracts](contracts.md#hook-points).

## Waiting for an answer

The agent sometimes needs something only an actor can give: an approval, an answer, a choice, a sign-in, a secret. This is an **input request**. When there is a tool call behind it, it is tied to that tool call.

These requirements are **proposed** ([open question](open-questions.md#waiting-for-an-answer)):
1. **The user answers in context, and the turn carries on.** In the common case the turn waits and continues once the answer arrives, as it does in Pi.
2. **A tool call can stay open past its turn.** If no answer comes in time, the turn ends with the call still open and no result recorded. The plugin that asks sets the time limit. A later answer settles the call: once every open call has its answer, a new turn runs them through the usual checks, and the agent carries on. New input while a call is open is allowed: the model's view shows the call as still waiting, and its real result later as a late result. The record itself never holds a stand-in result.
3. **Every request says who may answer it,** such as the user, the parent agent or a program, **and whether it can still be answered.** A request lost when a process stopped is shown as unanswerable, not silently dropped. Seeing a request does not mean being allowed to answer it.
4. **One answer closes a request.** Later answers are refused.
5. **Approval fails closed.** Only an explicit "allow" from an actor with the authority lets a tool call run. A late "allow" is checked again against current authority and the current branch before the call runs.
6. **A secret goes only to the credential store.** It never reaches the Runtime or the model. Its value is never recorded.
7. **Questions are recorded.** Each question and each answer is a history entry, so which questions are open is worked out from the history. A question can carry a key: asking again with the same key reopens the same question, or reuses its recorded answer if whoever gave it may still answer and it is on the current branch. This is how a question survives a restart with a durable Runtime: the pending call's checks run again and find it.
8. **A session can be set never to ask,** for unattended work. Every approval is then refused without asking.
9. **A subagent's requests go to its parent,** which can answer them itself or pass them to its own user.

## Jobs

A **job** is work the session owns that runs outside any turn. Examples: a background command or dev server, a watcher, a subagent, a task handed to a remote agent, a model request whose answer arrives much later.

These requirements are **proposed**:
- A plugin starts a job for the session, on behalf of an actor.
- A job can be cancelled on its own.
- When a job reports back, the report enters the session as input, recording which job it came from. It may start a turn.
- A job's usage counts toward the session's limits and budgets.
- **Cancelling a turn leaves its jobs running. Closing the session stops them.** An agent that works differently declares it. **Decided** ([round 2](pressure-test/round-2/synthesis.md#decisions)).

Schedules and webhooks are not jobs. They are actors that give the agent input.

## History

History is the session's record. What the model sees is a view of it, worked out before each step. **Decided** ([ADR 0007](adr/0007-context-management-is-a-hook.md)), as amended by the pressure tests.

- **History grows in normal use.** Nothing recorded is changed or deleted.
- **Compaction changes the view, not the record.** It adds a summary, and the model sees the summary instead of what it covers.
- **Moving the current position is recorded,** so a restart reopens the session where it was. Moving only changes which branch the view follows. **Decided** ([round 2](pressure-test/round-2/synthesis.md#decisions)).
- **Rewinding is separate from moving.** A rewind also restores outside state, such as files in the working environment or a Provider's state. A part that can't rewind refuses before anything changes. Work still pending on the branch left behind is cancelled, never resumed on the new branch.
- **Keeping history is the history store's job.** Without one, the session is ephemeral. A store may keep history for a limited time. **Decided** ([pressure test](pressure-test/synthesis.md#decisions)).
- **Erasure, where supported, reaches every copy the agent controls** when deletion is required. That includes summaries, forks, exports, and anything a Provider keeps. A record that something was erased always remains, without the erased content. Where a copy is out of reach, such as output already delivered, the agent says so.
- **What the model sees is the view plus whatever a Provider keeps or adds.**

How much the history must record, for example enough to rebuild exactly what the model saw on every step, is [open](open-questions.md#what-history-records).

## Surviving interruptions

These requirements are **proposed** ([open question](open-questions.md#transient-and-durable-runtimes)):
- **A session outlives a process only if it has a history store.**
- **With a transient Runtime,** a turn whose process stops ends as failed. Its record shows which tool calls finished, which never started, and which have an unknown outcome.
- **With a durable Runtime,** the turn carries on after a restart.
- **An outside effect with an unknown outcome is not repeated** unless it was declared safe to repeat. That applies to tool calls, and to model requests to a Provider that keeps state or runs tools.
- **A durable Runtime relies on other parts.** Tools say whether they are safe to repeat, Providers say whether they keep state, and a working environment says when it is lost.

## Who sees what

These requirements are **proposed**, except where marked:
- **The record keeps everything intact. Each recipient receives a view of it.** A view may leave out or redact content, or drop what the recipient's protocol can't carry.
- **Output passes the output gate before it reaches any recipient.** The gate may hold streamed output until it can decide, so a secret split across several pieces can still be caught. An agent that holds output declares it. **Decided** ([round 2](pressure-test/round-2/synthesis.md#decisions)).
- **Plugins that follow events see the gated view** unless they are allowed the raw one.
- **Output that bypasses the agent,** such as audio streamed straight from a Provider to a browser, is declared, and the gate doesn't cover it.

## Working with other agents

- **Another agent as a tool source.** Our agent can use another agent's tools or hand it work.
- **Another agent as an actor.** Another agent can use ours through an Interface, with its own authority.
- **Subagent.** A job starts a subagent. Its session belongs to the parent's. It starts from its task alone, and does not inherit the parent's history unless it is given it. It has no more authority than the parent. Its result reaches the parent as the job's report, and its input requests go to the parent.
- **Peer.** A peer is another agent this one can message, with no parent relationship.

Whether subagents need anything beyond this is [open](open-questions.md#agents-working-together).

## Being driven by a host

A host, such as T3 Code, coordinates several whole agents. It is outside this system ([ADR 0012](adr/0012-one-agent-is-the-scope.md)), but it must be able to drive the agent fully through an Interface. These requirements are **proposed**:
- **The agent declares what it supports** ([Declared support](#declared-support)).
- **It starts no turn the host didn't ask for,** unless it has declared that it can, for example because a job reports back.
- **The host can give input with a key.** The same key is taken once, so the host can resend after a crash or a dropped connection.
- **The host can follow a session from any point,** including after reconnecting.
- **The host can move, rewind or fork at a point,** or the agent refuses before anything changes.
- **The host can give the agent context from elsewhere,** such as a summary of what another agent did, as recorded input.
- **Every input request says whether it can still be answered.**
- **The host is an actor,** with its own authority.

## Declared support

The agent declares what the session, as set up, supports. That is what a host or Interface reads. For each feature it lacks, the description says what happens instead, so a missing feature is never a silent difference. A fallback never changes policy. **Proposed** ([Contracts](contracts.md#declaration)).

| Feature | What happens without it |
|---|---|
| Taking input during a turn | the input waits for the turn to end |
| Waiting for an answer through a restart | the tool call stays open, and the agent carries on when it has its result |
| Rewinding | rewinding is refused before anything changes. Moving the position still works. |
| Forking | a fork starts from a copy of the history |
| Keeping state at the Provider | every request carries the whole model context |
| Running tools at the Provider | the model is not offered those tools |
| Live sessions, such as voice | not available |
| Several actors in one session | the session has one actor |
| Holding output for the output gate | streamed output is not held, and a guardrail sees only complete pieces |
| Output that bypasses the agent | none bypasses it |
| Starting turns nobody asked for | the agent starts none |
| Cancelling a turn also cancels its jobs | it doesn't: jobs keep running |
| Adding plugins during a session | the session's plugins are fixed when it starts |
| Erasure | erasure is refused. Retention still applies. |

## Guarantees

These always hold. They are **proposed** unless a decision is linked.

1. **Everything can be identified.** Every session, turn, step, tool call, job and actor can be identified, and everything that happens can be traced to the ones it belongs to.
2. **Everything can be observed** by those allowed to see it, for as long as it is kept ([ADR 0010](adr/0010-describe-parts-not-wiring.md)).
3. **History grows in normal use.** Compaction, moving and rewinding add entries. History is deleted only by retention or erasure, and each erasure leaves a record without the deleted content ([ADR 0007](adr/0007-context-management-is-a-hook.md)).
4. **Every tool call ends with exactly one result,** even when it is refused, cancelled or interrupted, and even when the result arrives after its turn. An approval is not a result: it only decides whether the call may run.
5. **Credentials never reach the Runtime, and the Runtime never chooses the model** ([ADR 0005](adr/0005-provider-handles-from-the-harness.md)).
6. **The record keeps everything intact.** Content a part doesn't understand is recorded as it arrived. What each recipient receives is a view of the record.
7. **Plugins stay within the plugin API** ([ADR 0011](adr/0011-minimal-harness-everything-is-a-plugin.md)).
8. **Approval fails closed.**
9. **Authority only narrows.** Work an action causes gets the narrowest authority of everyone involved.
10. **Differences are declared.** The agent says which features it lacks, and what happens instead, without changing policy.

## How we will know the description is right

It is good enough when all of these hold:
- Pi, DeepSeek Harness, Pydantic AI, Tau and PiG can each be described in its terms, by saying which of their pieces plays each part. The [prior-art map](research/README.md) is the first attempt.
- A transient Runtime and a durable Runtime both fit the description of the Runtime.
- An agent in one process and one split across services could both follow it unchanged.
- A host such as T3 Code could drive it as it drives Pi today.
- Each [scenario](scenarios.md) can be told using only the parts and guarantees above.
- A review finds nothing that would break a plugin or a host when one implementation is swapped for another.

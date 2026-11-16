# Architecture

**Status:** draft, 2026-11-16. Items marked **decided** link to the decision record that settled them. Everything else is **proposed** and can change. Open points link to [open questions](open-questions.md).

This document describes **what** the system is: its parts, what each is responsible for, and what must always be true. It does not describe **how** the parts are built or wired together ([ADR 0010](adr/0010-describe-parts-not-wiring.md)). The same description should fit an agent that runs in one process and one split across services.

Two companion documents complete it:
- [Contracts](contracts.md): what passes between the parts. It gives enough detail to build the system in any form.
- [Scenarios](scenarios.md): the parts working together in specific situations.

Terms are defined in the [glossary](../GLOSSARY.md).

## Purpose

Modular Agent is an AI agent built from parts that can each be swapped out and studied on its own. A small **Harness** holds everything together, and every feature is a **plugin**, including the part that runs the agent loop.

The project is for understanding how an agent is put together. Production performance is not a goal.

## Goals

1. **Every part can be swapped.** That includes the Runtime (for example, a transient one for a durable one), Providers, Interfaces, tool sources, and where history is kept.
2. **Every part can be studied on its own.** Each part has one stated responsibility, and anything that passes between parts can be observed and recorded.
3. **The base does the minimum.** Anything that can be a plugin is a plugin.
4. **The description doesn't depend on wiring.** One process, several processes or separate services can all follow it.
5. **Existing agents fit it.** Pi, DeepSeek Harness, Pydantic AI and others can each be described by saying which of their pieces plays each of our parts.

## Out of scope for now

- How parts talk to each other: transports, message formats, protocols and process layout.
- How each part works inside, such as how a durable Runtime records its progress or how plugins are loaded. Questions like these are kept under [Parked: how](open-questions.md#parked-how).
- Features of any one kind of agent, such as coding tools or a particular UI. They are plugins.
- Production performance.

## The parts at a glance

An **agent** is the Harness plus a chosen set of plugins. **Decided** ([ADR 0011](adr/0011-minimal-harness-everything-is-a-plugin.md)).

```
      users · editors · other agents · webhooks · schedules
                            │
                      Interface plugins
                            │
  ┌──────────────────────── Harness ─────────────────────────┐
  │  hosts plugins · offers the plugin API · keeps sessions   │
  └──────┬─────────────┬─────────────┬─────────────┬─────────┘
         │             │             │             │
      Runtime      Providers    Tool sources   History store,
                                               credential store
          (each is provided by a plugin)  

  Feature plugins add behaviour without providing a capability:
  approval, context management, skills, commands, subagents, …
```

Plugins come in two kinds:
- A plugin can **provide a capability**: a named job the agent needs done, such as Runtime or Provider.
- A plugin can **add behaviour** without providing a capability, such as approval or context management.

One plugin can do both.

## The Harness

The Harness is the only part that is always present. It holds the agent together and does nothing else. **Decided** ([ADR 0011](adr/0011-minimal-harness-everything-is-a-plugin.md)).

It is responsible for three things. The exact list is **proposed** ([open question](open-questions.md#what-the-harness-keeps)):
1. **Hosting plugins:** starting them, giving each the capabilities it needs from other plugins, and stopping them.
2. **The plugin API:** everything a plugin can do. A plugin can act only through it.
3. **Sessions:** each session's identity, its settings, which plugins are active in it, and its history. A plugin decides where the history is stored.

It does not run turns, call models, run tools, show anything to a user, or store anything durably itself. With no plugins, it does nothing useful.

The Harness is also where the outside world is turned into a small set of standard forms (messages, tool definitions, tool calls and results, access to a model), so the Runtime never sees which vendor, tool source or Interface is involved. Plugins do that adapting. **Decided** ([ADR 0002](adr/0002-harness-is-the-standardizing-boundary.md)).

## Capabilities

| Capability | What it does | How many in an agent |
|---|---|---|
| [Runtime](#runtime) | Runs turns | one at a time per session ([open](open-questions.md#how-many-of-each-capability)) |
| [Provider](#provider) | Makes models available | any number |
| [Interface](#interface) | Lets the outside world use the agent | any number |
| [Tool source](#tool-source) | Offers tools and runs them | any number |
| [History store](#history-store) | Keeps session history | one |
| [Credential store](#credential-store) | Keeps credentials and hands them out | one ([open](open-questions.md#how-many-of-each-capability)) |

Whether the working environment (files, processes, a sandbox) is a capability too is [open](open-questions.md#working-environment). So is the word "capability" itself, which other projects use differently ([open](open-questions.md#naming-capability)).

### Runtime

Runs a turn from start to finish. It decides when to make the next model request, asks for tool calls to be run, lets plugins step in at the agreed points, reports what it is doing, and ends the turn with an outcome. **Decided** ([ADR 0003](adr/0003-session-turn-step-ownership.md), [ADR 0004](adr/0004-merge-core-into-runtime.md)).

It never:
- chooses the model, or holds credentials ([ADR 0005](adr/0005-provider-handles-from-the-harness.md))
- runs a tool or another plugin's code itself. It asks for that to be done ([ADR 0006](adr/0006-hook-points-belong-to-the-operation-owner.md)).
- keeps the session's history. The Harness does.

There are two kinds, and both must fit this description:
- A **transient** Runtime keeps a turn only while its process runs.
- A **durable** Runtime can carry on with a turn after its process stops and starts again.

### Provider

Makes one model, or one vendor's models, available. It offers a catalog (which models, their limits, what kinds of input they accept), answers model requests, and gets credentials from the credential store when it needs them. It never decides which model is used. **Decided** ([ADR 0005](adr/0005-provider-handles-from-the-harness.md)).

### Interface

Lets someone or something outside use the agent. Through an Interface, a user or another program can:
- start, find, resume and fork sessions
- give the agent input, and cancel what it is doing
- run commands
- follow what the agent does as it happens
- answer the agent's questions and approval requests

Examples: a terminal UI, a web UI, an editor (as ACP clients do), another agent (as A2A clients do), an incoming webhook. To the outside world the system looks like one agent, whichever plugins are inside it. What exactly an agent offers the outside world is [open](open-questions.md#the-agent-from-outside).

### Tool source

Offers tools and runs calls to them. A tool has a name, a description, the input it takes, and hints such as "read-only" or "destructive". Examples: built-in file and shell tools, an MCP server, another agent. Whether an Interface can also offer tools is [open](open-questions.md#tools-run-by-an-interface).

### History store

Keeps each session's history and gives it back. It never changes or deletes what has been recorded. It refuses a second writer for a session that is already open.

### Credential store

Keeps credentials, gives them to the Providers and tool sources that ask for them, and runs sign-in with the user's help. Credentials never reach the Runtime. **Decided** ([ADR 0005](adr/0005-provider-handles-from-the-harness.md)).

## Feature plugins

These provide no capability. They add behaviour through the plugin API. Each one is a feature that Pi builds in, or that Pi users add as extensions, so Pi's out-of-the-box experience can be described as one set of plugins.

| Feature | What it does | In Pi |
|---|---|---|
| Approval | Asks the user before a tool call runs, according to a per-session policy | not built in; an extension adds it |
| Context management | Decides what the model sees before each step, and summarizes older history when it grows too large ([ADR 0007](adr/0007-context-management-is-a-hook.md)) | compaction |
| System prompt | Builds the system prompt from parts that other plugins contribute, including context files such as `AGENTS.md` | base instructions and context files |
| Agent Skills | Lists skills for the model, and loads a skill's instructions when the model or user asks | skills |
| Prompt templates | Expands a short command into prepared text | prompt templates |
| Commands | Lets the user act directly, without the model: new session, fork, compact, change model | about 30 slash commands |
| Model selection | Chooses the model and reasoning level for a session, from every Provider's catalog | model selection |
| Telemetry | Follows events and reports them elsewhere, for example as OpenTelemetry traces | not built in |
| Subagents | Lets the agent hand a task to another agent and get the result back | not built in |
| Scheduling | Gives the agent input on a schedule or from a webhook, with no user present | not built in |

## What plugins can do

This is the plugin API, described by what it lets a plugin do. It is **proposed**. It was worked out by asking what each of Pi's built-in features would need as a plugin ([derivation](research/pi-builtins-as-plugins.md)).

**Capabilities**
- Provide a capability.
- Use a capability that another plugin provides. For example, context management uses a Provider to write a summary.
- Change what it offers over time, such as tools appearing as an MCP server connects.

**Sessions and input**
- Start, list, open, fork and close sessions.
- Give a session input, and say when it should be taken: now, into the turn that is running, or after it.
- Cancel the turn that is running.
- Change a session's settings, such as its model.

**History and what the model sees**
- Read a session's history.
- Add to it: either something the model will see (extra context, a summary) or something it won't (the plugin's own state, a record of an approval).
- Add to the system prompt.
- Decide what the model sees before each step.

**Tools and commands**
- Offer tools, and have a tool call run on its behalf, with the same checks as any other call.
- Offer commands to users, and change input before it reaches the model.

**Stepping in, and following along**
- Step in at a [hook point](#where-plugins-can-step-in) to observe, change or stop an operation.
- Follow events, and report its own.

**The user**
- Ask the user something: approve, choose, type, open a link, give a secret. An Interface plugin can answer these.
- Tell the user something that needs no answer, and show status.
- Say how what it produced should be shown. An Interface that doesn't understand that falls back to a plain display.

**Its surroundings**
- Read its own settings ([open](open-questions.md#configuration)).
- Know the working directory and project, and reach files and processes ([open](open-questions.md#working-environment)).

## Units of work

Work is nested three deep. **Decided** ([ADR 0003](adr/0003-session-turn-step-ownership.md)).

| Unit | What it is | Owned by |
|---|---|---|
| Session | One or more turns that share a history | the Harness |
| Turn | The agent working on something until it can't continue without outside input, or it stops | the Runtime |
| Step | One model request and its response, plus the tool calls the response asks for | nobody: it is a concept, not a part |

A turn can stop for its own reasons too: a limit, cancellation or an error. Its outcome says which. Whether new input can join a turn that is running is [open](open-questions.md#input-during-a-turn).

## The Runtime and the Harness

This is the heart of the design. **Decided** ([ADR 0006](adr/0006-hook-points-belong-to-the-operation-owner.md)), except where marked.

- To start a turn, the Runtime is given the input, the tools that are available, access to the chosen model without its credentials, and settings and limits ([open](open-questions.md#turn-limits) who sets them).
- During the turn, it asks for only two things: **run this tool call**, and **let plugins step in here** (a hook point). Deciding what the model sees before each step is one of these hook points.
- At the end, it reports the outcome, what happened, and how much was used.
- Throughout, it reports what it is doing, so Interfaces can show it as it happens.

The full list of what passes between them is in [Contracts](contracts.md#harness-and-runtime).

Whether every tool call must go through the Harness, or a Runtime may sometimes reach a tool source directly, is [open](open-questions.md#direct-tool-access).

## Where plugins can step in

A **hook point** is a moment in an operation where plugins can observe, change or stop it. Whoever owns the operation defines its hook points. **Decided** ([ADR 0006](adr/0006-hook-points-belong-to-the-operation-owner.md)).

Every Runtime offers the same standard set, so plugins keep working when the Runtime is swapped. The **proposed** set covers:
- the start and end of each session and turn
- input arriving, and the start of a turn: change the input, handle it as a command, add to the system prompt
- before each step: decide what the model sees. After each step: continue or end.
- before a tool call: allow, refuse or change it. After it: change the result.
- a failed model request: retry or give up
- around the model request itself, inside the Provider

The full table, with what plugins are given and can answer at each one, is in [Contracts](contracts.md#hook-points).

Whether plugins can define hook points for each other, such as "approval requested", is [open](open-questions.md#plugins-building-on-plugins).

## Waiting for the user

The agent sometimes needs something only the user can give: an approval, an answer, a choice, a sign-in, a secret. This is an **input request**. When there is a tool call behind it, it is tied to that tool call.

These requirements are **proposed** ([open question](open-questions.md#waiting-for-the-user)):
1. **The user answers in context, and the turn carries on.** The user sees what the agent was doing when it asked. In the common case the turn waits and continues once the user answers, as it does in Pi.
2. **A question can outlast the turn.** If no answer comes in time, or the agent has to stop, the turn moves on or ends, and the question stays open. A later answer reaches the agent as new input.
3. **It is always clear whether a request can still be answered.** A request lost when a process stopped is shown as unanswerable, not silently dropped.
4. **Approval fails closed.** Only an explicit "allow" lets a tool call run. If nobody can answer, the call does not run.
5. **A session can be set never to ask,** for unattended work. Every approval is then refused without asking.
6. **Requests from a subagent reach the user through the parent,** so the user doesn't have to watch every agent.

## Surviving interruptions

These requirements are **proposed** ([open questions](open-questions.md#transient-and-durable-runtimes)):
- **A session outlives any process.** Its history is kept by the history store.
- **With a transient Runtime,** a turn whose process stops simply ends. Its record shows which tool calls finished, which never started, and which have an unknown outcome. Nothing with an unknown outcome is retried automatically.
- **With a durable Runtime,** the turn carries on after a restart, without repeating side effects that already happened.
- **Repeating a model request is harmless.** It costs tokens and changes nothing outside the system. Tool calls are what need care ([ADR 0005](adr/0005-provider-handles-from-the-harness.md)).
- **Surviving a crash is a different need from saving and continuing a conversation.** The second needs no durable Runtime.

How much the history must record, for example enough to rebuild exactly what the model saw on every step, is [open](open-questions.md#what-history-records).

## Working with other agents

Our agent can use another agent as a tool source, and be used by one through an Interface. Whether subagents need anything beyond that is [open](open-questions.md#agents-working-together).

These requirements are **proposed**:
- **A subagent starts from its task alone.** It does not inherit the parent's history unless it is given it.
- **Permissions only narrow.** An agent cannot give another agent more freedom than it has itself.
- **The parent does not have to keep checking.** When a subagent finishes, its result reaches the parent as new input.
- **A subagent's questions to the user go through the parent** (see [Waiting for the user](#waiting-for-the-user)).

Whether coordinating several agents belongs inside an agent as plugins, or in a layer above it as T3 Code does, is [open](open-questions.md#a-layer-above-the-agent).

## Guarantees

These always hold. They are **proposed** unless a decision is linked.

1. **Everything can be identified.** Every session, turn, step and tool call can be identified, and everything that happens can be traced to the ones it belongs to.
2. **Everything can be observed.** Every interaction between parts can be observed and recorded ([ADR 0010](adr/0010-describe-parts-not-wiring.md)).
3. **History only grows.** Nothing recorded is changed or deleted. What the model sees is a view of the history, worked out before each step, so compaction adds a summary instead of removing anything ([ADR 0007](adr/0007-context-management-is-a-hook.md)).
4. **Every tool call ends with exactly one result,** even when it is refused, cancelled or interrupted.
5. **Credentials never reach the Runtime, and the Runtime never chooses the model** ([ADR 0005](adr/0005-provider-handles-from-the-harness.md)).
6. **Nothing is lost in passing.** Content a part doesn't understand is kept and passed on intact.
7. **Plugins stay within the plugin API** ([ADR 0011](adr/0011-minimal-harness-everything-is-a-plugin.md)).
8. **Approval fails closed.**

## How we will know the description is right

It is good enough when all of these hold:
- Pi, DeepSeek Harness, Pydantic AI, Tau and PiG can each be described in its terms, by saying which of their pieces plays each part. The [prior-art map](research/README.md) is the first attempt.
- A transient Runtime and a durable Runtime both fit the description of the Runtime.
- An agent in one process and one split across services could both follow it unchanged.
- Each [scenario](scenarios.md) can be told using only the parts and guarantees above.

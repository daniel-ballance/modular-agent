# Architecture

This document explains the parts, what each is responsible for, and why the design uses those boundaries. The rules are in [Contracts](contracts.md) and [Security](security.md). [Scenarios](scenarios.md) shows the parts working together. The [glossary](../GLOSSARY.md) defines the terms.

## Purpose

Modular Agent is an AI agent with a small **Harness** and a set of replaceable **plugins**. Even the loop that runs a turn is a plugin. A host sees one agent rather than the parts inside it.

## Goals

- **Swap parts.** A different Runtime, Provider, Interface, tool source, working environment or history store can do the same job. A transient Runtime and one that recovers after a restart use the same contract.
- **See how the parts work together.** Each part has a stated responsibility. The Harness can observe interactions through its API.
- **Keep the base small.** Features live in plugins. The same design fits an agent in one process or split across processes or services.
- **Describe existing agents.** The [prior-art map](research/README.md) uses the parts to describe Pi, DeepSeek Harness, Pydantic AI and others.
- **Let a host drive the agent.** A host such as T3 Code coordinates whole agents from outside ([ADR 0012](adr/0012-one-agent-is-the-scope.md)).

## Out of scope for now

- A required transport, encoding or process layout for the core. [Bindings](bindings/README.md) are optional profiles a build can claim.
- How each part works inside. See [Implementation concerns](research/implementation-concerns.md).
- Features of a particular agent, such as coding tools or a UI. Those are plugins.
- Coordinating several whole agents. That is a host's job.
- Performance targets. Each deployment sets its own.

## The parts at a glance

An **agent** is the Harness plus its plugins ([ADR 0011](adr/0011-minimal-harness-everything-is-a-plugin.md)).

```text
   users · editors · other agents · hosts · webhooks · schedules
                              │
                       Interface plugins
                              │
  ┌────────────────────────── Harness ───────────────────────────┐
  │   hosts plugins · offers the plugin API · keeps sessions      │
  └────┬───────────┬────────────┬─────────────┬─────────────┬───────┘
       │           │            │             │             │
    Runtime    Providers   Tool sources    Working      History store,
                                         environment   credential store
                   (each is provided by a plugin)

  Feature plugins add behaviour: approval, guardrails, context
  management, skills, commands, subagents, …
```

A plugin can provide a **capability**, a named job the agent needs done. It can also add behaviour such as approval or context management. One plugin can do both.

## The Harness

The Harness is the one part always present. It hosts plugins, exposes their API and owns session state. It checks authority and commits records. It coordinates work rather than implementing the turn loop, model adapters, tools, displays or durable storage. See [Plugins and capabilities](contracts.md#plugins-and-capabilities), [Authority](contracts.md#authority) and [Recovery](contracts.md#recovery-and-repeating-work).

Plugins adapt outside systems to common forms at this boundary. The Runtime sees a message, tool definition or model access instead of a vendor SDK ([ADR 0002](adr/0002-harness-is-the-standardizing-boundary.md)). The [declaration](contracts.md#declaration) exposes differences that matter to an Interface or host.

## Capabilities

| Capability | What it does | Selection in a session |
|---|---|---|
| [Runtime](#runtime) | Runs turns | at most one |
| [Provider](#provider) | Makes models available | a catalog can contain several Providers |
| [Interface](#interface) | Lets the outside world use the agent | several can be available |
| [Tool source](#tool-source) | Offers tools and runs them | several can be available |
| [Working environment](#working-environment) | Hosts files and commands | at most one |
| [History store](#history-store) | Keeps session history beyond the process | at most one |
| [Credential store](#credential-store) | Keeps credentials and runs sign-in | at most one |
| [Configuration](#configuration) | Supplies settings to the Harness and plugins | at most one |

Registration and selection are different: a session can exist without a selected Runtime or usable model, but it cannot run a turn that way. See [Plugins and capabilities](contracts.md#plugins-and-capabilities) for prerequisites and composition.

### Runtime

Runs a turn from start to finish. It prepares steps, asks for model inference and tool execution, runs its hook points and produces a turn outcome. It uses the model selected for the session, without access to credentials. The Harness owns the session and mediates the Runtime's calls. See [Harness and Runtime](contracts.md#harness-and-runtime).

A transient Runtime keeps a turn only while its process runs. A durable Runtime can reconstruct an interrupted turn from the record. Both use the same turn contract. See [Recovery](contracts.md#recovery-and-repeating-work).

### Provider

Offers a catalog of models and a way to use them. It gets its own credentials and reports what it supports. It does not select the session's model. [Provider state](contracts.md#provider-state) explains when it can reuse conversation state without adding omitted history.

The bindings cover request and response, which can stream. Live two-way sessions such as voice, delayed batch responses and tools that a Provider runs itself are outside the common `/1` wire and portability profile. In-process Provider-run tools use the [request's allowed list](contracts.md#provider-state); what returns is an account of work already done, not a request to run it.

### Interface

Lets someone or something outside the agent use it. A terminal UI, an editor over ACP, a web UI, another agent or a host can all use this role. An Interface uses an authenticated connection's actor, with the [authority](contracts.md#authority) of that actor. See [Interface and Harness](contracts.md#interface-and-harness) for operations and [ACP](bindings/acp.md) for a wire profile.

### Tool source

Offers tool definitions and runs calls. Built-in file and shell tools, MCP servers and other agents can all be tool sources. The catalog can differ between sessions. For example, an ACP host can provide MCP servers for a session; the agent starts them only under the [MCP server rules](contracts.md#mcp-servers). They run with the agent's permissions, not with isolation implied by the session catalog.

Agent-executed calls go through the same [dispatch checks](contracts.md#tool-dispatch) whether they originate in the model, a UI or another plugin. A read-only annotation comes from a trusted definition, not the tool's name or a model's description.

### Working environment

Where files live and commands run: the local machine, a remote host or a sandbox. It is distinct from the **project**, the folder the user is working on. Swapping the environment moves the work of tools that use it.

Containment describes which processes stop. Only strong containment covers all descendants. File confinement is a separate property, and neither implies that a command cannot reach outside the project. See [The working environment](contracts.md#the-working-environment) for what is promised and how recovery handles uncertain cleanup.

### History store

Keeps a session's record beyond the process. Without it the session is ephemeral. A store can apply retention or support erasure. Writer access prevents two writers from updating the same session at once. See [History store interactions](contracts.md#harness-and-history-store), [Recovery](contracts.md#recovery-and-repeating-work) and [Erasure](contracts.md#erasure).

### Credential store

Keeps credentials, gives them to authorized Providers, tool sources and working environments, and runs sign-in with an actor's help. The Runtime gets model access without credentials. See [Credential store interactions](contracts.md#asking-the-credential-store) and [Secrets](contracts.md#secrets).

### Configuration

Supplies session defaults and each plugin's own settings. It can draw from global and trusted project files. See [Configuration and trust](contracts.md#configuration-and-trust) for composition and [Settings](contracts.md#settings) for changes to a session.

## Feature plugins

Feature plugins add behaviour through the plugin API. For example:

| Feature | What it does |
|---|---|
| Approval | Asks about a particular tool call under the [session's approval policy](contracts.md#tool-dispatch). |
| Guardrails | Check input and shape the view sent to recipients. |
| Context management | Selects the model view and can summarize older entries. |
| System prompt | Assembles prompt fragments, sometimes including untrusted project text such as `AGENTS.md`. |
| Skills and prompt templates | Supply instructions or expand prepared text. |
| Commands | Carry out an actor's [direct action](contracts.md#commands) without starting a turn. A command such as `/compact` can declare that it asks the model. |
| Model selection | Chooses a model and reasoning level for a session. |
| Telemetry | Follows permitted events. |
| Subagents | Hand work to a child session as a job. |
| Scheduling | Submits input as an authorized actor. |

## What plugins can do

The plugin API lets a plugin register and use capabilities, hooks, tools and commands, and use session services. A tool source can announce a changed catalog. A plugin can explicitly replace a loaded plugin, for example one MCP tool source with another. The [plugin binding](bindings/plugin.md#starting-the-handshake) replaces named local registrations instead of whole plugins. [Plugins and capabilities](contracts.md#plugins-and-capabilities) describes selection and replacement. [Interactions](contracts.md#interactions) describes the services; the [Plugin binding](bindings/plugin.md) covers the subset available in another process.

The API is not a sandbox. Plugins are trusted code with the agent's permissions even when they run in another process. Using the API is a design rule. The Harness can observe interactions that go through it, not effects a plugin causes outside it. See [Security](security.md) for the operator's trust boundary.

## Units of work

| Unit | What it is | Owned by |
|---|---|---|
| Session | Turns and jobs that share a record | the Harness |
| Turn | Work from admission, continuation or other initiation to an outcome, possibly after waiting | the Runtime |
| Step | A model request and response plus the round of calls it asks for, through settlement of the round; in a live extension it can be a stretch between turn-taking points | a unit within a turn |
| Job | Session work outside a turn, which can outlive the turn that started it | the owning plugin, for the session |

The turn's initiator links it to actor input, a job report, a plugin or a late answer. Steering is another input to the same turn, taken at a tool-round boundary when supported. See [Turn input and outcome](contracts.md#turn-input-and-turn-outcome) and [Input](contracts.md#input). The `step.after` hook marks the end of the round, after calls settle or are left open. See [Hook execution](contracts.md#hook-execution).

## Actors and authority

An **actor** is a user, host, agent or program. Some agents support several actors per session, such as an owner and viewers. Rights are named. The Harness narrows them by current limits and by the rights of everyone behind the work. A job report does not inherit wider rights from whoever reads it. A peer's message is data, not a command or approval.

[Authority](contracts.md#authority) covers provenance, joining, grants and checks. [Limits and tenants](contracts.md#limits-and-tenants) covers ceilings and soft budgets. [Security](security.md) covers authentication and trust boundaries.

## The Runtime and the Harness

The Runtime owns the turn loop. It uses the Harness for model access, tool execution, hook answers and session services such as ids, history and steering. The Harness owns durable session changes and checks the final tool call at dispatch. For a remote Runtime, it also commits each checked tool result before returning it. The Runtime reports the outcome and usage. See [Harness and Runtime](contracts.md#harness-and-runtime), [Tool dispatch](contracts.md#tool-dispatch) and [Recovery](contracts.md#recovery-and-repeating-work).

## Where plugins can step in

A **hook point** is a place for a plugin to observe, change or stop an operation. The operation owner defines the point. For example, prompt fragments are collected before a turn, while turn start is an observation. The core [Hook points](contracts.md#hook-points) list and [combination rules](contracts.md#hook-execution) let a plugin work with different Runtimes. The [Plugin binding](bindings/plugin.md#the-host-asks-a-hook-handler) maps the points it carries.

## Waiting for an answer

An **input request** asks an actor to approve, choose, type, sign in or give a secret. Seeing a question does not imply eligibility to answer. A turn can wait for an answer. An eligible non-approval question can keep a call open past the turn if the build declares support. Once the group of questions closes, a continuation can rerun only unsettled question-backed calls through their checks. An answer is not a tool result. The proposed [Interface-run tool rules](contracts.md#interface-run-tools) also let an actor's Interface return the result of a handed-off call. The continuation uses that result without running the call again. A question interrupted inside a turn follows a different recovery path. See [Questions](contracts.md#questions), [Secrets](contracts.md#secrets) and [Tool dispatch](contracts.md#tool-dispatch).

## Jobs

Jobs include background commands, watchers and subagents. Their start and end are recorded separately from turns. A plugin can recover a logical job without claiming its earlier process survived. A job can report its result as input; the declaration says whether that input can start a turn on its own. [Jobs](contracts.md#jobs) covers recording, cancellation, close and missing owners.

A schedule or webhook is an outside program giving ordinary authorized input, not a job or an unasked turn.

## History

History normally grows by appending. The [default model view](bindings/data.md#context-and-interrupted-work) follows the current branch. [Shared data](bindings/data.md#append-order-and-the-branch) describes which records instead apply to the whole session. [Compaction](contracts.md#compaction) adds a summary rather than deleting entries. A [move](contracts.md#moving-and-rewinding) changes position without restoring files. A rewind also restores a saved project point and records completion. The [rewind journal](bindings/data.md#rewinding) distinguishes a completed restore from one that recovery still needs to finish. Both reset Provider conversation state. Neither promises to undo outside effects.

[Erasure](contracts.md#erasure), when supported, follows copies. The record distinguishes cleared content, pending deletions and out-of-reach copies. Authority records and tombstones remain while kept under retention. Secret values and protected launch material never belong in the record.

## Surviving interruptions

Recovery begins from the committed record. A transient Runtime ends the interrupted turn as failed. A durable one can continue when the checkpoints and dependencies permit. A lost result is not proof that an effect never happened. The [repeat rules](contracts.md#recovery-and-repeating-work) distinguish committed results, unstarted calls and ambiguous attempts, including model attempts on a stateless Provider that runs no tools. See also [The working environment](contracts.md#the-working-environment) for cleanup.

## Who sees what

Recipients get views. The agent authorizes a view before sending it through the [output gate](contracts.md#the-output-gate), including replay. An authorized internal reader can have a raw view. The record preserves permitted content, including unknown types; [erasure](contracts.md#erasure) and [secrets](contracts.md#secrets) define what is not kept. Untrusted project text, tool output and model output do not grant authority even when included in the prompt.

A route that bypasses the agent, such as direct Provider audio in a live extension, bypasses its gate. The route is declared, and is unsuitable for an operator policy that requires gating.

## Working with other agents

- **Tool source:** another agent offers tools or accepts work as calls.
- **Actor:** another agent uses an Interface with its own authority.
- **Subagent:** a child session works on a task as a job. It can send questions back through its parent and receive a follow-up after it finishes. See [Subagents](contracts.md#subagents) for depth, inheritance and relays.
- **Peer:** another agent without a parent relationship. The core does not define a peer coordination protocol.

## Being driven by a host

A host coordinates whole agents from outside. It reads the declaration and drives each agent through an Interface as a configured actor. It can submit keyed input, read outcomes, and use history or optional operations such as fork according to the selected profile. Job reports and late answers are distinct sources of work. A host's scheduler submitting input is acting as an actor, not relying on the agent to start an unasked turn. See [Interface and Harness](contracts.md#interface-and-harness), [Following a session](contracts.md#following-a-session) and [ACP](bindings/acp.md).

## Declared support

A declaration describes which features this agent or selected session supports. It is not a settings record, a readiness check or an authorization grant. The [declaration rules](contracts.md#declaration-rules) give the core requirements. The [ACP declaration](bindings/acp.md#the-declaration) defines field types and wire defaults. This table explains the restrictive case. The two fixed compatibility keys, `inputKeys: true` and `pluginsDuringSession: false`, are not feature switches.

| Declaration key | Restrictive case or absence |
|---|---|
| `inputDuringTurn` | Steering waits for the next turn. |
| `waitingThroughRestart` | An interrupted in-turn question closes as no longer answerable. This is not a late answer. |
| `continuesAfterRestart` | The interrupted turn ends as failed. Started calls without committed results can have unknown outcomes. |
| `rewinding` | Rewind is refused. Plain move does not restore files. |
| `forking` | Fork is refused. |
| `keepsStateAtProvider` | The Provider gets context on each request instead of reusing conversation state. |
| `runsToolsAtProvider` | The Provider does not execute tools. |
| `liveSessions` | No live two-way model sessions. |
| `severalActors` | The session has one actor. |
| `holdsOutput` | No whole-stream buffering guarantee. |
| `outputBypassesAgent` | No output bypasses the agent. If it does, the agent's gate does not cover it. |
| `cancellingTurnCancelsJobs` | Cancelling a turn leaves its jobs running; session close is separate. |
| `erasure` | Erasure is refused. Retention still applies. |
| `questionsOutlastTurns` | A question does not stay open past its turn. |
| `startsTurnsUnasked` | `never`: a job report does not start a turn on its own. |
| `queuedInputAfterRestart` | `handedBack`: queued input not taken is returned rather than run. |
| `movingWithUnfinishedWork` | `refused`: a move that would abandon unfinished work is refused. |
| `mixedActorInput` | `refused`: actors' input is not combined in one turn. |
| `settingsDuringTurn` | `refused`: a settings change during a turn is refused. |
| `erasureDuringTurn` | `refused`: erasure during a turn is refused. |
| `commandContainment` | `processGroup` covers only the process group; `none` makes no stop guarantee. |
| `lateAnswersStartTurns` | Without keyed continuation, calls do not stay open past a turn. |
| `queuedJobReportsAfterRestart` | If absent, the ordinary queued-input policy applies. |
| `portableSessions` | No shared-session portability claim. |
| `sessionLimits` | No session limit extension. |
| `tenants` | No tenant extension. |
| `projectRoot` | No single-project declaration. |
| `confinesFiles` | No claim of file confinement after resolving symlinks. |
| `telemetry` | No [metadata-only telemetry profile](telemetry.md) claim. Support does not tell a reader whether export is on. |

## Guarantees

[Contracts](contracts.md#rules-every-implementation-follows) covers the invariants: authority at dispatch, durable records before effects, one terminal result per settled call and explicit recovery of interrupted work. [Security](security.md) covers the trust and deployment constraints those invariants depend on. A fallback describes missing support, not permission to bypass deployment policy.

## How we will know the description is right

See the [acceptance test](../README.md#acceptance-test) and [Conformance](conformance.md). The [scenarios](scenarios.md) illustrate the same parts under different declarations.

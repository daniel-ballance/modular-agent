# Modular Agent

The vocabulary for describing an AI agent built from parts that can each be swapped out and studied on its own: a minimal Harness, and plugins for everything else.

## The system

**Agent**:
The Harness plus a chosen set of plugins. To the outside world it is one agent, whatever plugins are inside it.
_Avoid_: Assistant, bot

**Harness**:
The part that hosts plugins, offers the plugin API and owns sessions.
_Avoid_: Core, host, application layer, orchestrator

**Plugin**:
Trusted code that adds a capability or feature to the agent. Plugins run with the agent's permissions, even when hosted in another process.
_Avoid_: Extension (Pi's word), capability (Pydantic AI's word), add-on, module

**Plugin API**:
The supported interface for plugins to act on the agent. It exposes mediated interactions, not confinement of code or visibility into effects outside the API.
_Avoid_: Extension API (Pi's word)

**Capability**:
A named role a plugin can provide, such as Runtime, Provider or Interface.
_Avoid_: Seam (DeepSeek Harness's word), service, slot

**Feature plugin**:
A plugin that provides no capability and only adds behaviour, such as approval or context management.

**Declaration**:
A description of the behavior a part supports, such as taking input during a turn, rewinding or keeping state at the Provider.
_Avoid_: Capability flags (T3 Code's term), feature flags

## Capabilities

**Runtime**:
The capability that runs turns.
_Avoid_: Core, agent core, agent loop, engine

**Transient Runtime**:
A Runtime whose turn ends if its process stops.

**Durable Runtime**:
A Runtime that can carry on with a turn after its process stops and starts again.

**Provider**:
The capability that makes one model, or one vendor's models, available. It may keep its own conversation state and run some tools itself, and declares both.
_Avoid_: Model, LLM, inference layer

**Interface**:
The capability that lets someone or something outside use the agent, such as a terminal UI, an editor, another agent or a webhook.
_Avoid_: Frontend, client, UI (each is too narrow)

**Tool source**:
The capability that offers tools and runs them, such as built-in tools, an MCP server or another agent.
_Avoid_: Toolset, tool provider

**Working environment**:
The capability that provides where files live and commands run: the local machine, a remote host or a sandbox.
_Avoid_: Workspace, sandbox (one kind of it), environment (too vague)

**Project**:
The folder the user is working on, as distinct from the working environment that contains it.
_Avoid_: Repo, workspace root

**Project trust**:
The operator's authorization to load executable plugins and plugin settings from a project.

**Configuration**:
The capability that supplies the agent's settings and plugin selection from sources such as global and project files.

**History store**:
The capability that keeps session history beyond the process.
_Avoid_: Storage, database, persistence

**Credential store**:
The capability that keeps credentials, supplies them to authorized Providers, tool sources and working environments, and supports sign-in with an actor's help. See [Asking the credential store](docs/contracts.md#asking-the-credential-store).
_Avoid_: Secrets manager, keychain

**Staged secret**:
A secret answer the credential store has saved for a question but has not made active. Credential lookups cannot see it, and it does not replace the active value.

## Units of work

**Session**:
A history and its associated work, including any turns and jobs. Owned by the Harness.
_Avoid_: Conversation, thread, context

**Ephemeral session**:
A session with no history store. Its history is gone when the process stops.

**Portable session**:
A session stored in the [shared format](docs/bindings/data.md#portable-sessions) that another supporting agent can reopen and continue. Portability describes the record, not permission to use it.

**Turn**:
One period of work by the Runtime, with zero or more steps. Waiting in place for an answer is part of the turn.
_Avoid_: Run, agent run, task, prompt turn

**Step**:
One model request and its response, plus any calls it asks for, until each call settles or is left open. In a live session a step can be one stretch of the connection.
_Avoid_: Turn (Pi's word for it), iteration

**Auxiliary attempt**:
A model request a plugin makes for its own work, such as writing a summary. It has usage but is not a step.

**Continuation turn**:
A new turn that takes up pending calls from an ended turn once their questions are closed. It does not start from a new input admission.

**Metered identity**:
The model attempt or job to which reported usage belongs. The same work still has the same identity after its entry is erased.

**Outcome**:
How a turn ended: completed, cancelled, failed, or stopped at a limit.
_Avoid_: Stop reason, status

**Result**:
What a turn returns to whoever started it: text, structured data, or the tool calls still open.
_Avoid_: Output, return value, final answer

**Job**:
Work owned by a session that runs outside any turn and can outlive the turn that started it, such as a background command, a subagent or a remote task.
_Avoid_: Task (A2A's word for a turn), background task, activity

**Job report**:
Input carrying a job's result back to its session, acting with the job's authority.

**Parked job report**:
A job report admitted but not ready to run until an authorized actor releases it.

**Job key**:
A content-free identifier the owning plugin chooses to recognize a retry of a job start within a session.

**Unconfirmed cleanup**:
An unfinished job state after cancellation did not establish that the old execution stopped.

**Live session**:
A model connection where input and output flow both ways at once, such as voice.
_Avoid_: Realtime session, stream

**Input admission**:
The Harness's acceptance of input. A receipt identifies that admission, even when the input waits in a queue or is handed back before a turn takes it.

**Steering**:
Input requested to join a running turn when the Runtime supports it. The final steering check is the cutoff after which new steering waits for another turn.

**Hand-back**:
The disposition of admitted input returned without being taken by a turn. For example, a turn can end before taking admitted steering.

**Proposal**:
Admitted input that waits for an authorized actor to release it.

## Tools

**Tool definition**:
A tool's name, description, input schema and declarations about its effects.
_Avoid_: Tool schema

**Tool registration**:
A tool definition together with the plugin name and tool source id that identify where it is offered.

**Tool call**:
A request to run a named tool with some input, made by the model, a UI, a plugin or another tool, or made and run by the Provider itself.
_Avoid_: Function call, tool use

**Tool result**:
One tool call's settlement: its final status and any returned content or value. An answer to a question about the call is not a tool result.

**Open tool call**:
A tool call that has stopped its invocation and left its result pending for a continuation turn.
_Avoid_: Deferred tool call (Pydantic AI's term), pending call

## Context

**History**:
The record of a session, a tree of entries that grows in normal use. It includes entries the model never sees. It is deleted only by retention or erasure.
_Avoid_: Memory, transcript, log

**History entry**:
One item in a history, such as an input, a model response, a tool result, a summary or a setting change.

**Commit**:
A successful write to the session's store. A commit in an ephemeral session does not survive a restart.

**Tombstone**:
The record that stands in place of an erased entry. It preserves identities and selected control facts, such as fork provenance, job keys and numeric usage, not erased content.

**Current position**:
The history entry a session is at. The shared data binding calls it the *head*. The current branch is that entry and its ancestors. A page cursor identifies where to continue reading a view, not the session's position.

**Fork**:
A separate session based on history from a source session at a selected entry.

**Point**:
A saved snapshot of project files from a working environment, or the reference to that snapshot.

**Rewind**:
A move on the current branch that also restores project files from a point. Like any move, it resets Provider conversation state; it does not reverse effects outside the snapshot.
_Avoid_: Rollback, undo, revert

**Rewind journal**:
The records that distinguish an intended rewind from one whose files were restored, or whose prior position and files were re-established.

**View**:
What one recipient receives of the record. It may leave out or redact content.
_Avoid_: Projection, copy

**Model context**:
The view supplied to the model for a step. Retained Provider conversation state represents an exact prefix of that view, not extra history.
_Avoid_: Prompt, context window (that is the size limit)

**Compaction**:
Adding a summary of older history so the model context fits. It changes the view, not the history.
_Avoid_: Truncation, pruning

**Erasure**:
Deleting content from history and every copy the agent controls when deletion is required. It always leaves a record that it happened, without the content.
_Avoid_: Deletion (too general), purge

**Retention**:
How long a history store keeps a session's history.

**Lease**:
A time-limited claim to be the only writer of a session in a history service.

**Model access**:
What the Runtime is given so it can make model requests to the chosen model, without the credentials.
_Avoid_: Provider handle (our earlier name), client, API key

## Stepping in

**Hook point**:
A moment in an operation where plugins can observe, change or stop it. Whoever owns the operation defines it.
_Avoid_: Callback, middleware, interceptor

**Hook handler**:
A plugin operation registered at a hook point. It observes the operation or supplies an answer, depending on the point.
_Avoid_: Hook (unclear whether it means the point or the handler)

**Provider middleware**:
Hook points inside a Provider, around the model request itself.

**Output gate**:
The hook point before output reaches a recipient, where it can be let through, redacted, blocked, or held until more arrives.
_Avoid_: Output filter, post-processing

**Event**:
A report that something happened. It can't change what happened.
_Avoid_: Notification, message

**Output event**:
An item passed to the output gate in a [shared format](docs/bindings/data.md#output-events), such as streamed text, a history entry or a reply.

**Command**:
A direct action an actor takes through an Interface, such as `/model` or `/compact`, that a plugin carries out under the actor's authority without starting a turn. A command that uses a model declares it.
_Avoid_: Slash command (one form of it), tool

## Actors

**Actor**:
An identity acting within a session, with an id, one kind (`user`, `host`, `agent` or `program`) and recorded rights.
_Avoid_: Caller, participant

**Principal**:
A stable identity recognized by the operator for authentication and authority, whether a person or a system. An Interface connection acts as its configured principal's actor.

**User**:
A person acting on the agent through an Interface. One kind of actor.
_Avoid_: Human, operator, person

**Host**:
A system that drives agents from outside, such as T3 Code. In the [plugin binding](docs/bindings/plugin.md), *host* instead names the process running the Harness, not an actor kind for that process.
_Avoid_: Orchestrator, coordinator

**Operator**:
The person or organization responsible for deployment configuration, including which principals and plugins it trusts.

**Authority**:
What an actor may do in a session, represented by named rights.
_Avoid_: Permissions, access level, runtime mode

**Effective rights**:
The rights available to an actor after applicable ceilings. For work with more than one source of authority, the available rights are their intersection, bounded by the rights recorded for the work. See [Authority](docs/contracts.md#authority).

**Tenant**:
An operator-configured scope for sessions that share a rights ceiling and, if configured, a usage budget. A session's tenant is part of its identity.

**Session limit**:
A ceiling on session rights other than `administer`, distinct from a limit on work or usage.

**Administrator**:
An actor with `administer`, the right to set the session limit.

**Input request**:
A question for an actor, such as an approval, a choice, a sign-in or a secret. Its *answerers* are the actors eligible to answer it.
_Avoid_: Prompt, dialog, interrupt, elicitation

**Presence**:
Whether an open connection acts for an actor in a session and marks that actor present. Presence is not proof of a person's approval.

**Late answer**:
An answer to a non-approval question left open after its originating turn ended. Not a late batch model response.

**Continuation**:
A keyed turn that settles a previous turn's open calls once their questions are answered.

**Approval**:
An input request about one exact tool call and its tool registration. The recipient's approval view shows the tool name and input for that call.
_Avoid_: Permission request, confirmation

**Approval policy**:
The session setting for the approval check: `off` skips it, `ask` asks except for tools a trusted definition marks read-only, `all` asks for every call, and `never` refuses every call without asking. See [Tool dispatch](docs/contracts.md#tool-dispatch) and the [ACP options](docs/bindings/acp.md#configuration-options).
_Avoid_: Permission mode, runtime mode

**Subagent**:
An agent started by another agent's job to do a task, with its own session that belongs to the parent's.
_Avoid_: Child agent, delegate, worker

**Peer**:
Another agent this one can message, with no parent relationship.
_Avoid_: Teammate, sibling

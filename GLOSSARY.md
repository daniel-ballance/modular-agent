# Modular Agent

The vocabulary for describing an AI agent built from parts that can each be swapped out and studied on its own: a minimal Harness, and plugins for everything else.

## The system

**Agent**:
The Harness plus a chosen set of plugins. To the outside world it is one agent, whatever plugins are inside it.
_Avoid_: Assistant, bot

**Harness**:
The one part that is always present. It hosts plugins, offers the plugin API and keeps sessions, and does nothing else.
_Avoid_: Core, host, application layer, orchestrator

**Plugin**:
A unit that adds to the agent using only the plugin API. Everything beyond the Harness is a plugin, including the Runtime.
_Avoid_: Extension (Pi's word), capability (Pydantic AI's word), add-on, module

**Plugin API**:
Everything the Harness lets a plugin do. A plugin can do nothing else.
_Avoid_: Extension API (Pi's word)

**Capability**:
A named job the agent needs a plugin to do, such as Runtime, Provider or Interface. A plugin that does it provides the capability.
_Avoid_: Seam (DeepSeek Harness's word), service, slot

**Feature plugin**:
A plugin that provides no capability and only adds behaviour, such as approval or context management.

**Declaration**:
What a part says it supports, such as taking input during a turn, rewinding, or keeping state at the Provider. For each feature a part lacks, the description says what happens instead.
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
The folder the user is working on, which context files, skills and prompt templates read. It is separate from the working environment.
_Avoid_: Repo, workspace root

**History store**:
The capability that keeps session history beyond the process.
_Avoid_: Storage, database, persistence

**Credential store**:
The capability that keeps credentials and hands them to the Providers and tool sources that need them.
_Avoid_: Secrets manager, keychain

## Units of work

**Session**:
Exchanges, turns and jobs that share a history. Owned by the Harness.
_Avoid_: Conversation, thread, context

**Ephemeral session**:
A session with no history store. Its history is gone when the process stops.

**Exchange**:
Everything the agent does in response to one input from an actor: one or more turns, including restarts, retries, goal continuations and turns started when a job reports back.
_Avoid_: Run (T3 Code's word for it), request, interaction

**Turn**:
The agent working until it has nothing more to do for now, or it stops. Waiting for an answer is part of a turn, not its end. Owned by the Runtime.
_Avoid_: Run, agent run, task, prompt turn

**Step**:
One model request and its response, or one stretch of a live session, plus the tool calls it asks for.
_Avoid_: Turn (Pi's word for it), iteration

**Outcome**:
How a turn ended: completed, cancelled, failed, or stopped at a limit.
_Avoid_: Stop reason, status

**Result**:
What a turn returns to whoever started it: text, structured data, or the tool calls still open.
_Avoid_: Output, return value, final answer

**Job**:
Work a session owns that runs outside any turn and can outlive the turn that started it, such as a background command, a subagent or a remote task.
_Avoid_: Task (A2A's word for a turn), background task, activity

**Live session**:
A model connection where input and output flow both ways at once, such as voice.
_Avoid_: Realtime session, stream

## Tools

**Tool definition**:
A tool's name, description, the input it takes, and hints about its effects.
_Avoid_: Tool schema

**Tool call**:
A request from the model to run a named tool with some input.
_Avoid_: Function call, tool use

**Tool result**:
The single outcome of one tool call: what the model sees, and whether it completed, failed, was refused, was cancelled, never started, or has an unknown outcome. It can arrive after the call's turn has ended.

**Open tool call**:
A tool call still waiting for its result after its turn has ended.
_Avoid_: Deferred tool call (Pydantic AI's term), pending call

## Context

**History**:
The record of a session, a tree of entries that grows in normal use. It includes entries the model never sees. It is deleted only by retention or erasure.
_Avoid_: Memory, transcript, log

**History entry**:
One item in a history, such as an input, a model response, a tool result, a summary or a setting change.

**Current position**:
The history entry a session is at. Rewinding and branching move it, and the move is recorded.
_Avoid_: Head, cursor

**Model context**:
What the model sees on one step: a view worked out from the history on the current branch, plus whatever a Provider keeps or adds.
_Avoid_: Prompt, context window (that is the size limit)

**Compaction**:
Adding a summary of older history so the model context fits. It changes the view, not the history.
_Avoid_: Truncation, pruning

**Erasure**:
Deleting content from history and every copy the agent controls when deletion is required, leaving a record that it happened.
_Avoid_: Deletion (too general), purge

**Retention**:
How long a history store keeps a session's history.

**Model access**:
What the Runtime is given so it can make model requests to the chosen model, without the credentials.
_Avoid_: Provider handle (our earlier name), client, API key

## Stepping in

**Hook point**:
A moment in an operation where plugins can observe, change or stop it. Whoever owns the operation defines it.
_Avoid_: Callback, middleware, interceptor

**Hook handler**:
A plugin's response at one hook point.
_Avoid_: Hook (unclear whether it means the point or the handler)

**Provider middleware**:
Hook points inside a Provider, around the model request itself.

**Output gate**:
The hook point before output reaches a recipient, where it can be let through, redacted or blocked.
_Avoid_: Output filter, post-processing

**Event**:
A report that something happened. It can't change what happened.
_Avoid_: Notification, message

**Command**:
An instruction a user gives through an Interface, such as `/model` or `/compact`, that a plugin carries out without involving the model.
_Avoid_: Slash command (one form of it), tool

## Actors

**Actor**:
Whoever acts on the agent: a user, another agent, a host or a program such as a scheduler. Every input, answer and approval records its actor.
_Avoid_: Principal, caller, participant

**User**:
A person acting on the agent through an Interface. One kind of actor.
_Avoid_: Human, operator, person

**Host**:
A system outside this one that drives whole agents, such as T3 Code. It is an actor of this agent.
_Avoid_: Orchestrator, coordinator

**Authority**:
What an actor may do in a session, under limits that only narrow from administrator to tenant to session to actor.
_Avoid_: Permissions, access level, runtime mode

**Input request**:
A request for something only an actor can give: an approval, an answer, a choice, a sign-in or a secret. It says who may answer it and how.
_Avoid_: Prompt, dialog, interrupt, elicitation

**Approval**:
An input request that decides whether one tool call may run. Only an explicit "allow" lets it run.
_Avoid_: Permission request, confirmation

**Approval policy**:
A session setting that says when approval is asked for, including "never ask", which refuses every approval without asking.
_Avoid_: Permission mode, runtime mode

**Subagent**:
An agent started by another agent's job to do a task, with its own session that belongs to the parent's.
_Avoid_: Child agent, delegate, worker

**Peer**:
Another agent this one can message, with no parent relationship.
_Avoid_: Teammate, sibling

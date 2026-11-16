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

## Capabilities

**Runtime**:
The capability that runs turns.
_Avoid_: Core, agent core, agent loop, engine

**Transient Runtime**:
A Runtime whose turn ends if its process stops.

**Durable Runtime**:
A Runtime that can carry on with a turn after its process stops and starts again.

**Provider**:
The capability that makes one model, or one vendor's models, available.
_Avoid_: Model, LLM, inference layer

**Interface**:
The capability that lets someone or something outside use the agent, such as a terminal UI, an editor, another agent or a webhook.
_Avoid_: Frontend, client, UI (each is too narrow)

**Tool source**:
The capability that offers tools and runs them, such as built-in tools, an MCP server or another agent.
_Avoid_: Toolset, tool provider

**History store**:
The capability that keeps session history.
_Avoid_: Storage, database, persistence

**Credential store**:
The capability that keeps credentials and hands them to the Providers and tool sources that need them.
_Avoid_: Secrets manager, keychain

## Units of work

**Session**:
One or more turns that share a history. Owned by the Harness.
_Avoid_: Conversation, thread, context

**Turn**:
The agent working on something until it can't continue without outside input, or it stops. Owned by the Runtime.
_Avoid_: Run, agent run, task, prompt turn

**Step**:
One model request and its response, plus the tool calls the response asks for.
_Avoid_: Turn (Pi's word for it), iteration

**Outcome**:
How a turn ended: completed, cancelled, failed, or stopped at a limit.
_Avoid_: Stop reason, status

## Tools

**Tool definition**:
A tool's name, description, the input it takes, and hints about its effects.
_Avoid_: Tool schema

**Tool call**:
A request from the model to run a named tool with some input.
_Avoid_: Function call, tool use

**Tool result**:
The single outcome of one tool call: what the model sees, and whether it completed, failed, was refused, was cancelled, never started, or has an unknown outcome.

## Context

**History**:
The complete record of a session, which only grows. It includes entries the model never sees.
_Avoid_: Memory, transcript, log

**History entry**:
One item in a history, such as an input, a model response, a tool result, a summary or a setting change.

**Model context**:
What the model sees on one step: a view worked out from the history before that step.
_Avoid_: Prompt, context window (that is the size limit)

**Compaction**:
Adding a summary of older history so the model context fits, without removing anything from the history.
_Avoid_: Truncation, pruning

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

**Event**:
A report that something happened. It can't change what happened.
_Avoid_: Notification, message

**Command**:
An instruction a user gives through an Interface, such as `/model` or `/compact`, that a plugin carries out without involving the model.
_Avoid_: Slash command (one form of it), tool

## The user

**User**:
The person using the agent through an Interface.
_Avoid_: Human, operator, person

**Input request**:
A request for something only the user can give: an approval, an answer, a choice, a sign-in or a secret. It is tied to a tool call when there is one.
_Avoid_: Prompt, dialog, interrupt, elicitation

**Approval**:
An input request that decides whether one tool call may run. Only an explicit "allow" lets it run.
_Avoid_: Permission request, confirmation

**Approval policy**:
A session setting that says when approval is asked for, including "never ask", which refuses every approval without asking.
_Avoid_: Permission mode, runtime mode

**Subagent**:
An agent started by another agent to do a task, with its own session that belongs to the parent's.
_Avoid_: Child agent, delegate, worker

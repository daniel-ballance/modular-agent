# Contracts: what passes between the parts

**Status:** draft, revised 2026-11-16 after the [pressure test](pressure-test/synthesis.md). Everything here is **proposed** unless a decision is linked.

[Architecture](architecture.md) says what each part is responsible for. This document says what passes between the parts: the information each interaction carries, the answers it can get, and the states things move through. It should be detailed enough to build the system in any form: one process with function calls, separate processes over RPC, or services over a network.

It does not say how anything is sent. There are no signatures, message formats or transports here ([ADR 0010](adr/0010-describe-parts-not-wiring.md)). "Asks" means one part depends on another for an answer. A function call, an RPC request or an HTTP call can all satisfy it.

**Every request between parts can go unanswered** when a process stops or a connection drops. Each interaction below says what the asker assumes then.

## Information

These are the things that pass between parts, and what each contains. A field marked *(optional)* may be missing.

### Content

Content is an ordered list of typed parts. Every message, tool result and answer carries content.

| Part type | Contains |
|---|---|
| text | the text |
| image, audio, file | the data or a reference to it, its media type, a name *(optional)* |
| reasoning | the model's reasoning text, or a value only its Provider can read |
| tool call | see [Tool call](#tool-call) |
| other | anything else, such as an MCP Apps UI or A2UI data, with its type |

A part of a type that a receiver doesn't understand is kept and passed on intact, unless policy forbids passing it on. Which types every part must understand is [open](open-questions.md#content-model).

### Actor

| Contains | Notes |
|---|---|
| identity | |
| kind | user, agent, host, or program (such as a scheduler or webhook) |
| tenant *(optional)* | |
| authority in this session | what it may do: watch, propose input, give input, answer requests, approve, change settings, erase |

### Session

| Contains | Notes |
|---|---|
| identity | |
| settings | model and reasoning level, approval policy, limits and budgets, and any setting a plugin adds |
| actors | at least one. Several only when the agent supports it. |
| the active plugins | |
| current position | where the session is in its tree of history entries |
| its history | |
| retention | how long its history is kept, or ephemeral |
| its jobs | |
| where it came from *(optional)* | the session and point it was forked from, or the parent session if it belongs to a subagent |

### Exchange

| Contains | Notes |
|---|---|
| identity | |
| the input that started it, and its actor | |
| its turns | one or more |
| its jobs | the jobs started during it |
| state | running, waiting, or done |

### History entry

| Contains | Notes |
|---|---|
| identity | |
| the entry before it | History is a tree. An entry follows one earlier entry. |
| the session, and the exchange, turn, step, tool call and job it belongs to *(where they apply)* | |
| who wrote it | which part or plugin, and for which actor |
| when | |
| kind | input, model response, tool call, tool result, summary, setting change, position change, approval record, erasure record, plugin state, … |
| whether the model sees it | Plugin state, approval records and erasure records are kept for the record only. |
| content | Removed by erasure; the entry then says it was erased. |

### Tool definition

| Contains | Notes |
|---|---|
| name | unique among the tools a session can use ([open](open-questions.md#how-many-of-each-capability) what happens on a clash) |
| description | for the model |
| the input it takes | a schema |
| what it returns *(optional)* | a schema |
| hints | read-only, destructive, safe to repeat, reaches outside the system. These are hints, not promises. |
| whether it may run alongside other calls | |
| who may call it | the model, a UI, a plugin |
| how to show it *(optional)* | for Interfaces, including a UI it brings (as MCP Apps do) |

A tool can be registered without the model being told about it. The tools a plugin offers, the tools the model is told about, and the tools a call may use can differ ([plugin API](architecture.md#what-plugins-can-do)).

### Tool call

| Contains | Notes |
|---|---|
| identity | |
| the tool's name | |
| its input | |
| who started it | the model, the Provider (it ran the call itself), a UI, a plugin, or another tool call |
| the actor it acts for | |
| the step that asked for it *(optional)* | missing for calls a UI or plugin started outside a turn |

### Tool result

| Contains | Notes |
|---|---|
| the tool call it answers | |
| status | completed, failed, refused, cancelled, not started, outcome unknown |
| content | what the model will see. A refused call explains why. |
| structured value *(optional)* | for other tools and programs |
| how to show it *(optional)* | for Interfaces |

A tool call may stay open past its turn. It still ends with exactly one result.

### Model access

What the Runtime is given so it can use the chosen model. **Decided** ([ADR 0005](adr/0005-provider-handles-from-the-harness.md)).

| Contains | Notes |
|---|---|
| which model, and its limits | context window, output limit, accepted input types, reasoning levels |
| a way to use the model | Credentials are not included. The Provider gets them itself. |
| what the Provider supports | its [declaration](#declaration): whether it keeps state, runs tools itself, offers live sessions or answers later |

### Model request and response

The usual shape: one request, one response.

| Model request contains | Model response contains |
|---|---|
| the model context: system prompt and messages | content: text, reasoning, tool calls |
| the tool definitions the model may use | tool calls the Provider ran itself, with their results *(optional)* |
| whether the Provider may run tools itself, and which | why it stopped: finished, wants tool calls, reached the output limit, refused, failed |
| settings: reasoning level, output limit, and others the model accepts | usage |

The response arrives piece by piece as the model produces it, then complete.

A Provider that keeps state may use what it already holds as well as what it is sent. It reports when it has discarded that state, and anything it added to the context.

A failed request says why: a temporary problem worth retrying, the context is too large, the credentials were refused, or the model refused. If no answer comes at all, the Runtime assumes the request may have been accepted. Repeating it is safe only when the Provider keeps no state and runs no tools.

The other two shapes:
- **A live session,** such as voice. Input and output flow both ways at the same time. Either side can interrupt. The Provider may decide when a speaker has finished. Each stretch between turn-taking points is a step, with its tool calls and usage.
- **A late answer,** such as a batch request. The request is accepted, and its answer arrives later, possibly after the turn. Waiting for it is a job.

### Turn input and turn outcome

| Turn input | Turn outcome |
|---|---|
| the session and exchange | how it ended: completed, cancelled, failed (with the error), or stopped at a limit (which one) |
| the input, and its actor | the result: text, structured data, or the tool calls still open |
| the tools the model may use | the history entries the turn produced |
| model access | usage |
| settings and limits | open input requests *(if any)* |
| the shape the result must have *(optional)* | |

### Job

| Contains | Notes |
|---|---|
| identity | |
| kind | such as background command, watcher, subagent, workflow, remote task, late model answer |
| the session and exchange it belongs to, and the plugin that started it | |
| the actor it acts for | |
| state | see [Lifecycles](#lifecycles) |
| progress *(optional)* | |
| result | when it ends |
| usage | counts toward the session's limits and budgets |

### Event

An event says that something happened. It can't change what happened.

| Contains |
|---|
| what happened |
| when |
| the session, and the exchange, turn, step, tool call and job it belongs to |
| which part or plugin reported it, and for which actor |
| content *(optional)* |

The standard events:

| Event | Notes |
|---|---|
| session started, joined, left, ended | joined and left are for sessions with several actors |
| input accepted, withdrawn | accepted says when it will be taken: now, in the running turn, or after it. Accepting input does not mean the model has seen it. |
| exchange started, exchange ended | |
| turn started, turn ended | turn ended carries the outcome and result |
| step started, step ended | step ended carries usage |
| model output arriving | text, reasoning, audio, or a tool call's input, as it is produced. Live only, not kept in history. |
| tool call requested, started, progress, ended | |
| input request opened, answered, closed, no longer answerable | |
| job started, progress, ended | |
| history entry added, position moved, entries erased | |
| setting changed | such as the model. Says from which step it applies. |
| plugin loaded, replaced, unloaded | |

Plugins can report events of their own.

### Input request and answer

An input request asks for something only an actor can give.

| Input request contains | Notes |
|---|---|
| identity | |
| kind | approval, choice, free text, sign-in link, secret |
| what is asked, and details to help decide | |
| options *(for approval and choice)* | Approval options are at least "allow" and "refuse". "Always allow" is an option only when the asker can honour it. |
| the tool call it is tied to *(optional)* | |
| the session and agent asking | |
| who may answer | which actors, such as the user, the parent agent, or a program |
| how it can be answered | now, while something waits for it; later, as the tool call's result; or no longer |
| a time limit *(optional)* | |

| Answer contains |
|---|
| the request it answers |
| the value, or "declined" |
| the actor who answered |

### Declaration

What a part supports. Runtimes, Providers, working environments and the agent as a whole each declare it, and declare it again if it changes.

| Feature | Declared by |
|---|---|
| taking input during a turn | Runtime |
| waiting for an answer through a restart | Runtime |
| continuing a turn after a restart | Runtime |
| rewinding, forking | Runtime, Provider, working environment |
| keeping conversation state | Provider |
| running tools itself, and which | Provider |
| live sessions, late answers | Provider |
| several actors in one session | the agent |
| starting turns nobody asked for, and why | the agent |
| which hook points it offers beyond the standard set | Runtime, plugins |

For each feature a part lacks, [Architecture](architecture.md#declared-support) says what happens instead.

### Usage

Input tokens, output tokens, cached tokens, audio time where it applies, and cost where known. Reported for each step and job, and totalled for each turn, exchange, session and, where budgets apply, tenant.

## Interactions

Each interaction is listed by who asks, what it carries, and the possible answers. Every ask from an Interface carries the actor it acts for, and is refused if the actor lacks the authority.

### Interface and Harness

An Interface is a plugin, so these are things it does through the plugin API.

| Interface asks | Carrying | Answers |
|---|---|---|
| what does this agent support? | | the agent's [declaration](#declaration) |
| start a session | settings *(optional)*, a session and point to fork from *(optional)* | the session |
| list sessions, open a session, join a session | | sessions; the session and its history |
| give input | the session, the content, when to take it (now, in the running turn, after it), a key so repeating it has no further effect *(optional)* | accepted, with when it will be taken; or refused. Unanswered: the Interface may repeat it with the same key. |
| withdraw input | the input | withdrawn, with its content; or too late, already taken |
| cancel | the session | the turn ends as cancelled |
| move to a point | the session, the entry to move to | moved; or refused, with which part can't rewind |
| list commands, run a command | the command and its arguments | the command's result, or an error |
| follow a session | the session, and a point to start from | its history from that point, as this actor may see it, then its events as they happen |
| answer an input request | the [answer](#input-request-and-answer) | accepted; or the request can no longer be answered |
| list jobs, cancel a job | the session; the job | jobs; the job ends as cancelled |
| erase | what to erase | erased, with any copies out of reach; or refused |

| Harness tells the Interface | Carrying |
|---|---|
| an input request opened | the [input request](#input-request-and-answer). Only Interfaces acting for an actor who may answer it are told. |
| an event happened | the [event](#event), after the output gate |

### Harness and Runtime

**Decided** ([ADR 0006](adr/0006-hook-points-belong-to-the-operation-owner.md)), except the details.

| Harness asks the Runtime | Carrying | Answers |
|---|---|---|
| what do you support? | | its [declaration](#declaration) |
| run a turn | the [turn input](#turn-input-and-turn-outcome) | the [turn outcome](#turn-input-and-turn-outcome). Unanswered: the Harness treats the turn as ended with an unknown outcome, unless the Runtime is durable. |
| cancel the turn | the turn | the turn ends as cancelled |
| take this input in the running turn | the content | taken, or refused ([open](open-questions.md#input-during-a-turn)) |
| rewind to a point | the history entry | rewound, or refused before anything changes |

| Runtime asks the Harness | Carrying | Answers |
|---|---|---|
| run this tool call | the [tool call](#tool-call) | progress, then the [tool result](#tool-result); or "still open" if the call waits past the turn. Unanswered: the outcome is unknown. |
| let plugins step in | the hook point and what is at stake (see [hook points](#hook-points)) | the plugins' combined answer |

| Runtime tells the Harness | Carrying |
|---|---|
| this happened | an [event](#event) |

### Runtime and Provider

Through the [model access](#model-access) it was given:

| Runtime asks | Carrying | Answers |
|---|---|---|
| make a model request | the [model request](#model-request-and-response) | the response as it arrives, then complete; or a failure and why; or, for a late answer, "accepted" |
| open a live session | the model context and settings | a session that carries input and output both ways until either side closes it |
| cancel | the request or live session | cancelled; or already finished |
| discard your state | the session | discarded; or "I keep none" |

### Harness and tool source

| Harness asks | Carrying | Answers |
|---|---|---|
| which tools do you offer? | | [tool definitions](#tool-definition). A tool source says when its list changes. |
| run this call | the [tool call](#tool-call), and a way to cancel it | progress, then the [tool result](#tool-result). Unanswered: outcome unknown. |

### Harness and working environment

| Harness asks | Carrying | Answers |
|---|---|---|
| what do you support? | | its [declaration](#declaration) |
| run a command; read or write a file | what to do | the result; or failed; or "environment lost" |
| save this point; return to a saved point | the point | saved; returned; or refused |

Tools use the working environment through the Harness, so swapping the environment moves every tool.

### Harness and history store

| Harness asks | Carrying | Answers |
|---|---|---|
| keep these entries | the session, the [history entries](#history-entry) | kept safely; or failed |
| give me this session's history | the session, a point to start from *(optional)* | the entries |
| list sessions | filters *(optional)* | sessions |
| open a session for writing | the session | opened; or refused because it is already open elsewhere |
| erase | the session, what to erase | erased, including summaries and forks it holds; with an erasure record left in place |

### Provider, tool source or working environment and credential store

| Asks | Carrying | Answers |
|---|---|---|
| give me this credential | which credential | the credential; or "sign-in needed", which the credential store turns into an [input request](#input-request-and-answer) |

### Plugin and Harness: jobs

| Plugin asks | Carrying | Answers |
|---|---|---|
| start a job | the session, its kind, the actor | the [job](#job) |
| report on a job | progress or result | recorded. A result may start a turn in the job's exchange. |

The Harness can ask the plugin to cancel a job. Its answer is "cancelled", or the job's result if it had already finished.

## Hook points

Whoever owns an operation defines its hook points, including plugins ([ADR 0006](adr/0006-hook-points-belong-to-the-operation-owner.md)). Every Runtime offers the same standard set.

| Owner | Hook point | Plugins are given | Plugins can answer |
|---|---|---|---|
| Harness | plugin about to load | the plugin and the project | allow or refuse |
| Harness | session starts, joined, left, ends | the session and actor | nothing: observe only |
| Harness | input arrives | the input and its actor | pass it on; change it; or handle it, so it never reaches the model |
| Harness | exchange starts, ends | the exchange | nothing: observe only |
| Harness | before a turn | the session and the input | additions to the system prompt and the context |
| Harness | before output reaches a recipient | the output and the recipient | let it through, redact it, or block it |
| Runtime | turn starts | the turn input | nothing: observe only |
| Runtime | before each step | the history so far, usage so far, the model's limits | the model context for this step; the tools the model may use; whether the Provider may run tools itself |
| Runtime | after each step | the model response, including tools the Provider ran | continue or end the turn |
| Runtime | before a tool call | the tool call and its definition | allow it; refuse it, with a reason; or allow it with changed input |
| Runtime | after a tool call | the tool call and its result | keep the result, or replace it |
| Runtime | a model request failed | the request and why it failed | retry, perhaps after changing something such as the context; or let it fail |
| Runtime | the turn's result is ready | the result and the shape it must have | accept it; or send the model back with a reason |
| Runtime | turn ends | the outcome | nothing: observe only |
| Provider | before a model request | the request | a changed request |
| Provider | as the response arrives | each piece | nothing: observe only |

"Before a tool call" also applies to calls a UI or plugin starts. Tools a Provider runs itself can't be stopped one by one; they are allowed or refused before the request.

When several plugins handle one hook point, these rules are **proposed**:
- A refusal wins. If any plugin refuses a tool call or blocks output, it does not go ahead.
- Changes are applied one after another, each plugin seeing the result of the one before. The order is [open](open-questions.md#how-handlers-combine).
- If a plugin fails while handling a gate, the operation is refused.

## Lifecycles

### Exchange

```
started ──► running ──► waiting ──► running ──► done
```

It is waiting while no turn runs but a tool call it opened is still open, or a job it started may report back. When an exchange ends while a job it started keeps running is [open](open-questions.md#work-outside-a-turn).

### Turn

```
started ──► running ──► waiting for an answer ──► running ──► ended
```

A turn ends with one outcome: completed, cancelled, failed, or stopped at a limit. A turn that stops waiting before its answer arrives ends with the tool call still open.

### Tool call

```
requested ──► waiting for approval ──► running ──► completed | failed
                    │                     │  │
                    └──► refused          │  └──► cancelled
                                          └──► open past its turn ──► one result, later
```

A call interrupted by a stopped process ends as **not started** or **outcome unknown**. A call the Provider ran itself arrives already ended. Every tool call ends with exactly one result.

### Input request

```
open ──► answered | declined | cancelled
  │
  ├──► waiting past its turn (the answer becomes the tool call's result)
  └──► no longer answerable (the asker is gone)
```

### Job

```
started ──► running ──► completed | failed | cancelled
               │
               └──► outcome unknown (its process or working environment was lost)
```

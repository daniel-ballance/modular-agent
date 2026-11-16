# Contracts: what passes between the parts

**Status:** draft, revised 2026-11-16 after two rounds of [pressure testing](pressure-test/README.md). Everything here is **proposed** unless a decision is linked.

[Architecture](architecture.md) says what each part is responsible for. This document says what passes between the parts: the information each interaction carries and the answers it can get. It should be detailed enough that two implementations built from it can be swapped without breaking a plugin or a host. How each part behaves inside is left to [implementation](research/implementation-concerns.md).

It does not say how anything is sent. There are no signatures, message formats or transports here ([ADR 0010](adr/0010-describe-parts-not-wiring.md)). "Asks" means one part depends on another for an answer. A function call, an RPC request or an HTTP call can all satisfy it.

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

The record keeps every part as it arrived, including types nobody understands. What a recipient receives is a view, which may leave parts out ([Who sees what](architecture.md#who-sees-what)). Which types every part must understand is [open](open-questions.md#content-model).

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
| current position | the entry the session is at in its tree of history entries |
| its history | |
| retention | how long its history is kept, or ephemeral |
| its jobs | |
| where it came from *(optional)* | the session and point it was forked from, or the parent session if it belongs to a subagent |

### History entry

| Contains | Notes |
|---|---|
| identity | |
| the entry before it | History is a tree. An entry follows one earlier entry. |
| the session, and the turn, step, tool call and job it belongs to *(where they apply)* | |
| who wrote it | which part or plugin, and for which actor |
| when | |
| kind | input, model response, tool call, tool result, summary, setting change, position move, approval record, erasure record, plugin state, … |
| whether the model sees it | Plugin state, approval records and erasure records are kept for the record only. |
| content | Removed by erasure. The entry then becomes an erasure record. |

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

A tool can be available without the model being told about it.

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

Every tool call ends with exactly one result, even if it arrives after its turn. An approval is not a result.

### Model access

What the Runtime is given so it can use the chosen model. **Decided** ([ADR 0005](adr/0005-provider-handles-from-the-harness.md)).

| Contains | Notes |
|---|---|
| which model, and its limits | context window, output limit, accepted input types, reasoning levels |
| a way to use the model | Credentials are not included. The Provider gets them itself. |
| what the Provider supports | whether it keeps state, runs tools itself, offers live sessions or answers later |

### Model request and response

The usual shape: one request, one response.

| Model request contains | Model response contains |
|---|---|
| the model context: system prompt and messages | content: text, reasoning, tool calls |
| the tool definitions the model may use | tool calls the Provider ran itself, with their results *(optional)* |
| whether the Provider may run tools itself, and which | why it stopped: finished, wants tool calls, reached the output limit, refused, failed |
| settings: reasoning level, output limit, and others the model accepts | usage |

The response arrives piece by piece as the model produces it, then complete. A failed request says why: a temporary problem worth retrying, the context is too large, the credentials were refused, or the model refused.

The other two shapes:
- **A live session,** such as voice. Input and output flow both ways at the same time, and either side can interrupt. Each stretch between turn-taking points is a step, with its tool calls and usage.
- **A late answer,** such as a batch request. The request is accepted, and its answer arrives later. Waiting for it is a job.

### Turn input and turn outcome

| Turn input | Turn outcome |
|---|---|
| the session | how it ended: completed, cancelled, failed (with the error), or stopped at a limit (which one) |
| the input, and what started the turn: an actor, a job's report, or a plugin | the result: text, structured data, or the tool calls still open |
| the tools the model may use | the history entries the turn produced |
| model access | usage |
| settings and limits | open input requests *(if any)* |
| the shape the result must have *(optional)* | |

### Job

| Contains | Notes |
|---|---|
| identity | |
| kind | such as background command, watcher, subagent, remote task, late model answer |
| the session it belongs to, the turn that started it, and the plugin that runs it | |
| the actor it acts for | |
| state | running, completed, failed, cancelled, or outcome unknown |
| result | when it ends |
| usage | counts toward the session's limits and budgets |

### Event

An event says that something happened. It can't change what happened.

| Contains |
|---|
| what happened |
| when |
| the session, and the turn, step, tool call and job it belongs to |
| which part or plugin reported it, and for which actor |
| content *(optional)* |

The standard events:

| Event | Notes |
|---|---|
| session started, joined, left, ended | joined and left are for sessions with several actors |
| input accepted, withdrawn | accepted says when it will be taken: now, in the running turn, or after it |
| turn started, turn ended | turn ended carries the outcome and result |
| step started, step ended | step ended carries usage |
| model output arriving | text, reasoning, audio, or a tool call's input, as it is produced. Live only, not kept in history. |
| tool call requested, started, progress, ended | |
| input request opened, answered, closed, no longer answerable | |
| job started, progress, ended | |
| history entry added, position moved, entries erased | |
| setting changed | such as the model |
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
| who may answer | which actors, such as the user, the parent agent, or a program. They must be within the authority the asker has. |
| whether it can still be answered | |
| a time limit *(optional)* | |

| Answer contains |
|---|
| the request it answers |
| the value, or "declined" |
| the actor who answered |

The first accepted answer closes the request. An answer to a secret request goes only to the credential store.

### Declaration

What the session, as set up, supports. The agent declares it, and declares it again if it changes. It covers each feature in [Declared support](architecture.md#declared-support), and any hook points offered beyond the standard set.

### Usage

Input tokens, output tokens, cached tokens, audio time where it applies, and cost where known. Reported for each step and job, and totalled for each turn, session and, where budgets apply, tenant.

## Interactions

Each interaction is listed by who asks, what it carries, and the possible answers. Every ask from an Interface carries the actor it acts for, and is refused if the actor lacks the authority.

### Interface and Harness

An Interface is a plugin, so these are things it does through the plugin API.

| Interface asks | Carrying | Answers |
|---|---|---|
| what does this agent support? | | the session's [declaration](#declaration) |
| start a session | settings *(optional)*, a session and point to fork from *(optional)* | the session |
| list sessions, open a session, join a session | | sessions; the session and its history |
| give input | the session, the content, when to take it (now, in the running turn, after it), a key *(optional)* | accepted, with when it will be taken; or refused. Input with a key already taken returns the earlier answer, and is not taken again. |
| withdraw input | the input | withdrawn, with its content; or too late, already taken |
| cancel | the session | the running turn ends as cancelled. Its jobs keep running. Input queued for the turn or after it is handed back to the Interface, with its content. |
| move to a point | the session, the entry to move to, whether to rewind outside state too | moved; or refused, saying which part can't rewind |
| list commands, run a command | the command and its arguments | the command's result, or an error |
| follow a session | the session, and a point to start from | its history from that point, as this actor may see it, then its events as they happen |
| answer an input request | the [answer](#input-request-and-answer) | accepted; or refused because it is already closed, no longer answerable, or the actor may not answer it |
| list jobs, cancel a job | the session; the job | jobs; the job ends as cancelled |
| erase | what to erase | erased, listing any copies out of reach; or refused |

| Harness tells the Interface | Carrying |
|---|---|
| an input request opened | the [input request](#input-request-and-answer), to Interfaces whose actor may see it. Only those whose actor may answer it can answer. |
| an event happened | the [event](#event), after the output gate |

### Harness and Runtime

**Decided** ([ADR 0006](adr/0006-hook-points-belong-to-the-operation-owner.md)), except the details.

| Harness asks the Runtime | Carrying | Answers |
|---|---|---|
| what do you support? | | what it supports |
| run a turn | the [turn input](#turn-input-and-turn-outcome) | the [turn outcome](#turn-input-and-turn-outcome) |
| cancel the turn | the turn | the turn ends as cancelled |
| take this input in the running turn | the content | taken, or refused ([open](open-questions.md#input-during-a-turn)) |
| rewind to a point | the history entry | rewound, or refused before anything changes |

| Runtime asks the Harness | Carrying | Answers |
|---|---|---|
| run this tool call | the [tool call](#tool-call) | progress, then the [tool result](#tool-result); or "still open" if the call waits past the turn. If no answer comes, the outcome is unknown. |
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
| run this call | the [tool call](#tool-call), and a way to cancel it | progress, then the [tool result](#tool-result). If no answer comes, the outcome is unknown. |

### Harness and working environment

| Harness asks | Carrying | Answers |
|---|---|---|
| run a command; read or write a file | what to do | the result; or failed; or "environment lost" |
| save this point; return to a saved point | the point | saved; returned; or refused |

### Harness and history store

| Harness asks | Carrying | Answers |
|---|---|---|
| keep these entries | the session, the [history entries](#history-entry) | kept safely; or failed |
| give me this session's history | the session, a point to start from *(optional)* | the entries |
| list sessions | filters *(optional)* | sessions |
| open a session for writing | the session | opened; or refused because it is already open elsewhere |
| erase | the session, what to erase | erased, including summaries and forks it holds, with erasure records left in place; or not supported |

### Asking the credential store

| Asks | Carrying | Answers |
|---|---|---|
| give me this credential | which credential | the credential; or "sign-in needed", which the credential store turns into an [input request](#input-request-and-answer) |

Providers, tool sources and working environments ask. The Runtime never does.

### Plugin and Harness: jobs

| Plugin asks | Carrying | Answers |
|---|---|---|
| start a job | the session, its kind, the actor | the [job](#job) |
| report on a job | progress or result | recorded. A result enters the session as input, and may start a turn. |

The Harness can ask the plugin to cancel a job. Its answer is "cancelled", or the job's result if it had already finished.

## Hook points

Whoever owns an operation defines its hook points, including plugins ([ADR 0006](adr/0006-hook-points-belong-to-the-operation-owner.md)). Every Runtime offers the same standard set.

| Owner | Hook point | Plugins are given | Plugins can answer |
|---|---|---|---|
| Harness | plugin about to load | the plugin and the project | allow or refuse |
| Harness | session starts, joined, left, ends | the session and actor | nothing: observe only |
| Harness | input arrives | the input and its actor | pass it on; change it; or handle it, so it never reaches the model |
| Harness | before a turn | the session and the input | additions to the system prompt and the context |
| Harness | before output reaches a recipient | the output and the recipient | let it through, redact it, block it, or hold it until more arrives |
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

"Before a tool call" also applies to calls a UI or plugin starts. Tools a Provider runs itself can't be stopped one by one. They are allowed or refused before the request.

When several plugins handle one hook point, the hook point's owner fixes one rule for combining their answers. **Decided** ([open questions](open-questions.md#settled)). The rules are:
- **observe:** every handler sees it, and answers are ignored.
- **gate:** handlers answer in turn. A refusal wins and stops the rest. A handler may allow with changed input, and later handlers see the change. A handler that fails counts as a refusal.
- **transform:** each handler gets the previous handler's result and may change it. A handler may also stop the chain, as when input is handled as a command.
- **first answer:** the first handler that answers decides.
- **collect:** every handler's contribution is gathered.

Handlers run in the order their plugins were loaded. A plugin can ask to run first or last.

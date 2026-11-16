# Contracts: what passes between the parts

**Status:** draft, 2026-11-16. Everything here is **proposed** unless a decision is linked.

[Architecture](architecture.md) says what each part is responsible for. This document says what passes between the parts: the information each interaction carries, the answers it can get, and the states things move through. It should be detailed enough to build the system in any form: one process with function calls, separate processes over RPC, or services over a network.

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

A part of a type that a receiver doesn't understand is kept and passed on intact. Which types every part must understand is [open](open-questions.md#content-model).

### Session

| Contains | Notes |
|---|---|
| identity | |
| settings | model and reasoning level, approval policy, limits, and any setting a plugin adds |
| the active plugins | |
| its history | |
| where it came from *(optional)* | the session and point it was forked from, or the parent session if it belongs to a subagent |

### History entry

| Contains | Notes |
|---|---|
| identity | |
| the session, and the turn, step and tool call it belongs to *(where they apply)* | |
| who wrote it | which part or plugin |
| when | |
| kind | user input, model response, tool call, tool result, summary, setting change, approval record, plugin state, … |
| whether the model sees it | Plugin state and approval records are kept for the record only. |
| content | |

### Tool definition

| Contains | Notes |
|---|---|
| name | unique among the tools a session can use ([open](open-questions.md#how-many-of-each-capability) what happens on a clash) |
| description | for the model |
| the input it takes | a schema |
| what it returns *(optional)* | a schema |
| hints | read-only, destructive, safe to repeat, reaches outside the system. These are hints, not promises. |
| whether it may run alongside other calls | |
| how to show it *(optional)* | for Interfaces |

### Tool call

| Contains |
|---|
| identity |
| the tool's name |
| its input |
| the step that asked for it |
| the tool call that made it *(optional)*, when one tool calls another |

### Tool result

| Contains | Notes |
|---|---|
| the tool call it answers | |
| status | completed, failed, refused, cancelled, not started, outcome unknown |
| content | what the model will see. A refused call explains why. |
| structured value *(optional)* | for other tools and programs |
| how to show it *(optional)* | for Interfaces |

### Model access

What the Runtime is given so it can make model requests. **Decided** ([ADR 0005](adr/0005-provider-handles-from-the-harness.md)).

| Contains | Notes |
|---|---|
| which model, and its limits | context window, output limit, accepted input types, reasoning levels |
| a way to make model requests | Credentials are not included. The Provider gets them itself. |

### Model request and response

| Model request contains | Model response contains |
|---|---|
| the model context: system prompt and messages | content: text, reasoning, tool calls |
| the tool definitions | why it stopped: finished, wants tool calls, reached the output limit, refused, failed |
| settings: reasoning level, output limit, and others the model accepts | usage |

The response arrives piece by piece as the model produces it, then complete.

A failed request says why: a temporary problem worth retrying, the context is too large, the credentials were refused, or the model refused.

### Turn input and turn outcome

| Turn input | Turn outcome |
|---|---|
| the session | how it ended: completed, cancelled, failed (with the error), or stopped at a limit (which one) |
| the input | the history entries the turn produced |
| the tools available | usage |
| model access | open input requests *(if any)* |
| settings and limits | |

### Event

An event says that something happened. It can't change what happened.

| Contains |
|---|
| what happened |
| when |
| the session, and the turn, step and tool call it belongs to |
| which part or plugin reported it |
| content *(optional)* |

The standard events:

| Event | Notes |
|---|---|
| session started, session ended | |
| input accepted | including when it will be taken: now, in the running turn, or after it |
| turn started, turn ended | the turn ended event carries the outcome |
| step started, step ended | the step ended event carries usage |
| model output arriving | text, reasoning, or a tool call's input, as it is produced. These are live only and are not kept in history. |
| tool call requested, started, progress, ended | |
| input request opened, answered, closed | |
| history entry added | |
| setting changed | such as the model |

Plugins can report events of their own.

### Input request and answer

An input request asks for something only the user can give.

| Input request contains | Notes |
|---|---|
| identity | |
| kind | approval, choice, free text, sign-in link, secret |
| what is asked, and details to help decide | |
| options *(for approval and choice)* | Approval options are at least "allow" and "refuse". "Always allow" is an option only when the asker can honour it. |
| the tool call it is tied to *(optional)* | |
| the session and agent asking | |
| a time limit *(optional)* | |
| whether it can still be answered | |

| Answer contains |
|---|
| the request it answers |
| the value, or "declined" |
| who answered |

### Usage

Input tokens, output tokens, cached tokens, and cost where known. Reported for each step and totalled for each turn and session.

## Interactions

Each interaction is listed by who asks, what it carries, and the possible answers.

### Interface and Harness

An Interface is a plugin, so these are things it does through the plugin API.

| Interface asks | Carrying | Answers |
|---|---|---|
| start a session | settings *(optional)*, a session and point to fork from *(optional)* | the session |
| list sessions, open a session | | sessions; the session and its history |
| give input | the session, the content, when to take it (now, in the running turn, after it) | accepted, with the history entry; or refused |
| cancel | the session | the turn ends as cancelled |
| list commands, run a command | the command and its arguments | the command's result, or an error |
| follow a session | the session, and a point to start from | its history from that point, then its events as they happen |
| answer an input request | the [answer](#input-request-and-answer) | accepted; or the request can no longer be answered |

| Harness tells the Interface | Carrying |
|---|---|
| an input request opened | the [input request](#input-request-and-answer). Only Interfaces able to answer it are told. |
| an event happened | the [event](#event) |

### Harness and Runtime

**Decided** ([ADR 0006](adr/0006-hook-points-belong-to-the-operation-owner.md)), except the details.

| Harness asks the Runtime | Carrying | Answers |
|---|---|---|
| run a turn | the [turn input](#turn-input-and-turn-outcome) | the [turn outcome](#turn-input-and-turn-outcome) |
| cancel the turn | the turn | the turn ends as cancelled |
| take this input in the running turn | the content | taken, or refused ([open](open-questions.md#input-during-a-turn)) |

| Runtime asks the Harness | Carrying | Answers |
|---|---|---|
| run this tool call | the [tool call](#tool-call) | progress, then the [tool result](#tool-result) |
| let plugins step in | the hook point and what is at stake (see [hook points](#hook-points)) | the plugins' combined answer |

| Runtime tells the Harness | Carrying |
|---|---|
| this happened | an [event](#event) |

### Runtime and Provider

Through the [model access](#model-access) it was given:

| Runtime asks | Carrying | Answers |
|---|---|---|
| make a model request | the [model request](#model-request-and-response) | the response as it arrives, then complete; or a failure and why |

### Harness and tool source

| Harness asks | Carrying | Answers |
|---|---|---|
| which tools do you offer? | | [tool definitions](#tool-definition). A tool source says when its list changes. |
| run this call | the [tool call](#tool-call), and a way to cancel it | progress, then the [tool result](#tool-result) |

### Harness and history store

| Harness asks | Carrying | Answers |
|---|---|---|
| keep these entries | the session, the [history entries](#history-entry) | kept safely; or failed |
| give me this session's history | the session, a point to start from *(optional)* | the entries |
| list sessions | filters *(optional)* | sessions |
| open a session for writing | the session | opened; or refused because it is already open elsewhere |

### Provider or tool source and credential store

| Asks | Carrying | Answers |
|---|---|---|
| give me this credential | which credential | the credential; or "sign-in needed", which the credential store turns into an [input request](#input-request-and-answer) |

## Hook points

Whoever owns an operation defines its hook points ([ADR 0006](adr/0006-hook-points-belong-to-the-operation-owner.md)). Every Runtime offers the same standard set.

| Owner | Hook point | Plugins are given | Plugins can answer |
|---|---|---|---|
| Runtime | turn starts | the turn input | nothing: observe only |
| Runtime | before each step | the history so far, usage so far, the model's limits | the model context for this step |
| Runtime | after each step | the model response | continue or end the turn |
| Runtime | before a tool call | the tool call and its definition | allow it; refuse it, with a reason; or allow it with changed input |
| Runtime | after a tool call | the tool call and its result | keep the result, or replace it |
| Runtime | a model request failed | the request and why it failed | retry, perhaps after changing something such as the context; or let it fail |
| Runtime | turn ends | the outcome | nothing: observe only |
| Harness | session starts, session ends | the session | nothing: observe only |
| Harness | input arrives | the input and where it came from | pass it on; change it; or handle it, so it never reaches the model |
| Harness | before a turn | the session and the input | additions to the system prompt and the context |
| Provider | before a model request | the request | a changed request |
| Provider | as the response arrives | each piece | nothing: observe only |

When several plugins handle one hook point, these rules are **proposed**:
- A refusal wins. If any plugin refuses a tool call, it does not run.
- Changes are applied one after another, each plugin seeing the result of the one before. The order is [open](open-questions.md#how-handlers-combine).
- If a plugin fails while handling a gate, the operation is refused.

## Lifecycles

### Turn

```
started ──► running ──► waiting for the user ──► running ──► ended
                │                                              ▲
                └──────────────────────────────────────────────┘
```

A turn ends with one outcome: completed, cancelled, failed, or stopped at a limit. Whether a turn waiting for the user ends when the wait is long, and how, is [open](open-questions.md#waiting-for-the-user).

### Tool call

```
requested ──► waiting for approval ──► running ──► completed | failed
                     │                    │
                     └──► refused         └──► cancelled
```

A call interrupted by a stopped process ends as **not started** or **outcome unknown**. Every tool call ends with exactly one result.

### Input request

```
open ──► answered | declined | cancelled
  │
  └──► still open after its tool call has ended (the answer arrives as new input)
  └──► can no longer be answered (the asker is gone)
```

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
| what it copies *(optional)* | the entries whose content it copies, such as those a summary summarizes. Erasing any of them erases this entry too. |
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
| a key *(optional)* | Asking again with the same key reopens the same question, or reuses its recorded answer. |
| where to keep it *(secret only)* | the name the credential store keeps the answer under. Without one, or without a credential store, the request is declined before anyone is asked. |

| Answer contains |
|---|
| the request it answers |
| the value, or "declined". For a secret, only where it was kept. |
| the actor who answered |

The first accepted answer closes the request. An answer to a secret request goes only to the credential store: the asker, the record and every event see only the name it was kept under. That is why a recorded secret answer can be reused like any other.

### Declaration

What the session, as set up, supports. The agent declares it, and declares it again if it changes. It covers each feature in [Declared support](architecture.md#declared-support), and any hook points offered beyond the standard set.

### Usage

Input tokens, output tokens, cached tokens, audio time where it applies, and cost where known. Reported for each step and job, and totalled for each turn, session and, where budgets apply, tenant.

## Interactions

Each interaction is listed by who asks, what it carries, and the possible answers. Every ask from an Interface carries the actor it acts for, and is refused if the actor lacks the authority.

**An answer comes after its effects.** Once an interaction is answered, whoever asks next sees what it changed. A part that keeps a copy of another part's answers, such as a list of tools, refreshes the copy before the answer that changed it is passed on. **Decided while building** ([ADR 0014](adr/0014-plugins-in-other-processes.md)).

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
| resume an interrupted turn | the turn input, and the tool calls the history shows without a result, each marked started or not | the [turn outcome](#turn-input-and-turn-outcome). A transient Runtime ends the turn as failed. A durable one carries on. Either way, every pending call gets one result. |
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
| which tools do you offer? | the session *(optional)* | [tool definitions](#tool-definition), including any only that session has. A tool source says when its list changes. |
| run this call | the [tool call](#tool-call), and a way to cancel it | progress, then the [tool result](#tool-result). If no answer comes, the outcome is unknown. |

### Harness and working environment

| Harness asks | Carrying | Answers |
|---|---|---|
| run a command; read or write a file | what to do | the result; or failed; or "environment lost" |
| save this point; return to a saved point | the point | saved; returned; or refused |

### Harness and history store

| Harness asks | Carrying | Answers |
|---|---|---|
| keep these entries | the session, the [history entries](#history-entry) | kept safely; or failed. Keeping the same entries again keeps them once, so a writer that lost the answer can send them again. **Decided while building** ([ADR 0015](adr/0015-parts-as-services.md)). |
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
| start a job | the session, its kind, the actor, and the plugin's own detail | the [job](#job), recorded with the detail |
| report on a job | progress or result, and whether to report the result | recorded. A reported result enters the session as input, and may start a turn. |
| list its unfinished jobs | the session | the jobs this plugin started that the history shows never ended, with their detail |
| take up an unfinished job | the job | the job, running again, for this plugin to report on |

The Harness can ask the plugin to cancel a job. Its answer is "cancelled", or the job's result if it had already finished.

A job left unfinished by a stopped process stays unfinished until its plugin takes it up or ends it. The Harness never ends it by itself.

## Hook points

Whoever owns an operation defines its hook points, including plugins ([ADR 0006](adr/0006-hook-points-belong-to-the-operation-owner.md)). Every Runtime offers the same standard set.

| Owner | Hook point | Plugins are given | Plugins can answer | Rule |
|---|---|---|---|---|
| Harness | plugin about to load | the plugin and the project | allow or refuse | gate |
| Harness | session starts, joined, left, ends | the session and actor | nothing: observe only | observe |
| Harness | input arrives | the input and its actor | pass it on; change it; or handle it, so it never reaches the model | transform |
| Harness | before a turn | the session and the input | additions to the system prompt and the context | collect |
| Harness | before output reaches a recipient | the output and the recipient | let it through, redact it, block it, or hold it until more arrives | gate, applied by the Harness |
| Runtime | turn starts | the turn input | nothing: observe only | observe |
| Runtime | before each step | the history so far, usage so far, the model's limits | the model context for this step; the tools the model may use; whether the Provider may run tools itself | transform |
| Runtime | after each step | the model response, including tools the Provider ran | continue or end the turn | gate: a refusal ends the turn |
| Runtime | before a tool call | the tool call and its definition | allow it; refuse it, with a reason; or allow it with changed input | gate |
| Runtime | after a tool call | the tool call and its result | keep the result, or replace it | transform |
| Runtime | a model request failed | the request and why it failed | retry, perhaps after changing something such as the context; or let it fail | first answer |
| Runtime | the turn's result is ready | the result and the shape it must have | accept it; or send the model back with a reason | gate: a refusal sends the model back |
| Runtime | turn ends | the outcome | nothing: observe only | observe |
| Provider | before a model request | the request | a changed request | transform |
| Provider | as the response arrives | each piece | nothing: observe only | observe |

"Before a tool call" also applies to calls a UI or plugin starts. Tools a Provider runs itself can't be stopped one by one. They are allowed or refused before the request.

When several plugins handle one hook point, the hook point's owner fixes one rule for combining their answers. **Decided** ([open questions](open-questions.md#settled)). The rules are:
- **observe:** every handler sees it, and answers are ignored.
- **gate:** handlers answer in turn. A refusal wins and stops the rest. A handler may allow with changed input, and later handlers see the change. A handler that fails counts as a refusal.
- **transform:** each handler gets the previous handler's result and may change it. A handler may also stop the chain, as when input is handled as a command.
- **first answer:** the first handler that answers decides.
- **collect:** every handler's contribution is gathered.

Handlers run in the order their plugins were loaded. A plugin can ask to run first or last. Handlers that ask to run first form a group, in load order, then those with no preference, then those that ask to run last, again in load order. Neither group is reversed. **Decided** ([ADR 0016](adr/0016-rules-from-three-clean-room-builds.md)).

**When a handler fails:** at a gate, it counts as a refusal. At an observe point, the failure is reported and the operation carries on. At a transform, first-answer or collect point, the operation that ran the hook point fails, and says which handler failed. **Decided** ([ADR 0016](adr/0016-rules-from-three-clean-room-builds.md)).

**A handler may run more than once for the same work.** After a restart, a recovered turn runs its checks again from the last recorded point. A handler with an outside effect must make that effect safe to repeat, for example by keying it. Neither the Harness nor the Runtime makes a handler's effects happen exactly once. **Decided** ([ADR 0016](adr/0016-rules-from-three-clean-room-builds.md)).

## Rules every implementation follows

These rules come from three independent builds of this description, in Rust, Python and Go, each made from the docs alone ([ADR 0016](adr/0016-rules-from-three-clean-room-builds.md)). Each builder logged where the description left a choice open, and whether two builds that chose differently would break a plugin or a host. Where they would, and the builds agreed, the choice is now a rule. Where they would and the builds disagreed, the rule says what must be declared. All are **decided**.

### Plugins and capabilities

- **Some capabilities a session has only one of:** the Runtime, the history store, the working environment, the credential store and configuration. A second plugin providing one is refused, unless it names the plugin it replaces.
- **Names are never shadowed.** Two tools with one name, two commands with one name, or two Providers with one identity: the second is refused when it loads. Nothing is silently hidden by load order.
- **Replacing a plugin** names one that is loaded. Everything the replaced plugin registered goes. If the replacement fails to set up, nothing of it remains.
- **The set of plugins is fixed** while a session is open. Reopening a session records the plugins active now, beside what history says was active before.
- **Programs and servers a plugin starts** come from the current configuration and current trust. Nothing recorded in history can make the agent start a program.
- **Some settings are the Harness's own,** such as a session's parent or an actor's authority. Configuration files can't set them.

### Input

- **Steering joins the running turn** after the current round of tool calls, before the next model request. Input for after the turn starts a turn of its own.
- **One session takes one input at a time.** Two inputs arriving together are taken in some order, never both lost or merged.
- **A key is remembered for the session's life,** across branches and restarts, until the input it admitted is erased. Input given again with a known key gets the first receipt, whatever its content, and starts nothing.
- **Cancelling hands back all input not yet taken.** Input handed back keeps its key, so resending it needs a new key.
- **After a restart,** input that was queued but not taken is either handed back or run. Which one is declared.

### Settings

- **Settings belong to the session, not to a branch.** Moving keeps the current settings. A fork starts with its source session's current settings, whichever entry it was forked at.
- **A change never alters a running turn.** It applies from the next turn. An Interface may refuse a change while a turn runs, and declares whether it does.
- **A turn records what it started with:** the model, the tools offered and the system prompt. Recovery uses that record.

### Commands

- **A command never starts a turn.** Most make no model request either. A command that does, such as `/compact`, which asks a model for a summary, says so.
- **A command that only reads,** such as listing settings, doesn't make a session worth keeping.

### Compaction

- **Compaction never leaves a tool call without its result,** or a result without its call, in the model context. If the newest part can't be summarized without splitting a pair, the pair is summarized whole, or compaction is refused.
- **A summary names every entry it summarizes.** Erasure follows those names.
- **After a context-overflow failure,** a step is compacted and retried at most once. A summary that fails fails the turn. Nothing is deleted either way.

### The output gate

- **Everything that leaves the agent for a recipient passes the gate.** That includes live events, replayed history, answers to an Interface's requests, command results and turn outcomes, not only streamed pieces.
- **A stream has a declared end:** the end of a model response, or of a tool's output. A guardrail that holds output releases or redacts it no later than that end.
- **Plugins may read the raw record.** An Interface never passes the raw record to a recipient.

### Erasure

- **What counts as a copy.** Erasure follows copies, and copies of copies. Erasing too much is preferred to leaving a copy behind. The following count as copies:
  - a model response, of every model-visible entry in the request that produced it;
  - a tool result, of its call;
  - a turn's result, of its responses and tool results;
  - a summary, of what it summarizes;
  - a fork's entries, of the entries they were copied from;
  - a job's start, of the call that started it; its end, of the child's result; its report, of its end;
  - the record of taking an input, of the input. The two are one.
- **Erasure is refused** while another writer holds a session it would change. Whether it is also refused while a turn runs is declared.
- **Records of authority can't be erased.** Erasing a revocation must not widen anyone's authority.
- **Erasure reports three things:** what was erased; what is still pending, such as a remote deletion that failed and will be retried; and what is out of reach, such as output already delivered or a vendor's own logs.
- **A Provider that keeps state** discards it, and deletes the remote copies it knows of.

### Recovery and repeating work

- **A turn's start, and the input it takes, are recorded before the Runtime runs it,** so a turn lost at once is still on the record. **Decided** in round four, from the Rust, Python and Go builds, which all did this.
- **A model response is recorded before any tool call it asks for starts.** A call's start is recorded before the call runs. A finished call never runs again.
- **"Safe to repeat" is a promise, not a hint.** A call that started and didn't finish runs again only if both of these promise it is safe:
  - the tool's definition, both as recorded and as it is now;
  - the working environment: nothing from the first attempt is still running.

  A missing promise means unsafe. "Read-only" does not imply safe to repeat.
- **An interrupted model request is repeated** only if its Provider declares it keeps no state and runs no tools, or declares its requests safe to repeat.
- **Parallel tool calls** run together only if every call's tool allows it. Otherwise the whole round runs one call at a time. Each finished result is recorded at once, so a crash loses none, but the model sees results in the order it asked for them.

### The working environment

- **A command's background processes** outlive the call that started them, and a cancelled turn. They stop when the session closes or the agent stops.
- **The working environment declares how strongly it keeps "nothing outlives the agent",** and on which platforms. Where it can't keep the promise, it refuses to run commands, or declares a weaker promise. Recovery treats a weaker promise as an unknown outcome.
- **What a stopped agent left running is cleaned up** before any recovered work runs.

### Authority

- **Authority is a set of named rights.** An actor acts with its own rights, narrowed by the session's limit. For work another actor started, such as a job or a child session, they are narrowed further by every ancestor's current rights.
- **An actor may grant only rights it has.** Grants and revocations apply on every branch.
- **Work keeps the authority of everyone who contributed to it.** A turn that took input from several actors acts with only the rights they all share, or refuses mixed input. Which one is declared.
- **A job's report acts as the job,** with the job's narrowed authority, never as the actor who started the job.
- **Content is never authority.** Text in a message or a tool's input can't grant a right.
- **Presence is declared.** An Interface says when its actor is present to answer. Following events is not presence. An approval with no present actor who may answer is refused at once.

### Questions

- **A key binds the whole question:** its kind, text, options, credential name and tool call. Asking again with the same key and different details doesn't reuse the earlier answer.
- **Without a time limit,** a question waits in its turn. With one, the asker chooses what happens when it passes: decline, or leave the call open past its turn.
- **When every question behind a turn's open calls is answered,** one new turn starts. It is keyed, so answering again starts none. It runs the calls again from the top, through every check, and each open call gets exactly one result.
- **A call still waiting has no result in the record.** Only the model's view of the history describes it as waiting.
- **Moving away from unfinished work** either cancels the open calls, questions and jobs left on the abandoned branch, or is refused before anything changes. Which one is declared. Forking at unfinished work is refused.

### Secrets

- **A secret goes straight from the Interface to the credential store,** in one atomic write. Only the credential's name is recorded, sent in events or given to the asker.
- **If the write fails,** the question stays unanswered, and no error message contains the value.
- **A question can't replace a Provider's credential.** Those names are reserved.
- **With no credential store, or no name,** the question is declined before anyone is asked.
- **A protocol that forbids secrets in a form,** as ACP does, never carries one. The question is declined instead.

### Jobs

- **A job started with a key starts once.**
- **A job's end is recorded before its report is taken as input,** and the report is keyed by the job. A crash in between loses or repeats neither.
- **A job whose result goes back in the call that started it doesn't also report.**
- **Cancelling a job waits for it to clean up.** Closing a session cancels its jobs and waits for them. Stopping the process does neither: its jobs are interrupted, not ended.
- **A job's usage counts once** toward its session, however its result travels.

### Subagents

- **A child session gets** the same plugins and project, a copy of its parent's settings, only its task, and authority no wider than its parent's.
- **Subagents have a depth limit.** The default is three levels. The limit is declared.
- **A follow-up to a finished child** is a new job on the same child. A child that is busy refuses another message.
- **A child's question reaches the top one level at a time.** Each level records its link, and the answer goes back the same way. A secret's answer passes only its credential name.
- **A child's job isn't finished** while the child still has calls open.

### Configuration and trust

- **Trust is given outside the project and kept outside it.** A project's own files can't grant it. It is checked again every time plugins are composed.
- **Global plugins load first.** A trusted project's plugins and options load after them, merged by plugin name.

### MCP servers

- **Servers a host gives a session** serve only that session. Subagents don't inherit them. They close with the session, and must be given again when it reopens. Their environment and headers are never recorded.
- **A failure before a call reaches the server** is a failed result. Losing the server after the call was sent is an unknown outcome.
- **A tool's missing annotations are read cautiously:** it may change things, it may reach outside, and it is not safe to repeat.

### Parts that are lost

A part reached over a connection, such as a plugin in another process or a service, can be lost while the agent runs. Then:
- calls waiting on it fail, saying which part was lost;
- a tool call it had started gets one unknown outcome;
- a lost observer is skipped and reported, a lost gate refuses, and a lost transform fails its operation;
- a lost Runtime or history store is reported, not silently replaced.

### Provider state

- **A Provider that keeps state never supplies context missing from the agent's view.** It continues its state only when a request extends exactly what that state holds. Otherwise it starts again from what the agent sends.
- **Moving, forking, compacting, erasing and changing the model** all mean it starts again.

### Identities and usage

- **Every tool call has an identity unique in its session.** A vendor's own reference for the call is kept beside it, for the Provider.
- **Usage is plain numbers that add up:** input, output and cached tokens, and cost. A vendor's own breakdown stays in the Provider's data.

### Following a session

- **A follower resumes from an entry's identity.** It gets every entry recorded after that one, then live events. An unknown entry is refused.
- **A slow follower may miss streamed pieces, but never entries.** The entries hold the final content of every piece it missed.

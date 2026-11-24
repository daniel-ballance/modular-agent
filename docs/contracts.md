# Contracts: what passes between the parts

[Architecture](architecture.md) explains the parts. This document describes their information and interactions and states the rules they follow. [Security](security.md) covers trust and authentication. [Conformance](conformance.md) defines the keywords and the role of each document.

The core prescribes no transport, message encoding or process layout. An interaction can be a function call or a request to another process or service. The [bindings](bindings/README.md) define optional wire profiles.

## Information

These tables describe the information the parts exchange. A field marked *(optional)* can be absent. Field names and encodings on the wire are in [Shared data](bindings/data.md) and the applicable binding.

### Content

Content is an ordered list of typed parts. What a recipient sees is a view, not the raw record.

| Part type | Contains |
|---|---|
| text | text |
| image, audio, file | data or a reference, media type, name *(optional)* |
| reasoning | readable text or an opaque value for the Provider that produced it |
| tool call | see [Tool call](#tool-call) |
| other | typed data, such as an MCP Apps UI or A2UI data |

### Actor

| Field | Meaning |
|---|---|
| `id` | stable principal identity |
| `kind` | `user`, `host`, `agent`, or `program` (for example, a scheduler) |
| `rights` | named rights assigned to the actor, before ceilings |

### Session

| Contains | Notes |
|---|---|
| identity and project | |
| tenant *(optional)* | fixed at creation |
| settings | for example, model, reasoning level and approval policy |
| actors and session limit *(if set)* | recorded grants and the ceiling on their use |
| active plugins | the set for this opening of the session |
| current position and history | the head of the current branch and the session's record |
| retention | the history store's retention, or ephemeral |
| jobs | |
| source session and point *(optional)* | for a fork |
| parent session *(optional)* | for a subagent; independent of fork origin |

### History entry

| Contains | Notes |
|---|---|
| identity, session and time | |
| parent | an earlier entry in the session; `null` at the root |
| turn, step, call, job and actor identities *(where applicable)* | references to the work the entry concerns |
| writer and kind | for example, model response, tool start, summary, setting, move, erasure or plugin state |
| model visibility | control records such as grants, approvals and erasure are not model context |
| sources *(optional)* | links to entries whose content was copied or used to derive this entry |
| content and data | what was kept; a tombstone stands in place of erased content |

### Tool definition

| Contains | Notes |
|---|---|
| name and description | names are unique in the session's catalog |
| input schema, result schema *(optional)* | |
| effect annotations | read-only, destructive, outside the project or system (`openWorld`), safe to repeat (`safeToRepeat`, an explicit promise) |
| parallel | whether the tool permits concurrent calls |
| callers | allowed origins such as model, UI or plugin |
| presentation *(optional)* | display hints, including a UI the tool brings |

A catalog can include tools that are not offered to the model. [Shared data](bindings/data.md#tools) specifies the schema dialect and wire defaults.

### Tool call

| Contains | Notes |
|---|---|
| id, name and input | the call's identity and payload |
| caller and acting actor | caller is the origin, such as model, Provider, UI, plugin or another call; the actor is the principal behind the work |
| step *(optional)* and parent operation *(if any)* | an out-of-turn call has no step |
| Provider reference *(optional)* | the vendor's call identity, distinct from the agent's |

### Tool result

| Contains | Notes |
|---|---|
| call identity | |
| status | `completed`, `failed`, `refused`, `cancelled`, `notStarted`, or `outcomeUnknown` |
| content | including the reason for a refusal |
| structured value and presentation *(optional)* | |

A pending reply is not a result. An approval answer is not a result either.

### Model access

| Contains | Notes |
|---|---|
| model and limits | context window, output limit, input types and reasoning levels |
| a way to use the model | no credentials |
| Provider support | state, safe repeat, Provider-run tools, live sessions or late responses |

### Model request and response

| Request | Response |
|---|---|
| system prompt and messages | content: text, reasoning, requested tool calls |
| tool definitions offered to the model | already-run Provider calls and their results *(if any)* |
| allowed Provider-run tools | relevant only in process, outside `/1` wire and portability |
| reasoning, output limit and other model settings | stop reason, usage and error *(if any)* |

Output can arrive in pieces before the complete response. A failure describes its cause, such as a temporary issue, context overflow, refused credentials or model refusal. Live two-way sessions and delayed batch responses have no common wire or portable profile.

### Turn input and turn outcome

| Turn input | Turn outcome |
|---|---|
| session and input | `completed`, `cancelled`, `failed` with error, or `limit` with its name |
| initiator: actor, job, plugin or late answer | result: text, structured data or calls still open |
| model access, offered tools, settings and limits | history produced and usage |
| result shape *(optional)* | open questions *(if any)* |

### Job

| Contains | Notes |
|---|---|
| identity, kind and key *(optional)* | for example, a subagent or background command |
| session, owning plugin and starting actor | and the turn or call that started it, where applicable |
| starting rights and state | unfinished (possibly running), completed, failed, cancelled, or outcome unknown |
| result and usage *(as available)* | result at end; usage attributed to the job's session |

### Event

An event reports an occurrence. It does not change it.

| Contains |
|---|
| type and time |
| associated session, turn, step, call, job, actor and reporting part *(where applicable)* |
| data or content *(optional)* |

| Standard event | Notes |
|---|---|
| session started, joined, left, ended | join and leave relate to actors |
| session interrupted | this agent stopped writing the session, because a commit failed or writer access was lost or uncertain; not recorded |
| input accepted, withdrawn or handed back | the receipt is separate from taking the input |
| turn started, ended | end carries outcome and result |
| step started, ended | end carries usage |
| model output arriving | text, reasoning, audio or tool input; live pieces, not history entries |
| tool requested, started, progress, ended | |
| question opened, answered, closed, no longer answerable | |
| job started, progress, ended | |
| entry added, position moved, entries erased | |
| setting changed; plugin loaded, replaced, unloaded | |

Plugins can also report their own events, distinct from the Harness's records and standard events.

### Input request and answer

| Request | Meaning |
|---|---|
| id, session, asker and tool call *(if any)* | the work the question belongs to |
| kind, text, details and options *(where applicable)* | approval, choice, free text, sign-in link or secret |
| `answerers` *(optional)* | list of actor ids; absent means any session actor with the appropriate right |
| answerable, time limit and expiry action *(optional)*, key *(optional)* | current state, wait policy and identity for reopening; [shared mapping](bindings/data.md#questions) |
| credential name *(secret only)* | where the answer is stored |

| Answer | Meaning |
|---|---|
| request id | the question it closes |
| answering actor *(absent on system closure)* | |
| value, stored name, or decline | a refusal by the system includes a reason; a pending wait is not an answer |

### Declaration

The agent's and session's profile: selected capabilities, supported features and the fallbacks the build uses. See [Declaration rules](#declaration-rules) and the [ACP keys](bindings/acp.md#the-declaration). A declaration is separate from the session's settings and from current availability.

### Usage

Additive input and output token counts, cache counts, and cost in US dollars where known. Audio duration, where applicable, is an additional core measure outside the common `/1` usage shape. Attribution is to work such as a step or job, with totals for its turn, session and tenant as applicable.

## Interactions

These tables list what an operation receives and returns. Rights, ordering and failure rules are in [Rules every implementation follows](#rules-every-implementation-follows). The tables are not a list of wire methods.

### Interface and Harness

The Interface uses the plugin API. Authority comes from the authenticated connection, not from a claimed identity in its request.

| Asks | Carrying | Answers |
|---|---|---|
| describe support; list sessions | session *(if selected)*; project or other filters *(optional)* | declaration; authorized sessions |
| create; open; close | project and optional settings or tenant; session id | session or refusal; closed or refusal |
| fork; move | source session and entry; rewind flag for a move | new session; moved, with `outOfReach` call ids for rewind when applicable; or refusal |
| list, join or remove actors; set presence | session, target actor or connection state as applicable | actors and presence; recorded change or refusal |
| read or change settings; set a limit | session and keys or ceiling | current view; recorded change or refusal |
| give input or propose it | session, content, timing, key *(optional)* | first admission receipt, or refusal |
| list, release or decline proposals; withdraw input | session and input id as applicable | proposals; new disposition, or refusal (including already taken) |
| cancel a turn or call; list or cancel jobs | session and target where applicable | state, including idle/already ended, or refusal; authorized jobs |
| list or run commands; call a tool directly | session, name, arguments or tool input | available operations; result, pending for a supported call, or refusal |
| follow | session and cursor *(optional)* | authorized catch-up then live events, or refusal |
| list or answer questions | session and answer where applicable | visible requests; accepted or refused (closed, no longer answerable or ineligible) |
| report an Interface tool result | session and report for a handed-off call | accepted, already settled or refused; no dispatch |
| erase | session and entries | erased, pending and out-of-reach copies, or refusal |

The Harness delivers authorized question views and events through the [output gate](#the-output-gate). [ACP](bindings/acp.md#extension-methods) defines the subset available through that binding and its errors.

**From [ADR 0035](adr/0035-host-limits-from-the-ops-desk.md).** An Interface that identifies a run may offer its client a read-only receipt. Bind it to the accepted work, not just the session. Distinguish the end of the exchange from the outcome of the turn it followed. Expose only committed facts permitted by the source views and the reply gate at read time. A receipt is not input, an answer route or permission to execute a call. See [AG-UI run receipts](bindings/agui.md#run-receipts).

### Harness and Runtime

| Harness asks | Carrying | Answers |
|---|---|---|
| describe support | | Runtime support |
| run, cancel or resume a turn | turn input or identity; on resume, the recorded checkpoint and unsettled work, distinguishing started from not started | turn outcome |
| offer queued steering | admitted inputs in order | the Runtime asks at a step boundary; the Harness commits the taking transition |

| Runtime asks | Carrying | Answers |
|---|---|---|
| use session services | session work identity, request for ids, history, tools, queued steering or recording | scoped data or acknowledgement |
| make a model request | selected model access and request | streamed pieces and final response, or failure |
| invoke a hook | point and its payload | the combined answer |
| run a tool | call | progress and result, or pending; see [Tool dispatch](#tool-dispatch) |

The Runtime can report events. The Harness owns the session's standard records and events.

| Seam | Authority and commit | Wire mapping |
|---|---|---|
| Actor input and steering | [Input](#input) and [Authority](#authority); admission and taking are separate | [ACP admission](bindings/acp.md#input-admission), [Runtime callbacks](bindings/plugin.md#runtime-callbacks) |
| Model and tool dispatch | [Tool dispatch](#tool-dispatch) and [Recovery](#recovery-and-repeating-work); intent before handoff | [Runtime sequence](bindings/plugin.md#runtime-records-and-effects) |
| Hooks | [Hook execution](#hook-execution) by the operation owner | [Plugin hook mapping](bindings/plugin.md#from-core-hooks-to-wire-hooks) |
| History and erasure | [Erasure](#erasure); the Harness computes copies | [History HTTP](bindings/history-http.md) |
| Environment and jobs | [Working environment](#the-working-environment) and [Jobs](#jobs) | [Environment](bindings/plugin.md#the-host-asks-the-working-environment), [Jobs](bindings/plugin.md#jobs) |

### Runtime and Provider

Using model access supplied by the Harness, the Runtime requests inference and can cancel it. In a local extension it can open or interrupt a live session or ask for a late response. The Harness, not the Runtime, asks the Provider to discard session state or delete known remote copies. Replies include success, no state, or failure.

### Harness and tool source

| Asks | Carrying | Answers |
|---|---|---|
| list tools | session *(if scoped)* | definitions; change notice when the list changes |
| run a call | authorized call and cancellation signal | progress then result, or a typed pending reply tied to a question or an [Interface handoff](#interface-run-tools) |

A running call can ask the Harness for the tools another call may start, and ask it to run one as a [nested call](#nested-calls):

| Asks | Carrying | Answers |
|---|---|---|
| list callable tools | the asking call | definitions a call may start |
| run a nested call | the asking call, tool name and input | the nested call's terminal result, or refusal of the request |

Loss before dispatch is distinct from loss after a call may have started.

### Harness and working environment

| Asks | Carrying | Answers |
|---|---|---|
| run a command; read or write a file | session project, command and working directory or file path and data, cancellation signal | result, failure, or environment lost |
| list a directory *(optional)* | session project, working directory and path | entries with their kinds, failure, or not supported |
| save, check or restore a point | project and environment identity; saved point for check or restore | saved, exists, restored or refused |
| end a session | session | cleanup outcome within the declared containment scope |

### Harness and history store

| Asks | Carrying | Answers |
|---|---|---|
| acquire, renew or release writer access | session and writer or current lease | access, held or lost |
| append a batch | session, current writer access and entries | committed or failed |
| read history; list sessions | session, optional cursor and filters | entries or matching sessions |
| erase | exact entry ids, with writer access when required | tombstones or refusal |

The Harness computes the copy set. The store does not interpret the contents. [History service](bindings/history-http.md) defines remote leases, retries and paging.

### Asking the credential store

An authorized Provider, tool source or working environment asks for a named credential in its scope. The answer is the credential, unavailable or sign-in needed. The Runtime gets model access instead of credentials.

| Secret answer operation | Scope | Result |
|---|---|---|
| Stage | Deployment, session, request id, credential name and authenticated answerer; value on the secret path only | Durable staging receipt with the answerer id, or refused |
| Look up staging | Same scope, no value | Receipt or not found, with no secret value |
| Activate | Deployment, session and request id | Activated, `superseded`, or failed |
| Discard | Deployment, session and request id | Discarded or not found; leaves the active value alone |

These are in-process operations. [Secrets](#secrets) defines ordering and recovery.

### Plugin and Harness: jobs

| Asks | Carrying | Answers |
|---|---|---|
| start | session, work identity, kind, key *(optional)* and plugin detail | recorded job or refusal |
| report progress or end | job, progress or outcome, result, usage and report flag as applicable | acknowledgement or refusal |
| list unfinished; take up | owning plugin and session; job to claim | unfinished jobs or exclusive take-up |
| cancel (Harness asks the owner) | job | cancellation outcome, or the already recorded outcome |

## Hook points

The operation owner defines its hook points, including points owned by plugins. The table describes the core points; [Hook handlers](bindings/plugin.md#the-host-asks-a-hook-handler) maps them to the `/1` payloads and lists omissions, including session join/leave and per-piece Provider response. In process the Runtime invokes `tool.after`; for calls it mediates over `/1`, the host runs the chain before replying and returns the cached hook outcome on a later callback. See [Runtime records and effects](bindings/plugin.md#runtime-records-and-effects).

| Owner | Point | Payload | Answer and combination |
|---|---|---|---|
| Harness | plugin about to load | plugin and project | allow or refuse (gate) |
| Harness | session starts, joined, left, ends | session and actor where applicable | observe |
| Harness | input arrives | input and actor | pass, change or handle (transform) |
| Harness | before a turn | session and input | prompt fragments and context additions (collect) |
| Harness | before output | recipient and output | allow, redact or block (gate); buffering belongs to the Harness |
| Runtime | turn starts | turn input | observe |
| Runtime | before each step | prepared request, history, usage and model limits | change context, offered tools or Provider-tool allowance (transform) |
| Runtime | after each step (`step.after`) | recorded model response, including any already-run Provider calls | continue or end (gate after the step's calls are settled, before the next model request) |
| Runtime | before a call | call and definition | allow, refuse, change input, or leave pending under [Questions](#questions) (gate) |
| Runtime | after a call | call and result | keep or change result content or value (transform) |
| Runtime | model request failed | request and failure | retry, optionally with changes, or give up (first answer) |
| Runtime | turn result ready | result and expected shape | accept or refuse with [feedback](#hook-execution) (gate) |
| Runtime | turn ends | outcome | observe |
| Provider | before a request | model request | change request (transform) |
| Provider | response arrives | each piece in process | observe |

## Rules every implementation follows

### Declaration rules

- The agent MUST publish its declaration, provide the selected session's declaration on opening, and publish changes before using the changed features.
- The declaration MUST name the bindings and versions the build claims and any additional hook points it offers.
- The declaration MUST reflect the rules below and use the more restrictive value when behavior varies within the scope being declared.
- The declaration MUST set `inputKeys: true` and `pluginsDuringSession: false`.
- The declaration MUST set `continuesAfterRestart: true` when `waitingThroughRestart` is true.
- An agent with [Interface-run tools](#interface-run-tools) MUST declare `interfaceTools: true` in the supported scope. Omission or false keeps the existing behavior. This key requires a Runtime that supports result-only continuations. It does not imply that questions can outlast a turn or that a session survives restart.
- A session that supports [approvals that wait](#approvals-that-wait) MUST declare `approvalsOutlastTurns: true`. This requires the approval gate, a finite operator maximum and `portableSessions`, `questionsOutlastTurns` and `lateAnswersStartTurns` all true. It does not require `waitingThroughRestart`. Omission or false means live-only approvals. The operator MUST exclude writers that cannot enforce or safely refuse outstanding waits before enabling the feature on shared history.
- An agent that supports the [metadata-only telemetry profile](telemetry.md) MUST declare `telemetry: 1`. Omission makes no claim. The optional key reports support, not whether telemetry is sampled or exported. Peers ignore a key they do not recognize.
- The agent MUST refuse unsupported capabilities with no applicable fallback. The wire names and defaults are in [ACP](bindings/acp.md#the-declaration).

### Plugins and capabilities

- The Harness MUST select at most one Runtime, history store, working environment, credential store and Configuration for a session. Providers, tool sources and Interfaces can have multiple registrations.
- The Harness MUST refuse a turn without a selected Runtime and available model access before starting effects. Missing services MUST return unavailable for operations that need them. A session can open without a Runtime or selected model.
- Without a history store, the Harness MUST treat the session as ephemeral across process stops.
- The Harness MUST refuse a second singleton, tool name, command name or Provider identity unless a valid replacement removes the conflict.
- A whole-plugin replacement MUST name a loaded plugin and replace all its registrations atomically after setup and collision checks. The [plugin binding](bindings/plugin.md#starting-the-handshake) instead maps explicit replacements to individual local registrations. Failed replacement leaves the prior registrations in place.
- The Harness MUST reject a tool-list refresh that would introduce a clash. The last valid list remains registered; the [plugin binding's refresh rules](bindings/plugin.md#the-host-asks-a-tool-source) make an invalidated list unavailable for dispatch until refreshed successfully.
- The Harness MUST keep the plugin set fixed while a session is open. Offering an already registered, authorized tool does not change that set. The Harness MUST record the active set on first use and on reopen when it differs from the last record. See the [plugin-set fold](bindings/data.md#session-state) for the comparison.
- A plugin MUST use the plugin API for supported interactions with the agent. This is a design rule, not a sandbox; [Security](security.md#plugins) describes the trust boundary.
- The Harness MUST refuse a plugin whose declared dependencies cannot be satisfied, including a dependency cycle. A plugin MAY define a capability for other plugins in the same build.

### Input

- The Harness MUST serialize admission, taking and withdrawal in commit order, with at most one turn running per session.
- The Harness MUST take ready items one per turn in commit order, including `now`, `after`, released proposals and continuations. New input cannot overtake ready work.
- The Harness MUST refuse conflicting mixed-actor steering before admission when `mixedActorInput` is `refused`. If queued steering becomes conflicting before taking, the Harness MUST hand it back and check the next item.
- With `inputDuringTurn`, the Runtime MUST check for eligible steering after the current tool round, before the next model request or the decision to end. The Harness MUST serialize the Runtime's final steering check with admission. After that check, or without steering support, it MUST queue steering as `after` with receipt `after`.
- The Harness MUST serialize key lookup and reservation before preprocessing. The input transform MUST NOT cause outside effects. The Harness MUST commit a handled input's admission and no-turn disposition together before starting a transform-selected command. A handled input is never requeued after restart.
- The Harness MUST record admission before acknowledging it, including when input is queued or proposed. For a known key it MUST return the first receipt to an authorized actor, regardless of new content or whether it was taken, without starting work. A key does not authorize receipt access.
- The Harness MUST reserve admitted keys for the session's life, across branches, restarts and erasure. For an erased key it MUST return only `{ duplicate: true, erased: true }`. The Harness MUST reserve the `job:` and `continue:` prefixes for internal work. When it serves [AG-UI](bindings/agui.md), it MUST reserve `agui:` for that adapter's admissions.
- On turn cancellation the Harness MUST hand back input not yet taken at the cancellation cutoff, without affecting later admissions. It MUST keep the keys and show handed-back content only to authorized recipients. Resending requires a fresh key.
- At a turn end other than cancellation, the Harness MUST hand back that turn's untaken `inTurn` inputs with reason `turnEnded` in the same batch as `turnEnd`. It MUST keep the first receipt and key.
- On restart, the Harness MUST run or hand back queued input as `queuedInputAfterRestart` declares, using `queuedJobReportsAfterRestart` for reports if present. It MUST apply the restart policy only to ready items, not parked reports.
- A new session MUST remain provisional and unlisted until first admission, with setup staged in memory and reported as not durable. The Harness MUST flush setup with first admission in original order and with original times. Provisional setup is lost on process stop. Until materialization the Harness MUST refuse other work needing a durable dispatch record as unavailable. See [Setup records](bindings/data.md#setup-records).

### Settings

- The Harness MUST apply settings to the whole session, across branches. Fork inheritance is in [Moving and rewinding](#moving-and-rewinding).
- The Harness MUST apply changes from the next turn or refuse changes during a turn, as `settingsDuringTurn` declares. Rights, ceilings, answer eligibility and deployment policy remain current at each action; they are not pinned settings.
- The Harness MUST select and record the turn's model, settings, offered tools, prompt additions and context additions and supply them on recovery. The Runtime MUST NOT choose a different model. Step preparation still applies.
- The Harness MUST offer the model only registered tools whose callers include the model. When the [`modelTools`](bindings/data.md#setting-keys) setting is recorded, the Harness MUST also leave out every tool the setting does not name. A name with no registered tool is inert. The setting narrows the model's offer only. It does not limit what the UI, a plugin or a nested call can start, and it grants nothing.

### Commands

- A command MUST NOT start a turn.
- A standalone model-using command MUST declare that fact. The Harness MUST require `input` and apply the same dispatch, persistence and metering rules as in a turn. A model attempt outside a turn is linked by `stepId`. The Harness MUST NOT restart a standalone command automatically.
- A standalone read-only command MUST NOT materialize a provisional session. Actor input handled as a command still has a committed admission.
- A command is a direct action by its invoking actor, including when selected by an input transform. At handoff the Harness MUST authorize working-environment operations under that actor's current `tools` right and other operations under the rights they need, such as `settings` for a setting change. Approval policy and `tool.before` govern tool calls, including any tool call a command requests, not these direct operations. An operator who requires approval for such effects leaves those commands uninstalled or withholds `tools` from the actors.

### Compaction

- The Runtime MUST keep settled call/result pairs together, either in the view or summarized as a pair. It MUST keep an open call explicitly pending in the view or refuse compaction that would break that association.
- A summary MUST name every entry it summarizes, including earlier summaries it uses.
- The Runtime MUST limit context-overflow recovery to one compaction and one retry. The Harness MUST run compaction during step preparation. The Runtime MUST fail the turn if the summary request fails.

### Hook execution

- Each operation owner MUST offer its standard core points in [Hook points](#hook-points), subject to the selected binding's coverage.
- The owner MUST apply the combination in [Hook points](#hook-points): observe calls all handlers and ignores answers; gate stops at the first refusal or permitted pending; transform passes the current value along until handled or finished; first answer skips passes and stops at the first decision; collect gathers contributions in order. A first-answer chain without a decision does not request a retry.
- The owner MUST order handlers in three groups: first, unspecified, last, each in plugin load order.
- At an observe point the owner MUST report a failed handler without stopping the operation. At a gate it MUST treat a failed or invalid answer as refusal. At a transform, first-answer or collect point it MUST fail the operation and identify the failed handler. Cancellation is not permission to continue.
- The Harness MUST assemble prompt contributions in handler order, separated by newlines, and append context contributions in handler order.
- Without a context-management handler, the Runtime MUST use the [default model view](bindings/data.md#context-and-interrupted-work). The initial request for a transform includes this view (or its managed replacement), the assembled prompt, the selected tools and pinned settings.
- A model request for a plugin's own work, such as compaction, is an auxiliary attempt, not a step. The Harness MUST record auxiliary attempts with their usage and lineage. The Harness MUST count auxiliary usage toward budgets without counting those attempts toward `maxSteps`.
- The Runtime MUST run `step.after` once per answered step, after every call from its response has a terminal result or a committed pending disposition, and before the next model request or the normal end of the turn. Auxiliary attempts and recovery bookkeeping settlements have no `step.after`. The Harness MUST commit the gate's decision before returning or acting on it. On refusal the Runtime MUST end the turn as failed with the gate's reason and make no further model request. On resume see [Recovery and repeating work](#recovery-and-repeating-work). Checks on individual calls belong to `tool.before`.
- The Runtime MUST end confirmed cancellation as cancelled and output exhaustion as `limit: output`, without running partial calls. A recovery bookkeeping abort does not confirm cancellation. The Runtime MUST end a failed attempt or model refusal as failed unless an applicable retry rule permits another attempt.
- If the turn declares a result shape, the Harness MUST require `value` on completion and validate it against the shape. Missing `value` is distinct from JSON null. On refusal by `turn.result`, including result shape rejection, the Harness MUST commit [`resultFeedback`](bindings/data.md#standard-kinds) before reporting the refusal to the Runtime. A retry uses the [feedback projection](bindings/data.md#context-and-interrupted-work). Before a new attempt the Harness MUST check cancellation before step and usage limits. Before recording a step's attempt, the Harness MUST refuse it with `limit: steps` if the number of committed step attempts in that turn already meets `maxSteps`. The count includes retries of step attempts.
- A handler with outside effects MUST make them safe to repeat. Recovery can run hooks again and does not guarantee exactly-once effects.

### Tool dispatch

- Every agent-executed call MUST go through the Harness, whether it comes from a model, Interface, plugin or another call.
- Immediately before handoff to the tool, Provider or environment executor, after every wait and history write, the Harness MUST check current rights for every actor behind the work, policy, availability, cancellation and writer access. A change to any checked fact before handoff MUST trigger another check.
- At ToolCall handoff the Harness MUST also check registration, input validity and an unused allowance for that exact call. An environment callback under a tool invocation MUST use its own live, authorized, dispatched parent and stay within that parent's scope. The environment callback needs no second allowance. A nested ToolCall MUST pass its own gates and get its own allowance. For direct commands see [Commands](#commands).

#### Nested calls

- A tool invocation MAY ask the Harness to run another call, only under its own live, dispatched invocation. A build that does not run nested calls MUST refuse the request and MUST NOT declare `nestedToolCalls`.
- The Harness MUST make the request a new ToolCall with a fresh id, a tool as its caller, the asking call as its parent, and the parent's actor, turn and step. The asking tool MUST NOT choose any of these.
- The Harness MUST check a nested call as it checks any call, separately from its parent: the registration's callers MUST include a plugin, and rights, gates, approval and the final dispatch check all apply. The one exception is a [covered approval](#approvals-that-cover-nested-calls): its parent's allow answers the approval question, and nothing else. The [recorded offer](#recovery-and-repeating-work) governs the calls a model starts. A nested call needs no place in it.
- The Harness MUST commit the nested call's start and its terminal result as for any call, keep both out of the model's view, and return the committed terminal result to the asking invocation. Only the parent's own result reaches the model.
- A nested call MUST NOT be left open. If a gate answers pending for it, the Harness MUST close that call's open questions as `noLongerAnswerable` and settle the call as `refused`.
- The Harness MUST enforce a finite nesting depth, which the build documents, and refuse a request beyond it.
- Cancelling a call MUST cancel its unsettled nested calls. The Harness MUST settle every nested call no later than its parent, with the [settlement](#settlement) statuses.
- On recovery the Harness MUST settle an unsettled nested call itself. It MUST NOT hand one to the Runtime or repeat one on its own. A nested call runs again only when its parent is repeated and asks again, and then it is a new call.

#### Gates and registration

- A tool's registration is its plugin name, tool source id and tool definition. The Harness MUST compare definitions by [shared JSON equality](bindings/data.md#general-rules). It MUST bind allowances, pending calls and approvals to the call id, name, input and registration. A change to the source or definition invalidates outstanding allowances and approvals. The Harness MUST run the gates again on the new registration, asking again where required. A call already bound to an [approval that waits](#approvals-that-wait) is refused instead.
- In `tool.before`, each handler MUST see the call as changed so far. If a pass ends with changed input or any handler changed it during the pass, the Harness MUST run the whole chain again once from its first handler with the resulting input before allowing dispatch.
- The Harness MUST refuse a second pass that changes input again, or any change to id, name, actor or caller. First-pass approvals apply only if still bound to the exact call and registration. `tool.after` MAY change only content and value.
- The Harness MUST consume the allowance at the initial handoff of each ToolCall attempt. For a remote Runtime, the [Plugin binding](bindings/plugin.md#the-host-asks-the-runtime) maps this check to `host/runtime/hook` and `host/runtime/runToolCall`.

#### Approval policy

- An agent with an approval plugin MUST apply the recorded policy as follows:

  | Policy | Required approval behavior |
  |---|---|
  | `off` | The approval check MUST NOT ask. |
  | `ask` | The approval check MUST ask unless a trusted tool definition declares the tool read-only. |
  | `all` | The approval check MUST ask for every call. |
  | `never` | The approval check MUST refuse every call without asking. |

- With an approval plugin, the agent MUST use `all` when no policy was recorded and `never` for an unrecognized recorded value until an actor with `settings` chooses a recognized one.
- When approval is required, the gate MUST require an explicit eligible allow for the exact call. The Harness MUST record the [approval binding](bindings/data.md#questions) before delivery. It MUST NOT reuse an answer without an exact call and registration match. For a live approval, if the binding is missing or changed and the call can otherwise proceed, it MUST ask with a fresh question ID and key.
- Every approval route MUST present the exact tool name and input. The Harness MUST track whether a request is answerable and can authorize the call separately for each recipient and route. The Harness MUST treat a route whose view was changed or withheld as unanswerable and grant no approval authority through it. An unchanged request already delivered to the same recipient on another route MUST remain answerable as long as that route is still eligible. The Harness MUST recheck route eligibility when presence, rights, membership, gating or delivery changes. Except for [approvals that wait](#approvals-that-wait), if no present eligible answerer has a route that can deliver an unchanged view, the Harness MUST close any open approval with reason `refused` and settle the call as `refused`. See [ACP Request](bindings/acp.md#request) for the route mapping.
- Without an approval plugin, the agent MUST apply rights and other gates alone and signal the absence of approval support (no `approval` option in [ACP](bindings/acp.md#configuration-options)). No approval setting bypasses other gates.

#### Approvals that cover nested calls

Accepted in [ADR 0034](adr/0034-approvals-that-wait.md#amendment-approvals-that-cover-nested-calls). Off unless the operator turns it on; the agent declares `approvalCoversNested: true` only then.

- With it on, an explicit allow for a top-level call MUST also answer the approval check for each nested call that call makes during the same dispatch, at any depth. It answers nothing else: rights, every other gate, the nested call's own registration and input validity, the nesting limit and the final dispatch check MUST still apply, and a `never` policy or a gate's refusal still refuses.
- The approval route MUST tell the approver that the allow covers the nested calls the call makes, as part of the exact view (`coversNested: true` on the [request](bindings/data.md#questions)). A view without it covers nothing.
- The Harness MUST record on each covered nested call's `toolStarted` the parent call and the request whose allow covered it. A nested call whose parent was not explicitly allowed, including a parent the policy let through without asking, is not covered and is approved as any call.
- Coverage ends with the dispatch. A repeated or recovered parent needs a new allow; an allow never covers a call made after its parent settles.

#### Approvals that wait

Accepted in [ADR 0034](adr/0034-approvals-that-wait.md). These rules apply only with `approvalsOutlastTurns: true` and the recorded session setting `approvalWait: "untilDeadline"`. The default is `"live"`. The setting requires `settings`; it does not change the approval policy.

- **Which calls.** When the approval policy requires its `tool.before` gate to ask, the Harness MUST use this wait only for an unstarted, top-level call from a committed model response to a tool source other than an Interface. It MUST NOT convert a direct, nested, Provider-run or already started call, a question from inside a tool, or a relayed question into such a wait. Those paths keep their existing rules.
- **At the gate.** The Harness MUST bind the request to the exact call as it stands at the gate and its registration. It MUST reserve the open call, closing records and settlement. It MUST commit the [request and pending checkpoint](bindings/data.md#waiting-approval-records) together, then return pending immediately. There is no dispatch allowance, `toolStarted` or handoff, including to an Interface. At least one session member MUST qualify under the answerer restriction and current grants for `watch` and `approve`; otherwise refuse. No one need be present or have received the request at ask time.
- **At turn end.** Apply the normal sibling and `step.after` rules. Once the remaining calls are left open, the Runtime MUST end the turn `completed` with those calls in `openToolCalls`, unless a real limit, cancellation or failure ended it first. It MUST NOT wait for the approval deadline or re-enter that call. Until that end commits the request is not answerable. A failed, cancelled or limited origin MUST close its waits and settle its unstarted calls as `notStarted`. Once the origin has ended, disconnect, closing an idle kept session and stopping the process MUST NOT by themselves settle the call. The Harness retains its reservations, not a live invocation.
- **At the answer.** The Interface MUST show the immutable question, call ID, exact name, complete input and deadline for the decision. The Harness MUST require unchanged delivery on this authenticated recipient's answer route. A summary, history entry or forwarded ID is not such a delivery. It MUST recheck the view, presence on that route, membership, answerer restriction, representation, `watch`, `approve`, project and tenant at answer time. Losing a route invalidates its delivered view, not another route or the open question. If no member remains eligible even ignoring presence, close the request as `noLongerAnswerable` and settle the call as `refused`.
- **At decision.** Serialize answer, expiry, cancellation, revocation, branch change and pending erasure under writer access. Only the first valid decision commits. An explicit decline settles the call as `refused`. For an allow the Harness MUST commit the [binding to the delivered view](bindings/data.md#waiting-approval-records). The answer closes the question; it is not itself permission to dispatch. Use the [continuation queue](#questions) once all waits of the ended origin are ready, including on system closure. Do not create new input, run an unrelated turn or retry a settled sibling.
- **At dispatch.** The continuation MUST run `tool.before` again from the original recorded call. Reuse the allow only at its matching gate. Verify the recorded offer and validate the final input. After all gate passes, compare the call ID, name, actor, input and registration (plugin, source and whole definition) with the request by [shared JSON equality](bindings/data.md#general-rules). Check current policy and the original work's recorded ceilings and current authorizers, including ancestors. Independently recheck the answering principals, their ceiling, scope, representation and the unchanged approval view on the recorded route under current gate policy. Compare the approval content, not the now-closed question's `answerable` flag. Presence was needed for the answer, not after it. The approver's rights MUST NOT replace the work's rights.
- The Harness MUST refuse the waiting call if its registration or final input changed, consent cannot be verified, or policy or rights no longer permit it. It MUST NOT rebind that answer or ask again for a changed call under this identity. A more permissive policy cannot waive the recorded wait. Only an exact allow can pass this gate. All [final dispatch checks](#tool-dispatch), including availability, erasure, cancellation and writer access after every wait and write, still apply. Consume a fresh allowance only at initial handoff.
- **Deadline.** The operator MUST set a positive finite `maxApprovalWaitMs`. The Harness MUST record the lesser of it and any requested time limit, and the resulting absolute `deadlineAt`, before publication. No reopen, delivery, answer or policy change extends it. At or after that deadline on the Harness clock, close an unanswered request with `timeLimit` and settle a still-unstarted call as `notStarted`, even if an allow had committed before expiry. Do not append a second answer. Check expiry at decision and again immediately before handoff. On a supporting writer, if the session changes back to `live` or the saved interval exceeds a new operator maximum, close any open question as `refused` and refuse the call. Neither change permits dispatch under live-only rules.
- **Loss and recovery.** On reopen the writer MUST reconcile pending erasure, terminal identities, the original deadline and reservations before serving answerable views or starting effects. Expiry while stopped is settled on reopen. Before origin end, a durable Runtime can restore an intact pending checkpoint; a transient Runtime fails the interrupted turn. After a completed end, restore the open request or the one eligible continuation, not presence or a previous delivery. A reader without support or intact proof MUST NOT spend a waiting approval. Close an unsupported open wait as `noLongerAnswerable` and settle known unstarted work as `notStarted`. On recovery after a committed start, never dispatch again on that allow. Use confirmed facts to settle; uncertainty about handoff is `outcomeUnknown`, not `notStarted`.
- **Erasure and branch changes.** Include the call, question, answer binding, checkpoints, recipient buffers and continuation copies in the [erasure fold](#erasure). Invalidate affected views and queued work at the pending mark. Settle affected calls before erasing proof; never dispatch from missing or tombstoned data. The call is unfinished work for [fork, move and rewind](#moving-and-rewinding). A fork is refused while it is open; a later display-only copy, an off-branch request or a move back cannot restore permission.
- **Telemetry.** Under [telemetry](telemetry.md#spans-and-events), record `modular_agent.question.open` on the opening operation. End step and turn spans as usual. Put `modular_agent.question.close` on the later answer or system operation; use `modular_agent.question.answer` for an answer with no enclosing span. The continuation starts a new `invoke_agent` span, linked to the origin when available. Only dispatch starts `execute_tool`; report a pre-dispatch terminal status with `modular_agent.tool.disposition`. Record IDs and dispositions, never the arguments, question, answer or route proof.

#### Settlement

- Except for a call left pending under [Questions](#questions) or [Interface-run tools](#interface-run-tools), the Harness MUST settle each call once, ignoring late or duplicate completions. If result processing fails, it MUST commit a minimal safe result with confirmed status (or `outcomeUnknown` if unconfirmed). It MUST report the processing error separately and fail the enclosing operation, without redispatch.
- The Harness MUST use `refused` for pre-dispatch policy denial, `notStarted` for a call abandoned before dispatch, `failed` for known failure (including invalid input), `cancelled` for confirmed cancellation, and `outcomeUnknown` when dispatch may have occurred and the outcome cannot be established. Refusal of a retry does not settle an ambiguous original attempt.
- The Harness MUST check authority and gates independently for siblings. It MUST dispatch in model order unless every call permits parallel execution. A sequential round MUST wait for each invocation to return or relinquish execution before moving on. The Harness MUST record final results as known and present them to the model in call order. A refused or pending call does not cancel siblings.

#### Interface-run tools

An Interface-run tool has a registered tool source, but its executor is an authenticated actor's Interface. The actor behind the model's work and the executing actor are separate. This profile supports model calls in a turn, not direct, nested, auxiliary or Provider-run calls.

- The operator MUST register the source, exact [tool definitions](bindings/data.md#tools), executor actor, stable Interface route and a positive result timeout in milliseconds. The timeout and resulting deadline MUST fit the shared `Duration` and `Time` shapes. A route identifies an operator-configured binding and executor slot, not a socket or claimed identity. Registration takes place at composition. The ordinary collision and fixed plugin-set rules apply. The definition MUST restrict callers to the model and MUST NOT promise repeat safety or confinement by the agent's working environment.
- The Interface MUST advertise which registered tools are available for the work. This asserts availability, not authority or a new registration. The normal offer checks and `modelTools` apply. The Harness MUST pin the offer for the turn and recheck the exact definition, route and availability at handoff. A changed definition or executor invalidates any unconsumed allowance.
- At handoff the Harness MUST check the original work's authority and the executor's current membership, presence, `watch`, `tools` and scope. It MUST apply the normal `tool.before`, approval and final dispatch checks. The executable request MUST pass the executor's output gate unchanged, including name, arguments and call identity. If it is withheld or changed, the Harness MUST NOT hand it off. Showing another recipient a call or an approval is not a handoff.
- The Harness MUST commit `toolStarted` and its [Interface handoff checkpoint](bindings/data.md#interface-handoff-records) together before handoff. It MUST consume the allowance once. The checkpoint binds the call to the registered executor and route, records the executor's rights ceiling and sets an absolute deadline from the configured timeout. The host's clock decides expiry. No connection, replay or retry extends it. The Harness MUST never dispatch this call a second time, including when delivery is uncertain. A binding can delay release of an already staged request. Before release it MUST redo the final checks; staging does not give future permission to send.
- The invocation relinquishes execution to the Interface. The Harness MUST return pending to the Runtime, not a provisional result. The Runtime MUST treat the checkpoint as a pending disposition at `step.after` and include the call in `openToolCalls` if the turn completes with it left open. A failed, cancelled or limited turn MUST settle its Interface calls instead. Expiry before the originating turn ends settles the call in that turn, not in a continuation. This form does not open a question or use `toolPending`.
- After the originating `turnEnd`, the Harness MUST accept at most one valid report for an open call on the current branch, before its deadline. The report MUST match the session, canonical call ID, recorded executor actor and route. The reporting connection MUST authenticate independently and still have scope, with current `watch` and `tools` intersected with the recorded executor ceiling. Representation alone does not qualify. Another connection for the same actor on the same authorized route can report; a connection on a different route cannot take over. The Harness MUST NOT transfer the call or send its executable request again. A report before the committed end is not ready and can be retried. Rejection, duplication or timeout MUST NOT cause dispatch or disclose another actor's result.
- The Harness MUST serialize report acceptance with expiry, cancellation, branch changes and pending erasure. The first valid terminal commitment wins. The report is data from the authenticated executor, not approval, a hook decision or authority. The Harness MUST validate the report, run `tool.after` on the proposed terminal result and commit the checked result with the reporting actor. It MUST use the usual result schema and processing-failure rules. It MUST NOT store a raw report separately or substitute the executor's rights for the original work's rights.
- Disconnect clears presence. It MUST NOT settle the call or cancel the originating turn solely because the executor is gone. At expiry, cancellation or abandonment, the Harness MUST use `outcomeUnknown` if handoff may have occurred and no result or confirmed cancellation is known. If it can prove there was no handoff, it MUST apply the normal pre-dispatch statuses. An open call holds its call reservation until terminal commitment.
- The Harness MUST reuse the [continuation queue](#questions). An ended turn is ready when all questions behind its other open calls are closed and all its Interface calls have terminal results, including system settlements. A result-only continuation has no calls to dispatch: it uses the committed results in context. Mixed continuations rerun only eligible question-backed calls. The originating work authorizes any new effects under current rights. Neither the reporting connection nor timeout supplies authority.
- On reopen the Harness MUST restore the deadline, route and ownership from an intact checkpoint, not from current advertisements. Before an interrupted turn resumes, it MUST withhold these calls from dispatch and settle expired calls or calls whose checkpoints cannot be restored. An eligible durable Runtime restores the pending disposition; a transient Runtime ends the interrupted turn as failed. If the originating turn already ended with the call open, interrupted-turn support is not needed to receive the result. If the checkpoint, branch, route identity or scope cannot be restored, the Harness MUST NOT accept reports or repeat the call. It MUST settle it under the ambiguous-start rule. Readers without this feature MUST NOT try to continue such a call from the stored start.
- For erasure the Harness MUST treat handed-off arguments and returned results as copies in the [copy set](#erasure). It MUST invalidate affected pending handoffs, reports and buffered delivery, settle as above and preserve terminal identity. It MUST account for a known or possibly delivered copy outside its control as `outOfReach` unless deletion is confirmed. No affected continuation may start from an erased report or checkpoint. Tombstoned data cannot authorize a report or continuation. Moving away from the handoff, closing the session or cancelling the open call MUST settle it or be refused under the existing lifetime rules. A plain disconnect is not any of those operations.
- With [telemetry](telemetry.md), the Harness MUST end the `execute_tool` span at handoff with status `pending`. It MUST use a separate `modular_agent.tool.settle` span for a later terminal decision, parented to the authorized reporting operation when available and linked to the handoff span when its context is available. A timeout has no reporting parent. Neither span records arguments, results or route credentials. A continuation starts a new turn span and links to its originating turn when available.

### The output gate

- The Harness MUST authorize each recipient view under current rights, project and tenant before gating it. The gate covers all recipient content sent by the agent, including replay, the content of replies and errors, approvals, command results and streamed events. Content-free protocol errors carry no recipient content.
- The Harness MUST keep internal capability calls and authorized internal raw access separate from recipient delivery. A plugin gets raw records only when explicitly allowed by the Harness; being an Interface or following events does not confer raw access.
- The gate MAY answer `null` to allow, `{ block: true }` to block, or `{ events }` to redact.
- For `{ events }`, the Harness MUST accept only redactions that preserve event count, order, types and structure and change only unprotected strings. The protected keys and JSON comparison are in [Output events](bindings/data.md#output-events).
- The Harness MUST block invalid answers and gate failures rather than send unchecked output. A withheld reply uses the binding's content-free error; see [ACP](bindings/acp.md#output-gate). Without a gate handler, authorized views pass unchanged.
- The Harness MUST submit any held stream by its end, including interruption, loss or pending for a tool, and block held output it cannot safely buffer or gate. `holdsOutput: false` means no whole-stream buffering guarantee.
- The agent MUST declare bypassed output before enabling it. The operator MUST NOT enable it where policy requires gating. Bypassed output never reaches the gate.

### Erasure

- In normal use the history store MUST append without modifying or deleting committed entries. Erasure and retention are separate operations.
- The Harness MUST compute the transitive copy set, including controlled copies outside the history store. It follows requests into responses, prompts and context into turn snapshots, calls into results, and responses and results into turn results. It follows summaries, fork copies, jobs and reports, and both admission and taking of input. See [shared record lineage](bindings/data.md#recording-order-and-ownership).
- The history store MUST apply erasure to the exact ids sent by the Harness and leave tombstones without erased content. The Harness MUST preserve authority, accounting and the control facts needed to prevent replay of erased work, following the [shared erasure fold](bindings/data.md#session-state).
- The Harness MUST authorize and validate the requested targets before starting erasure, honor `erasureDuringTurn` and durably mark the known copy set pending before deletion. It MUST follow [Cross-session coordination](#cross-session-coordination) wherever copies can span sessions. With an ephemeral record, the mark need not survive the loss of all its copies, but MUST survive as long as any controlled copy does.
- The Harness MUST request Provider state discard and deletion of known remote copies and reset state before further affected model requests. Unconfirmed deletion is not success. A description of an out-of-reach copy is text for a person. A receiver MUST NOT branch on its wording.
- The record MUST preserve permitted content losslessly, including unknown types, except for retention or erasure. Secret values and protected launch material are excluded at write time. The core does not promise deletion of copies it cannot identify or control.

#### Cross-session coordination

- Every participating reader and writer MUST use the same authoritative pending state for the history it shares, including agents reopening portable sessions and instances already holding leases. The operator MUST provide that state, or restrict the deployment to a scope the Harness can coordinate itself. A mark kept only by the initiating process or in the source session's history is not sufficient for shared copies. The Harness MUST refuse a new erasure as unavailable before deletion if it cannot establish the required coordination. For shared HTTP history, see the [pending-erasure registry profile](bindings/history-http.md#pending-erasure-registry-profile-pendingerasure-1).
- The durable intent MUST identify the operation, the source targets, the known copies by stable session and entry IDs (or an equivalent stable handle for a non-record copy), and progress for each copy. It MUST NOT store erased payload. The Harness MUST serialize publication of the pending marks with the final checks for delivery, dispatch and publication of copies. It MUST include copies published before that cutoff. A copy not yet published MUST NOT become usable after the cutoff; if it cannot be prevented, it MUST be tracked as pending before it can be read. Copy lineage MUST be discoverable by the other participating agents. How a deployment stores or indexes this state is not a wire rule.
- Until erasure is confirmed, the Harness MUST treat pending content as unavailable in every view, including history, live and buffered output, plugin reads, receipts, model context and recovery. It MUST refuse a fork or replay that would copy or disclose the content. It MUST invalidate cached views, cancel or settle affected work and stop it from recreating pending content. A check made earlier at session open or at the output gate is not enough. If freshness cannot be established, the Harness MUST refuse reads and effects for any scope it cannot rule out as affected. It cannot recall payloads delivered or effects handed off before the cutoff.
- The Harness MUST take current writer access to each affected session before changing its records. Held sessions stay pending; the Harness MUST NOT evict their writers or bypass a lease. The current writer, or a writer that later acquires the session, MUST reconcile pending work before serving affected views, replaying history, recovering work or admitting new effects in that session. It MUST settle work that would otherwise need the erased data for recovery, then commit the session's `erasure` record, including any input-key reservations, before tombstoning. Work already authorized by the durable intent completes as system work, not as a new grant to act in the destination session.
- The Harness MUST retry pending work while available, including on restart and on writer acquisition. It MUST verify tombstones under current writer access after uncertain writes, reuse the same bookkeeping record on replay, and mark a copy complete only with confirmed deletion and required bookkeeping. Missing records, retention and lost replies do not prove deletion; they leave an obligation pending until reconciled. Completion MUST NOT permit stale readers, restored state or new copies of the erased payload. The operator MUST enforce the [restore freshness rule](security.md#data-the-record-views-the-output-gate-and-erasure).
- Reports MUST distinguish confirmed `erased` copies, outstanding `pending` copies and `outOfReach` copies (known but outside the guarantee, including unconfirmed external deletion when no stable handle is reportable). The Harness MUST retain any retryable obligation even when a report has no way to name it. A repeated authorized request for the same targets MUST reconcile the existing intent and report current progress, without repeating committed changes. An `entries erased` event MUST describe confirmed deletions only. All reports and events MUST apply recipient scope and visibility; erasure authority at the source does not grant access to other sessions. See [ACP erase](bindings/acp.md#extension-methods).
- The agent MUST NOT declare `erasure` for a scope where it cannot enforce pending erasure across the readers, writers and controlled copies it serves. The presence of portable history or a store erase method alone does not establish this support.

### Recovery and repeating work

A commit is a successful write to the session's store. For an ephemeral session the record is in memory and has no restart guarantee.

- The Harness MUST commit `turnStart` and the input it takes before invoking the Runtime. It MUST commit each `modelRequest` and `toolStarted` before dispatching to inference or executing the call. For wire Providers, the [Provider request boundary](bindings/plugin.md#the-host-asks-a-provider) separates request preparation from inference.
- Each model attempt MUST have a fresh `stepId` and a recorded repeat-safety decision from the Provider's declared support. A retry is a new request/response pair, not a second response to the old step. The [recorded final offer](bindings/data.md#recording-order-and-ownership) governs which calls from that attempt can run.
- The Runtime MUST record a response before agent-executed calls from it start. It MUST record in-process Provider-run calls and results on receipt without dispatching them again.
- For in-process dispatch other than [Interface-run tools](#interface-run-tools), the Runtime MUST run `tool.after` on the terminal result and commit the checked result before the next step. For `/1`, the host MUST finalize and commit the checked result before returning it to the Runtime, as in [Runtime records and effects](bindings/plugin.md#runtime-records-and-effects).
- Except for provisional setup, the Harness MUST commit a mutation before reporting success and make it visible to the next request. Refresh failure does not change an already committed result.
- If a commit fails or writer access is lost or uncertain, the Harness MUST stop starting effects in the session, cancel running calls and leave the session interrupted for recovery on reopen. It MUST emit session interrupted to every follower of the session, and settle each caller waiting on work in it, such as an input whose turn has not ended, with `lost`. Nothing about the interruption is recorded, since the agent can no longer write the session. [History service](bindings/history-http.md#writing-one-writer-at-a-time) defines lease renewal, loss, reconciliation and resend rules.
- The Harness MUST recover from committed checkpoints: the turn start with its [admission or continuation context](bindings/data.md#context-and-interrupted-work), model attempts and responses, call starts, pending dispositions, terminal results, hook decisions and turn end. A transient Runtime MUST end an interrupted turn as failed. A durable Runtime MAY continue from an intact checkpoint. The Runtime MUST NOT rerun a committed hook decision. If a lost hook decision other than `step.after` could allow a forbidden step and cannot be safely reconstructed, the Runtime MUST fail closed.
- Before handing an interrupted turn to the Runtime, the Harness MUST settle every unresolved call ineligible for initial dispatch or repeat, except calls with an existing pending disposition under [Questions](#questions) or [Interface-run tools](#interface-run-tools). It MUST pass only calls eligible for initial dispatch or repeat and leave current gate and dispatch checks in force.
- On resume the Harness MUST restore the last answered step from the checkpoint, excluding auxiliary attempts and bookkeeping settlements. If there is a committed `step.after` decision for that step, the Harness MUST return it to the Runtime for reuse. If the Harness establishes that no decision committed, the Runtime MUST run the gate once at the [hook boundary](#hook-execution). The Harness MUST accept that gate invocation at this boundary. If the Harness cannot establish which case applies, it MUST fail the turn closed. See the [shared checkpoint records](bindings/data.md#recording-order-and-ownership) and [plugin resume request](bindings/plugin.md#the-host-asks-the-runtime).
- The Runtime MUST NOT repeat a call with a committed terminal result anywhere in the session. It MAY repeat an unsettled started call only with identical recorded and current registrations, recorded and current repeat-safety promises from tool and environment, and confirmed cleanup. Read-only and containment alone are not evidence.
- Before a recovered repeat is dispatched or its new start recorded, the Harness MUST compare the final input after current gates to the previous `toolStarted.data.call.input` by [shared JSON equality](bindings/data.md#general-rules). If they differ, it MUST settle the call as `outcomeUnknown` without repeating it.
- The Harness MUST use `outcomeUnknown` for an unsettled started call that it cannot safely repeat or otherwise settle from confirmed facts. The Harness MUST settle a known unstarted call that is abandoned as `notStarted`.
- After ambiguous model failure the Runtime MUST repeat only the same final effective request with recorded and current repeat support from the same Provider. A stateless Provider running no tools qualifies; otherwise an explicit promise is needed. If the request was erased or cannot be reconstructed, the Runtime MUST NOT repeat it. Its outcome is unknown.
- The Harness MUST assign history metadata and retain ownership of authority, admission, dispatch and lifecycle records. It MUST NOT accept Runtime assertions as proof of authority, dispatch or outcome. It MUST validate that a submitted response matches a model attempt it recorded. For a remote Runtime it MUST treat a submitted tool result only as a reference to the result the host already committed, not as a new result. See the [plugin binding](bindings/plugin.md#runtime-records-and-effects) for the allowed kinds and errors.

### The working environment

- The working environment MUST declare `commandContainment` for the current platform: `strong` covers all descendants; `processGroup` covers only the command's process group; `none` makes neither promise.
- The Harness MUST stop background commands when their session or process ends within that scope. Outliving a call or cancelled turn is not itself a fault.
- Before resuming work after interruption, the Harness MUST confirm cleanup of prior work that could race it or refuse automatic recovery of the affected work. An affected tool call with an unconfirmed outcome is `outcomeUnknown`.
- The working environment MUST issue point IDs that cannot collide with those saved by another environment. It MUST report a point it did not save as `not_found` on restore. See [Rewinding](bindings/data.md#rewinding) for failed restores.
- The working environment SHOULD refuse file operations that resolve outside the session's project after following symlinks. The `confinesFiles` declaration reports this property; absence means false. Command containment limits process lifetime, not what a command can reach. See [Security](security.md#what-an-operator-configures) for when to use a sandbox.

### Authority

- The Harness MUST use one Actor shape `{ id, kind, rights }` and read a recorded `plugin` kind as `program`. The Actor table lists the current kinds.
- The operator MUST configure each Interface connection's stable actor id, kind, rights, allowed tenants and any additional actors it may represent. The Harness MUST derive representation from that configuration and the [authenticated connection](security.md#authentication-on-each-wire), never from session membership or a join. When acting for another member, the Harness MUST record both identities and check their shared effective rights.
- The agent MUST default `joinOnOpen` to true for a single-user local agent and false otherwise. The Harness MUST apply the following connection actor rules and check the required right before creating or joining:

  | Session and actor state | Action |
  |---|---|
  | Creating a session | The Harness MUST record the configured actor with rights narrowed by the tenant. |
  | Opening as a recorded actor who has not left | The Harness MUST use the actor's recorded rights, not replace them with configured rights. A transport may impose a narrower connection ceiling, as [ACP over WebSocket](bindings/websocket.md#an-agent-service) does. |
  | Opening as a recorded actor who left | The Harness MUST refuse the open. |
  | Opening as an unrecorded actor | The Harness MUST refuse unless operator policy admits that principal for this session's project and tenant, `joinOnOpen` is enabled and the session supports another member if needed. It MUST check effective `watch` before recording rights narrowed by the session and tenant. |
- Builds sharing sessions SHOULD configure the same stable principal ids. Rights are session-wide, not branch history that a move can undo.
- The Harness MUST check effective rights at each action and delivery, including plugin callbacks. Effective rights are recorded rights intersected with current tenant and session ceilings, except that the session ceiling does not remove `administer`. If the binding imposes a connection ceiling, the Harness MUST also apply it to work and deliveries on that connection.
- The Harness MUST derive project and tenant scope from the trusted connection and composition, not from a request, recorded grant or supplied ID. It MUST check the stored scope before attachment and recheck it at each session action, effect and delivery, including across reopens and in callbacks and relays. A continuation, job, job report or child MUST stay within the scope of its originating work; a recorded grant or known ID cannot extend that reach. The Harness MUST retain the effective rights of admitted work as its starting ceiling, including any connection ceiling. Loss of the connection does not raise it.
- The Harness MUST record who caused work and who authorized it, including releases, represented actors, steering and ancestors. Work MUST stay within its recorded starting rights and the current rights of every contributing actor and ancestor, under every applicable ceiling. If required provenance is unavailable the action is refused. `mixedActorInput` chooses intersection or refusal, not a more privileged actor.
- A job MUST act with its `jobStarted.data.rights` intersected with its starting actor's current effective rights and every current ceiling. Without the recorded ceiling the Harness MUST refuse the work. A report MUST act as the job, not its starter.
- Creation and authorized join on open are operator grants. The Harness MUST record operator admission as their source. Other joins, changes of rights and removal of another actor MUST require `grant`. A grant MUST NOT exceed the granter's effective rights. The Harness MUST record the granter's id. Removing connection representation does not widen or reset recorded membership.
- The Harness MUST apply the following rights at minimum. Compound operations check each constituent action.

  | Right | Operation that requires it |
  |---|---|
  | `watch` | discover, open and read visible sessions; follow; list visible actors, proposals, jobs and requests |
  | `propose` | admit input that awaits release |
  | `input` | create a session; give, steer, release or decline input; withdraw another actor's proposal |
  | `answer` | answer a question other than approval |
  | `approve` | answer an approval |
  | `tools` | dispatch a call; report a previously handed-off Interface result on its bound route; admit host-supplied MCP servers |
  | `cancel` | cancel a turn, call or job, including on session close |
  | `settings` | change session settings; move, rewind or fork |
  | `erase` | erase history |
  | `grant` | join, change rights or remove another actor |
  | `jobs` | start a job |
  | `delegate` | start a subagent |
  | `administer` | set or remove the session ceiling |

- The Harness MUST check scope before composing or loading project parts and before creating any session, including a fork or child. It MUST filter discovery before returning results or issuing cursors. For a connection's request to close the session, the Harness MUST require membership and require `cancel` only if a running turn, unfinished job or open Interface call would be cancelled. The Harness MUST check this at the close cutoff before stopping admission or making any other change. A connection MAY always detach its own view without closing the session. An actor can withdraw its own input or leave without `grant`.
- The Harness MUST keep unknown fields and names inert. No unknown field or right widens authority or changes how known fields are checked.
- The Harness MUST treat project files (including `AGENTS.md`), tool and Provider output, and peer and subagent messages as untrusted content. They can shape what the model says, not what it is allowed to do. Tool names and model claims do not establish read-only status.
- The Interface MUST clear a connection's presence on disconnect. An actor counts as present while at least one open connection acts for it and marks it present. Following events alone is not presence.
- The agent SHOULD keep grants, revocations, limits, tenant assignment, approval answers, gate refusals, secret storage by name, erasure and plugin loading reachable to the operator for as long as history is kept. These are existing entries or standard events, not a new audit channel.

**From [ADR 0035](adr/0035-host-limits-from-the-ops-desk.md).** A plugin listener may name the Harness that authenticated the connection. That name is not an actor in the session. It adds no rights to the original work and cannot stand in for the scope or live parent a callback requires.

### Limits and tenants

- The Harness MUST require `administer` to set a session limit. The replacement set MUST fit within the administrator's own rights narrowed by its tenant, not by the limit being replaced.
- Removing the ceiling with `null` MUST require every standard right under that same tenant check. A session ceiling cannot remove `administer`.
- A connection MUST use only tenants the operator allows it to create, list, open, fork or follow. The Harness MUST refuse an unauthorized tenant and refuse omission when that connection must use one.
- The Harness MUST keep the creation tenant fixed and pass it to every fork and child. Tenant policy comes from outside the project.
- The Harness MUST check the tenant token budget before each turn, after each step and before any model dispatch. If reported input plus output tokens meet or exceed it, the Harness MUST refuse dispatch and end any enclosing turn with `{ kind: "limit", limit: "tenantTokens" }`. Attempts already running can overshoot. Hard caps are out of scope.
- The agent MUST durably tally reported tokens by [metered identity](#identities-and-usage) and reconcile committed usage before new dispatch after restart. It MUST NOT charge imported or copied usage or reduce charges for retention or erasure. Unreported tokens do not supply a charge. Each deployment counts work it runs.
- Work and storage limits are separate from rights ceilings and reported token budgets. See [Resource reservations](#resource-reservations).

### Resource reservations

- The Harness MUST enforce finite bounds on pending input, unfinished calls and jobs, buffered bytes and storage use per session, per tenant (including one bucket for sessions without a tenant), and across the agent. It MUST test and charge all applicable bounds atomically with authorization and admission or start. Per-project compositions behind one serving agent MUST share its aggregate bounds. Across independent agents the operator MUST allocate non-overlapping shares of any common capacity or provide shared enforcement; an independent agent's counter cannot reserve another's capacity.
- Before committing new input, the Harness MUST reserve its retained payload and the capacity to record and report its disposition, including hand-back. This applies to steering, proposals and queued input. A duplicate receipt adds no work and takes no new work reservation. Release and taking transfer existing obligations; before a turn starts the Harness MUST reserve its start, required input records and terminal outcome. Queued input MAY wait for turn capacity but MUST remain possible to hand back. The Harness MUST preserve queue order and MUST NOT let a refused admission claim a key.
- Before handing off a model attempt (including an auxiliary attempt), tool call (including a nested call), direct command with effects or job, the Harness MUST reserve execution and recording capacity for its intent and settlement. Reserve a question's closing record before opening it, and retain the obligation for an open call across turn end and continuation. A job that can report MUST reserve an input slot and bounded space for its report at start, transferable to its keyed admission at job end. The Harness MUST reserve any mandatory follow-up bookkeeping, including when a job's cleanup is unconfirmed.
- Before accepting a response with tool calls into history, the Harness MUST reserve enough to settle every call in it, even if none can start. When capacity cannot cover the call list, it MUST record a bounded failed response with no call parts, preserving any reported usage, and run none of those calls. The enclosing turn stops at the capacity limit. This rule does not turn already-run Provider effects into unstarted calls: a Provider that can cause such effects MUST fit a bound proven before dispatch, or the Harness MUST disallow them. Once a call has been recorded, capacity denial alone is `notStarted` if no attempt could have run; an earlier ambiguous dispatch remains `outcomeUnknown`.
- The Harness MUST include both processing capacity and durable write space in its reservations, including batch and individual entry size limits. The write-space quota counts retained encoded records and outstanding write obligations; for a backend that writes an atomic replacement, the operator MUST provide the extra physical space the replacement needs, which does not enlarge the quota. Ordinary work, plugin records, optional output and slow recipients MUST NOT consume capacity reserved for settlement. The Harness MUST bound data retained for settlement. If a payload cannot fit, it MUST use a minimal factual record preserving the required identities, status, usage and replay controls; it MUST report `result_too_large` separately for oversized results. A minimal job result, if reported, MUST be the same bounded result in both records. The Harness MUST NOT use a smaller payload to evade result-shape checks or claim success for an unconfirmed effect.
- The Harness MUST retain reservations until the corresponding commit and any required cleanup are confirmed, or the obligations are transferred to another reservation. Consumed write space counts as retained storage, not as free capacity. The Harness MUST reconstruct outstanding obligations before admitting work or starting effects after loss or restart. It MUST NOT spend that capacity on new work even if an operator lowers a limit below existing obligations. If a reserved commit fails or becomes uncertain, the Harness MUST interrupt the session under [Recovery](#recovery-and-repeating-work).
- The Harness MUST refuse a new admission or direct start that cannot reserve capacity with `busy`, without effects or a receipt. Inside an admitted turn, a host capacity limit that prevents another model attempt or accepting its call list MUST stop the turn with `{ kind: "limit", limit: "capacity" }`. If intent for an unstarted attempt already committed, the Harness MUST close it with the existing bookkeeping response before returning the limit. The normal cancellation cutoff takes precedence. Merely leaving a call open is not a limit.
- The declaration MUST report enforced count ceilings for input slots (including reserved job reports), unfinished model attempts and tool calls together (including open calls), and unfinished jobs, at each scope. Multiple charges for the same obligation at different scopes count once in each scope. In the agent declaration, variable session and tenant ceilings use the most restrictive value; a session declaration uses its applicable ceilings. Report configured bounds, not live occupancy. The operator MUST also be able to inspect processing, storage, size and control headroom limits without exposing other tenants' state. See [ACP declaration](bindings/acp.md#the-declaration) for the wire mapping.

### Questions

- The Harness MUST record the question before asking and keep its `answerers` restriction, if supplied. Absent means any session actor with the required right. An answerer need not have all the asker's rights.
- The Harness MUST check current effective rights, answerer membership and branch eligibility when accepting or reusing an answer. It MUST serialize answers and system closures and accept only the first valid committed decision. It MUST record a system closure as `inputAnswer` with no `actorId`, `declined: true` and a reason.
- A question key MUST bind the question to its session and originating work, including the exact call when applicable, kind, text, details, options, answerers, deadline policy and credential name. The Harness MUST reject changed bindings under the same key. A recorded allow for a changed effect is not reusable.
- An untimed question MUST wait until answered or closed. The Harness MUST close an unanswered non-approval question as `noLongerAnswerable` when no session member is eligible, not merely because eligible members are offline. The Harness MUST preserve the original deadline and decide expiry at serialized host decision time, not client send time. Expiry of `leaveOpen` ends only the wait. See [Questions on the wire](bindings/data.md#questions).
- Except for a declared [approval that waits](#approvals-that-wait), an approval MUST NOT outlast its turn. If still unanswered at its deadline, the Harness MUST decline it with `timeLimit`. If later work needs approval for that exact call, the Harness MUST ask a new question under current rights, not reopen the expired question.
- The agent MUST NOT let a question outlast its turn without `lateAnswersStartTurns` and `questionsOutlastTurns`. A question-backed pending reply MUST refer to a committed non-approval question tied to that call whose wait expired with `leaveOpen`, or to the pre-dispatch checkpoint for a declared waiting approval. The latter never uses `leaveOpen`. Only `tool.before` can return pending among the gates.
- Leaving a call open is not a limit. When a turn ends because its remaining calls are left open, the Runtime MUST end it `completed` with those calls in `openToolCalls`, unless a real limit, cancellation or failure ended it first. The Harness MUST NOT rewrite a Runtime's outcome; it MUST refuse an outcome that disagrees with committed state.
- The Harness MUST close unanswered requests with reason `cancelled` when it cancels their work. Seeing a question or its link does not authorize acting on it.
- A tool leaving a call open MUST make outside effects before relinquishing execution safe to repeat, or ask before effects and cause none while leaving it open. On `pending` it MUST have stopped all work started by that invocation.
- The Harness MUST commit [`toolPending`](bindings/data.md#standard-kinds) before accepting a `pending` reply as a checkpoint. It MUST continue the recorded call only in a continuation turn after a committed `turnEnd` listing it, even if the answer or pending disposition commits before `turnEnd`. There is no in-turn re-entry.
- On recovery before `turnEnd`, the Harness MUST include calls with a recorded pending disposition in `openToolCalls` without invoking them in the interrupted turn, except on cancellation or terminal settlement. If a `leaveOpen` deadline has passed with no answer or closure before it and no pending disposition proves relinquishment, the Harness MUST close that invocation's still-open questions as `noLongerAnswerable`. It MUST settle the call without dispatch, as `outcomeUnknown` if it may have run or `notStarted` otherwise.
- When `turnEnd` has committed, all questions behind its open calls are closed, including by decline, and any [Interface-run calls](#interface-run-tools) have settled, the Harness MUST queue one continuation in ready order. Its derived queue key is `continue:<turnId>`, not an input admission key. The continuation MUST NOT create or take an `inputAccepted` or `input` to start. It MUST rerun only eligible question-backed calls without a committed terminal result, through all checks. It MUST NOT rerun an Interface call. The original work actors authorize dispatch. Answerers authorize only their decisions; a decline or ineligible answer cannot allow dispatch.
- For other interrupted in-turn waits, a durable Runtime with `waitingThroughRestart` MUST ask again with the same key. Without that support the Harness MUST close it as `noLongerAnswerable`; the Runtime handles the closure as declared. Only calls already left open past their turn use late-answer continuation.

### Secrets

- The Harness MUST enforce credential access by capability, name and authorized scope. A plugin MUST NOT read credentials for Providers it did not register. The Harness MUST NOT give credentials to the Runtime.
- If the store or name is missing, the Harness MUST decline a secret question before asking. A secret question MUST NOT target registered Provider credentials.
- The Interface MUST send a secret only to the store on its authorized path. The store MUST accept at most one stage per deployment, session and request ID, even if discarded. It MUST atomically save the staged value, receipt and current generation of the credential slot the stage would replace. Until activation it MUST keep the stage invisible to credential lookups and leave the active value unchanged.
- The Harness MUST check the staging receipt for the current request, credential name and eligible answerer without reading the secret. It MUST commit [`secretAnswerAccepted`](bindings/data.md#standard-kinds) before activating that stage. This selects the winning submission and bars other answers or closures while activation is unresolved; it is not a terminal answer.
- On first activation the store MUST atomically activate that request's single stage only if the slot generation still matches, advancing the generation on replacement. Every change to the slot, including deletion, MUST advance its generation. If it does not match, the store MUST return `superseded` without changing the slot. The store MUST keep `activated` and `superseded` decisions idempotent by request ID. Replaying a successful activation does not replace a newer value.
- After confirmed activation the Harness MUST commit the stored-name `inputAnswer` before acknowledging success or allowing reuse. On `superseded` it MUST close with a declined `inputAnswer` and reason `superseded`. An unconfirmed activation is not a terminal answer.
- On recovery the Harness MUST finish a committed activation decision before reusing or answering that question. The Harness MUST discard staging for a committed decline, including on recovery. Discard MUST prevent later staging for that request. Without a committed decision, staging remains unusable. On recovery the Harness MUST decide the interrupted question again under current eligibility and deadline, discarding any unselected stage. If another submission is needed after discard, it MUST use a fresh question ID and key.
- The agent MUST NOT put the value in history, model context, hooks, events, errors or logs. Only the stored name is returned to the asker and recorded.
- A protocol that forbids secret entry MUST NOT carry the value. An independently authorized path to the store can answer it; otherwise the question is declined.

### Jobs

- A plugin MUST start a job through the Harness for its session and actor. The Harness MUST record the start, owner, effective starting rights and cause before the job runs. A job key is scoped to the owning plugin and session. A plugin MUST NOT put content in a job key. The Harness MUST reserve used keys for the session's life, including after erasure. On a duplicate the Harness MUST return only `{ jobId, started: false }` with the original job id. See [Job key reconstruction](bindings/data.md#session-state).
- The Harness MUST accept one terminal outcome per job. It MUST acknowledge an identical end retry only when it can compare it to a retained live end. A tombstoned end still settles the job but does not support end retries. Taking up an unfinished job is exclusive to its owning plugin.
- The Harness MUST commit and recover reports using [Job reports](bindings/data.md#job-reports).
- With `startsTurnsUnasked: jobReports`, the Harness MUST add a new report to the ready queue. Otherwise it MUST park the report until explicit authorized release. A release MUST preserve job attribution and act with the job and releaser's shared current rights. A released report MUST take its own turn, not steer another turn. Parked reports do not block ready input. See [ACP release](bindings/acp.md#several-actors).
- A job whose result returns in its starting call MUST NOT also report that result as input.
- On close the Harness MUST cancel jobs and wait up to the cancellation deadline. Turn cancellation MUST leave jobs running unless `cancellingTurnCancelsJobs` is true. Process stop MUST interrupt jobs rather than end them.
- If cancellation reaches its cutoff without confirmed cleanup, the Harness MUST leave the job unfinished, commit [`jobCleanupUnconfirmed`](bindings/data.md#standard-kinds) and refuse further callbacks from that execution. A cleanup timeout does not prevent close after the marker commits. A job MUST start or resume at most once per plugin connection.
- Without the owning plugin, the Harness MUST leave unfinished jobs listed as unfinished on reopen. It MUST NOT end a job itself except on explicit cancellation of a job whose plugin is gone, by an actor with `cancel`. For that cancellation it MUST record `jobEnded` with outcome `cancelled`. That record does not prove an external effect stopped.

### Subagents

- The Harness MUST start a child as a job with the parent's project, tenant, plugins and copied settings, excluding host-supplied MCP servers. It MUST give the child only its task, not the parent's history by default. A model override MUST pass the applicable settings and model availability checks.
- The Harness MUST check the child depth limit before starting work, with root depth zero and default maximum three. The build MUST declare the maximum. The core names no wire key for it.
- A follow-up to a finished child MUST start a new job on the same child. The Harness MUST refuse a follow-up to a busy child.
- Each relay MUST record its parent link, route a child's question and answer one hop at a time, and recheck eligibility and authority at each hop. A secret answer relays only its stored name.
- The owning plugin MUST keep the child's job unfinished while that child has calls open.

### Configuration and trust

- The Harness MUST load only operator-approved plugins and dependencies. It MUST use only current trusted configuration for launches. The operator MUST grant and store project trust outside the project. The Harness MUST check that trust at composition time. History is not launch authority. An untrusted project cannot select launchable code or alter policy or credentials.
- The Harness MUST compose global plugins first, then trusted project plugins and options, merged by plugin name, within operator and tenant policy. It MUST use a stable configured order and refuse composition errors without partially installing registrations.
- When reading optional project files, such as instructions or settings read by convention, the Harness MUST skip a file if the session's working environment returns `not_found` or `not_supported`. It MUST fail preparation on any other read error and report the failure. It MUST NOT fall back to another environment. See [Paths and points](bindings/plugin.md#paths-and-points) for the wire mapping.
- Configuration files MUST NOT set Harness-owned authority or parentage. The Harness MUST record changes to live session settings under [Settings](#settings). The deployment defines how it identifies and revokes project trust; see [Security](security.md).

### MCP servers

- The Harness MUST start host-supplied MCP servers only with the connection actor's current `tools` right and operator permission (`hostMcpServers`). The default is allowed for ACP over stdio and denied for network Interfaces. Such servers run with the agent's permissions.
- The Harness MUST validate the full requested set before launch. On partial startup failure it MUST tear down the started set without claiming its effects were undone. It MUST scope the servers to the session, close them with it and require new specifications on reopen. It MUST NOT record or disclose their environment values or headers. Tool approval policy governs calls, not server startup.
- Before exposing any tools from a host-supplied set, the Harness MUST validate authorization and collisions with the session catalog. It MUST refuse a conflicting list rather than shadow a tool.
- The Harness MUST report a definite pre-dispatch server failure as `failed` and a loss after send without a confirmed result as `outcomeUnknown`.
- The Harness MUST treat missing tool annotations conservatively: potentially side-effecting and open-world, not safe to repeat, not parallel.

### Parts that are lost

- The Harness MUST identify a lost part to affected callers without claiming results it cannot establish. Known unstarted and possibly dispatched work follow different statuses in [Tool dispatch](#tool-dispatch).
- Lost handlers MUST follow the failure rules in [Hook execution](#hook-execution). The Harness MUST report a lost Runtime or store rather than silently replace it. [Recovery and repeating work](#recovery-and-repeating-work) applies to interrupted work.
- Work MUST have no implicit timeout except where the binding provides one. Authorized cancellation MUST cut off new dispatch on receipt. The cancelled request MUST receive a reply within five seconds of cancellation receipt. That reply does not prove termination.

### Provider state

- The Provider MUST reuse state only for an exact prefix of the final ordered context after middleware in the same authorized session, branch and model. Without proof it MUST start fresh without adding omitted history. Opaque state never crosses Providers.
- The Harness MUST reset Provider conversation state on move, fork, compaction, erasure or model change before any affected request. If reset cannot be made safe, that request is refused.
- The Harness MUST authorize the final Provider and context at [dispatch](#tool-dispatch). For in-process Provider-run tools it MUST send an explicit allow list, empty by default. It MUST exclude tools that lack current authority, need a call-specific check or have a `tool.before` handler. With an approval plugin, only `off` or `ask` with a trusted read-only definition permits inclusion. A Provider unable to honor the list and validate each argument against the offered definition MUST NOT run tools. The list does not fence an already dispatched Provider request.
- The agent MUST declare `runsToolsAtProvider: true` for a session using Provider-run tools. Such sessions, live sessions and late batch responses are outside `/1` wire and portability. See [Plugin binding](bindings/plugin.md#the-host-asks-a-provider).

### Moving and rewinding

- Every move MUST target a quiescent entry on the current branch: a `turnEnd` or an entry recorded outside all turns. The Harness MUST commit a `position` for a plain move without restoring files. The Harness MUST cancel and settle unfinished work left behind or refuse before moving, as `movingWithUnfinishedWork` declares. Cancellation requires `cancel`.
- The Harness MUST refuse a fork without `forking` support or while the source session has unfinished work. A fork MUST inherit the source's current settings, recorded actor state and session ceiling, not their values at the fork point. The Harness MUST NOT carry live work, connection presence or host-supplied MCP servers into the fork. Copied history does not authorize replay of source inputs, questions, calls or jobs as new work.
- With `rewinding`, the Harness MUST save a project point before each turn or out-of-turn tool execution and record it on its start entry.
- The Harness MUST refuse rewind without `rewinding` support or while another hosted session uses the same canonical project. It MUST refuse before changing anything if the session has unfinished work, a job started after the target, or any later turn or out-of-turn call lacks a point from the same environment and project. The Harness MUST check every such point without changing anything before starting the [rewind journal](bindings/data.md#rewinding), using [`env/checkPoint`](bindings/plugin.md#paths-and-points) for a remote environment. It MUST refuse rewind if any required point cannot be verified. The Harness MUST serialize rewind, including preflight and restore, with its own opening and use of that project by other sessions. Rewind restores the whole project. See [Security](security.md#what-an-operator-configures) for shared projects.
- The Harness MUST select the earliest recorded point in branch order after the target. With no later turn or out-of-turn call it MUST move without restoring a point.
- The Harness MUST follow the [rewind journal](bindings/data.md#rewinding). It MUST report calls not covered by the snapshot as `outOfReach`, using recorded `openWorld` and the shared missing-value rule. Non-call outside effects are not undone. [Provider state](#provider-state) applies to both moves.

### Identities and usage

- The Harness MUST keep tool call identities unique within a session and preserve the distinct Provider reference when supplied. It MUST NOT reuse a session id or an entry id within a session.
- The Harness MUST count reported usage once per metered identity, from a live record or a tombstone: `(sessionId, stepId)` for a model attempt, and `jobId` for a job. Copies, turn totals and child reports do not add usage. Input and output counts are tokens; the Provider's extra breakdown stays in Provider data. See [Shared data](bindings/data.md#messages) for the wire mapping.

### Following a session

- The Harness MUST emit standard events for actions and states the build supports. It MUST commit the associated entry before emitting an event that claims a recorded transition. Unrecorded progress and stream pieces can arrive before the completed step or call is committed.
- A follower with an authorized cursor MUST receive visible committed entries in recording order after it, then authorized live events. The Harness MUST establish a single catch-up watermark so that entries are not lost or repeated at cutover. The ACP branch history page is not this subscription.
- The Harness MUST refuse a cursor it cannot resolve for that viewer, including after expiry. It MUST recheck delivery rights and apply the output gate on replay. Replay covers recorded content, not missed live chunks.
- The Harness MUST bound follower queues and disconnect a follower that cannot keep up with committed entries, allowing it to resume from its last visible cursor. Live pieces can be dropped.

**From [ADR 0035](adr/0035-host-limits-from-the-ops-desk.md).** An Interface may follow just the committed closures of waits in one session. A question closes with its `inputAnswer`; an open Interface call settles with its terminal `toolResult`. A revocation may cause a closure, but loss of answerability for one recipient is not itself a closure. Gate both the source facts and the notice for the current recipient. Following closures never establishes presence or delivers an actionable view. See [AG-UI wait closures](bindings/agui.md#wait-closures).

### Deliberate limits

- The core has no general transaction across plugin state and input, common custom capability discovery protocol or common command argument and error format.
- Exact recording of every effective model request is not a portability guarantee. [Recovery](#recovery-and-repeating-work) defines when missing request data blocks retry. There is no common retry schedule beyond the compaction limit, and no step cap unless one is configured.
- There is no common portable approval grant beyond a decision on the exact call. Deployment-specific policy, trust grants and access to credentials are separate from question answers.
- The core has no common mechanism for reconciling arbitrary external effects, tracking delivery of individual live pieces or recovering job ownership after replacement by a different plugin.
- The core has no shared working environment sandbox or command execution profile. File confinement and command containment describe different properties; [Security](security.md) covers deployment requirements.

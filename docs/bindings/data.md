# Shared data: `modular-agent-data/1`

This binding defines shared JSON shapes and how to reconstruct a portable session. [Contracts](../contracts.md) defines core behavior, and [Security](../security.md) defines trust. Each transport binding defines its own envelopes, errors and recipient projections.

## General rules

- A sender MUST encode JSON as UTF-8 without a byte order mark. A receiver MUST reject invalid UTF-8, unpaired surrogates, duplicate object member names and malformed known fields. A malformed known variant is not an extension. The enclosing binding defines its errors and size limits.
- Receivers MUST accept valid JSON nested up to 64 levels, counting an outermost object or array as level 1 and each nested object or array as another level. A scalar does not add a level. Receivers MAY refuse deeper JSON with `invalid_request` as mapped by the enclosing binding.
- Each size limit MUST count the exact UTF-8 bytes sent for the bounded value, including any whitespace or escape sequences in it. A sender's preflight MUST use its own encoding. A receiver that prepares a page in reply to a request MUST measure the page in the encoding it sends. Bindings define what each limit counts: a stdio line, an HTTP body or a value within a message.
- A field marked `?` MUST default to absent unless a different default is stated. All other listed fields are required and have no default. Only a type that includes `null` or arbitrary JSON admits null; null is not omission.
- Known fields MUST use the names shown. A receiver MUST keep unknown fields recursively as inert data when storing or relaying a shape, except for explicit projections, redaction or erasure. It MUST NOT use unknown data to grant rights, change a ceiling or change how known fields are checked. Preservation is not permission to disclose a field.
- Shared records use the [I-JSON](https://www.rfc-editor.org/rfc/rfc7493#section-2.2) number rules. A sender SHOULD NOT emit a number that is not exactly representable as an IEEE 754 double. A receiver MAY round such a number to the nearest double. A value that needs exact decimal precision MUST travel as a string.
- Equality MUST compare JSON by value: exact strings without normalization, numbers by their double values, arrays in order and objects by member name and value regardless of member order. Thus `0`, `-0` and `0.0` compare equal, and absent differs from null. A relay does not need to preserve a number's spelling.
- `Count` is an integer from 0 through 9,007,199,254,740,991. `Time` and `Duration` are Counts in milliseconds, since the Unix epoch for Time. `Id` is a nonempty, case-sensitive string. `object` means a JSON object; `JSON` includes any JSON value. An array admits zero items unless stated otherwise. Lengths stated in characters count Unicode code points.

| Identity | Required scope |
|---|---|
| Session | The agent MUST assign a unique ID across the shared store, never reused, including after retention. |
| Entry, turn, step, input admission, question and tool call | The Harness MUST assign or reserve a distinct ID within the session for each new identity of that type. It MUST NOT reuse an ID of that type, including after erasure. An attempt to rerun the same unfinished call is not a new call. |
| Job | The host MUST generate job IDs unique across sessions, with at least 122 random bits or equivalent uniqueness. |
| Provider, model and plugin | Provider IDs and plugin names MUST be unique in the agent. A model is identified by the pair of Provider ID and model ID. |
| Actor | The issuer MUST assign stable principal IDs across restarts. Agents that share sessions SHOULD configure the same IDs for the same principals. |
| Key | Input and question keys MUST use separate namespaces scoped to the session. Externally supplied input keys MUST also be scoped to authenticated submitter and attributed actor, defaulting the latter to the submitter. Job keys MUST be scoped to session and owning plugin name. |
| Source entry | A `sources` id MUST name an earlier entry in the same session except for fork prefix entries, where it names the origin under [Portable sessions](#portable-sessions). |

Authenticated principals and live parent work, not body fields such as `actorId`, `startedBy` or `writer`, establish authority. See [Security](../security.md).

## Content

Content is an array of part objects. Each part has a required `type: Id`.

| `type` | Other fields |
|---|---|
| `text` | `text: string` |
| `image` | `data: string` (RFC 4648 standard base64, padded where necessary, no whitespace); `mimeType: string` (an `image/<subtype>` media type without parameters) |
| `reasoning` | `text?: string` (readable reasoning only); `providerData?: JSON` (opaque) |
| `toolCall` | `id: Id`; `name: Id`; `arguments: object`; `providerCallId?: Id` (the Provider's reference, for that Provider only) |
| Other | An extension object. Files, audio and content references have no standard shared form in this edition. |

A reasoning part MUST have at least one of `text` and `providerData`. A receiver MUST keep unknown parts without interpreting them. A model or recipient projection MUST omit parts it cannot represent. A projection MUST NOT render opaque Provider data as text or disclose it to a different Provider or recipient. Only the producing Provider, when its trusted identity can be established, gets that data back.

## Messages

| `role` (required) | Other fields |
|---|---|
| `user` | `content: Content` |
| `assistant` | `content: Content`; `stop: Stop`; `usage?: Usage` (unreported); `model?: ModelRef` (use the associated request's model); `error?: ModelError`; `providerData?: JSON` (same rule as for reasoning) |
| `toolResult` | `toolCallId: Id`; `toolName: Id`; `content: Content`; `isError: boolean` |

- Stop is one of `finished`, `toolUse`, `length`, `refused`, `failed` or `aborted`. A sender MUST include `error` on `failed`. It MAY include an error on `refused` or `aborted`. Other stops MUST NOT carry an error.
- ModelError is `{ kind, message: string }`. Its required `kind` is `temporary`, `contextTooLarge`, `credentials`, `refused` or `other`.
- Usage is `{ input: Count, output: Count, cacheRead: Count, cacheWrite: Count, cost: number }`. Counts are tokens. Cache counters report cached input, are not added to input and have no required combined ratio. Cost is nonnegative US dollars. A sender MUST use zero for fields missing from a partial meter. The host MUST sum reported fields from zero using the [core metered identities](../contracts.md#identities-and-usage). It MUST keep exact totals for charging and saturate a projected aggregate Count at the Count maximum. Missing Usage adds no charge.
- ModelRef is `{ provider: Id, id: Id }`.

## Models

| Shape | Fields |
|---|---|
| ModelInfo | ModelRef, plus `name?: string` (display `id` if absent); `contextWindow: Count` (positive, tokens); `maxOutput: Count` (positive, tokens); `input: Id[]`; `reasoning: boolean`; `thinking?: Reasoning[]` (no explicit selectable levels if absent) |
| ModelRequest | `systemPrompt: string`; `messages: Message[]`; `tools: ToolDefinition[]`; `settings: ModelSettings` |
| ModelSettings | `reasoning?: Reasoning` (Provider default); `maxOutput?: Count` (positive token cap, Provider default if absent) |
| TurnSettings | ModelSettings plus `maxSteps?: Count` (positive step cap; no cap in this snapshot if absent) |
| Stream event | `type: "text" \| "reasoning" \| "toolInput"`; `delta: string`; `toolCallId?: Id` (only on `toolInput`) |

Reasoning levels in ascending order are `off`, `minimal`, `low`, `medium`, `high` and `xhigh`. A host MUST choose a level for a request by the [selection rule](#context-and-interrupted-work). A Provider that still receives a level its model does not list MUST apply the same rule itself: the nearest listed level no higher, or no reasoning setting if none qualifies. It MUST NOT fail the request for that reason, and it MUST NOT raise the level. A request's explicit output cap MUST NOT exceed the model's advertised maximum. The standard model input modalities are `text` and `image`. A receiver MUST NOT infer support from an unknown modality. Unrecognized ModelSettings fields are inert unless both sides implement the extension.

A stream MUST end with the answer to its enclosing request. There is no end event. A sender MUST include `toolCallId` when a tool-input delta can be attributed to a specific call. Within that stream the ID MUST match the reference in the sender's final message, before the host maps it to the canonical call ID. An unkeyed tool-input delta is progress only, not a call. A receiver MUST NOT dispatch from any delta.

The [Provider binding](plugin.md#the-host-asks-a-provider) carries request/response model access only. Provider-run tools, live model sessions and late batch model answers are outside the `/1` wire and portable profiles. The [Provider state rules](../contracts.md#provider-state) define the declaration and in-process behavior.

## Tools

| Shape | Fields |
|---|---|
| ToolDefinition | `name: Id`; `description: string`; `parameters: Schema`; `returns?: Schema` (no result schema); `hints?: ToolHints` (same as `{}`); `parallel?: boolean` (false); `callers?: Caller[]` (all three callers; empty means none) |
| ToolHints | `readOnly?: boolean` (false); `destructive?: boolean` (true); `openWorld?: boolean` (true); `safeToRepeat?: boolean` (false) |
| ToolCall | `id: Id`; `name: Id`; `input: object`; `startedBy: Caller \| "provider" \| "tool"`; `actorId?: Id` (authenticated work's actor if omitted); `stepId?: Id` (no model step); `parentCallId?: Id` (no parent call) |
| ToolResult | `callId: Id`; `status: ToolStatus`; `content: Content`; `value?: JSON` (no structured result) |

Caller is `model`, `ui` or `plugin`. For the caller check, the host MUST treat `provider` as `model` and `tool` as `plugin`. Callers are a set. Repeat safety and dispatch authority follow [Contracts](../contracts.md#recovery-and-repeating-work) and [Authority](../contracts.md#authority), not model assertions. A host MUST refuse an effect without authenticated attribution. A ToolCall inside recorded `toolStarted` MUST include `actorId`.

A [nested call](../contracts.md#nested-calls) MUST have `startedBy: "tool"` and a `parentCallId` naming the call that asked for it. Its `actorId` and, where its parent has them, `turnId` and `stepId` MUST be the parent's. Every record of a nested call MUST have `modelVisible: false`. A reader MUST NOT project a nested call or its result into model context, and MUST NOT treat one as a call from the step's response.

Schema is JSON Schema Draft 2020-12, including boolean schemas. Senders MUST use only its standard vocabulary and within-document references. Receivers MUST NOT fetch external references. The effective `parameters` schema also requires an object; a non-object Provider argument MUST fail the attempt before recording a call part. After `tool.after`, the Harness MUST require `value` on a completed result when `returns` is set and validate it against that schema. Non-completed results have no `returns` constraint. Invalid completed values follow [settlement](../contracts.md#settlement), preserving fact of execution.

ToolStatus is `completed`, `failed`, `refused`, `cancelled`, `notStarted` or `outcomeUnknown`. Every non-completed result MUST say in its content what failed, did not run, or may have run, and give the reason if known. When a call is left open under the [question rules](../contracts.md#questions), its immediate reply MUST be `{ pending: string }` with the reason, not a ToolResult. The same pending envelope is used for a committed [Interface handoff](#interface-handoff-records). The Runtime wire envelope adds `callId` as specified by the [plugin binding](plugin.md#the-host-asks-the-runtime).

### Interface handoff records

For [Interface-run tools](../contracts.md#interface-run-tools), a result report is `{ callId: Id, status: "completed" | "failed", content: Content, value?: JSON }`. Its actor and route come from authentication, not the report. It is not a Message or a question answer.

The Harness MUST commit `modular-agent.interfaceHandoff` in the batch immediately after the matching `toolStarted`. The start MUST have `safeToRepeat: false` and `openWorld: true`. The checkpoint MUST match its start's turn, step and call and have no second checkpoint for that call. It is private control data: omit its payload from ordinary recipient views and omit the record from model context. Keep the route ID nonsecret. It shows intent to hand off, not receipt. It MUST NOT be used to authorize another handoff.

The checkpoint's `data` is `{ toolStartedId: Id, executorActorId: Id, routeId: Id, rights: string[], deadline: Time }`. `toolStartedId` names the matching start, which also appears in `sources`; the start's `data.source` names the registered executor source. `executorActorId` is the actor whose Interface runs the call, `rights` is the executor's effective rights ceiling at handoff, and `deadline` is absolute. Ordinary recipient views omit `data`. A reader MUST treat a checkpoint whose `data` lacks any of these fields as not intact.

A terminal `toolResult` MUST keep the originating turn, step and call associations even when appended later, under the current head. On an accepted report it MUST name the reporting actor as top-level `actorId`; system settlements omit it. The writer MUST name the dispatch and checkpoint entry IDs in `sources` to preserve erasure lineage.

The reader MUST fold starts, checkpoints and terminal results in append order. Only intact starts and checkpoints on the current branch can receive a report. A terminal result anywhere still settles the call. Copied checkpoints have no effect. Missing or erased provenance is not proof that nothing ran. If erasure affects a result that would have supplied context, the reader MUST NOT use the erased result or resume work that requires it.

An ended origin becomes eligible for a continuation only if it is on the branch, its `openToolCalls` is nonempty, and all listed Interface calls have terminal results and all listed question-backed calls have closed their questions. The settling record that makes the origin ready fixes its ready order. When this is an Interface result (including a system settlement), `turnStart.data.startedBy` MUST be `{ kind: "toolResult", id: <terminal entry ID> }`. Otherwise use the last qualifying answer. Only one `turnStart` can name the origin, across the entire record. An Interface result on the branch supplies the originating assistant call's result in the default model view; it is not fresh input. A result-only continuation starts with the next model step under the usual checks. For example, append `response(c1)`, `toolStarted(c1)` and its handoff checkpoint, the originating `turnEnd` listing `c1`, the late `toolResult(c1)`, then `turnStart` for the continuation. The result uses the origin's turn and step; the new turn names the origin and the result entry. No new `inputAccepted`, `input` or `toolStarted(c1)` belongs to that continuation.

### Call identities and mappings

| Shape | Call ID | Arguments or result |
|---|---|---|
| Assistant `toolCall` content part | `id` | `arguments` |
| ToolCall dispatched by the host | `id` | `input` |
| ToolResult | `callId` | `status`, `content`, optional `value` |
| History, tool result Message and output events | `toolCallId` when named directly | ToolCall or projection as specified by the shape |

The host MUST assign a canonical session ID to each Provider call before recording or dispatching it, using the Provider ID only if the host reserved it in that session for this call. It MUST preserve the vendor reference separately if there is one. All references to the same call MUST use that canonical ID. A projected ToolCall MUST copy the part's name and map its `arguments` to `input`. The authorized `tool.before` transformation can change `input` before dispatch; `toolStarted.data.call` holds the actual dispatch input. When repeated in a record, step ID, actor ID and call identity MUST match the originating work, except that a terminal Interface report names its separate reporting actor. A result's tool name MUST match the call. A ToolResult from `tools/call` has no `callId`; the host MUST supply the request's `call.id`. In `toolResult` history, the writer MUST map `content` to `message.content`, set `message.isError` to `status !== "completed"` and preserve `status` and `value` in `data`.

For an inherited call, the continuation's `toolStarted`, `toolPending` and `toolResult` MUST use the executing continuation's `turnId` and the originating call's `stepId` (if any) and `toolCallId`. A cross-turn step reference MUST be backed by a chain of `continuesTurnId` links and committed `turnEnd` entries listing that call at each link back to the originating turn. New questions for that invocation MUST use the same scope in `inputRequest` and `inputAnswer`, even when the answer arrives after the invocation ends. An answer to an earlier question keeps that question's scope. Recovery uses these associations to distinguish the current invocation's start from earlier starts. A terminal result still settles the call globally.

## Questions

An InputRequestDraft has `kind: "approval" | "choice" | "text" | "link" | "secret"`, `question: string`, `details?: string`, `timeLimitMs?: Duration` (no deadline if absent), `whenTimeLimit?: "decline" | "leaveOpen"` (default `decline`), `key?: Id` (see below) and `answerers?: Id[]` (any eligible actor if absent, no one if empty). The following fields depend on kind:

| Kind | Additional fields | Accepted value |
|---|---|---|
| `approval` | none | `"allow"`; refusal is a decline |
| `choice` | `options: string[]`, at least one distinct value | One listed string |
| `text` | none | Any string |
| `link` | `details: string` (absolute URI) | Any string acknowledgment |
| `secret` | `credential: Id`, the storage name | The value goes only to the credential store, not in the Answer |

A recorded InputRequest includes the draft plus `id: Id`, `sessionId: Id`, `answerable: boolean`, `toolCallId?: Id`, `askedBy?: Id`, `deadlineAt?: Time`, `coversNested?: true` (an approval whose allow also covers the call's nested calls) and `relayedFrom?: { sessionId: Id, requestId: Id }` (the child request for a relay, otherwise absent). The host MUST fill the IDs and `answerable`, name the authenticated asker in `askedBy` for new records and persist `deadlineAt` for a timed request before publishing it. The deadline is the request entry's time plus the time limit; zero means immediate expiry. Legacy timed requests without a deadline MUST use that same calculation. A receiver MUST refuse an unrepresentable deadline or a supplied deadline inconsistent with the question time. An untimed request MUST NOT carry a deadline. `answerable` is the state at publication, not authority. [ACP Request](acp.md#request) defines the value for each recipient's projection.

For approval, the host MUST keep the exact bound `call: ToolCall`, `source` and `definition` on the `inputRequest` entry, in `data` alongside `request`. The registration fields use the `toolStarted` shape. [Core approval policy](../contracts.md#approval-policy) governs reuse.

A terminal Answer has `requestId: Id` and exactly one of these forms:

| Form | Other fields |
|---|---|
| Value | `actorId: Id`; `value: string`, as specified for that kind |
| Secret stored | `actorId: Id`; `stored: Id` (the credential name) |
| Actor declined | `actorId: Id`; `declined: true`; `reason?: string` |
| System closed | `declined: true`; `reason: "timeLimit" \| "cancelled" \| "noLongerAnswerable" \| "refused" \| "superseded"`; no `actorId` |

**From [ADR 0035](../adr/0035-host-limits-from-the-ops-desk.md).** On a system `inputAnswer` with reason `refused` or `noLongerAnswerable`, the Harness may also record `cause: "revoked"`. A writer offering the wait-closure feed records it when removing a grant, membership or representation actually caused the question to close. Keep the existing reason. Neither an actor's decline nor loss of presence sets this field. An old closure without the field is not proof of revocation.

The host MUST apply [Questions](../contracts.md#questions) when serializing answers, cancellation and deadlines. At or after the deadline it MUST close a `decline` question before accepting an answer. The earlier return of a pending gate for a [waiting approval](#waiting-approval-records) does not end this deadline. For `leaveOpen` it MUST end the synchronous wait without closing the question. The host MUST reject `leaveOpen` unless the question is not an approval, belongs to a call in a turn and qualifies under the core rules. The ask reply when left open MUST be `{ requestId: Id, pending: true }`; it is not an Answer. The host MUST NOT record a losing reply or pending state as `inputAnswer`. The original deadline identifies when the synchronous wait ended; it does not expire a question left open.

At receipt and reuse the host MUST check that the authenticated answerer is still eligible, including any recorded list, and has current effective `approve` for approval or `answer` otherwise. The answerer does not need all the asker's rights. A system closure never grants permission. A stored answer is the closure used by [the secret storage rules](../contracts.md#secrets). A secret that has no valid collection channel MUST be system-closed without storing a value.

A supplied key MUST NOT start with `call:`. For an unkeyed tool question the host MUST assign `call:<toolCallId>:<n>`, starting at 1 in ask order within the call. An asker with concurrent questions in one call MUST supply distinct stable keys. An unkeyed question outside a call cannot reuse an earlier answer. Reuse MUST match the same originating work on the current branch, including the originating call for a continuation, session and known draft values, and the final call input for an approval. A mismatched key MUST be refused, not treated as a new permission. Reuse MUST NOT reset the synchronous wait deadline. Fresh approval identities and keys follow [Approval policy](../contracts.md#approval-policy) and [Questions](../contracts.md#questions).

### Waiting approval records

Under `approvalsOutlastTurns` ([core rules](../contracts.md#approvals-that-wait)). Only the Harness writes the following fields. A question draft, Runtime record, Interface answer or client copy of history cannot set them.

1. **Open.** In one batch commit `inputRequest` then `toolPending` in the origin's turn, step and call scope. The request has `kind: "approval"`, `answerable: false` at publication, `approvalWait: "untilDeadline"` (a field on the recorded request, absent on all other requests), effective `timeLimitMs`, absolute `deadlineAt` and `whenTimeLimit: "decline"`. It is not a `leaveOpen` timeout. Keep the exact call, source and definition alongside the request as for live approval. List the response entry in the request entry's `sources`. The pending record names just this request in `data.requestIds`, with no `toolStartedId`. There can be no earlier start or terminal result for this call. Neither record authorizes execution.
2. **Answer.** Only a non-copied completed `turnEnd` listing the call on the current branch makes this request answerable. Bind each unchanged delivery to its request entry, recipient and live answer route. Recheck current eligibility and the unchanged view before accepting. For a committed allow, `inputAnswer.data` is the usual value Answer plus `approvalView: { requestEntryId: Id, submittedBy: Id, routeId: Id, rights: Rights }`. List the request entry ID in `sources`. `actorId` is the answering actor; `submittedBy` is the authenticated principal, even when they are the same. `rights` is their effective intersection including the connection ceiling. `routeId` identifies the operator's binding route and scope, not a socket or credential. These fields attest to delivery of the unchanged approval view of that immutable request. They are not a saved allowance. The Harness MUST omit `approvalView` from model and ordinary recipient views. A decline or system closure needs no such proof.
3. **Continue or settle.** Fold the decision once by request ID, across the session. Apply the ordinary `continue:<turnId>` queue rule and `turnStart.continuesTurnId`. If this answer makes the origin ready, use `data.startedBy: { kind: "answer", id: <request ID> }`. A system closure counts as a closure, not an allow. Keep mixed waits in the [existing ready order](#interface-handoff-records). Before dispatch verify the entire request binding and answer proof against the current branch, gates and principals. Do not require a live socket after answer commit. Put the first `toolStarted` in the continuation only after all checks pass; use the [inherited call IDs](#call-identities-and-mappings). Its `sources` MUST include the bound request and answer entry IDs.
4. A writer settling before continuation (for example at expiry) MUST append the `toolResult` with the origin's turn, step and call IDs under the current head. Commit any still-needed `inputAnswer` and the settlement together. Retain an earlier actor answer. In a started continuation use its executing turn instead. Name the bound request and any decision in the result's `sources`. A terminal result anywhere still bars dispatch. A ready continuation uses settled results as context; it does not dispatch those calls.

For example: `response(c1)`, then [`inputRequest(q1,c1)`, `toolPending(c1,[q1])`] in one batch; `turnEnd(t1,openToolCalls:[c1])`. Hours later: `inputAnswer(q1,allow)`, `turnStart(t2,continuesTurnId:t1)`, then, if still authorized, `toolStarted(c1)` and its result under `t2`. There is no second model request to generate `c1`, new input admission or start under `t1`.

Restore neither answerable deliveries nor proof of presence from history. On writer acquisition apply the [core recovery and expiry rules](../contracts.md#approvals-that-wait) before offering the request or taking ready work. A copied, erased, off-branch or incomplete binding cannot authorize a continuation's call. A reader that cannot enforce a waiting approval MUST NOT fall back to ordinary question replay. If it cannot safely settle the work, it MUST refuse to take it up.

## Working environment

ExecResult is `{ exitCode: integer | null, output: string, timedOut: boolean, truncated?: true }`. Exit codes use signed safe integers; null means no code for an interrupted command. `timedOut` indicates an execution deadline. `truncated` indicates sender-side output loss. See [Command lifetime](plugin.md#command-lifetime).

DirEntry is `{ name: string, kind: "file" | "directory" | "other" }`. `name` is one path segment, never `.` or `..`. A symlink MUST be reported with the kind of what it resolves to, or `other` if it resolves to nothing or to a special file. Entries are in no fixed order.

## Actors

Actor is `{ id: Id, kind: "user" | "host" | "agent" | "program", rights: Rights }`. A reader MUST interpret a recorded legacy `kind: "plugin"` as `program`. Rights is a set encoded as an array of Ids. A receiver MUST retain unknown rights as inert values and disregard them in authorization.

| Right | What it means |
|---|---|
| `watch` | See the session and follow its events. |
| `propose` | Give input that waits for someone to release it. |
| `input` | Give input that starts or steers a turn. |
| `answer` | Answer questions other than approvals. |
| `approve` | Answer approvals. |
| `tools` | Have tools run for this actor. |
| `cancel` | Cancel turns, calls and jobs, including on [session close](../contracts.md#authority). |
| `settings` | Change session settings. |
| `erase` | Erase entries. |
| `grant` | Give or take away another actor's rights. |
| `jobs` | Start jobs. |
| `delegate` | Start subagents. |
| `administer` | Set the session limit. |

The Harness MUST apply [Authority](../contracts.md#authority) to the current rights of all contributors and ancestors as well as the recorded maximum for the work. It MUST refuse an effect if it cannot resolve required provenance. Authorizer is either `{ sessionId: Id, actorId: Id }` or `{ sessionId: Id, jobId: Id }`, exclusively. Provenance recorded in history references these trusted principals or jobs; it is never accepted from free-form content.

## Limits and tenants

The Harness MUST check and commit a `limit` change atomically under [Limits and tenants](../contracts.md#limits-and-tenants). With no `limit` entry, or with `data.rights: null` in the latest one, there is no session ceiling.

A build MUST refuse a tenant it cannot identify or enforce. Authorization and inheritance follow the [core tenant rules](../contracts.md#limits-and-tenants).

A build supporting tenants MUST read `MODULAR_AGENT_TENANTS` if set. It is a JSON object mapping each tenant Id to `{ rights: Rights, tokens?: Count }`. An absent budget means no token limit. Malformed tenant configuration MUST fail closed. Only the operator's configuration can define tenants.

Token units are in [Usage](#messages). Budget check timing, the `tenantTokens` outcome and deployment-local accounting are in [Contracts](../contracts.md#limits-and-tenants).

## Output events

An event is `{ type: Id, data: object }` with the following payload. The [plugin binding](plugin.md#the-host-asks-a-hook-handler) owns the hook envelope and held-stream segmentation. The [ACP binding](acp.md#updates) owns recipient projection and withheld replies.

| `type` | `data` |
|---|---|
| `text` | `{ delta: string, stepId?: Id }` |
| `reasoning` | `{ delta: string, stepId?: Id }` (readable only) |
| `toolCall` | `{ call: ToolCall }` |
| `toolOutput` | `{ toolCallId: Id, content: Content }`: progress as reported, including text or images. A recipient adapter derives its presentation only from the content allowed by the output gate |
| `toolResult` | `{ toolCallId: Id, status: ToolStatus, content: Content }` |
| `entry` | `{ entry: object }` (the recipient's history view) |
| `turnEnded` | `{ turnId: Id, outcome: Outcome, result: TurnResult }` |
| `reply` | `{ method: Id, result: JSON }` or `{ method: Id, error: object }` (error shape from the recipient binding) |
| `request` | `{ method: Id, params: object }` (an agent-originated request or notification to the recipient) |
| Own type containing a dot | An extension object. |

Each output gate and each wire MUST apply its own size limit to its own encoding under [General rules](#general-rules). The host MUST treat an item that cannot fit the gate's limit just as if the gate refused it. For an item in a page, the host MUST still deliver the page with that item withheld, subject to gating and size checks on the page reply itself. See [ACP Output gate](acp.md#output-gate) and [Held output](plugin.md#held-output).

The host MUST give the gate the intended recipient's view, not the raw record. Session-specific output carries the session identity in the enclosing hook payload; non-session output uses null there. A model stream groups the readable text and reasoning of one model attempt; a tool stream groups the chunks of one call attempt. A host MUST preserve arrival order within each stream and place tool output after its call event and before its result. The request ending, cancellation or loss ends that attempt's stream; no later pieces belong to it. Empty streams have no events to gate. Independent streams can overlap.

A handler MUST use one of the [core output gate answers](../contracts.md#the-output-gate), with an `OutputEvent[]` for `events`. The host MUST accept a redacted array only if it has the same length, order and types, and identical JSON values except for strings. It MUST reject a changed string under a key named `type`, `kind`, `status`, `method`, `stop` or `id`, or ending in `Id` or `Ids`, including in arrays or objects under such a key. For actionable fields it MUST permit only explicitly mapped display redactions. Routing, permission choices, keys, cursors, rights, credential names, approval arguments and unknown actionable fields remain unchanged. The host MUST block a missing, invalid or unmappable answer. It MUST NOT write recipient redactions back to history. Unchanged structure does not exempt unknown content from an operator's gate policy.

## Credentials

Credential is an object with required `type: Id`.

| `type` | Other fields |
|---|---|
| `apiKey` | `key: Id` (nonempty secret string) |
| `oauth` | `accessToken: Id`; `refreshToken?: Id` (no refresh token); `expires?: Time` (expiry unknown) |
| Other | An opaque extension object. |

A store with a bare string MUST return it as `{ type: "apiKey", key: <string> }`. An OAuth access token MUST NOT be used at or after its stated expiry. A refresh token does not promise automatic refresh. Hosts and plugins MUST NOT expose credentials through recipient events, history, logs or errors. Access is defined by [the credential store rules](../contracts.md#secrets).

## History entries

### Entry fields and tombstones

A live Entry has `id: Id`, `parentId: Id | null`, `sessionId: Id`, `kind: Id`, `time: Time`, `writer: Id` and `modelVisible: boolean`. `writer` names the component or registered plugin responsible for the record. The kinds table specifies all standard associations, messages and data. An association not listed has no standard meaning for that kind. `sources?: Id[]` lists the earlier entries whose content the record copies, in branch order for summaries. An omitted list means no sources. Fork prefix entries use the [fork mapping](#portable-sessions). The Harness MUST keep the copy relationships required by [Erasure](../contracts.md#erasure).

A tombstone is `{ id: Id, parentId: Id | null, kind: Id | null, erased: true, turnId?: Id, stepId?: Id, toolCallId?: Id, jobId?: Id, inputId?: Id, requestId?: Id, continuesTurnId?: Id, sources?: Id[], usage?: Usage, writer?: Id, jobKey?: Id }`. The enclosing session supplies the session ID. An opaque [history service](history-http.md#erasure) record allows any string for kind and associations, and null for kind. A portable tombstone has a known or dotted kind and Id associations. Its identities stand; the reader MUST NOT verify links against a tombstoned endpoint.

| Fields | Preserved from |
|---|---|
| `id`, `parentId`, `kind`, listed `*Id` associations | The live entry's envelope |
| `sources` | The live entry's source ids; required for a fork-prefix copy, where the single id names its origin |
| `usage` | `response.message.usage`, `jobEnded.data.usage` or `turnEnd.data.usage`, with only the numeric fields in [Usage](#messages) |
| `writer`, `jobKey` | For a keyed `jobStarted` only: the owner in `writer` and the key in `data.key` |

The store MUST keep the listed fields when applicable and omit all other fields. The reader MUST use tombstone usage like live usage under [Identities and usage](../contracts.md#identities-and-usage).

The envelope alone supplies the associations. On a live `inputRequest`, `requestId` MUST match `data.request.id`. The Harness MUST write one `inputHandedBack` per returned input. When returning several inputs together it MUST append the records in one atomic batch.

### Standard kinds

The host and Runtime MUST write the shapes and visibility shown. Associations before the semicolon are top-level Ids. Payloads are in `data`, except `message` and `sources`.

| Kind | Record owner over the plugin binding | Model-visible | Required or optional fields |
|---|---|---|---|
| `inputAccepted` | Host | No | `actorId`, `jobId?`, `inputId`; `key?: Id`, `when: "now" \| "steer" \| "after" \| "propose"`, `releasedBy?: Id`, `submittedBy?: Id` (defaults to actor), `parked?: boolean` (initial disposition for job reports; see [Job reports](#job-reports)), `taken?: "now" \| "after" \| "inTurn" \| "proposed"` (original receipt if known), `content: Content`, `authorizers: Authorizer[]`, `rights: Rights` |
| `inputHandedBack` | Host | No | `inputId`; `reason?: "withdrawn" \| "declined" \| "cancelled" \| "restart" \| "conflict" \| "handled" \| "turnEnded"` |
| `input` | Host | Yes | `turnId`, `actorId`, `jobId?`, `inputId`; `message: Message` with role `user`, `key?: Id` |
| `turnStart` | Host | No | `turnId`, `continuesTurnId?`; `startedBy: { kind: "actor" \| "job" \| "plugin" \| "answer" \| "toolResult", id: Id }`, `model: ModelRef \| null`, `system: string`, `context?: Content`, `tools: ToolDefinition[]`, `settings: TurnSettings`, `resultShape?: Schema`, `traceContext?: TraceContext`, `point?: Id`, `authorizers: Authorizer[]`, `rights: Rights`, `sources?: Id[]` for history carried in `system` or `context` |
| `modular-agent.turnTrace` | Host | No | `turnId`; `traceContext: TraceContext` |
| `modelRequest` | Host | No | `stepId`, `turnId?`; `model: ModelRef`, `safeToRepeat: boolean`, `tools: Id[]` (final offered names), `auxiliary?: true` (absent for step attempts), `request?: ModelRequest` (required exactly when repeatable), `sources?: Id[]` for history carried in the request |
| `response` | Runtime; host for its requests and bookkeeping settlements | Yes for steps except bookkeeping aborts | `stepId`, `turnId?`; `message: Message` with role `assistant`, `recovery?: true` (bookkeeping abort) |
| `toolStarted` | Host | No | `toolCallId`, `turnId?`, `stepId?`, `actorId`; `call: ToolCall`, `source: { plugin: Id, toolSource: Id }`, `definition: ToolDefinition`, `safeToRepeat: boolean`, `openWorld?: boolean` (defaults to true), `approvalCoveredBy?: { toolCallId: Id, requestId: Id }` (a nested call whose approval a parent's allow answered; see [covered approvals](../contracts.md#approvals-that-cover-nested-calls)), `point?: Id` (out-of-turn only), `authorizers: Authorizer[]`, `rights: Rights` |
| `modular-agent.interfaceHandoff` | Host | No | `toolCallId`, `turnId`, `stepId`; `toolStartedId: Id`, `executorActorId: Id`, `routeId: Id`, `rights: Rights`, `deadline: Time` (absolute; see [Interface handoff records](#interface-handoff-records)) |
| `toolPending` | Host | No | `toolCallId`, `turnId`, `stepId?`; `requestIds: Id[]` (nonempty, the questions whose waits ended with `leaveOpen`, even if since answered, or a single [waiting approval](#waiting-approval-records)), `toolStartedId?: Id` (the current invocation's start, absent for a pending pre-dispatch gate) |
| `toolResult` | Host; Runtime can reference a matching committed result | Yes for calls from model responses; no otherwise | `toolCallId`, `turnId?`, `stepId?`, `actorId?` (Interface reporter only), `message: Message` with role `toolResult`; `status: ToolStatus`, `value?: JSON` |
| `inputRequest` | Host | No | `requestId`, `toolCallId?`, `turnId?`, `stepId?`; `request: InputRequest`, `call: ToolCall`, `source: { plugin: Id, toolSource: Id }` and `definition: ToolDefinition` (last three for approvals only) |
| `secretAnswerAccepted` | Host | No | `requestId`, `actorId`, `toolCallId?`, `turnId?`, `stepId?`; no payload |
| `inputAnswer` | Host | No | `requestId`, `toolCallId?`, `turnId?`, `stepId?`; `data: Answer` |
| `modular-agent.stepAfter` | Host | No | `turnId`, `stepId`; `decision: null \| { refuse: string }` (`null` allows), `sources?: Id[]` for history content copied into the decision |
| `resultFeedback` | Host | Yes, in its next prepared request only | `turnId`; `reason: string` |
| `turnEnd` | Host | No | `turnId`; `outcome: Outcome`, `result: TurnResult`, `usage: Usage` |
| `summary` | Host | Yes | `sources: Id[]` (nonempty); `summary: string`, `summarizes?: Id[]` (copied summary's remapped context sources only) |
| `setting` | Host | No | `actorId?` (defaults or inherited settings if absent); `key: Id`, `value: JSON` (see [setting keys](#setting-keys)) |
| `actorJoined` | Host | No | `actorId?` (granter, absent for host-authorized setup); `actor: Actor`, `operatorAdmission?: true` (operator grant) |
| `actorLeft` | Host | No | `actorId?` (revoker, absent for host-authorized setup); `actorId: Id` in `data` names the actor who left |
| `limit` | Host | No | `actorId` (administrator); `rights: Rights \| null` (no ceiling if null) |
| `tenant` | Host | No | `tenant: Id` |
| `jobStarted` | Host (sets `writer` to owning plugin name) | No | `jobId`, `actorId`, `toolCallId?`, `turnId?`; `kind: Id`, `key?: Id` (unkeyed), `detail: JSON`, `rights: Rights`, `authorizers: Authorizer[]` |
| `jobCleanupUnconfirmed` | Host | No | `jobId`; no payload |
| `jobEnded` | Host | No | `jobId`; `outcome: JobOutcome`, `result?: Content` (none), `report: boolean`, `usage?: Usage` (unreported) |
| `plugins` | Host | No | `active: { name: Id, origin?: string }[]` (origin unreported if absent) |
| `position` | Host | No | `to: Id \| null`, `restore?: { point: Id, undo: Id }` |
| `erasure` | Host | No | `entryIds: Id[]`; `inputKeys?: { inputId: Id, key: Id, actorId?: Id, submittedBy?: Id }[]` (content-free reservations) |

A missing `point` means no provable saved point. For admissions, turn starts, dispatches and jobs the Harness MUST record `authorizers` and the rights ceiling for that work. Work with missing authority evidence MUST be refused. An explicit empty rights ceiling grants no rights. The Harness MUST record the authenticated granter for grants and rights changes.

Outcome is exactly one of `{ kind: "completed" }`, `{ kind: "cancelled" }`, `{ kind: "failed", error: string }` or `{ kind: "limit", limit: Id }`. Standard limit names are `steps`, `output`, `capacity`, `sessionTokens` and `tenantTokens`. `capacity` names the [host reservation limit](../contracts.md#resource-reservations), not a token budget. `sessionTokens` denotes an optional deployment soft session token limit, with no common configuration or default. Other names have deployment-specific meaning; a call left open is never a limit (see [Questions](../contracts.md#questions)). TurnResult is `{ text?: string, value?: JSON, openToolCalls: Id[] }`. Neither optional field supplies a default result. `openToolCalls` lists unfinished calls left open in call order, or is empty. A `turnStart` for a late-answer continuation MUST record `continuesTurnId`, with `startedBy` of kind `answer` and the ID of the last request closed for those calls. For Interface results and mixed continuations see [Interface handoff records](#interface-handoff-records). JobOutcome uses the completed, cancelled and failed forms of Outcome, or `{ kind: "outcomeUnknown" }`.

A private kind MUST have a dot in its name, be namespaced by its writer and be non-model-visible in a portable session. A reader MUST keep private records. Portable reconstruction MUST NOT depend on their meaning.

`TraceContext` is `{ traceparent: string, tracestate?: string }` in W3C format. These two fields are private Harness metadata, not content or authority. A legacy reader keeps the unknown field and dotted kind as inert data. Readers that recognize them ignore invalid context without rejecting otherwise valid history. The usual envelope and topology checks still apply. See [Restart](../telemetry.md#restart).

### Recording order and ownership

- The host MUST assign `id`, `parentId`, `sessionId`, `time`, `turnId` where applicable, and `writer` itself for `host/runtime/record`. The [plugin binding](plugin.md#runtime-records-and-effects) defines which drafts it accepts and how it returns a matching committed result. The host commits the checked `toolResult` before replying to `host/runtime/runToolCall`; a later `tool.after` callback returns the cached hook outcome. The in-process Runtime invokes `tool.after` itself and commits the result before the next step, as in [Contracts](../contracts.md#recovery-and-repeating-work).
- The Harness MUST commit the admitted input before taking it. After the before-turn hook, it MUST commit `turnStart` and, for a turn started by an admission, its first `input` in that order in one batch. It MUST keep steering input before the next model request it affects. It MUST record `turnEnd` last, except for questions and calls explicitly left open for continuation. Other session records can be interleaved. Hand-backs of untaken steering follow [Input](../contracts.md#input).
- For a durable turn under the [telemetry profile](../telemetry.md#restart), include the initial span's own valid context in `turnStart.data.traceContext`. Before resuming effects, commit each new valid segment context as `modular-agent.turnTrace` with the same `turnId` and `modelVisible: false`. Without valid context there is no new checkpoint. Only the Harness writes these fields.
- For every model attempt, the Harness MUST record the tool names from the final effective request in `modelRequest.data.tools`, in request order, including `[]` for no tools. An agent-executed call from a response whose name was not offered MUST be settled as `refused` with reason `not offered`, regardless of the current catalog. The Harness MUST NOT dispatch a call without recorded proof of its offer; an ambiguous prior dispatch still follows [core recovery](../contracts.md#recovery-and-repeating-work).
- For a portable repeatable attempt the host MUST record the final effective request and model without credentials. If it cannot keep the exact request, it MUST omit it and set `safeToRepeat: false`. The host MUST list carried history in `modelRequest.sources` and history carried in `turnStart.system` or `context` in `turnStart.sources`, even after transforms. Unknown lineage is not verifiably erasable. A response settles one attempt by step ID and scope. It MUST list the `modelRequest` it copies in `sources`.
- The Harness MUST record `data.auxiliary: true` for an [auxiliary attempt](../contracts.md#hook-execution).
- For each step attempt the Harness MUST record any [committed `step.after` decision](../contracts.md#hook-execution) as `modular-agent.stepAfter` in the same turn and step scope as its `response`. The Harness MUST NOT record a second decision for that step anywhere in the session. In a complete, unerased history, no decision record for that step means no decision committed. A tombstoned decision is not proof that the gate is due.
- The Harness MUST record the dispatch registration on each `toolStarted` as `data.source` and `data.definition`, with `openWorld` from the trusted definition and `safeToRepeat` from tool and environment. Without proof of the registration the Harness MUST NOT repeat the call. See [core recovery](../contracts.md#recovery-and-repeating-work). A repeat keeps its call ID. Parallel results are kept in completion order.
- The [core persistence rules](../contracts.md#recovery-and-repeating-work) govern failure to commit or loss of writer access. A stored intent alone cannot fence an outside service.
- The Harness MUST record an `inputRequest` before delivering the question and an `inputAnswer` when it closes, as in [Questions](#questions). It MUST compare the record's associations with the request being opened or closed. A `secretAnswerAccepted` MUST match the scope of its secret request and name the authenticated answerer. It selects an activation, not a closure; see [Secrets](../contracts.md#secrets).
- For [`toolPending`](../contracts.md#questions), the Harness MUST name the relinquished invocation's `toolStarted` for a pending tool reply, omitting it for a pending gate. It MUST match the listed requests to the call in that invocation's scope, in ask order. A call can have only one pending checkpoint in that executing turn. The checkpoint is not reusable gate authority.

### Job reports

The host MUST require `result` when `report` is true. It MUST append that `jobEnded` and the report's `inputAccepted` with key `job:<jobId>` in one batch. It MUST record the report's initial disposition in `inputAccepted.data.parked`, `true` for parked and `false` for ready under [Jobs](../contracts.md#jobs). The report content MUST be exactly the job's result. The initial admission has the job ID, the job's starting actor for attribution, the job as authorizer, the job's rights ceiling and `when: "after"`. An ordinary input key MUST NOT start with `job:`. The turn that takes the report MUST have `startedBy: { kind: "job", id: <jobId> }`. Acceptance does not mean that the turn has started.

On reopen the Harness MUST verify the matched end and admission, including the recorded disposition and exact result where live. It MUST refuse an inconsistent live log before starting work. A tombstone or erasure reservation keeps its identity; it does not authorize reconstruction of the report. The Harness MUST NOT regenerate, admit or schedule a missing report. For a committed admission it MUST restore the recorded disposition before applying a release or [restart policy](../contracts.md#input). It MUST NOT enqueue a report already taken or erased.

### Setting keys

| Key | Value | If never recorded |
|---|---|---|
| `model` | ModelRef | Agent's configured default |
| `reasoning` | Reasoning | Agent's configured default, otherwise unset |
| `maxSteps` | positive Count | Agent's configured default, otherwise no cap |
| `maxOutput` | positive Count | Agent's configured default, otherwise Provider default |
| `approval` | `off`, `ask`, `all` or `never` | [Core default](../contracts.md#tool-dispatch) |
| `approvalWait` (requires `approvalsOutlastTurns`) | `live` or `untilDeadline` | `live` |
| `modelTools` | Array of tool names, or `null` | Same as `null`: every registered tool that allows the model as a caller. See [Settings](../contracts.md#settings). |
| `settings` | Object of changes by key; no nested `settings` | No change |

The reader MUST keep unknown setting keys inert. It MUST preserve an unrecognized recorded string for `approval` and apply the [core fallback](../contracts.md#tool-dispatch). The Harness MUST reject new writes of unrecognized approval values. A non-string approval is malformed. The writer MUST reject a new `approvalWait` outside the declared feature or its two values. An unknown value MUST NOT enable waiting or authorize an outstanding call.

## Portable sessions

A build that declares `portableSessions` can read, replay and extend a session written by another such build. Whether it resumes interrupted work depends on its declarations and the safety checks below. Portability covers the standard records, not Provider state, credentials, arbitrary plugin state or working-environment snapshots. A session header and its lineage belong to the store; agents exchanging only history entries do not exchange the project or session lineage.

The Harness MUST use the standard kinds and preserve append order.

A fork MUST begin with a display-only prefix copied from the chosen source branch in branch order. The Harness MUST omit erased payloads from the prefix and relink retained parents. Each copied entry MUST use a new destination ID and `sources: [originEntryId]`. The fork header supplies the origin session. The Harness MUST consistently remap links within the prefix, using `data.summarizes` for a copied summary's effective context sources. It MUST write current tenant, actors (including departures), settings and limit as fresh destination records without a source. A fresh `plugins` record ends setup. The Harness MUST publish the prefix and setup together. The reader MUST use copied entries only for display and context, not authority, usage or live work. Live-work association validation does not apply inside the copied prefix. The reader MUST identify the copied prefix before fresh setup as the leading run of entries with origin `sources`, including tombstones. It MUST also keep legacy sourceless tombstones in that leading run. Their provenance is unresolved. The Harness MUST NOT use them to confirm complete erasure. Omit `modular-agent.interfaceHandoff` records from fork copies and relink across them. They contain executor routing and no display or model context.

Under `approvalsOutlastTurns`, strip `inputAnswer.data.approvalView` from the display-only fork prefix. Do not copy answer routes or deliveries.

When copying history, omit `modular-agent.turnTrace` records and strip `turnStart.data.traceContext`. Relink across omitted checkpoints without changing the order of retained entries.

### Setup records

For a newly created empty session, the Harness MUST hold setup entries provisionally until the first admission, with `tenant` first if present. It MUST append those entries in their original order and with their original times before the first `inputAccepted`. An unused session that closes leaves no setup record. [History HTTP](history-http.md#sessions) defines when to create the service record.

### Append order and the branch

1. The reader MUST fold entries in the order kept, including within a batch, never by time. The initial head is null.
2. A normal record MUST have the current head as its parent, even when it records session-level activity about work on an older branch. Each kept entry except `position`, including a tombstone or private entry, becomes the head.
3. A `position` MUST name the previous head as its parent and an earlier non-position entry or null in `data.to`. The [core target rule](../contracts.md#moving-and-rewinding) governs moves; null is for internal restoration of an empty head, not an ordinary move. Its target becomes the head. The control record is not part of any branch. The current branch is the head and its ancestors, read from root to head.
4. The reader MUST fold `setting`, `actorJoined`, `actorLeft`, `limit`, `tenant`, `plugins`, `erasure`, `jobStarted`, `jobCleanupUnconfirmed`, `jobEnded`, `inputAccepted` and `inputHandedBack` from all records, not only the current branch. Branch choice selects model context, candidates for recovering interrupted turns and open calls or questions, and rewind points. Terminal facts are global. Consumption of a receipt remains terminal across branches.
5. The reader MUST refuse malformed fields, duplicate entry IDs, invalid topology, conflicting terminal records, changed tenant or erased authority or topology records. It MUST validate live associations using this table. Tombstone identities follow [Entry fields and tombstones](#entry-fields-and-tombstones).

| Identity | Establishing record | Later references |
|---|---|---|
| Input | First `inputAccepted` | One authorized release of parked input, then one `input` or `inputHandedBack` |
| Turn | `turnStart` | Work in the turn and one `turnEnd`; a continuation names an earlier turn |
| Step | `modelRequest` | One `response` and at most one `modular-agent.stepAfter` in the same scope, and calls, questions or results under [Call identities and mappings](#call-identities-and-mappings) |
| Call | Response call part or first direct `toolStarted` or pre-dispatch `toolResult` | Approved repeat starts, pending checkpoints and one terminal result |
| Question | `inputRequest` | At most one `secretAnswerAccepted` for a secret and one `inputAnswer` with matching scope |
| Job | `jobStarted` | `jobCleanupUnconfirmed`, one `jobEnded` and at most one report admission |

A `modular-agent.turnTrace` is a normal private entry for branch topology. It does not settle a turn or affect recovery eligibility.

Bootstrap actor IDs can name newly configured principals. The reader MUST NOT infer a principal or skip a revocation.

### Session state

| State | Fold |
|---|---|
| Settings | The reader MUST apply each change in append order, treating properties of one `settings` change as applied at the same position. A later change wins per key. |
| Actors | The reader MUST replace a recorded actor on `actorJoined` and mark it departed on `actorLeft`. It MUST enforce the [connection actor and authority rules](../contracts.md#authority) before new work. |
| Limits and tenant | The reader MUST use the latest limit and the fixed tenant. It MUST refuse to open a tenant session if the tenant or its required policy cannot be enforced. |
| Input keys | The reader MUST index first admissions and erased reservations across branches. Before tombstoning a keyed admission, the Harness MUST commit its reservation in the erasure record. An erased reservation returns the [core duplicate receipt](../contracts.md#input), never the earlier receipt. |
| Pending input | A release MUST retain the input ID, actor, content and key, add `releasedBy` and its authority restriction, and take its ready order at release. An `input` or `inputHandedBack` anywhere settles the receipt; a legacy hand-back without a reason remains terminal. The first receipt is independent of current disposition. Scheduling follows [Input](../contracts.md#input) and [Jobs](../contracts.md#jobs). |
| Job keys | The reader MUST index live keyed starts and keyed start tombstones by owning plugin and key within the session. For a tombstone it uses `writer`, `jobKey` and `jobId`. See [Jobs](../contracts.md#jobs) for the duplicate reply. |
| Jobs | The reader MUST pair by job ID and treat a start without an end as unfinished. It MUST keep cleanup unconfirmed from `jobCleanupUnconfirmed` until that job's `jobEnded`, regardless of branch or owner connection. Job and report rights are in [Authority](../contracts.md#authority). |
| Plugins | The Harness MUST compare the recorded plugin set by name and origin, not order. [Plugins and capabilities](../contracts.md#plugins-and-capabilities) defines when to record the active set. [Configuration and trust](../contracts.md#configuration-and-trust) defines which plugins to load. |
| Trace context | For an interrupted turn in its original session and trust scope, take the latest valid committed context in branch order, starting with `turnStart.data.traceContext`. Ignore copied, erased, invalid and off-branch checkpoints and checkpoints for other turns. |
| Erasure | The Harness MUST reconcile [pending erasure](../contracts.md#cross-session-coordination) before rescheduling work. An `erasure` entry lists targets and preserves key reservations; it does not itself confirm tombstones or completion in other sessions. It MUST protect authority and branch-control records and `jobCleanupUnconfirmed` from erasure. It MUST preserve accounting under [Entry fields and tombstones](#entry-fields-and-tombstones). It MUST erase all admissions, release records and consumption for an erased input, following the [copy rules](../contracts.md#erasure). It MUST settle any affected live work before erasing data needed to recover it. A tombstoned terminal record still settles any work identifiable from its remaining associations. If a question or answer is erased, its counterpart MUST NOT authorize reuse. An incomplete lifecycle whose erased content prevents reliable reconstruction MUST NOT be replayed. |

The Harness MUST NOT reopen an unfinished job under a different owner name. The [plugin binding](plugin.md#jobs) maps the [core job rules](../contracts.md#jobs) to callbacks. Portable history does not attest that a newly installed program with the same name is the same code; that trust is the operator's responsibility.

### Context and interrupted work

- No model view may include trace context or trace checkpoints. If the interrupted turn has no valid saved context, recovery proceeds without a saved parent. With instrumentation it starts a new trace. The [profile](../telemetry.md#restart) defines how to use a saved parent and link. A checkpoint never authorizes recovery.

- The default view MUST use current-branch model-visible messages, skipping tombstones and private records. It MUST append the current turn's `turnStart.data.system` additions to the base system prompt, with one newline between them when both are nonempty. This binding does not prescribe a base prompt. A context handler MAY project a different view.
- Before applying summaries, the default view MUST place each included turn's `turnStart.data.context`, when present, as one `user` message at the original first `input` position, just before the input, with the `turnStart` entry ID as its effective source. Without a first input position there is no separate context message. Replacing that `turnStart` removes its context message; replacing the first input alone does not. The reader MUST NOT synthesize or re-anchor context after replacement.
- The Harness MUST append pending `resultFeedback` to the other messages in the next step preparation, as one `user` message with one text part containing `data.reason`. A feedback entry is pending if it is live on the current branch, belongs to that turn and no later step `modelRequest` in that turn has committed. Its ID is a [request source](#recording-order-and-ownership). Feedback is not part of auxiliary attempts or later turns. An exact replay follows the recorded request rather than projecting feedback again.
- A summary MUST replace at least one visible effective source on that branch, name all summarized records and keep call/result pairs together. In a fork prefix the reader MUST use `data.summarizes` in place of `sources`, including the destination `turnStart` ID for copied turn context. The default view MUST project the summary as one `user` message with one text part holding `data.summary`, at the earliest removed source. A replacement summary MUST name the summary it replaces. The reader MUST omit a summary with an erased source and refuse malformed summary lineage.
- The default view MUST omit a `response` with `stop` `failed` or `aborted` and no content. This does not remove the attempt or settlement from history.
- For an assistant message with calls, the reader MUST place their terminal tool messages immediately after it, in the order of the call parts, regardless of completion order. It MUST omit orphan results and remove call parts whose counterparts cannot be reconstructed due to erasure. It MUST omit call parts from failed, refused, aborted or length-limited responses; partial readable text can remain visible. For a call left open after its turn, the reader MUST use a model-only tool result with `isError: true` and text `This call is waiting for an answer. It has no result yet.` in place of the missing result. It MUST NOT record that projection as a terminal status. Other unresolved calls cannot enter a later step's context. Provider-only data follows [Content](#content).
- For a new turn the Harness MUST use the current settings. If the recorded model is unavailable, it MUST fail with model error kind `other` and put the explanatory message in the failed turn outcome, without substituting a model. When a selected model advertises a set of accepted reasoning levels, it MUST use the nearest one no higher than the selected level, or omit reasoning if none qualifies.
- A non-copied `turnStart` on the branch is interrupted only if no `turnEnd` for that ID exists anywhere in the session. The Harness MUST use the recorded model, system, context, offer, settings and shape. It MUST fail the turn and settle unresolved calls if an essential part is unavailable. A turn started by an admission MUST fail without consuming its receipt if its first `input` is missing. A continuation's checkpoint is its `turnStart` with `continuesTurnId`, the originating turn and the recorded call and question dispositions. For Interface calls it also uses the committed reports or system settlements. The Harness MUST identify starts and questions in the executing turn using [Call identities and mappings](#call-identities-and-mappings). It has no first-input requirement.
- The last answered step is the latest committed `response` paired with a step `modelRequest` in that turn on the current branch, excluding auxiliary attempts and bookkeeping settlements. The Harness MUST NOT skip an erased response to resume an earlier step if the erased response might be the last answered step. The [core resume rule](../contracts.md#recovery-and-repeating-work) uses its [recorded gate state](#recording-order-and-ownership).
- An unsettled request may have reached the Provider. The Harness MUST follow [core repeat rules](../contracts.md#recovery-and-repeating-work). A bookkeeping settlement MUST set `stop: "aborted"` and `data.recovery: true`, with no model-visible content. A repeat uses a fresh step ID. Out-of-turn work has no portable continuation. See [Runtime sequence](plugin.md#runtime-records-and-effects).
- A call is pending only if no terminal `toolResult` for its ID exists anywhere in the session. Settlement follows [core recovery](../contracts.md#recovery-and-repeating-work). An off-branch result prevents rerun but does not supply context; the reader MUST omit its unmatched call part.
- A branch question is open only if no `inputAnswer` for its ID exists anywhere in the session. An erased or off-branch answer cannot supply authority or content. The Harness MUST NOT reuse a stored-name answer without a matching live `secretAnswerAccepted` or confirmed child activation in an authorized relay. Recovery follows [Questions](../contracts.md#questions) and [Secrets](../contracts.md#secrets).
- A `toolPending` checkpoint holds the call out of dispatch in its executing turn even if its questions have since closed. It is not a continuation trigger. The Harness MUST preserve its call and request IDs when finishing that interrupted turn under [Questions](../contracts.md#questions).
- A call was left open past its turn if `openToolCalls` on the branch lists it and no terminal result exists anywhere. The [Interface handoff fold](#interface-handoff-records) also tracks settled calls from `openToolCalls` for readiness; a settled call is never dispatched. A `turnStart` naming the originating turn anywhere bars a second continuation. The Harness MUST recover eligible continuations before fresh work, in order of eligibility. Without late-answer support it MUST close question-backed calls' questions as `noLongerAnswerable` and settle those calls without rerunning them. That fallback does not preclude a supported Interface-result continuation.

The following append sequence is one turn with one model attempt and one call. Session-level records can appear between these records.

| Record | Matching identities |
|---|---|
| `inputAccepted` | input `i1` |
| `turnStart` | turn `t1` |
| `input` | input `i1`, turn `t1` |
| `modelRequest` | turn `t1`, step `s1` |
| `response` | turn `t1`, step `s1`, call part `c1` |
| `toolStarted` | turn `t1`, step `s1`, call `c1` |
| `toolResult` | turn `t1`, step `s1`, call `c1` |
| `modular-agent.stepAfter` | turn `t1`, step `s1` |
| `turnEnd` | turn `t1` |

## Rewinding

[Moving and rewinding](../contracts.md#moving-and-rewinding) defines point checks before the journal, eligible targets and when to refuse. `data.point` on `turnStart` or an out-of-turn `toolStarted` holds the saved point. The working environment keeps points at least while the session is open; later retention is environment-specific.

The Harness MUST NOT infer point ownership from a history entry that references it. A point without an owning session, including a legacy point, MUST be treated as `not_found` in preflight, so a rewind that needs it is refused before any change. On replay of an unresolved journal, the Harness MUST verify ownership before each restore it needs. For a remote point, `exists: true` from [`env/checkPoint`](plugin.md#paths-and-points) confirms ownership. `exists: false` does not say why the point is unavailable. If ownership cannot be verified, the Harness MUST report recovery failure and leave the journal unresolved for repair.

When producing `outOfReach`, the host MUST use `openWorld` recorded on the call's `toolStarted`, treating an absent value as true. It MUST return the IDs of the affected calls in first dispatch order, without repeats.

The Harness MUST use this journal when restoring a point:

1. The host MUST save the current files as point P0.
2. It MUST commit a `position` to the target with `data.restore: { point, undo: P0 }` before restoring. If the commit is uncertain, it MUST read and reconcile the record under a verified writer lease before restoring or rolling back.
3. The host MUST restore the target point idempotently. Once restored, it MUST commit a completion `position` to the same target without `restore`.
4. If the target restore fails, including when its point is missing, the host MUST commit a compensating intent to the previous head with `restore: { point: P0, undo: point }` and attempt to restore P0. After a successful undo restore it MUST commit a completion to the previous head and report the move as failed. The compensating intent immediately follows the unresolved target intent in append order, pointing to the earlier intent's parent with its `point` and `undo` exchanged.
5. On reopen the Harness MUST replay only a latest `position` with `restore` and no completion. A replay of a target intent follows steps 3 and 4. After ownership is verified, `not_found` from restore is a failed restore. A replay of a compensating intent MUST restore the undo point and complete to the previous head only on success. If the undo point is missing or cannot be restored, the Harness MUST report failure and leave the journal unresolved.

While an intent is unresolved, the Harness MUST block project work and keep other entries from interleaving with the journal. It MUST resume project work only once the target or undo restore has established the files at the head and the matching completion is committed. A missing point or a partial restore is not evidence of completion. A legacy `data.failed: true` record MUST NOT clear that block.

## Changes

- **Accepted 2026-11-23, implemented in 0.3.0 ([ADR 0034](../adr/0034-approvals-that-wait.md)).** Under `approvalsOutlastTurns`, add the `approvalWait` setting, a marked request paired with a pre-dispatch `toolPending`, and a private view binding on a late allow. No new record kind or input starts the continuation.

- **Accepted with [ADR 0033](../adr/0033-interface-tools-and-ag-ui.md).** Add a private Interface handoff checkpoint and result-only continuations. Existing call and question forms are unchanged.

- **2026-11-22.** Add optional Harness trace context on turn start and a private segment checkpoint for recovery. Exclude both from fork copies and model views.

- **Proposed production rules.** `capacity` uses the existing `limit` outcome. Erasure records preserve key reservations but do not prove deletion.

- **2026-11-21, after the SDK's fifth build round.** `toolOutput` may carry the progress as reported, `content`, beside its text `chunk`, so a tool's image progress is not reduced to text. Additive; a reader that knows only `chunk` is unaffected (Rust SDK).

- **Edition 4** ([ADR 0023](../adr/0023-edition-4-draft.md), accepted by [ADR 0027](../adr/0027-sdk-0-1-and-edition-4.md)). From the first working build on edition 3. Nested calls have a defined shape and stay out of model context. `modelTools` is a standard setting. A Provider handed a reasoning level its model does not list lowers it, as the host does. DirEntry is added for directory listing.

- **Production edition 3.** A turn whose remaining calls are left open ends `completed`, never as a limit, and a host refuses rather than rewrites a Runtime's outcome (Python G107: a Runtime reported `limit: questions`). Session ownership of saved points (Go P11), independent gate and wire size limits (TypeScript), and I-JSON numbers (Elixir PE2-3, TypeScript). The `step.after` checkpoint distinguishes a due gate from a committed decision (Runtime E, Go with Rust, Python and Elixir, and TypeScript with Rust and Python: the host did not restore the answered step's gate state).

- **Production edition 2.** Measure actual encoded bytes (Go P5), bound JSON nesting and preserve numeric value without requiring the original spelling (TypeScript), omit empty failed or aborted responses from the default model view (Elixir PE-6), and add the `resultFeedback` record and projection (TypeScript). Rewind preflight has a [remote point check](plugin.md#paths-and-points) (Elixir PE-5, Go P9, TypeScript, Python G82).

- Production round two: erasure identities and keys, display-only fork copies, global settlement, request lineage and rewind completion.

- **Production edition.** Defines the field types and mappings, history ownership and replay, approval and question policy, effect intents and rewind recovery. The binding remains `modular-agent-data/1`.
  - Round three: unresolved rewind journals, tombstone provenance, usage and job keys, durable job cleanup and report disposition, exact tool registrations, continuation checkpoints and default model projection.
  - Round four: pending and secret activation checkpoints, approval bindings, attempt tool offers, legacy tombstone associations, continuation record scope and turn-context summary sources.

- **2026-11-18, after a round-six real-model run.** A result that isn't `completed` says what happened in its content. With a session limit refusing `read`, `gpt-6-luna` answered that the file named no harbour: it took the refusal for the file's contents. Every build already gave a reason (a missing `tools` right); the rule asks that the content also say plainly the call didn't run.
- **2026-11-18, after the round-six matrices.** Numbers are compared by value. TypeScript's output gate returned `cost: 0` for Rust's `cost: 0.0`, and the Rust host took every response and turn end as changed by the gate, could not map them back, and blocked them: its history pages came back without them.
- **2026-11-18, after the round-six builds.** A rewind saves first and lets `env/restore` refuse a missing point, since a remote environment has no separate check (TypeScript, Go, Elixir). Concurrent steps may cross a tenant's budget together (Go, Elixir). No accepted reasoning level at or below: leave it out (Go, Elixir). `sessionId: null` for output not about one session (Elixir).
- **2026-11-18, round six.** Limits and tenants (`limit`, `tenant`, the `administer` right, `MODULAR_AGENT_TENANTS`, the `tenantTokens` limit). Output events: a shared vocabulary for what the output gate is given (Rust R5-05, Go B30, Elixir R5-3). A job's rights on `jobStarted` (Go B29, Elixir R5-5). The order of a rewind, its branch and the life of a point (Rust R5-04, Python G78, Go B32, Elixir R5-6). A reasoning level the new model doesn't accept (Rust R5-03).
- **2026-11-18, after the round-five matrices.** A job's report is its result, unchanged. The Python agent framed the report of a job it took up in another build's session ("Job <id> reported ..."), so the model saw different text depending on which build took the job up.
- **2026-11-18, round five.** Jobs and plugins become portable: `jobStarted`, `jobEnded`, a job's report, and `plugins`. Rewinding: `data.point` on `turnStart` and `toolStarted`. Before this, jobs and plugins were each build's own kinds, and no build could rewind. From the gaps the builders logged in round four:
  - `inputAccepted` and `inputHandedBack`, so queued input and its keys survive a reopening in another build (Python G67, Go B19, Elixir M1-2);
  - `modelRequest`, so a crash during a model request can be told apart from one before it (Python G68, Go B23, Rust R4-02);
  - `turnStart` carries `data.context` (Go B23, Python G71);
  - why a question closed without an answer (Rust R4-04); the key of a question a call asks without one (Python G69, Elixir M3-3); who may answer an open question after a reopening (Go B20);
  - a recorded model the reopening build doesn't offer (Go B22, Rust R4-03);
  - a repeat that is refused gives `outcomeUnknown` (Python G77);
  - an erased entry keeps its identities (Go B21).
- **2026-11-18, after the real-model runs.** `approval` is a standard setting key. The Rust agent kept the approval policy under a key of its own, so the Elixir agent reopening its session fell back to its own default and refused a call the user had allowed. The other way round, a reopening agent whose default is `off` would have run tools the user wanted to approve.
- **2026-11-18, after the first portable-session swaps.** The names of rights, and what a started call that doesn't run again gets. TypeScript's actor had no `tools` right, because no names were defined, so the Rust agent reopening its session refused the interrupted call. The three clean-room builds had each chosen the same extra names (`tools`, `cancel`, `grant`, `jobs`, `delegate`); those are now the standard. Rust also recorded that started call as `refused`, though it had run.
- **2026-11-18, round four.** Portable sessions; Credentials; the kinds `toolStarted`, `inputRequest`, `inputAnswer`, `actorJoined` and `actorLeft`; what a `turnStart` carries; standard setting keys, and `settings` for several at once. From the round-three gaps: Rust B-09, Python G53 and Go B8 found three different credential shapes (`apiKey`, `value` and `key`); Python G54 and Go B10 both chose `settings` for a change of several settings.
- **2026-11-17.** First version. It collects the shapes the [ACP binding](acp.md) already used for entries and requests, and adds the rest.

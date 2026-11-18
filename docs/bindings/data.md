# Shared data: `modular-agent-data/1`

This binding defines shared JSON shapes and how to reconstruct a portable session. [Contracts](../contracts.md) defines core behavior, and [Security](../security.md) defines trust. Each transport binding defines its own envelopes, errors and recipient projections.

## General rules

- A sender MUST encode JSON as UTF-8 without a byte order mark. A receiver MUST reject invalid UTF-8, unpaired surrogates, duplicate object member names and malformed known fields. A malformed known variant is not an extension. The enclosing binding defines its errors and size limits.
- A field marked `?` MUST default to absent unless a different default is stated. All other listed fields are required and have no default. Only a type that includes `null` or arbitrary JSON admits null; null is not omission.
- Known fields MUST use the names shown. A receiver MUST keep unknown fields recursively as inert data when storing or relaying a shape, except for explicit projections, redaction or erasure. It MUST NOT use unknown data to grant rights, change a ceiling or change how known fields are checked. Preservation is not permission to disclose a field.
- Equality MUST compare JSON by value: exact strings without normalization, numbers by numeric value, arrays in order and objects by member name and value regardless of member order. Thus `0`, `-0` and `0.0` compare equal, and absent differs from null. Implementations MUST compare number literals as exact decimal values, including when they relay opaque JSON. A build does not need to represent arbitrary JSON numbers in its own arithmetic.
- `Count` is an integer from 0 through 9,007,199,254,740,991. `Time` and `Duration` are Counts in milliseconds, since the Unix epoch for Time. `Id` is a nonempty, case-sensitive string. `object` means a JSON object; `JSON` includes any JSON value. An array admits zero items unless stated otherwise. Lengths stated in characters count Unicode code points.

| Identity | Required scope |
|---|---|
| Session | The agent MUST assign a unique ID across the shared store, never reused, including after retention. |
| Entry, turn, step, input admission, question and tool call | The Harness MUST assign or reserve a distinct ID within the session for each new identity of that type. It MUST NOT reuse an ID of that type, including after erasure. An attempt to rerun the same unfinished call is not a new call. |
| Job | The host MUST generate job IDs unique across sessions, with at least 122 random bits or equivalent uniqueness. |
| Provider, model and plugin | Provider IDs and plugin names MUST be unique in the agent. A model is identified by the pair of Provider ID and model ID. |
| Actor | The issuer MUST assign stable principal IDs across restarts. Agents that share sessions SHOULD configure the same IDs for the same principals. |
| Key | Input and question keys MUST be separate namespaces, each scoped to the session. Job keys MUST be scoped to the session and owning plugin name. |
| Source entry | In `sources` an ID MUST refer to an earlier entry in the same session. The Harness MUST use fork lineage for cross-session copies. |

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
- Usage is `{ input: Count, output: Count, cacheRead: Count, cacheWrite: Count, cost: number }`. Input and output are total tokens in each direction. Cache reads and writes are counts of cached input tokens, not added again to input. Cost is a nonnegative decimal in US dollars. A sender without a cost figure MUST use 0. Aggregation MUST add each reported field once and add nothing for missing usage. This profile does not distinguish a zero cost from an unreported cost.
- ModelRef is `{ provider: Id, id: Id }`.

## Models

| Shape | Fields |
|---|---|
| ModelInfo | ModelRef, plus `name?: string` (display `id` if absent); `contextWindow: Count` (positive, tokens); `maxOutput: Count` (positive, tokens); `input: Id[]`; `reasoning: boolean`; `thinking?: Reasoning[]` (no explicit selectable levels if absent) |
| ModelRequest | `systemPrompt: string`; `messages: Message[]`; `tools: ToolDefinition[]`; `settings: ModelSettings` |
| ModelSettings | `reasoning?: Reasoning` (Provider default); `maxOutput?: Count` (positive token cap, Provider default if absent) |
| TurnSettings | ModelSettings plus `maxSteps?: Count` (positive step cap; no cap in this snapshot if absent) |
| Stream event | `type: "text" \| "reasoning" \| "toolInput"`; `delta: string`; `toolCallId?: Id` (only on `toolInput`) |

Reasoning levels in ascending order are `off`, `minimal`, `low`, `medium`, `high` and `xhigh`. A request's explicit output cap MUST NOT exceed the model's advertised maximum. The standard model input modalities are `text` and `image`. A receiver MUST NOT infer support from an unknown modality. Unrecognized ModelSettings fields are inert unless both sides implement the extension.

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

Schema is JSON Schema Draft 2020-12, including boolean schemas. A conforming sender MUST use only the standard vocabulary and references within the schema document, for `parameters`, `returns` and `resultShape`. A receiver MUST NOT fetch external references. Tool-specific display hints have no common wire meaning.

ToolStatus is `completed`, `failed`, `refused`, `cancelled`, `notStarted` or `outcomeUnknown`. Every non-completed result MUST say in its content what failed, did not run, or may have run, and give the reason if known. When a call is left open under the [question rules](../contracts.md#questions), its immediate reply MUST be `{ pending: string }` with the reason, not a ToolResult. The Runtime wire envelope adds `callId` as specified by the [plugin binding](plugin.md#the-host-asks-the-runtime).

### Call identities and mappings

| Shape | Call ID | Arguments or result |
|---|---|---|
| Assistant `toolCall` content part | `id` | `arguments` |
| ToolCall dispatched by the host | `id` | `input` |
| ToolResult | `callId` | `status`, `content`, optional `value` |
| History, tool result Message and output events | `toolCallId` when named directly | ToolCall or projection as specified by the shape |

The host MUST assign a canonical session ID to each Provider call before recording or dispatching it, using the Provider ID only if the host reserved it in that session for this call. It MUST preserve the vendor reference separately if there is one. All references to the same call MUST use that canonical ID. A projected ToolCall MUST copy the part's name and map its `arguments` to `input`. The authorized `tool.before` transformation can change `input` before dispatch; `toolStarted.data.call` holds the actual dispatch input. When repeated in a record, step ID, actor ID and call identity MUST match the originating work. A result's tool name MUST match the call. A ToolResult from `tools/call` has no `callId`; the host MUST supply the request's `call.id`. In `toolResult` history, the writer MUST map `content` to `message.content`, set `message.isError` to `status !== "completed"` and preserve `status` and `value` in `data`.

## Questions

An InputRequestDraft has `kind: "approval" | "choice" | "text" | "link" | "secret"`, `question: string`, `details?: string`, `timeLimitMs?: Duration` (no deadline if absent), `whenTimeLimit?: "decline" | "leaveOpen"` (default `decline`), `key?: Id` (see below) and `answerers?: Id[]` (any eligible actor if absent, no one if empty). The following fields depend on kind:

| Kind | Additional fields | Accepted value |
|---|---|---|
| `approval` | none | `"allow"`; refusal is a decline |
| `choice` | `options: string[]`, at least one distinct value | One listed string |
| `text` | none | Any string |
| `link` | `details: string` (absolute URI) | Any string acknowledgment |
| `secret` | `credential: Id`, the storage name | The value goes only to the credential store, not in the Answer |

A recorded InputRequest includes the draft plus `id: Id`, `sessionId: Id`, `answerable: boolean`, `toolCallId?: Id`, `askedBy?: Id`, `deadlineAt?: Time` and `relayedFrom?: { sessionId: Id, requestId: Id }` (the child request for a relay, otherwise absent). The host MUST fill the IDs and `answerable`, name the authenticated asker in `askedBy` for new records and persist `deadlineAt` for a timed request before publishing it. The deadline is the request entry's time plus the time limit; zero means immediate expiry. Legacy timed requests without a deadline MUST use that same calculation. A receiver MUST refuse an unrepresentable deadline or a supplied deadline inconsistent with the question time. An untimed request MUST NOT carry a deadline. `answerable` is the state at publication, not authority.

A terminal Answer has `requestId: Id` and exactly one of these forms:

| Form | Other fields |
|---|---|
| Value | `actorId: Id`; `value: string`, as specified for that kind |
| Secret stored | `actorId: Id`; `stored: Id` (the credential name) |
| Actor declined | `actorId: Id`; `declined: true`; `reason?: string` |
| System closed | `declined: true`; `reason: "timeLimit" \| "cancelled" \| "noLongerAnswerable" \| "refused"`; no `actorId` |

The host MUST apply [Questions](../contracts.md#questions) when serializing answers, cancellation and deadlines. At or after the deadline it MUST close a `decline` question before accepting an answer. For `leaveOpen` it MUST end the synchronous wait without closing the question. The host MUST reject `leaveOpen` unless the question is not an approval, belongs to a call in a turn and qualifies under the core rules. The ask reply when left open MUST be `{ requestId: Id, pending: true }`; it is not an Answer. The host MUST NOT record a losing reply or pending state as `inputAnswer`. The original deadline identifies when the synchronous wait ended; it does not expire a question left open.

At receipt and reuse the host MUST check that the authenticated answerer is still eligible, including any recorded list, and has current effective `approve` for approval or `answer` otherwise. The answerer does not need all the asker's rights. A system closure never grants permission. The host MUST enforce [the secret storage rules](../contracts.md#secrets) before recording a stored answer. A secret that has no valid collection channel MUST be system-closed without storing a value.

A supplied key MUST NOT start with `call:`. For an unkeyed tool question the host MUST assign `call:<toolCallId>:<n>`, starting at 1 in ask order within the call. An asker with concurrent questions in one call MUST supply distinct stable keys. An unkeyed question outside a call cannot reuse an earlier answer. Reuse MUST match the same originating work on the current branch, including the originating call for a continuation, session and known draft values, and the final call input for an approval. A mismatched key MUST be refused, not treated as a new permission. Reuse MUST NOT reset the synchronous wait deadline. A fresh approval after expiry uses a new question identity and key under the [core rules](../contracts.md#questions).

## Working environment

ExecResult is `{ exitCode: integer | null, output: string, timedOut: boolean }`. The exit code is an integer within the signed safe integer range, or null for an interrupted command with no exit code. `timedOut` is true only when an execution deadline stopped the command. The [environment wire methods](plugin.md#the-host-asks-the-working-environment) define timeout and output streaming.

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
| `cancel` | Cancel turns and jobs. |
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
| `toolOutput` | `{ toolCallId: Id, chunk: string }` |
| `toolResult` | `{ toolCallId: Id, status: ToolStatus, content: Content }` |
| `entry` | `{ entry: object }` (the recipient's history view) |
| `turnEnded` | `{ turnId: Id, outcome: Outcome, result: TurnResult }` |
| `reply` | `{ method: Id, result: JSON }` or `{ method: Id, error: object }` (error shape from the recipient binding) |
| `request` | `{ method: Id, params: object }` (an agent-originated request or notification to the recipient) |
| Own type containing a dot | An extension object. |

The host MUST give the gate the intended recipient's view, not the raw record. Session-specific output carries the session identity in the enclosing hook payload; non-session output uses null there. A model stream groups the readable text and reasoning of one model attempt; a tool stream groups the chunks of one call attempt. A host MUST preserve arrival order within each stream and place tool output after its call event and before its result. The request ending, cancellation or loss ends that attempt's stream; no later pieces belong to it. Empty streams have no events to gate. Independent streams can overlap.

A handler MUST use one of the [core output gate answers](../contracts.md#the-output-gate), with an `OutputEvent[]` for `events`. The host MUST accept a redacted array only if it has the same length, order and types, and identical JSON values except for strings. It MUST reject a changed string under a key named `type`, `kind`, `status`, `method`, `stop` or `id`, or ending in `Id` or `Ids`, including in arrays or objects under such a key. The host MUST block a missing, invalid or unmappable answer. It MUST NOT write recipient redactions back to history. Unchanged structure does not exempt unknown content from an operator's gate policy.

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

A live Entry has `id: Id`, `parentId: Id | null`, `sessionId: Id`, `kind: Id`, `time: Time`, `writer: Id` and `modelVisible: boolean`. `writer` names the component or registered plugin responsible for the record. The kinds table specifies all standard associations, messages and data. An association not listed has no standard meaning for that kind. `sources?: Id[]` lists the earlier entries whose content the record copies, in branch order for summaries. An omitted list means no same-session sources. The Harness MUST keep the copy relationships required by [Erasure](../contracts.md#erasure).

A tombstone is `{ id: Id, parentId: Id | null, kind: Id | null, erased: true, turnId?: Id, stepId?: Id, toolCallId?: Id, jobId?: Id }`. The store MUST preserve those associations when present and omit all other fields. Its enclosing session supplies the session ID. For opaque [history service](history-http.md#erasure) records, `kind` and retained associations can be any string and kind can be null. A standard portable tombstone instead has a known or dotted kind and Ids for its associations. A tombstone supplies topology and terminal identity, never content or authority.

### Standard kinds

The host and Runtime MUST write standard kinds with the fields and visibility shown. In the table, association names refer to top-level fields of type Id. Payload fields are inside `data`, except `message` and `sources` where listed. An optional association has no associated work if absent.

| Kind | Record owner over the plugin binding | Model-visible | Required or optional fields |
|---|---|---|---|
| `inputAccepted` | Host | No | `actorId`, `jobId?`; `inputId: Id`, `key?: Id` (unkeyed), `when: "now" \| "steer" \| "after" \| "propose"`, `releasedBy?: Id` (no release), `content: Content`, `authorizers?: Authorizer[]`, `rights?: Rights` |
| `inputHandedBack` | Host | No | `inputIds: Id[]` |
| `input` | Host | Yes | `turnId`, `actorId`, `jobId?`, `message: Message` with role `user`; `inputId: Id`, `key?: Id` (unkeyed) |
| `turnStart` | Host | No | `turnId`; `startedBy: { kind: "actor" \| "job" \| "plugin" \| "answer", id: Id }`, `model: ModelRef \| null` (null when no model was selected), `system: string`, `context?: Content` (none), `tools: ToolDefinition[]`, `settings: TurnSettings`, `continuesTurnId?: Id` (the originating turn for a late-answer continuation), `resultShape?: Schema` (no shape), `point?: Id`, `authorizers?: Authorizer[]`, `rights?: Rights` |
| `modelRequest` | Host | No | `stepId`, `turnId?` (out-of-turn request); `model: ModelRef`, `safeToRepeat: boolean`, `request?: ModelRequest` (legacy: no exact request) |
| `response` | Runtime; host for its own requests and for aborted attempts it settles on recovery | Yes in a turn; no otherwise | `stepId`, `turnId?`, `message: Message` with role `assistant`; no standard `data` |
| `toolStarted` | Host | No | `toolCallId`, `turnId?`, `stepId?`, `actorId`; `call: ToolCall`, `safeToRepeat: boolean`, `openWorld?: boolean` (defaults to true), `point?: Id` (out-of-turn only), `authorizers?: Authorizer[]`, `rights?: Rights` |
| `toolResult` | Host; Runtime can reference a matching committed result | Yes for calls from model responses; no otherwise | `toolCallId`, `turnId?`, `stepId?`, `message: Message` with role `toolResult`; `status: ToolStatus`, `value?: JSON` |
| `inputRequest` | Host | No | `toolCallId?`, `turnId?`; `request: InputRequest` |
| `inputAnswer` | Host | No | `toolCallId?`, `turnId?`; `data: Answer` |
| `turnEnd` | Host | No | `turnId`; `outcome: Outcome`, `result: TurnResult`, `usage: Usage` |
| `summary` | Host | Yes | `sources: Id[]` (nonempty); `summary: string` |
| `setting` | Host | No | `actorId?` (defaults or inherited settings if absent); `key: Id`, `value: JSON` (see [setting keys](#setting-keys)) |
| `actorJoined` | Host | No | `actorId?` (granter, absent for host-authorized setup); `actor: Actor` |
| `actorLeft` | Host | No | `actorId?` (revoker, absent for host-authorized setup); `actorId: Id` in `data` names the actor who left |
| `limit` | Host | No | `actorId` (administrator); `rights: Rights \| null` (no ceiling if null) |
| `tenant` | Host | No | `tenant: Id` |
| `jobStarted` | Host (sets `writer` to owning plugin name) | No | `jobId`, `actorId`, `toolCallId?`, `turnId?`; `kind: Id`, `key?: Id` (unkeyed), `detail: JSON`, `rights?: Rights` (legacy: `watch` only), `authorizers?: Authorizer[]` |
| `jobEnded` | Host | No | `jobId`; `outcome: JobOutcome`, `result?: Content` (none), `report: boolean`, `usage?: Usage` (unreported) |
| `plugins` | Host | No | `active: { name: Id, origin?: string }[]` (origin unreported if absent) |
| `position` | Host | No | `to: Id \| null` (null for no head), `restore?: { point: Id, undo: Id }` (no restore) |
| `erasure` | Host | No | `entryIds: Id[]` |

A missing `point` means no provable saved point. For new admissions, turn starts, dispatches and jobs the Harness MUST record `authorizers` and the rights ceiling for that work. An absent `authorizers` or ceiling on a legacy record MUST NOT be treated as unrestricted. Recovery MAY use an older record only for an effect whose required provenance and ceiling are provable from the standard records. The Harness MUST record the authenticated granter for grants and rights changes.

Outcome is exactly one of `{ kind: "completed" }`, `{ kind: "cancelled" }`, `{ kind: "failed", error: string }` or `{ kind: "limit", limit: Id }`. Standard limit names are `steps`, `output`, `sessionTokens` and `tenantTokens`; other names have deployment-specific meaning. TurnResult is `{ text?: string, value?: JSON, openToolCalls: Id[] }`. Neither optional field supplies a default result. `openToolCalls` lists unfinished calls left open in call order, or is empty. A `turnStart` for a late-answer continuation MUST record `continuesTurnId`, with `startedBy` of kind `answer` and the ID of the request whose closure made the turn eligible. JobOutcome uses the completed, cancelled and failed forms of Outcome, or `{ kind: "outcomeUnknown" }`.

A private kind MUST have a dot in its name, be namespaced by its writer and be non-model-visible in a portable session. A reader MUST keep private records. Portable reconstruction MUST NOT depend on their meaning.

### Recording order and ownership

- The host MUST assign `id`, `parentId`, `sessionId`, `time`, `turnId` where applicable, and `writer` itself for `host/runtime/record`. The [plugin binding](plugin.md#runtime-records-and-effects) defines which drafts it accepts and how it returns a matching committed result. The host commits the checked `toolResult` before replying to `host/runtime/runToolCall`; a later `tool.after` callback returns the cached hook outcome. The in-process Runtime invokes `tool.after` itself and commits the result before the next step, as in [Contracts](../contracts.md#recovery-and-repeating-work).
- The Harness MUST commit the admitted input before taking it. After the before-turn hook, it MUST commit `turnStart` and, for a turn taking input at the start, its first `input` in that order in one batch. It MUST keep steering input before the next model request it affects. It MUST record `turnEnd` last, except for questions and calls explicitly left open for continuation. Other session records can be interleaved.
- The host MUST give each model attempt, including a retry, a fresh `stepId` and record its `modelRequest` before dispatch. It MUST record the exact effective request and model after transforms, without credentials, and set `safeToRepeat` from the Provider's declared support. A response settles only the request with its step ID, in the same turn or in the same out-of-turn scope. There is at most one response per request. The Runtime MUST commit a response before running calls from it.
- The Harness MUST commit `toolStarted` before executing a call and record `safeToRepeat` as true only with the tool's and environment's promises. It MUST record `openWorld` from the trusted definition used at dispatch. A repeated call keeps its original ID and may have another start record, but the host MUST NOT repeat a call with a terminal result. There is at most one terminal result per call. Parallel results are kept in the order they finish, not necessarily the order the model requested them.
- The [core persistence rules](../contracts.md#recovery-and-repeating-work) govern failure to commit or loss of writer access. A stored intent alone cannot fence an outside service.
- The Harness MUST record an `inputRequest` before delivering the question and an `inputAnswer` when it closes, as in [Questions](#questions). It MUST compare the record's associations with the request being opened or closed.

### Job reports

The host MUST require `result` when `report` is true. It MUST append that `jobEnded` and the report's `inputAccepted` with key `job:<jobId>` in one batch. The report content MUST be exactly the job's result. The admission has the job ID, the job's starting actor for attribution, the job as authorizer, the job's rights ceiling and `when: "after"`. An ordinary input key MUST NOT start with `job:`. The turn that takes the report MUST have `startedBy: { kind: "job", id: <jobId> }`. Acceptance does not mean that the turn has started.

On reopen the Harness MUST repair a legacy reported end without a matching admission before starting any other work. It MUST NOT enqueue a report already taken or intentionally erased. For a legacy report already taken without an admission, it MUST use the report input's ID, key and content to repair the admission, treating it as taken. An ended job without its legacy report content MUST NOT be restarted to regenerate it.

### Setting keys

| Key | Value | If never recorded |
|---|---|---|
| `model` | ModelRef | Agent's configured default |
| `reasoning` | Reasoning | Agent's configured default, otherwise unset |
| `maxSteps` | positive Count | Agent's configured default, otherwise no cap |
| `maxOutput` | positive Count | Agent's configured default, otherwise Provider default |
| `approval` | `off`, `ask`, `all` or `never` | [Core default](../contracts.md#tool-dispatch) |
| `settings` | Object of changes by key; no nested `settings` | No change |

The reader MUST keep but ignore unknown setting keys. A portable session cannot rely on a safety requirement in a private setting. The [tool dispatch rules](../contracts.md#tool-dispatch) define what each policy does and how lack of an approval plugin is declared.

## Portable sessions

A build that declares `portableSessions` can read, replay and extend a session written by another such build. Whether it resumes interrupted work depends on its declarations and the safety checks below. Portability covers the standard records, not Provider state, credentials, arbitrary plugin state or working-environment snapshots. A session header and its lineage belong to the store; agents exchanging only history entries do not exchange the project or session lineage.

The Harness MUST use the standard kinds and shapes, preserving append order.

### Setup records

For a newly created empty session, the Harness MUST hold setup entries provisionally until the first admission, with `tenant` first if present. It MUST append those entries in their original order and with their original times before the first `inputAccepted`. An unused session that closes leaves no setup record. [History HTTP](history-http.md#sessions) defines when to create the service record.

### Append order and the branch

1. The reader MUST fold entries in the order kept, including within a batch, never by time. The initial head is null.
2. A normal record MUST have the current head as its parent, even when it records session-level activity about work on an older branch. Each kept entry except `position`, including a tombstone or private entry, becomes the head.
3. A `position` MUST name the previous head as its parent and name an earlier non-position entry or null in `data.to`. Its target becomes the head. The control record is not part of any branch. The current branch is the head and its ancestors, read from root to head.
4. The reader MUST fold `setting`, `actorJoined`, `actorLeft`, `limit`, `tenant`, `plugins`, `erasure`, `jobStarted`, `jobEnded`, `inputAccepted` and `inputHandedBack` from all records, not only the current branch. Branch choice matters only for model context, interrupted turns, open calls and questions, and rewind. Consumption of a receipt remains terminal across branches.
5. The reader MUST refuse portable open for malformed required fields, duplicate identities, invalid parent or target links, conflicting terminal records, mutable tenant identity, or an authority or topology record lost to erasure. It MUST check that each association matches an earlier record that established the identity in that session, allowing the tombstones and explicitly noted legacy cases. An Actor ID in an initial grant refers to a configured or newly joined principal, not necessarily an earlier entry. It MUST NOT infer a default principal or skip a revocation to make a log readable.

### Session state

| State | Fold |
|---|---|
| Settings | The reader MUST apply each change in append order, treating properties of one `settings` change as applied at the same position. A later change wins per key. |
| Actors | The reader MUST replace a recorded actor on `actorJoined` and mark it departed on `actorLeft`. It MUST enforce the [connection actor and authority rules](../contracts.md#authority) before new work. |
| Limits and tenant | The reader MUST use the latest limit and the fixed tenant. It MUST refuse to open a tenant session if the tenant or its required policy cannot be enforced. |
| Input keys | The reader MUST index a key by its first surviving admission, regardless of branch or later release. On duplicate input the Harness MUST return that receipt without starting new work. A handed-back admission retains its key. |
| Pending input | The reader MUST take a receipt's state from its latest admission, keeping the first admission's place in order. A release repeats the original admission ID, actor, content and key, records `releasedBy`, changes `when` from `propose` and adds the releaser's authority restriction. A matching `input` or `inputHandedBack` anywhere settles the receipt. An unreleased proposal is not runnable. The Harness MUST apply the [queued-input recovery rules](../contracts.md#input) in first-admission order, including the separate override for job reports. A job report can start a turn on its own only under the [job scheduling rule](../contracts.md#jobs). |
| Jobs | The reader MUST pair by job ID and treat a start without an end as unfinished. Current job and report rights, including the legacy `watch` fallback, are in [Authority](../contracts.md#authority). |
| Plugins | The Harness MUST compare the recorded plugin set by name and origin, not order. [Plugins and capabilities](../contracts.md#plugins-and-capabilities) defines when to record the active set. [Configuration and trust](../contracts.md#configuration-and-trust) defines which plugins to load. |
| Erasure | The Harness MUST reconcile erasure intents before rescheduling work. It MUST keep authority, accounting and branch-control records and erase all admissions, release records and consumption for an erased input, following the [copy rules](../contracts.md#erasure). It MUST settle any affected live work before erasing data needed to recover it. A tombstoned terminal record still settles any work identifiable from its remaining associations. If a question or answer is erased, its counterpart MUST NOT authorize reuse. An incomplete lifecycle whose erased content prevents reliable reconstruction MUST NOT be replayed. |

The Harness MUST NOT reopen an unfinished job under a different owner name. The [plugin binding](plugin.md#jobs) maps the [core job rules](../contracts.md#jobs) to callbacks. Portable history does not attest that a newly installed program with the same name is the same code; that trust is the operator's responsibility.

### Context and interrupted work

- For the default context the reader MUST take the current branch's model-visible messages in branch order, skipping erased records and private kinds. At each summary, it MUST remove its named visible sources from the view and insert a user text message containing `data.summary` at the earliest removed position. A later summary that replaces a summary MUST name that summary. A summary MUST name all entries it summarizes. It MUST NOT split a model call/result pair. If an erased source remains, the reader MUST omit its dependent summary. An enabled context handler can prepare a different request, but the committed request is the recovery reference.
- For an assistant message with calls, the reader MUST place their terminal tool messages immediately after it, in the order of the call parts, regardless of completion order. It MUST omit orphan results and remove call parts whose counterparts cannot be reconstructed due to erasure. For a call left open after its turn, the reader MUST use a model-only tool result with `isError: true` and text `This call is waiting for an answer. It has no result yet.` in place of the missing result. It MUST NOT record that projection as a terminal status. Other unresolved calls cannot enter a later step's context. Provider-only data follows [Content](#content).
- For a new turn the Harness MUST use the current settings. If the recorded model is unavailable, it MUST fail with model error kind `other` and put the explanatory message in the failed turn outcome, without substituting a model. When a selected model advertises a set of accepted reasoning levels, it MUST use the nearest one no higher than the selected level, or omit reasoning if none qualifies.
- A `turnStart` on the branch without a matching `turnEnd` is interrupted unless it is copied fork history. The reader MUST NOT schedule recovery from copied fork history. A tombstoned `turnEnd` still ends it. The Harness MUST use the recorded model, system, context, tool offer, settings and result shape, not new session defaults. If required parts or the snapshot are unavailable, it MUST end the turn as failed and settle pending calls honestly. A legacy input-taking turn abandoned before keeping its first `input` MUST end as failed without consuming the receipt. `continuesAfterRestart` governs whether the Runtime carries on.
- An unsettled model request may have reached the Provider. The Harness MUST repeat it only with the exact request available, recorded and current repeat guarantees, and a verified compatible Provider and account where the guarantee depends on them. It MUST check the recorded request against current authority and policy without changing it into a different request. To retry on recovery, the host MUST settle the previous attempt with an aborted response and commit the retry's fresh request intent in the same batch. This does not prove the previous attempt never ran. If it cannot be retried, the Harness MUST fail its interrupted turn. An out-of-turn request without a response is not a resumable turn.
- A call in a response or a `toolStarted` without a terminal result for its call ID is pending. For a call interrupted in flight, the Harness MUST repeat it only if the recorded start and current tool and environment promise safety, the call is recoverable and the Runtime continues it. It MUST run fresh dispatch checks. If the call is not repeated, or retry is refused or stopped before reaching the tool, the result MUST be `outcomeUnknown`. An unstarted call that will not run MUST get `notStarted`. A direct call interrupted outside a turn has no portable continuation; the Harness MUST settle it as unknown if it had started.
- The reader MUST identify an open question by a branch `inputRequest` with no terminal `inputAnswer` by request ID. With `waitingThroughRestart`, the durable Runtime MUST ask again using the same key and eligibility; an unkeyed request outside a tool call cannot be reused. Without that capability, the host follows the [core interrupted-question rule](../contracts.md#questions). A legacy record that cannot prove eligibility or whose answer has been erased MUST NOT authorize an effect.
- The reader MUST identify a call left open past its turn by membership in `turnEnd.data.result.openToolCalls` without a terminal `toolResult` on the branch. When its originating turn's open calls have no unanswered questions, the Harness MUST queue one continuation, unless a `turnStart` already names that turn in `continuesTurnId`. The eligible order is the append order of the records that made continuations eligible. The Harness MUST recover this queue before accepting more work and schedule it behind any running turn. A reopened build lacking either late-answer declaration MUST close the open questions as `noLongerAnswerable` and settle the calls without rerunning them. A started call with no confirmed outcome gets `outcomeUnknown`; otherwise apply [Tool dispatch](../contracts.md#tool-dispatch). An interrupted in-turn question not listed as left open MUST NOT become a late-answer continuation.

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
| `turnEnd` | turn `t1` |

## Rewinding

[Moving and rewinding](../contracts.md#moving-and-rewinding) defines when to save points, which target and point are eligible, and when to refuse. `data.point` on `turnStart` or an out-of-turn `toolStarted` holds the saved point. The working environment keeps points at least while the session is open; later retention is environment-specific.

When producing `outOfReach`, the host MUST use `openWorld` recorded on the call's `toolStarted`, treating an absent value as true. It MUST return the IDs of the affected calls in first dispatch order, without repeats.

The Harness MUST use this journal when restoring a point:

1. The host MUST save the current files as point P0.
2. It MUST commit a `position` to the target with `data.restore: { point, undo: P0 }` before restoring. If the commit is uncertain, it MUST read and reconcile the record under a verified writer lease before restoring or rolling back.
3. It MUST restore `point` before allowing any other work. Restoration MUST be idempotent. On reopening with this `position` as the latest record, it MUST restore the point again before any work.
4. If restoring fails, the host MUST commit a compensating `position` to the previous head with `restore: { point: P0, undo: point }`, restore P0 and refuse the move. If either compensation step fails or is uncertain, it MUST block further work until the committed head and its files can be reconciled. It MUST NOT report a successful rewind or rollback in that state.

## Changes

- **Production edition.** Defines the field types and mappings, history ownership and replay, approval and question policy, effect intents and rewind recovery. The binding remains `modular-agent-data/1`.

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

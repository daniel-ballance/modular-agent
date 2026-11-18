# Plugin binding: `modular-agent-plugin/1`

This binding connects the Harness to a plugin in another process. It covers tool sources, Providers, working environments, hook handlers, commands, Runtimes and jobs. History has [its own binding](history-http.md). Credential and configuration stores are not served over this binding.

Both peers MUST use the [shared data](data.md) shapes. The tables define method schemas: fields are required unless marked `?`; `Id` is a shared string identity and `RpcId` is a transport request id. `JSON` is any JSON value and `object` is a JSON object. `notify` means a notification with no response. The errors in the tables are in addition to [common protocol errors](#transport).

## Transport

- The host MUST start the plugin as a child process and send and receive JSON-RPC 2.0 over its stdin and stdout. The launching process is the authenticated peer on stdio; there is no extra authentication. The plugin MUST NOT write anything else to stdout. The host MAY route stderr to operator diagnostics. Each peer MUST NOT include secrets in errors, traces or diagnostics.
- Each peer MUST send one UTF-8 JSON-RPC object per line, with no byte order mark or batch. Receivers MUST accept LF and CRLF. The 64 MiB cap is 67,108,864 bytes, excluding the line ending. Receivers MUST bound input before decoding or parsing and close the connection on an oversized frame, including a frame with no newline. Senders MUST substitute `result_too_large` for an oversized success result. For an oversized outgoing error, senders MUST replace its diagnostic text and data with the minimal envelope for the same code. A sender MUST NOT send an oversized request or notification.
- Request ids MUST be strings or integers in the inclusive range −(2^53 − 1) to 2^53 − 1. Peers MUST compare ids by type and value, independently in each direction. A sender MUST NOT reuse an id on the same connection, even after its request settles. A parent is live from send until its answer is received. A peer MUST close on a reused request id, an unsolicited or duplicate answer, or an invalid response envelope.
- Each side MUST keep reading while work is pending. A receiver MUST register notifications in arrival order before settling a later answer, without blocking the reader on notification work. Only the method's stated completion barriers delay handing an answer back to the caller. Stream notifications MUST precede their request's answer. A receiver MUST discard notifications for a closed or wrong-kind request.
- A caller MAY send `$/cancel { id: RpcId }` for its own request. The receiver MUST ignore cancels for unknown or settled ids and treat duplicate cancels as one. On cancellation, the receiver MUST stop work in scope and answer within five seconds, with its result if the work already settled, or `cancelled` unless the method defines a cancellation result. A cancellation does not undo an outside effect.
- After sending cancel for a parent, the host MUST cancel active effect callbacks under it and reject new `host/env/exec`, `host/env/write`, `host/ask`, `host/runtime/runToolCall`, `host/runtime/model` and `host/jobs/start` with `cancelled`. Until the answer arrives, the host MUST still accept authorized reads, `host/runtime/record` and the `turn.end` hook. Other callbacks under a cancelled parent cannot start work. On receipt of the parent answer, the host MUST reject new requests naming it with `invalid_request` and cancel any unsettled effect callbacks. A plugin MUST settle its callbacks before answering their parent.

### Errors and connection loss

| JSON-RPC code | `data.code` | What it means |
|---|---|---|
| -32700 | `parse_error` | Invalid JSON or UTF-8, including an empty frame |
| -32600 | `invalid_request` | Invalid request envelope or batch |
| -32601 | `method_not_found` | The receiver has no such method |
| -32602 | `invalid_request` | Invalid params, identity, scope, authorization or state |
| -32000 | `not_found` | Named file or saved point does not exist |
| -32000 | `unknown_handler` | No such registered handler at this hook |
| -32000 | `cancelled` | Request cancelled |
| -32000 | `not_supported` | Unsupported version or capability |
| -32000 | `result_too_large` | The result does not fit its limit |
| -32000 | `lost` | The connection or a required part was lost |
| -32000 | `internal` | Other operation failure |

A receiver MUST return one error for a bad request frame, with the valid request id if known, else `null`. It MUST NOT answer a notification, including one with unknown method or bad params. Senders MUST include `data.code`. Receivers MUST use it rather than message text or the numeric code to identify an operation error. An unrecognized code is a failure of that operation. Neither `internal` nor `lost` is evidence that retrying is safe. Unknown fields follow the [shared data rules](data.md#general-rules).

Each peer SHOULD bound queued work and concurrent requests and callbacks. A peer MUST fail an over-limit request with `internal` before admitting the work and drop an over-limit notification rather than bypass validation.

Both directions offer `$/ping` with params `{}`, result `{}` and no method-specific error. Either peer MAY use it to check liveness. Normal work has no transport timeout. The host MUST bound initialization, any ping it sends, shutdown acknowledgement and process exit, with a default of five seconds per wait, configurable by the operator.

The host MUST treat unexpected EOF, process exit, an unusable stream, a required protocol close or a missed control or cancellation deadline as loss. On loss, each peer MUST end the connection, settle unanswered work once as `lost` and cancel callbacks still in flight. The host MUST terminate a lost child process still running and apply [Parts that are lost](../contracts.md#parts-that-are-lost) and [persistence before effects](#runtime-records-and-effects). Working-environment cleanup is limited by its declared containment. Process loss is not proof a durable job ended.

## Starting: the handshake

| Host request | Params | Result | Errors |
|---|---|---|---|
| `plugin/initialize` | `{ binding: string, data: string, host: { name: string, version: string }, project: string, home: string, config: object }` | `Registration` | `not_supported` for an unsupported version |
| `plugin/shutdown` | `{ reason: "stop" \| "reload" \| "refused", detail?: string }` | `{}` | Common errors only |

The first frame MUST be `plugin/initialize`, with `binding: "modular-agent-plugin/1"` and `data: "modular-agent-data/1"`. `project` and `home` are absolute paths to the project and the plugin's state folder. `config` is the plugin's settings, `{}` if none. A plugin MUST reject a second initialize with `invalid_request`. Until registration is accepted, only initialize, ping, cancel, shutdown and `host/problem` are available; there is no separate acceptance frame. The host's first request for registered work signals acceptance.

**Registration**

| Field | Type and default |
|---|---|
| `binding` | `"modular-agent-plugin/1"` |
| `name` | Nonempty string, stable plugin identity |
| `providers?` | `{ id: Id, supports: ProviderSupports, models: ModelInfo[] }[]`; default `[]` |
| `toolSources?` | `{ id: Id, tools: ToolDefinition[], perSession?: boolean }[]`; defaults `[]` and `perSession: false` |
| `workingEnvironment?` | `{ containment: "strong" \| "processGroup" \| "none", platforms?: string[], points?: boolean, confinesFiles?: boolean }`; default absent; omitted platforms makes no platform claim; omitted flags are false |
| `hooks?` | `{ hook: HookName, handlerId: integer, order?: "first" \| "normal" \| "last" }[]`; defaults `[]` and `order: "normal"` |
| `commands?` | `{ name: string, description: string }[]`; default `[]` |
| `runtime?` | `{ id: Id, supports: RuntimeSupports }`; default absent |
| `replaces?` | `string[]`; default `[]` |

`ProviderSupports` is `{ keepsState: boolean, runsTools: false, safeToRepeat?: boolean }`; the explicit repeat promise defaults to false. `RuntimeSupports` is `{ inputDuringTurn?: boolean, waitingThroughRestart?: boolean, continuesAfterRestart?: boolean }`; omitted flags default to false. `HookName` is a wire name from the [hook table](#the-host-asks-a-hook-handler). Handler ids are unique safe integers per registration. Tool source ids are unique per plugin. Provider ids, command names and tool names are unique in the host's registry for their kind, including within one registration or a refreshed tool view. A Runtime id identifies the single Runtime. Platform names name the systems on which the advertised containment applies.

Example:

```json
{
  "binding": "modular-agent-plugin/1",
  "name": "filter",
  "hooks": [{ "hook": "tool.before", "handlerId": 1 }]
}
```

- The host MUST validate the entire registration and run the already loaded [plugin load gate](#the-host-asks-a-hook-handler) before publishing any item. A plugin MUST serve the methods for each role it registers. A host MUST NOT send work for a role the plugin did not register. Only model catalogs, availability and tool lists can change without a new load.
- The host MUST load at most one plugin per name across local and external plugins. The host MUST compose plugins in load order as in [Contracts](../contracts.md#configuration-and-trust). The host MUST NOT change the plugin set while a session is open.
- A replacement MUST name an item it registers using `runtime`, `working-environment`, `provider:<id>`, `tool:<name>` or `command:<name>`. The host MUST refuse a duplicate replacement name, an unlisted collision (including a second Runtime or environment) or replacement of another external plugin's item. A registered replacement with no collision adds the item. The host MUST remove only the named local items and keep the rest of each local plugin.
- On refusal the host MUST leave the prior registry unchanged, report the reason and send `plugin/shutdown` with `reason: "refused"` and a diagnostic `detail`. A failed handshake loads nothing.
- When draining, the host MUST stop dispatching new work and cancel unsettled work. A plugin MUST stop accepting new work after receiving shutdown, settle it, and answer `{}` when cleanup in scope is complete. The host MUST close stdin after the answer. A plugin MUST exit on stdin EOF. The [connection loss rules](#errors-and-connection-loss) apply if shutdown or exit misses its deadline.

## The host asks a tool source

| Host method | Params | Result | Errors |
|---|---|---|---|
| `tools/list` | `{ toolSource: Id, sessionId?: Id }` | `{ tools: ToolDefinition[] }` | `invalid_request` for unknown source or wrong session scope |
| `tools/call` | `{ toolSource: Id, sessionId: Id, project: string, call: ToolCall }` | ToolResult without `callId`, or `{ pending: string }` | `invalid_request` for unknown source or tool, wrong scope or malformed call |

| Plugin notification | Params | Result / errors |
|---|---|---|
| `tools/progress` | `{ parentRequestId: RpcId, content: Content }` | notify |
| `tools/changed` | `{ toolSource: Id, parentRequestId?: RpcId }` | notify |

- Registration supplies the initial tool list. A source MUST return its full current list from `tools/list`, including entries it still provides from registration. The host MUST use a session id for per-session lists and omit it for other lists. The host MUST fetch a per-session list before first use in that session.
- A source MUST send `tools/changed` before answering a request that caused its list to change, with that request id. `tools/list` is read-only and MUST NOT cause a change. The notification affects only the parent's session for a per-session source with a session-scoped parent, all open sessions for other per-session changes, or the one shared list for a source that is not per-session.
- The host MUST invalidate affected lists on receipt and serialize refreshes for each affected view. The host MUST validate and publish each refreshed list atomically, discarding a refresh superseded by a later change. It MUST finish the refresh before passing on the triggering answer, without blocking the reader. If querying or validation fails, the host MUST leave that source unavailable in the affected view until a successful refresh and fail the triggering operation with `internal`. The host MUST NOT dispatch using an invalidated list or use a refresh to shadow another tool.
- The host MUST accept progress only for its live `tools/call`. A plugin MUST report ordinary tool failures as ToolResults and MUST NOT send further progress after its terminal answer. The host supplies `callId` from the call.
- A tool MAY ask through `host/ask` and use the session's environment through `host/env/*`. A tool MUST use that environment, not one of its own, for these operations. A tool provided by the environment itself need not route its own operations back through the host. This is a plugin design rule, not confinement.
- The plugin MUST answer `{ pending }` only when `host/ask` left a qualifying question open for the call. Question keys and answer shapes are in [Questions](data.md#questions); the [core question rules](../contracts.md#questions) govern persistence, reuse and effects before asking. A late continuation reruns the call from the top.

## The host asks a Provider

| Host method | Params | Result | Errors |
|---|---|---|---|
| `provider/models` | `{ provider: Id }` | `{ models: ModelInfo[] }` | `invalid_request` for unknown Provider |
| `provider/available` | `{ provider: Id }` | `{ available: boolean }` | `invalid_request` for unknown Provider |
| `provider/request` | `{ provider: Id, model: ModelRef, request: ModelRequest, sessionId?: Id }` | Assistant message | `invalid_request` for unknown Provider or model, mismatched identity or missing required session |
| `provider/discard` | `{ provider: Id, sessionId: Id, erase?: boolean, entryIds?: Id[] }` | `{}`, or `{ pending?: Id[], outOfReach?: string[] }` when erasing | `invalid_request` for bad scope or erasure params; `not_supported` for a stateless Provider |

| Plugin notification | Params | Result / errors |
|---|---|---|
| `provider/event` | `{ parentRequestId: RpcId, event: ModelStreamEvent }` | notify |

`ModelRef` is defined in [Messages](data.md#messages). `ModelStreamEvent` is the stream event in [Models](data.md#models).

- A Provider MUST register `runsTools: false`. A Provider MUST NOT run tools over this binding. This is the request/response profile; live sessions and late model (batch) answers are out of scope.
- A Provider MUST return its full current catalog for `provider/models`. The registration catalog is the initial view. Each catalog entry MUST name the registered Provider and a distinct model id. A Provider MUST report `available: false` if it cannot take requests with its current configuration and credentials. `true` does not guarantee the next request succeeds. A model failure after admission, including credentials rejected by the model service, MUST be an assistant message with `stop: "failed"` and an `error`, not a protocol error.
- The host and Provider MUST validate `model.provider == provider` and the model's identity against the Provider's catalog. The host MUST give a `sessionId` for a stateful request. A stateful Provider MUST isolate state by session and follow [Provider state](../contracts.md#provider-state). Requests and discards for one Provider and session MUST be serialized, including erasure.
- The host's Provider adapter MUST run the `provider.request` transform once before [recording](data.md#recording-order-and-ownership) and sending the effective `provider/request`. The Provider MUST call `host/hook` for `provider.request` before calling the model and use the returned request. The host MUST return the effective payload bound to that parent without running the transform again. The Provider MUST call `host/hook` for `provider.response` once with the complete message, after the last `provider/event` and before the answer. The Provider MUST return that same message. The host MUST run the response observers once, on that callback. The Runtime does not dispatch either Provider hook. An in-process Provider uses its own hook interface, not `host/hook`.
- `erase` defaults to false. The host MUST send a deduplicated `entryIds` list if and only if `erase` is true. The Provider MUST reject `entryIds` with duplicate ids, a missing list when `erase` is true, or a supplied list when `erase` is false or absent. A stateful Provider MUST discard conversation state when asked and, for erasure, attempt to delete the named remote copies it knows of. It MUST return `pending` as a subset of the requested ids without duplicates and `outOfReach` as kinds of copies it cannot delete. Omitted lists mean empty. The host MUST await the answer before reporting erasure and retain pending ids for a retry. Erasure retries identify the same copies.
- Credentials are returned by [`host/credentials/read`](#what-a-plugin-may-ask-the-host). A Runtime has no credential access as a Runtime.

## The host asks the working environment

| Host method | Params | Result | Errors |
|---|---|---|---|
| `env/read` | `{ sessionId: Id, cwd: string, path: string }` | `{ data: string }`, base64 | `not_found` for missing file; `invalid_request` for invalid or denied path; `internal` for I/O failure |
| `env/write` | `{ sessionId: Id, cwd: string, path: string, data: string }`, base64 | `{}` | `not_found` for missing parent directory; `invalid_request` for invalid or denied path or bad base64; `internal` for I/O failure |
| `env/exists` | `{ sessionId: Id, cwd: string, path: string }` | `{ exists: boolean }` | `invalid_request` for invalid or denied path; `internal` for I/O failure |
| `env/save` | `{ sessionId: Id, cwd: string }` | `{ point: Id }` | `not_supported` without points; `internal` for save failure |
| `env/restore` | `{ sessionId: Id, cwd: string, point: Id }` | `{}` | `not_supported` without points; `not_found` for unknown, expired or foreign point; `internal` for restore failure |
| `env/exec` | `{ sessionId: Id, cwd: string, command: string, timeoutMs?: integer }` | [ExecResult](data.md#working-environment) | `invalid_request` for invalid cwd or timeout; `internal` for launch failure; `lost` if cleanup in scope cannot be confirmed |
| `env/sessionEnded` | `{ sessionId: Id }` | `{}`, including when the session never used the environment | `lost` if cleanup in scope cannot be confirmed |

| Plugin notification | Params | Result / errors |
|---|---|---|
| `env/output` | `{ parentRequestId: RpcId, chunk: string }` | notify |

### Paths and points

- The host MUST route by its trusted session-to-environment and session-to-project mappings, never by a plugin's claimed project. The host MUST reject a supplied session or project that disagrees with the parent and validate authority before forwarding each callback.
- `cwd` MUST be an absolute path resolving to the project root or a directory inside it. A relative `path` MUST be resolved against `cwd`; an absolute path is resolved as given. The [core confinement rule](../contracts.md#the-working-environment) covers file paths after following symlinks. An environment that registers `confinesFiles: true` MUST enforce that boundary at the operation, including if paths change between check and use. The host MUST report the declaration in [ACP](acp.md#the-declaration). Process containment limits lifetime, not reach.
- `read` and `write` operate on regular files, including symlinks to such files if allowed by confinement. The environment MUST reject directory or special-file read and write targets with `invalid_request`. The environment MUST return `exists: false` for an admissible missing target. The environment MUST distinguish denied access from missing data. File writes have no portable atomicity promise on failure.
- The host MUST ask for points only from an environment that advertises `points: true`. A point covers the project files, not processes or external effects. The environment MUST scope points to the saving environment, session and project. It MUST keep them at least while the session is open. Retention after close or restart depends on that environment. A foreign or missing point MUST leave files unchanged.
- An environment MUST restore idempotently and in place, preserving the project directory itself. The host MUST exclude concurrent work it controls in that workspace during save and restore. An I/O failure can leave a partial restore; rewind and rollback follow [Rewinding](data.md#rewinding). The host MUST suspend new work in the session if restoration and rollback cannot establish the expected files.

### Command lifetime

- `command` is a string for the working environment's shell. The interpreter and shell syntax outside the fixture are deployment choices. `timeoutMs` MUST be a safe integer from 0 upwards. Omission and 0 both mean no requested deadline. The operator MAY set a shorter command deadline.
- The environment MUST decode stdout and stderr as UTF-8, replacing invalid input with U+FFFD, and merge chunks in observed order. The final `output` MUST be their concatenation. No relative ordering of simultaneous writes on the two pipes is guaranteed. The environment MUST send chunks only during the exec request, not after the answer. The host MUST forward allowed chunks on its corresponding `host/env/output`.
- An exit code MUST be an integer or `null` when killed. A command stopped by a deadline MUST return `timedOut: true` and `exitCode: null`. A wire cancel that wins the race MUST return `cancelled`, not a timeout result. The environment MUST stop a timed-out or cancelled command within the scope advertised below, within five seconds of timeout or cancel, or answer `lost` if that cleanup is unconfirmed.
- A normal exec answer and cancellation of a later turn MUST NOT by themselves stop background processes left by that command. The host MUST request `env/sessionEnded` on close and not issue new work for that session while it closes. The environment MUST clean up only that session's processes in scope and settle its outstanding commands before acknowledging. Repeating `env/sessionEnded` is safe. Agent or worker loss follows [connection loss](#errors-and-connection-loss); unconfirmed cleanup is not proof an interrupted command is safe to repeat.

| Containment | Scope on exec cancel or deadline, session close, or agent/worker loss |
|---|---|
| `strong` | The environment MUST stop the affected commands and all their descendants, including ones that left the original process group. This supplies the environment's promise for [safe repetition](../contracts.md#recovery-and-repeating-work). |
| `processGroup` | The environment MUST stop processes still within the affected commands' managed process groups. Processes that escape them are outside the promise. |
| `none` | The environment SHOULD attempt to stop the direct commands. No descendant or post-loss cleanup guarantee applies. |

## The host asks a hook handler

| Host request | Params | Result | Errors |
|---|---|---|---|
| `hook/handle` | `{ handlerId: integer, hook: HookName, payload: object }` | The answer in the hook table | `unknown_handler` if the id does not identify a handler for that hook; `invalid_request` for a malformed payload |

### From core hooks to wire hooks

The first column names the operation in [Contracts](../contracts.md#hook-points). The table projects those hooks onto the wire; it does not expose every core payload. In the table, field names ending in `Id` are shared ids. `Gate` is `null` or `{ refuse: string }`. `Transform` is `null` or `{ value: payload }`, replacing that hook's full payload. `InputWhen` and `StartedBy` are the forms used by `inputAccepted` and `turnStart` in [History entries](data.md#history-entries). `TurnResult` and `Outcome` are `data.result` and `data.outcome` on `turnEnd`.

| Core hook | /1 hook | Payload | Handler answer |
|---|---|---|---|
| Plugin about to load | `plugin.load` | `{ name: string, origin: "global" \| "project", project: string }` | Gate |
| Session starts | `session.start` | `{ sessionId, resumed: boolean }`; false on first start, true on reopen | `null` |
| Session joined or left | Not carried | | |
| Session ends | `session.end` | `{ sessionId }` | `null` |
| Input arrives | `input` | `{ sessionId, actorId, content: Content, when: InputWhen }` | Transform, or `{ value: payload, stop: true }` to handle the input |
| Before a turn | `turn.before` | `{ sessionId, turnId, input: Content }` | `null` or `{ system?: string, context?: Content }` |
| Turn starts | `turn.start` | `{ sessionId, turnId }` | `null` |
| Before each step | `step.before` | `{ sessionId, turnId, stepId, model: ModelInfo, request: ModelRequest }` | Transform |
| After each step | `step.after` | `{ sessionId, turnId, stepId, response: AssistantMessage }` | Gate; refusal ends the turn |
| Before a tool call | `tool.before` | `{ sessionId, turnId?, call: ToolCall, definition: ToolDefinition }` | Gate, `{ change: { call: ToolCall } }`, or `{ pending: string }` |
| After a tool call | `tool.after` | `{ sessionId, call: ToolCall, result: ToolResult }` | Transform |
| Model request failed | `model.failed` | `{ sessionId, request: ModelRequest, error: ModelError }` | `null` to pass, `{ retry: false }` to stop, or `{ retry: true, request?: ModelRequest }` |
| Turn result ready | `turn.result` | `{ sessionId, turnId, result: { text?: string, value?: JSON }, shape?: Schema }` | Gate; refusal sends the model back with the reason |
| Turn ends | `turn.end` | `{ sessionId, turnId, outcome: Outcome, result: TurnResult }` | `null` |
| Before a model request | `provider.request` | `{ sessionId: Id \| null, provider: Id, model: ModelRef, request: ModelRequest }` | Transform |
| As each Provider piece arrives | Not carried | | |
| Complete Provider response, wire projection | `provider.response` | `{ sessionId: Id \| null, provider: Id, model: ModelRef, message: AssistantMessage }` | `null` |
| Before output reaches a recipient | `output` | `{ sessionId: Id \| null, recipient: Id, events: OutputEvent[], final: true }` | `null`, `{ events: OutputEvent[] }` or `{ block: true }` |

`AssistantMessage` and `ModelError` use [Messages](data.md#messages). For sessionless Provider work, the host MUST normalize an omitted `sessionId` to `null`. `turn.before` collects additions before the turn is recorded; `turn.start` observes the start. The wire step hook carries the prepared request and model limits, not a history or usage snapshot. Permitted handlers can read recorded input, history and usage through `host/history`.

- The host MUST combine handlers according to the [core hook rules](../contracts.md#hook-points), with registration order breaking ties within one plugin. The host MUST reject registration of hooks not carried here. This binding has no plugin-defined hooks.
- The host MUST treat an illegal answer as a handler failure under those same rules. A transform MUST leave the enclosing scope, identity and authority fields unchanged. An `input` transform can change only `content`; `stop: true` ends the chain and consumes the input without sending it to the model. Handled input uses the core admission and command rules; this shape carries no command reply.
- The host MUST splice only `change.call.input` from a `tool.before` answer into the payload for the next handler. The host MUST apply the [input change and recheck rule](../contracts.md#tool-dispatch) before allowing dispatch. A `pending` answer is valid only for a question the host has persisted for this call that can outlast its turn. A `tool.after` transform can change only `result.content` and `result.value`.
- A `step.before` or `provider.request` transform MUST change only the `request` field. A changed or retried ModelRequest MUST NOT add a tool or expand its definition beyond what the turn and its current authority allow. The host MUST enforce the chosen model, current limits and tool offer at dispatch.

### Held output

The [core output gate](../contracts.md#the-output-gate) defines which deliveries are covered. The host MUST check each answer against the [shared event shapes and redaction rules](data.md#output-events) before using it.

- For a recipient covered by a remote output gate, the host MUST hold model response and tool output streams until their declared end, using the gate chain in effect when the stream began. The host MUST declare `holdsOutput: true`. The host MUST deliver a held stream before the reply to the request that caused it.
- At the end the host MUST send ordered segments of at most 4 MiB of compact UTF-8 JSON for the `events` array, splitting only at event boundaries. For other output, the host MUST send one item at a time, with the same byte limit. `final: true` means the gate has to decide on this batch now, even if another segment follows. Redaction across segment boundaries is not guaranteed.
- The host MUST bound the bytes held per recipient and stream, including replacement events. The host MUST block the stream on overflow or if one event cannot fit in a segment. For one non-stream item over 4 MiB, the host MUST block that item. The total buffer limit is a deployment setting.
- The host MUST pass each segment through the chain in order, giving each handler the events the previous one left. The host MUST NOT release any part before validating the whole delivery. The host MUST block delivery on a block, an oversized, malformed or unmappable replacement, an error or a lost handler. While awaiting a gate, the host MUST queue other output for that recipient separately, subject to the same limits and gate. The gate MUST NOT bypass itself by emitting output from its callback.
- The host MUST suppress withheld events and use the [ACP withheld response](acp.md#updates) for blocked replies to ACP clients. Raw history returned to a trusted plugin is not a recipient delivery.

## The host asks the Runtime

| Host request | Params | Result | Errors |
|---|---|---|---|
| `runtime/runTurn` | `{ turn: Turn }` | TurnOutcome | `not_supported` without a Runtime; `invalid_request` for malformed turn |
| `runtime/resumeTurn` | `{ turn: Turn, interrupted: { turnId: Id, calls: PendingCall[] } }` | TurnOutcome | As for `runTurn`; `invalid_request` for mismatched turn or calls |
| `runtime/continueOpenCalls` | `{ turn: Turn, calls: PendingCall[] }` | TurnOutcome | As for `runTurn`; `invalid_request` for invalid continuation |

| Shape | Fields |
|---|---|
| Turn | `{ sessionId: Id, turnId: Id, startedBy: StartedBy, model: ModelInfo, modelSupports: ProviderSupports, settings: TurnSettings, resultShape?: Schema }` |
| PendingCall | `{ id: Id, name: Id, input: object, stepId?: Id, started: boolean, safeToRepeat: boolean }` |
| TurnOutcome | `{ outcome: Outcome, result: TurnResult, entries: Id[], usage: Usage }` |

`StartedBy`, `Outcome` and `TurnResult` are the [history shapes](data.md#history-entries). `Usage` is the [shared total](data.md#messages). `TurnSettings` is defined in [Models](data.md#models) and `Schema` in [Tools](data.md#tools). `entries` lists the ids returned by `record` and `takeSteering` for this Runtime request, once each in commit order. It does not include `turnEnd`.

- The host MUST have at most one Runtime parent in flight per session. The Runtime MUST ask the host for model and tool work, not choose a model, read its credentials or run a tool itself. Out-of-turn Interface calls and [rewinding](data.md#rewinding) stay with the host.
- `runtime/resumeTurn` MUST use the interrupted turn's id in both places. The host MUST give unsettled calls in their original request order, with ids, original step and attribution taken from history. `started` means a `toolStarted` was recorded. `safeToRepeat` MUST be false unless a started call's recorded and current promises both hold. The [recovery rules](data.md#portable-sessions) govern interrupted model attempts, the transient or durable path, fresh authority checks and outcomes when a call cannot run again. The Runtime MUST recover from standard history kinds alone. [Questions](../contracts.md#questions) govern interrupted in-turn questions.
- For [late answers to questions](../contracts.md#questions), the host MUST send `runtime/continueOpenCalls` only after committing the one continuation for the original turn. Its new `turnId` and `startedBy: { kind: "answer", id }` identify the continuation and the last answered request. The host MUST record the [continuation link](data.md#history-entries) to the original turn. The host MUST use the original call order, ids and attribution, as read from the original turn and its question records. Calls rerun with current authority. Reopening an interrupted continuation uses `resumeTurn` for its existing id, not a second continuation.
- The host MUST serialize cancellation against a committed turn outcome. If cancellation wins, the host MUST record one cancelled outcome, settle calls and hand back queued input by the [core rules](../contracts.md#input). The Runtime MUST stop, cancel its in-flight work and report a cancelled outcome, even if a callback saw the cancellation first. A late reply claiming completion cannot override a winning cancel. Process loss is interruption, not cancellation.
- The host MUST validate `TurnOutcome` against committed entries, accounted usage and actual open calls. Only calls with a qualifying open question can appear in `openToolCalls`; a cancelled turn cannot leave a call open. An invalid outcome is a Runtime failure, not authority to write a forged `turnEnd`.

### Runtime callbacks

Every method or notification in this table also carries `parentRequestId: RpcId` for the turn. Bad scope, phase or identity is `invalid_request`; see [authority](#authority) and [transport](#transport).

| Plugin method | Other params | Result | Errors |
|---|---|---|---|
| `host/runtime/newId` | `{}` | `{ id: Id }` | Common errors only |
| `host/runtime/prepareStep` | `{ stepId: Id, usage: Usage }` | ModelRequest | `invalid_request` for an unallocated/reused step id or mismatched usage |
| `host/runtime/model` | `{ request: ModelRequest, stepId: Id }` | Assistant message | `invalid_request` for an unauthorized request or attempt; `lost` for Provider loss |
| `host/runtime/hook` | `{ hook: HookName, payload: object }` | Combined answer below | `invalid_request` for a wrong hook, payload or phase; `internal` for a failing non-gate, non-observe chain |
| `host/runtime/definition` | `{ toolName: string }` | ToolDefinition or `null` if not offered | Common errors only |
| `host/runtime/runToolCall` | `{ call: ToolCall }` | ToolResult or `{ callId: Id, pending: string }` | `invalid_request` for an unknown or settled call id; a known call denied dispatch gets a refused result |
| `host/runtime/record` | `{ entry: object }`, a draft [History entry](data.md#history-entries) | Committed history entry | `invalid_request` for a forbidden kind or mismatched entry; `lost` if the commit cannot be confirmed |
| `host/runtime/takeSteering` | `{}` | `{ entries: HistoryEntry[] }` | `not_supported` if steering is not offered |
| `host/runtime/hasSteering` | `{}` | `{ waiting: boolean }` | Common errors only |
| `host/runtime/report` | `{ type: string, data: JSON, stepId?: Id, toolCallId?: Id }` | notify | No reply |

| Host notification | Params | Result / errors |
|---|---|---|
| `host/runtime/modelEvent` | `{ parentRequestId: RpcId, event: ModelStreamEvent }`; id of the `host/runtime/model` callback | notify |

- `host/runtime/hook` MUST accept only `turn.start`, `step.after`, `tool.before`, `tool.after`, `model.failed`, `turn.result` and `turn.end`. The payload uses the [hook table](#from-core-hooks-to-wire-hooks) without `sessionId` and `turnId`, which the host derives from the parent and validates if supplied. The host MUST derive the tool definition and call attribution from its own state. Observe returns `null`; a gate returns `{ value: payload, refused?: string, pending?: string }` with at most one reason; a transform returns the complete payload; first answer returns the deciding answer or `null`. The Runtime MUST use `turn.end` at most once, as its last callback before answering; this is a pre-commit observation. If cancel has won, the host MUST present the cancelled outcome to the observers.
- For each attempt the Runtime MUST allocate a fresh `stepId` through `newId` and pass the cumulative usage of prior attempts to `prepareStep`. The host MUST verify usage from its own Provider responses and account for its own work separately. The host MUST freeze the [steering input](../contracts.md#input) it takes for that attempt before preparing it. `takeSteering` records and returns newly taken input in order; during a model request or tool round it returns no entries and leaves input queued.
- `prepareStep` runs `step.before` and returns the prepared request. The host MUST allow only that request, or a replacement from a validated `model.failed` retry of the last failed attempt. The host MUST permit one model attempt at a time per turn and reject a repeated send for the same step id. A retry MUST use a fresh attempt id, current limits and the same authority checks. On an allowed retry, the host MUST discard Provider state before resending. The [context-overflow limit](../contracts.md#compaction) still applies.
- The Runtime MUST submit a response for every answered model attempt, including a failure it will retry, before asking for a retry or dispatching calls. The Runtime runs `step.after` after the step's calls are settled, as in [Hook execution](../contracts.md#hook-execution); a refusal ends the turn. The host MUST bind `tool.before` to a call from a committed response or a pending call passed to this turn. The host MUST validate the id, name and original input before running the chain. The host MUST enforce the [all-parallel-or-serial tool round](../contracts.md#tool-dispatch). The host MUST NOT prepare the next step before the current round is settled. The next request receives the committed results in the original call order.
- At `runToolCall`, the host MUST check that every actor behind the work has the current effective `tools` right, that the tool is offered to the turn and still callable, and that an allowed `tool.before` decision matches the exact id, name and input. The host MUST retain that decision from its own hook chain under the live turn and consume it at most once. The host MUST serialize check and dispatch for each call against another dispatch, cancellation or change of authority. A missing or nonmatching decision, or failed authority or offer check, MUST produce one recorded `refused` result for the known call without dispatch. A call with a valid pending decision remains open without dispatch or result.

### Runtime records and effects

The host is the sole history writer. The Runtime port can submit only the kinds below.

| Owner | Entry kinds and commit point |
|---|---|
| Host | `inputAccepted`, `inputHandedBack`, `input` and `turnStart`; the host commits the turn start and the input it takes before dispatching the turn |
| Host | `modelRequest` at `host/runtime/model`, before sending to the Provider; fresh `stepId` each attempt and `safeToRepeat` from the Provider's declared support |
| Host | `toolStarted` before dispatch; `turnEnd` from the validated outcome |
| Host | `setting`, `actorJoined`, `actorLeft`, `limit`, `tenant`, `position`, `erasure`, `jobStarted`, `jobEnded`, `plugins`, `inputRequest` and `inputAnswer` |
| Runtime via `record` | `response` for a host-recorded attempt, `toolResult` for a call the host started or refused, and Runtime-owned kinds containing a dot |

- The host MUST refuse any other kind from `record` with `invalid_request`. It MUST fill `id`, `parentId`, `sessionId`, `time`, `turnId` and `writer` itself, and derive attribution from the parent and tracked work. A custom kind cannot stand for a standard record or change authority. Custom records are optional; their submission has no portable deduplication key.
- A `response` MUST match the host's `modelRequest` for that step and the assistant message returned by the host, with [canonical call ids](data.md#call-identities-and-mappings). The host MUST keep only one response per attempt and one terminal result per call. Repeating the same standard record under an eligible parent MUST return its existing entry; conflicting content is `invalid_request`.
- The host MUST run `tool.after` once while finalizing a known terminal tool result and commit the checked result before returning it to the Runtime. If the transform fails, the host MUST retain the factual result in history and fail the operation without returning unchecked output to the Runtime. A later `tool.after` for a settled call returns the cached outcome of that hook. A matching `record` returns the committed entry.
- A pending call has no terminal result. The host MUST retain its gate refusals and settle them even if the Runtime does not ask to dispatch. For cancellation and interruption the host MUST use the [core recovery rules](../contracts.md#recovery-and-repeating-work) to settle calls, not accept an unverified outcome from the Runtime. For a known call that will not be dispatched, the host MUST register the refusal or non-start in its call state before accepting a `toolResult` for it.
- The host MUST apply the [core persistence and lease rules](../contracts.md#recovery-and-repeating-work) to all dispatch through the Runtime port. An unconfirmed commit is not authority to start an effect. The host MUST treat the session as interrupted on such a failure, not replace the Runtime or retry the effect in the same session.

### Turn events

The host MUST emit standard [events](../contracts.md#event) once, through the output gate. Turn start and end follow their commits. Step start follows successful preparation. Step end follows the recorded response and disposition of its calls, or the failure or cancellation of the attempt, and carries accounted usage. Tool progress is live; a tool's terminal event follows its committed result, including refusal without dispatch. The host also emits model pieces and history entry events. A Runtime report MUST use a dotted custom event name, not a standard event name. The host MUST ignore a report impersonating a standard event and MUST NOT depend on reports to recover.

## Jobs

A job belongs to its plugin by registered name. The host records jobs in the [shared history kinds](data.md#history-entries).

| Host request | Params | Result | Errors |
|---|---|---|---|
| `jobs/cancel` | `{ jobId: Id }` | `{}` after the job's end is committed | `invalid_request` for an unknown job; `lost` if cleanup cannot be confirmed |

| Plugin method | Params | Result | Errors |
|---|---|---|---|
| `host/jobs/start` | `{ parentRequestId: RpcId, kind: string, key?: string, detail: JSON }` | `{ jobId: Id, started: boolean }` | `invalid_request` for an unauthorized start or a closing session |
| `host/jobs/unfinished` | `{ sessionId: Id }` | `{ jobs: { jobId: Id, kind: string, key?: string, detail: JSON, actorId: Id }[] }` in start order | `invalid_request` for a session that is not open |
| `host/jobs/resume` | `{ jobId: Id }` | `{}` | `invalid_request` for unknown, ended or foreign job, or closing session |
| `host/jobs/progress` | `{ jobId: Id, content: Content }` | notify | No reply |
| `host/jobs/end` | `{ jobId: Id, outcome: JobOutcome, result?: Content, report: boolean }` | `{}` | `invalid_request` for unknown/foreign job, conflicting end or inadmissible report; `lost` for an unconfirmed commit |

`JobOutcome` is `data.outcome` on `jobEnded` in [History entries](data.md#history-entries).

- The host MUST generate job ids unique across sessions, using at least 122 random bits or an equivalent source of uniqueness. For a provided key, the host MUST deduplicate by session and plugin name, even for a job already ended. It MUST return the original `jobId` with `started: false` on a duplicate and commit `jobStarted` before answering a new start. The host MUST check `jobs` against the current effective rights of everyone behind the parent before admitting the request.
- After a restart, unfinished jobs remain in history. On `session.start` with `resumed: true`, the plugin MAY find, resume or end its unfinished jobs. The host MUST allow resume or end only from the owning plugin's current connection while the host holds session write authority. A repeated resume on the same connection returns `{}` and does not start another execution. Resume grants that connection the job until the job ends, the connection is lost or the writer loses authority. The host MUST ignore progress without an active unfinished job on that connection. Progress is an event, not a commit.
- The host MUST serialize resume, cancel and end for a job. The first committed end wins. A repeated identical `end` from the current owner in an open session MUST return `{}` without a second end or report; a conflicting end is `invalid_request`. A plugin MAY end its unfinished job without resuming its work. A request that exceeds the owner's current authority cannot take effect.
- The host MUST check the job's [current narrowed rights](../contracts.md#authority), including `input` for a report. The plugin MUST NOT request a report for a result it already returned in the starting call or when the session is closing. The host MUST apply [atomic admission and recovery](data.md#job-reports) before acknowledging `end`. The acknowledgement does not wait for a turn. Scheduling follows `startsTurnsUnasked` and the session's input queue. There is no wire field for externally measured job usage; the host accounts once for work it tracks.
- The host MUST use the [core job rules](../contracts.md#jobs) to decide when turn cancellation or session close cancels jobs, and when an absent owner leaves work unfinished. Process stop interrupts jobs and does not end them.
- To cancel a job with a live owner, the host MUST send `jobs/cancel` to the owner and wait at most five seconds for confirmation. The plugin MUST stop the job and have its end committed through `host/jobs/end` before answering `{}`. If the work already finished, the plugin MUST use its actual result. An answer without a committed end, a lost owner or an unconfirmed cleanup is not a successful cancellation. The host MUST report `lost`, block further progress and late reports from that execution and retain the unfinished record rather than invent a clean end. A failed cleanup does not keep a closing session open.

## The host asks a command

| Host request | Params | Result | Errors |
|---|---|---|---|
| `command/run` | `{ name: string, args: string, sessionId: Id, actorId: Id }` | `{ output?: string }` | `invalid_request` for unknown command or invalid scope; `internal` for command failure |

`args` is the command's argument text, `""` if empty. The host MUST bind the command to the actor who gave it, including commands handled by an input transform. The [core command rules](../contracts.md#commands) govern dispatch.

## What a plugin may ask the host

| Plugin method | Params | Result | Errors |
|---|---|---|---|
| `host/ask` | `{ parentRequestId: RpcId, request: InputRequestDraft }` | [Answer or pending reply](data.md#questions) | `invalid_request` for bad question or parent; `not_supported` for unsupported waiting mode |
| `host/env/read` | `env/read` params plus `parentRequestId: RpcId` | As for `env/read` | As for `env/read`; `not_supported` if no environment |
| `host/env/write` | `env/write` params plus `parentRequestId: RpcId` | As for `env/write` | As for `env/write`; `not_supported` if no environment |
| `host/env/exists` | `env/exists` params plus `parentRequestId: RpcId` | As for `env/exists` | As for `env/exists`; `not_supported` if no environment |
| `host/env/exec` | `env/exec` params plus `parentRequestId: RpcId` | As for `env/exec` | As for `env/exec`; `not_supported` if no environment |
| `host/hook` | `{ parentRequestId: RpcId, hook: "provider.request" \| "provider.response", payload: object }` from the [hook table](#from-core-hooks-to-wire-hooks) | Full transformed payload for `provider.request`; `null` for `provider.response` | `invalid_request` for wrong hook, scope, phase or payload; `internal` for a failed request transform |
| `host/credentials/read` | `{ provider: Id }` | `{ credential: Credential \| null }`, in the [shared shape](data.md#credentials); `null` if none | `invalid_request` for a Provider not registered by that connection |
| `host/history` | `{ sessionId: Id, parentRequestId?: RpcId, after?: Id, limit?: integer, all?: boolean }` | `{ entries: HistoryEntry[], next?: Id }` | `invalid_request` for invalid cursor, limit or session; `result_too_large` for an entry that cannot fit |
| `host/session` | `{ sessionId: Id, parentRequestId?: RpcId }` | `{ id: Id, project: string, settings: object, busy: boolean, actors: Actor[] }` | `invalid_request` for invalid session or parent |
| `host/declaration` | `{ sessionId?: Id, parentRequestId?: RpcId }` | [Declaration](acp.md#the-declaration) | `invalid_request` for invalid session or parent |
| `host/emit` | `{ sessionId: Id, parentRequestId?: RpcId, type: string, data: JSON }` | notify | No reply |
| `host/problem` | `{ where: string, message: string }` | notify | No reply |

| Host notification | Params | Result / errors |
|---|---|---|
| `host/env/output` | `{ parentRequestId: RpcId, chunk: string }`; id of `host/env/exec` | notify |

`host/ask` MUST NOT return a secret value, only its stored name or the non-value fields of the [shared Answer](data.md#questions). For `host/emit`, the host MUST accept only dotted custom event names that do not impersonate standard events. The host MUST attribute them to the sending plugin and gate them as output. `host/problem` is operator diagnostics, not an event or a history write.

### Paging history

`all` defaults to false. The host MUST return the current branch in root-to-head order, or all entries in kept order with `all: true`, as defined in [Shared data](data.md#history-entries). `limit` MUST be from 1 to 500 inclusive, default 500. The host MUST page from immediately after `after`, or from the start when it is absent. A cursor not in the selected view is `invalid_request`. Each request reads the current view; the cursor is an entry id, not a snapshot. Appends, moves and erasure can change the view between pages.

The host MUST fit the whole compact UTF-8 JSON result, including any `next`, in 4 MiB. It MUST return `next` as the last returned id only when more entries remain. The host MUST include at least one entry when entries remain; if that entry and any required cursor do not fit, the host MUST return `result_too_large` rather than split or skip it. A host MUST NOT commit an entry that would make its own Runtime unable to page it. An external record already too large is a recovery failure, not an empty page.

### Authority

The host MUST reject invalid authority, session, role, ownership or parent with `invalid_request`, or drop an invalid notification. Parent scope comes from the host's record of the request, not callback parameters. If both a parent and a session are supplied, they MUST match. The host MUST apply the current effective rights of all actors behind the work and all relevant job ceilings at dispatch. The [cancellation rules](#transport) further narrow valid parents.

| Plugin method | Caller and required parent or scope |
|---|---|
| `host/ask` | Tool source, under its own live `tools/call`; question belongs to that call |
| `host/env/read`, `host/env/exists`, `host/env/write`, `host/env/exec` | Tool source under its own live `tools/call`, or command handler under its own live `command/run`; requires `tools` |
| `host/hook` | Provider under its own live `provider/request`, same Provider, model and session; sessionless only if the parent is sessionless |
| `host/runtime/*` | Registered Runtime under its own live `runtime/runTurn`, `runtime/resumeTurn` or `runtime/continueOpenCalls`; restricted to that turn and callback phase |
| `host/jobs/start` | Tool source under its own `tools/call` or command handler under its own `command/run`; session and actor from the parent; requires `jobs` |
| `host/jobs/unfinished` | Loaded plugin, own jobs in the named open session |
| `host/jobs/progress`, `host/jobs/resume`, `host/jobs/end` | Owning plugin connection, in the state allowed by [Jobs](#jobs); no parent |
| `host/history`, `host/session`, `host/emit` | Loaded plugin, open session; no parent required |
| `host/declaration` | Loaded plugin; open session when scoped; no parent for the unscoped declaration |
| `host/credentials/read` | Loaded plugin, for its own registered Provider only; no parent or session |
| `host/problem` | Sending plugin, including during handshake; no parent or session |

A Runtime registration grants no direct access to `host/env/*`, `host/ask` or credentials. An output hook grants no effect authority. The host MUST permit raw reads of any session open in that host to its loaded plugins. The host MUST NOT expose other sessions through these methods. The binding has no callback for erasing copies held independently by other plugins. Those copies are out of reach under [Erasure](../contracts.md#erasure).

## Choosing plugins at start

A plugin is trusted code. It runs with the agent's permissions. Process separation and use of the plugin API do not make a sandbox. The host observes interactions through the API, not effects a plugin causes outside it. An operator needing tenant isolation uses separate agents per tenant. See [Security](../security.md) for trust and deployment boundaries.

- The host MUST start only programs approved by the operator. The host MUST check project trust before starting a project plugin. The host MUST validate registration before enabling the plugin's callbacks or replacements.
- The host MUST read `MODULAR_AGENT_PLUGINS` at startup if set. It is a JSON array of `{ command: string[], env?: object, config?: object }`. `command` is a nonempty argument vector; its first item is the executable, with no shell expansion. `env` maps names to strings. Both optional objects default to `{}`. The host MUST reject malformed configuration before spawning programs from it. A build MAY support other configuration sources.
- The host MUST initialize these programs in array order after its own plugins. The host SHOULD start plugins with a minimal environment, adding only approved variables and passing only needed descriptors and configuration. The host MUST NOT pass credentials it holds in the process environment, arguments, configuration or inherited descriptors. Provider credentials requested through the credential method are a separate, scoped exchange.

## The conformance plugin

A host's conformance tests exercise the baseline roles and any Runtime tier the host claims. The transient and durable Runtime tiers are optional; neither is part of the baseline fixture. An environment's fixture advertises its actual containment, supported platforms and point support.

A build serving the conformance plugin MUST document its command and support the four baseline parts below. It MUST read `MODULAR_AGENT_PLUGIN_PARTS` as a comma-separated list of exact part names. If unset it MUST serve `provider,tools,environment,hooks`. The build MUST serve exactly the selected parts and reject empty, repeated or unknown names, unavailable parts and the combination of `runtime` and `durable-runtime`. Normal validation applies to fixture messages.

| Part | Registers | Replaces |
|---|---|---|
| `provider` | Provider `conformance`, model `echo`, as in [ACP conformance mode](acp.md#conformance-mode) | `provider:conformance` |
| `tools` | Source `conformance-tools` with `bash { command: string }` using `host/env/exec` and `read { path: string }` using `host/env/read` | `tool:bash`, `tool:read` |
| `environment` | Local environment; executes the fixture commands with Bash | `working-environment` |
| `runtime` | Transient Runtime | `runtime` |
| `durable-runtime` | Durable Runtime | `runtime` |
| `hooks` | `tool.before`, `turn.before` and `output`, as below | Nothing |

- `read` MUST return `completed` with one text part containing the file decoded as UTF-8, or `failed` with an explanation if the read fails. `bash` MUST forward each output chunk as a text progress part and return one text part containing combined output followed by a newline and `[exit code N]`, where `N` is the returned exit code or `null`. Its status MUST be `completed` only for exit code 0, and `failed` otherwise. Wire cancellation follows [Transport](#transport).
- The `tool.before` fixture MUST refuse a call whose input JSON contains `conformance-forbidden`, with reason `refused by the conformance plugin`. The `turn.before` fixture MUST contribute `{ "system": "The conformance plugin is loaded." }`. The `output` fixture MUST replace `conformance-secret` with `[redacted]` in editable strings, including a match across text events within one segment, without making other changes.

## Changes

- **Production edition.** Defines protocol lifecycle, method schemas, callback authority, Runtime commit and dispatch ownership, environment confinement and containment, exclusive jobs and atomic reports, and validation of segmented held output. The binding remains `/1`.
- **2026-11-18, round six.** One plugin of each name (Python G81, Go B29). The output gate's payload uses the shared [output events](data.md#output-events). A job's report is accepted before `host/jobs/end` answers, not run (Rust R5-07). A cancelled turn ends as cancelled even if a callback failed first (Rust R5-01). A page always holds at least one entry (Rust R5-08).
- **2026-11-18, after the round-five matrices.** `env/restore` restores in place. Elixir's environment replaced the project folder, so the Rust host, whose working directory it was, failed its next file operation with "no such file or directory".
- **2026-11-18, round five.** The open items left after round four, and the gaps the builders logged in it:
  - **Jobs** over the binding: `host/jobs/*` and `jobs/cancel`, recorded in standard kinds, so a reopening build with the same plugin finds a job's unfinished work. A plugin's `name` is its identity.
  - **The output gate,** offered as `output`, a stream at a time: the host holds each stream to its end and asks once. The conformance plugin's `hooks` part redacts `conformance-secret`.
  - **Rewinding** is the host's: `env/save` and `env/restore` with `points: true`. A Runtime's `supports` no longer mentions it.
  - **"Safe to repeat"** from a working environment means `containment: "strong"` (Elixir M2-4).
  - **`provider/discard`** with `erase` names entries, and `pending` lists entries (Go B24, Rust R4-05, Python G73). **`tools/changed`** may carry the request that caused it (Go B25). The history page's 4 MiB counts the `result` object (Python G72, Rust R4-07).
- **2026-11-18, after the final round-four matrices.** The Provider hook payloads' `model` is `{ provider, id }`. The TypeScript Provider sent the model's id as a string, and the Go host, checking it against the parent `provider/request`, refused every hook call, so every turn failed. The other hosts didn't compare the two.
- **2026-11-18, after the round-four Runtime matrix.** The `turn.end` payload's `outcome` is the `{ kind, ... }` object of a `turnEnd` entry, with `result` beside it. TypeScript's Runtime sent the whole TurnOutcome as `outcome`, and the Rust and Python hosts, reading `outcome.kind`, refused the hook request, which failed every turn. The Go and Elixir hosts accepted either.
- **2026-11-18, round four.** Rules from the 42 binding gaps the Rust, Python and Go builders logged in round three. Where they agreed, their choice became the rule. Where they didn't, the change says which way it went:
  - **Replacing** is by item, not by plugin, and a registration the host can't accept means the plugin isn't loaded, with `plugin/shutdown { reason: "refused" }` (Rust B-08, Python G52 and G65, Go B7).
  - **Which requests need a parent,** which may name a session directly, and that a parent is live only until it's answered (Rust B-10, Python G53, Go B8).
  - **Paging history:** `next`, an unknown `after`, the limit, and `result_too_large` for one entry over 4 MiB (Rust B-10, Python G54, Go B10).
  - **Credentials** have a shared shape (Rust B-09, Python G53, Go B8). The three builds had picked `apiKey`, `value` and `key`.
  - **`provider/discard` with `erase`,** for erasing a stateful Provider's remote copies (Rust B-11).
  - **"As the response arrives"** runs once per response over the wire, with the complete message (Rust B-12, Python G56, Go B9). Plugins can't define hook points over the wire.
  - **`env/*` carries `sessionId`,** and `env/sessionEnded` stops a session's background work (Rust B-13, Python G51, Go B11).
  - **Cancelling a request that hadn't started** still gets an answer (Python G64). Both sides keep reading while they work (Python G55). JSON-RPC error numbers (Go B11).
  - **The Runtime:** the host records `turnStart` before the turn and `turnEnd` from its outcome (Rust B-19, Python G59, Go B15); `turn.end` is the Runtime's last request (Python G60); `safeToRepeat` on interrupted calls (Go B14); recovery from the standard kinds alone, with no private records required (Rust B-18, Python G58, Go B13); gate answers typed (Python G60); a retried model request (Rust B-21); continued calls and `openToolCalls` (Rust B-22, Go B16); reports are optional and a host never depends on them (Rust B-20, Python G61, Go B15); parallel results recorded at once and shown in call order (Python G62); UI tool calls and rewinding stay with the host (Python G63, Go B16).

- **2026-11-17, after the Runtime matrix.** A Runtime reads history with `host/history`, which Go's durable Runtime needed to recover and Python's host refused. Rust (B-18) and Python (G58) had both logged the gap. And a host answers a cancelled `host/*` request too: the Rust host left one unanswered, so a cancel that landed during a hook stalled the turn until a timer fired.
- **2026-11-17, after the first Runtime swaps.** The host emits the standard turn events itself, and `host/runtime/model` carries `stepId`. Go's Runtime reported streamed text as `model.delta`, and the TypeScript host expected `model.output`, so a TypeScript agent running Go's Runtime showed the client no streamed text. The host sees the stream anyway, so nothing needed naming.
- **2026-11-17.** Stage 2: the Runtime. `runtime/runTurn`, `runtime/resumeTurn` and `runtime/continueOpenCalls`, the Runtime host as `host/runtime/*`, and the conformance parts `runtime` and `durable-runtime`.
- **2026-11-17.** First version, stage 1.
- **2026-11-17, after the four-language matrix.** A missing file is `not_found`. Every environment reported it as `internal`, in its own language's words, and the Python host told it apart by looking for the text "No such file". That worked with Rust's and Python's environments, and failed every turn with Go's and TypeScript's.
- **2026-11-17, after the first swap matrix.** `timeoutMs: 0` means no limit. Go sent `0` for no limit and Rust read it as an instant timeout, so a Rust host with Go's tools, and a Go host with Rust's tools, cancelled every command at once. Each build passed on its own; only the swap found it. The plugin kit now checks both readings.

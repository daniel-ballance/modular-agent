# Plugin binding: `modular-agent-plugin/1`

This binding defines the wire between the Harness and a plugin in another process. It covers tool sources, Providers, working environments, hook handlers, commands, Runtimes and jobs. [Contracts](../contracts.md) defines core behavior and [Security](../security.md) defines trust. History has [its own binding](history-http.md). This binding does not serve credential or configuration stores.

Both peers MUST use the [shared data](data.md) shapes. The tables define method schemas: fields are required unless marked `?`; `Id` is a shared string identity and `RpcId` is a transport request id. `JSON` is any JSON value and `object` is a JSON object. `notify` means a notification with no response. The errors in the tables are in addition to [common protocol errors](#transport).

## Transport

- The host MUST start the plugin as a child process and send and receive JSON-RPC 2.0 over its stdin and stdout, or connect to a plugin service over the [WebSocket transport](websocket.md), which replaces this section's stdio rules. See [Stdio authentication](../security.md#authentication-on-each-wire) for the peer and trust rules. The plugin MUST NOT write anything else to stdout. The host MAY route stderr to operator diagnostics. Each peer MUST NOT include secrets in errors, traces or diagnostics.
- Each peer MUST send one UTF-8 JSON-RPC object per line, with no byte order mark or batch. Receivers MUST accept LF and CRLF. The 64 MiB cap counts 67,108,864 [actual line bytes](data.md#general-rules), excluding the line ending. Receivers MUST bound input before decoding or parsing and close the connection on an oversized frame, including a frame with no newline. Senders MUST substitute `result_too_large` for an oversized success result. For an oversized outgoing error, senders MUST replace its diagnostic text and data with the minimal envelope for the same code. A sender MUST NOT send an oversized request or notification.
- Request ids MUST be strings or integers in the inclusive range −(2^53 − 1) to 2^53 − 1. Peers MUST compare ids by type and value, independently in each direction. A sender MUST NOT reuse an id on the same connection, even after its request settles. A parent is live from send until its answer is received. A peer MUST close on a reused request id, an unsolicited or duplicate answer, or an invalid response envelope.
- Each side MUST keep reading while work is pending. A receiver MUST register notifications in arrival order before settling a later answer, without blocking the reader on notification work. Only the method's stated completion barriers delay handing an answer back to the caller. Stream notifications MUST precede their request's answer. A receiver MUST discard notifications for a closed or wrong-kind request.
- A caller MAY send `$/cancel { id: RpcId }` for its own request. The receiver MUST ignore cancels for unknown or settled ids and treat duplicate cancels as one. On cancellation, the receiver MUST stop work in scope and answer within five seconds, with its result if the work already settled, or `cancelled` unless the method defines a cancellation result. A cancellation does not undo an outside effect.
- After sending cancel for a parent, the host MUST cancel active effect callbacks under it and reject new `host/env/exec`, `host/env/write`, `host/tools/call`, `host/ask`, `host/runtime/runToolCall`, `host/runtime/model`, `host/jobs/start` and `host/hook` for `provider.request` with `cancelled`. Until the answer arrives, the host MUST still accept authorized reads, `host/runtime/record` and the `turn.end` hook. Other callbacks under a cancelled parent cannot start work. On receipt of the parent answer, the host MUST reject new requests naming it with `invalid_request` and cancel any unsettled effect callbacks. A plugin MUST settle its callbacks before answering their parent.

### Errors and connection loss

| JSON-RPC code | `data.code` | What it means |
|---|---|---|
| -32700 | `parse_error` | Invalid JSON or UTF-8, including an empty frame |
| -32600 | `invalid_request` | Invalid request envelope or batch |
| -32601 | `method_not_found` | The receiver has no such method |
| -32602 | `invalid_request` | Invalid params, identity, scope, authorization or state, including a [Provider reply without its request callback](#the-host-asks-a-provider); a request refused for [JSON depth](data.md#general-rules) |
| -32000 | `not_found` | Named file does not exist or a saved point is unavailable in the requested scope; see [Paths and points](#paths-and-points) |
| -32000 | `unknown_handler` | No such registered handler at this hook |
| -32000 | `cancelled` | Request cancelled |
| -32000 | `not_supported` | Unsupported version or capability |
| -32000 | `result_too_large` | The result does not fit its limit |
| -32000 | `busy` | A new operation cannot reserve capacity; no start or admission was recorded |
| -32000 | `turn_limit` | The host stopped preparation or dispatch for a limit, including one reached after the previous step; `data.limit` is `steps`, `capacity`, `tenantTokens`, `sessionTokens` or a deployment limit name |
| -32000 | `lost` | The connection or a required part was lost |
| -32000 | `internal` | Other operation failure |

A receiver MUST treat invalid UTF-8, invalid JSON and duplicate JSON keys as `parse_error` with null id. A parsed object with `result` or `error` is response-like and MUST close the connection if the response envelope is invalid, including if it also has `method`. A valid request envelope without `id` is a notification; the receiver MUST NOT answer it, even for an unknown method or bad params. For other malformed envelopes the receiver MUST return `invalid_request` using a valid request id if known, otherwise null. Invalid params use -32602. Senders MUST include `data.code`. Receivers MUST interpret that code without inferring retry safety.

Each peer MUST bound queued work and reserve capacity for responses and cancellation. It MUST handle nested callbacks while awaiting a response, or reject cyclic routing with `internal` before dispatch. An overloaded peer MUST reject new requests with `internal` before admission. It MAY drop progress notifications, but MUST NOT silently drop a catalog invalidation. If it cannot process one, it MUST invalidate the source or close the connection. At the request-ID budget, a sender MUST drain and close rather than reuse ids; a reconnect has a new scope.

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

`ProviderSupports` is `{ keepsState: boolean, runsTools: false, safeToRepeat?: boolean }`; the explicit repeat promise defaults to false. `RuntimeSupports` is `{ inputDuringTurn?: boolean, waitingThroughRestart?: boolean, continuesAfterRestart?: boolean }`; omitted flags default to false. `HookName` is a wire name from the [hook table](#the-host-asks-a-hook-handler). Handler ids MUST be unique safe integers per registration. Tool source ids MUST be unique per plugin. Provider ids, command names and tool names MUST be unique within their kind in the host's registry, including within one registration or refreshed view. A Runtime id identifies the single Runtime. The standard platform identifiers are `linux`, `darwin`, `win32`, `freebsd` and `openbsd`. Senders MUST use those spellings for claims on those systems. The host MUST compare the advertised identifiers to the execution platform exactly. The host MUST treat unknown, omitted or nonmatching identifiers as no claim of containment.

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
- On refusal the host MUST leave the prior registry unchanged, report the reason and send `plugin/shutdown` with `reason: "refused"` and a diagnostic `detail`. A failed handshake loads nothing. For a configured program, any registration refusal is a [startup failure](#choosing-plugins-at-start).
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

- Registration supplies the initial tool list. The host MUST identify each tool's [source](data.md#standard-kinds) by the registered plugin name and `toolSource` id. A source MUST return its full current list from `tools/list`, including entries it still provides from registration. The host MUST use a session id for per-session lists and omit it for other lists. The host MUST fetch a per-session list before first use in that session.
- A source MUST send `tools/changed` before answering a request that caused its list to change, with that request id. `tools/list` is read-only and MUST NOT cause a change. The notification affects only the parent's session for a per-session source with a session-scoped parent, all open sessions for other per-session changes, or the one shared list for a source that is not per-session.
- The host MUST invalidate affected lists on receipt and serialize refreshes by view. It MUST publish only a validated refresh not superseded by a newer change. It MUST finish that refresh or report its failure before passing on the triggering answer, using an operator-configured timeout (default five seconds). On failure it MUST keep the source unavailable, report that separately and preserve the triggering call's result. It MUST retry the refresh before a later use of an unavailable list. Cancel stops new dispatch for the cancelled work, not catalog invalidation.
- The host MUST accept progress only for its live `tools/call`. A plugin MUST report ordinary tool failures as ToolResults and MUST NOT send further progress after its terminal answer. The host supplies `callId` from the call.
- A tool MAY ask through `host/ask` and use the session's environment through `host/env/*`. A tool MUST use that environment, not one of its own, for these operations. A tool provided by the environment itself need not route its own operations back through the host. This is a plugin design rule, not confinement.
- The plugin MUST answer `{ pending }` only after stopping its invocation as in [Questions](../contracts.md#questions). The implicit question set is all committed non-approval questions left open by `host/ask` for that exact invocation. The host MUST follow the [continuation rule](../contracts.md#questions) even if an answer reached it before the pending reply. `pending` text is descriptive, not an identifier.

## The host asks a Provider

| Host method | Params | Result | Errors |
|---|---|---|---|
| `provider/models` | `{ provider: Id }` | `{ models: ModelInfo[] }` | `invalid_request` for unknown Provider |
| `provider/available` | `{ provider: Id }` | `{ available: boolean }` | `invalid_request` for unknown Provider |
| `provider/request` | `{ provider: Id, model: ModelRef, request: ModelRequest, sessionId?: Id }` | Assistant message | `invalid_request` for unknown Provider or model, mismatched identity or missing required session |
| `provider/discard` | `{ provider: Id, sessionId: Id, erase?: boolean, entryIds?: Id[] }` | `{}`, or `{ pending?: Id[], outOfReach?: string[] }` when erasing | `invalid_request` for bad scope or erasure params; `not_supported` for an unsupported discard or copy deletion |

| Plugin notification | Params | Result / errors |
|---|---|---|
| `provider/event` | `{ parentRequestId: RpcId, event: ModelStreamEvent }` | notify |

`ModelRef` is defined in [Messages](data.md#messages). `ModelStreamEvent` is the stream event in [Models](data.md#models).

- A Provider MUST register `runsTools: false`. A Provider MUST NOT run tools over this binding. This is the request/response profile; live sessions and late model (batch) answers are out of scope.
- A Provider MUST return its full current catalog for `provider/models`. The registration catalog is the initial view. Each catalog entry MUST name the registered Provider and a distinct model id. A Provider MUST report `available: false` if it cannot take requests with its current configuration and credentials. `true` does not guarantee the next request succeeds. A model failure after admission, including credentials rejected by the model service, MUST be an assistant message with `stop: "failed"` and an `error`, not a protocol error.
- The host MUST refresh catalog and readiness before preparing a step and refuse an unavailable or removed selection without substituting a model. The host and Provider MUST validate `model.provider == provider` and the selected identity; a removal noticed after preparation fails the dispatch or attempt. Stateful requests MUST carry `sessionId`. The host MUST serialize those requests and discards and apply [Provider state](../contracts.md#provider-state).
- For every `provider/request`, even with no registered handlers, the Provider MUST call `host/hook` with `hook: "provider.request"` and the original request payload. The host MUST accept that callback only once per parent and apply the transform there, except on an authorized exact replay. With no handler or on exact replay, the request is unchanged.
- The host MUST commit [`modelRequest`](data.md#recording-order-and-ownership) for the final transformed request at that callback before returning the transformed payload to the Provider. It MUST recheck [dispatch authority](../contracts.md#tool-dispatch) before replying with permission to infer. The Provider MUST wait for that successful answer and use its request for inference.
- If a Provider answers `provider/request` without first calling `host/hook` with `hook: "provider.request"`, the host MUST treat the attempt as not started. It MUST NOT write any history record for the attempt. It MUST answer `host/runtime/model` with `invalid_request` (`-32602`). This case is safe to retry because the host did not admit inference.
- The host MUST discard any `provider/event` before that successful callback answer. After streaming any pieces, the Provider MUST call `host/hook` with `hook: "provider.response"` and exactly `{ sessionId, provider, model, message }` as the payload. `message` is the complete raw response. The Provider MUST return that same message as its `provider/request` result.
- The host MUST validate those four fields against the [hook projection](#from-core-hooks-to-wire-hooks) and the admitted scope. It MUST treat unknown payload members as [inert data](data.md#general-rules), never as a reason to refuse. The host MUST reject a `provider.response` callback without a committed `modelRequest` for that parent with `invalid_request`. It MUST fail the attempt without using the final result if the result arrives without that commit or without the accepted response callback. The host MUST run observers on the raw response callback once. It MUST compare that response with the final result before canonicalizing call IDs and fail an inconsistent attempt without dispatching its calls.
- `erase` defaults to false. The host MUST send a deduplicated `entryIds` list exactly when erasing. A stateful Provider MUST discard state when asked; state discard does not confirm copy deletion. Any Provider that can identify and delete the named copies MAY support erasure independently of state. It MUST report unresolved copies as `pending` ids or `outOfReach` kinds. A Provider lacking a reliable copy mapping MUST report those copies out of reach or answer `not_supported`, which the host MUST NOT treat as deletion. `/1` has no vendor copy handle.
- Credentials are returned by [`host/credentials/read`](#what-a-plugin-may-ask-the-host). A Runtime has no credential access as a Runtime.
- A Provider whose `provider/request` is cancelled MUST stop inference and answer `cancelled`. It MUST NOT call `host/hook` with `provider.response` for that request once the cancel has reached it. A response callback already sent stands.
- Each `outOfReach` item is a description for a person, such as which copies the vendor keeps. A host MUST pass it on unchanged and MUST NOT branch on its wording.

## The host asks the working environment

| Host method | Params | Result | Errors |
|---|---|---|---|
| `env/read` | `{ sessionId: Id, cwd: string, path: string }` | `{ data: string }`, base64 | `not_found` for missing file; `not_supported` if the environment does not support reads; `invalid_request` for invalid or denied path; `internal` for I/O failure |
| `env/write` | `{ sessionId: Id, cwd: string, path: string, data: string }`, base64 | `{}` | `not_found` for missing parent directory; `invalid_request` for invalid or denied path or bad base64; `internal` for I/O failure |
| `env/exists` | `{ sessionId: Id, cwd: string, path: string }` | `{ exists: boolean }` | `invalid_request` for invalid or denied path; `internal` for I/O failure |
| `env/list` | `{ sessionId: Id, cwd: string, path: string }` | `{ entries: DirEntry[] }`, in the [shared shape](data.md#working-environment) | `not_found` for a missing directory; `invalid_request` for an invalid or denied path or a target that is not a directory; `not_supported` if the environment does not list; `internal` for I/O failure |
| `env/save` | `{ sessionId: Id, cwd: string }` | `{ point: Id }` | `not_supported` without points; `internal` for save failure |
| `env/checkPoint` | `{ cwd: string, sessionId: Id, point: Id }` | `{ exists: boolean }`; see [Paths and points](#paths-and-points) | `not_supported` without points; `invalid_request` for invalid scope; `internal` for a check failure |
| `env/restore` | `{ sessionId: Id, cwd: string, point: Id }` | `{}` | `not_supported` without points; `not_found` for unknown, expired, foreign or unowned point; `internal` for restore failure |
| `env/exec` | `{ sessionId: Id, cwd: string, command: string, timeoutMs?: integer }` | [ExecResult](data.md#working-environment) | `invalid_request` for invalid cwd or timeout; `internal` for launch failure; `lost` if cleanup in scope cannot be confirmed |
| `env/sessionEnded` | `{ sessionId: Id }` | `{}`, including when the session never used the environment | `lost` if cleanup in scope cannot be confirmed |

| Plugin notification | Params | Result / errors |
|---|---|---|
| `env/output` | `{ parentRequestId: RpcId, chunk: string }` | notify |

### Paths and points

- The host MUST route by its trusted session-to-environment and session-to-project mappings, never by a plugin's claimed project. The host MUST reject a supplied session or project that disagrees with the parent and validate authority before forwarding each callback.
- A remote environment connection MUST serve only the canonical project from initialization, in that environment's path syntax. The host MUST refuse use for another project. `cwd` MUST resolve to the root or a directory inside it. Relative `path` resolves against `cwd`; absolute paths resolve as given. Platform claims follow [Registration](#starting-the-handshake). An environment declaring `confinesFiles: true` MUST enforce the boundary at use, including symlink changes. See [core confinement](../contracts.md#the-working-environment).
- `read` and `write` operate on regular files, including symlinks to such files if allowed by confinement. The environment MUST reject directory or special-file read and write targets with `invalid_request`. The environment MUST return `exists: false` for an admissible missing target. The environment MUST distinguish denied access from missing data. The host MUST apply the [core optional project file rule](../contracts.md#configuration-and-trust) to `env/read` errors when loading those files. File writes have no portable atomicity promise on failure.
- The host MUST ask for points only from an environment that advertises `points: true`. A point covers the project files, not processes or external effects. The environment MUST scope points to the saving session and project and follow the [core point identity rule](../contracts.md#the-working-environment). It MUST keep them at least while the session is open. Retention after close or restart depends on that environment. `env/checkPoint` MUST leave state unchanged. It MUST return `exists: false` for an unknown, expired, foreign or [unowned point](data.md#rewinding). See [rewind preflight](../contracts.md#moving-and-rewinding) and [journal recovery](data.md#rewinding) for when the host uses it. A restore refused with `not_found` MUST leave files unchanged.
- An environment MUST restore idempotently and in place, preserving the project directory itself. The host MUST exclude concurrent work it controls in that workspace during save and restore. An I/O failure can leave a partial restore; rewind and rollback follow [Rewinding](data.md#rewinding). The rewind journal governs when project work can resume.

### Command lifetime

- `command` is a string for the working environment's shell. The interpreter and shell syntax outside the fixture are deployment choices. `timeoutMs` MUST be a safe integer from 0 upwards. Omission and 0 both mean no requested deadline. The operator MAY set a shorter command deadline.
- The environment MUST decode stdout and stderr as UTF-8 with U+FFFD replacement and merge in observed order. `output` MUST concatenate the chunks the sender retained, not the subset delivered to a recipient. The environment MUST bound retained output to fit the result frame, stop retaining and emitting on overflow, and report `truncated: true` with the terminal status. The host MUST forward only authorized pieces before the answer.
- An exit code MUST be an integer or `null` when killed. A command stopped by a deadline MUST return `timedOut: true` and `exitCode: null`. A wire cancel that wins the race MUST return `cancelled`, not a timeout result. The environment MUST stop a timed-out or cancelled command within the scope advertised below, within five seconds of timeout or cancel, or answer `lost` if that cleanup is unconfirmed.
- A normal exec answer and cancellation of a later turn MUST NOT by themselves stop background processes left by that command. The host MUST request `env/sessionEnded` on close and not issue new work for that session while it closes. The environment MUST clean up only that session's processes in scope and settle its outstanding commands before acknowledging. Repeating `env/sessionEnded` is safe. Agent or worker loss follows [connection loss](#errors-and-connection-loss); unconfirmed cleanup is not proof an interrupted command is safe to repeat.

| Containment | Scope on exec cancel or deadline, session close, or agent/worker loss |
|---|---|
| `strong` | The environment MUST stop the affected commands and all their descendants, including ones that left the original process group. Containment alone is not a [repeat guarantee](../contracts.md#recovery-and-repeating-work). |
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
| Session starts | `session.start` | `{ sessionId, resumed: boolean }`; false on first start, true on reopen; see [callback lifetime on reopen](#jobs) | `null` |
| Session joined or left | Not carried | | |
| Session ends | `session.end` | `{ sessionId }` | `null` |
| Input arrives | `input` | `{ sessionId, actorId, content: Content, when: InputWhen }` | Transform, or `{ value: payload, stop: true }` to handle the input |
| Before a turn | `turn.before` | `{ sessionId, turnId, input: Content }` | `null` or `{ system?: string, context?: Content }` |
| Turn starts | `turn.start` | `{ sessionId, turnId }` | `null` |
| Before each step | `step.before` | `{ sessionId, turnId, stepId, model: ModelInfo, request: ModelRequest }` | Transform |
| After each step | `step.after` | `{ sessionId, turnId, stepId, response: AssistantMessage }` | Gate; refusal ends the turn |
| Before a tool call | `tool.before` | `{ sessionId, turnId?, call: ToolCall, definition: ToolDefinition }` | Gate or `{ change: { call: ToolCall } }`; remote handlers cannot return pending. The [host's reply to the Runtime](#runtime-records-and-effects) also carries the committed result for a refusal. |
| After a tool call | `tool.after` | `{ sessionId, call: ToolCall, result: ToolResult }` | Transform |
| Model request failed | `model.failed` | `{ sessionId, request: ModelRequest, error: ModelError }` | `null` to pass, `{ retry: false }` to stop, or `{ retry: true, request?: ModelRequest }` |
| Turn result ready | `turn.result` | `{ sessionId, turnId, result: { text?: string, value?: JSON }, shape?: Schema }` | Gate; refusal triggers [result feedback](../contracts.md#hook-execution) |
| Turn ends | `turn.end` | `{ sessionId, turnId, outcome: Outcome, result: TurnResult }` | `null` |
| Before a model request | `provider.request` | `{ sessionId: Id \| null, provider: Id, model: ModelRef, request: ModelRequest }` | Transform |
| As each Provider piece arrives | Not carried | | |
| Complete Provider response, wire projection | `provider.response` | `{ sessionId: Id \| null, provider: Id, model: ModelRef, message: AssistantMessage }`; see [Provider callback validation](#the-host-asks-a-provider) | `null` |
| Before output reaches a recipient | `output` | `{ sessionId: Id \| null, recipient: Id, events: OutputEvent[], final: true }` | `null`, `{ events: OutputEvent[] }` or `{ block: true }` |

`AssistantMessage` and `ModelError` use [Messages](data.md#messages). For sessionless Provider work, the host MUST normalize an omitted `sessionId` to `null`. `turn.before` collects additions before the turn is recorded; `turn.start` observes the start. The wire step hook carries the prepared request and model limits, not a history or usage snapshot. Permitted handlers can read recorded input, history and usage through `host/history`.

- The host MUST combine handlers according to the [core hook rules](../contracts.md#hook-execution), with registration order breaking ties within one plugin. The host MUST reject registration of hooks not carried here. This binding has no plugin-defined hooks.
- The host MUST treat an illegal answer as a handler failure under those same rules. A transform MUST leave the enclosing scope, identity and authority fields unchanged. An `input` transform MUST leave every field except `content` unchanged. The host MUST treat `stop: true` as a handled input under [Input](../contracts.md#input), without sending it to the model. This shape carries no command reply.
- The host MUST splice only `change.call.input` into the payload for the next handler and follow the [core two-pass rule](../contracts.md#tool-dispatch). A remote gate cannot open a question and MUST NOT answer `pending`. Host-local gates follow the core question rules. The host MUST reject changes outside `result.content` or `result.value` in `tool.after`.
- A `step.before` or `provider.request` transform MUST change only the `request` field. A changed or retried ModelRequest MUST NOT add a tool or expand its definition beyond what the turn and its current authority allow. The host MUST enforce the chosen model, current limits and tool offer at dispatch.

### Held output

The [core output gate](../contracts.md#the-output-gate) defines which deliveries are covered. The host MUST apply the [shared size and redaction rules](data.md#output-events) before using a gate answer.

- For a recipient covered by a remote output gate, the host MUST hold model response and tool output streams until their declared end, using the gate chain in effect when the stream began. The host MUST declare `holdsOutput: true`. The host MUST deliver a held stream before the reply to the request that caused it.
- At the end the host MUST send ordered segments, splitting only at event boundaries. For other output, the host MUST send one item at a time. Each gate's `events` array MUST fit in 4 MiB of its [encoded bytes](data.md#general-rules), including for a replacement. `final: true` means the gate has to decide on this batch now, even if another segment follows. Redaction across segment boundaries is not guaranteed.
- The host MUST bound the bytes held per recipient and stream, including replacement events. The host MUST block the stream on overflow or if one event cannot fit in a segment. Non-stream items that cannot fit follow the [shared withholding rule](data.md#output-events). The total buffer limit is a deployment setting.
- The host MUST pass each segment through the chain in order, giving each handler the events the previous one left. The host MUST NOT release any part before validating the whole delivery. The host MUST block delivery on a block, an oversized, malformed or unmappable replacement, an error or a lost handler. While awaiting a gate, the host MUST queue other output for that recipient separately, subject to the same limits and gate. While a connection handles an output gate, the host MUST drop its `host/emit` notifications, including unattributed ones.
- The host MUST suppress withheld events and use the [ACP withheld response](acp.md#output-gate) for blocked replies to ACP clients. Raw history returned to a trusted plugin is not a recipient delivery.

## The host asks the Runtime

| Host request | Params | Result | Errors |
|---|---|---|---|
| `runtime/runTurn` | `{ turn: Turn }` | TurnOutcome | `not_supported` without a Runtime; `invalid_request` for malformed turn |
| `runtime/resumeTurn` | `{ turn: Turn, interrupted: { turnId: Id, calls: PendingCall[], lastStep?: ResumedStep } }` | TurnOutcome | As for `runTurn`; `invalid_request` for mismatched turn, calls or step |
| `runtime/continueOpenCalls` | `{ turn: Turn, calls: PendingCall[] }` | TurnOutcome | As for `runTurn`; `invalid_request` for invalid continuation |

| Shape | Fields |
|---|---|
| Turn | `{ sessionId: Id, turnId: Id, startedBy: StartedBy, model: ModelInfo, modelSupports: ProviderSupports, settings: TurnSettings, resultShape?: Schema }` |
| PendingCall | `{ id: Id, name: Id, input: object, stepId?: Id, started: boolean, safeToRepeat: boolean }` |
| ResumedStep | `{ stepId: Id, decision?: StepAfterDecision }`; `decision` has the shape of [`modular-agent.stepAfter.data.decision`](data.md#standard-kinds) |
| TurnOutcome | `{ outcome: Outcome, result: TurnResult, entries: Id[], usage: Usage }` |

`StartedBy`, `Outcome` and `TurnResult` are the [history shapes](data.md#history-entries). `Usage` is the [shared total](data.md#messages). `TurnSettings` is defined in [Models](data.md#models) and `Schema` in [Tools](data.md#tools). `entries` lists the ids returned by `record` and `takeSteering` for this Runtime request, once each in commit order. It does not include `turnEnd`.

- The host MUST have at most one Runtime parent in flight per session. The Runtime MUST ask the host for model and tool work, not choose a model, read its credentials or run a tool itself. Out-of-turn Interface calls and [rewinding](data.md#rewinding) stay with the host.
- `runtime/resumeTurn` MUST use the interrupted turn id in both places. The host MUST settle and filter `interrupted.calls` as in [core recovery](../contracts.md#recovery-and-repeating-work) before sending the request. It MUST send the eligible calls in original order with original ids and steps. Recorded `toolPending` calls follow the [pending recovery rule](../contracts.md#questions). The host alone resolves attribution, registration and cleanup proof. `safeToRepeat` is a hint and does not authorize dispatch.
- The Runtime MUST read the committed checkpoint from `host/history` by turn id, not from the current head or session settings. For an admission-started turn it MUST read `turnStart` and its first `input`. For a continuation it MUST read the [continuation checkpoint](data.md#context-and-interrupted-work).
- The host MUST include `interrupted.lastStep` for the [restored answered step](../contracts.md#recovery-and-repeating-work) and omit it only if there is no such step. The host MUST include `decision` for a committed decision, including `null` for allow. It MUST omit `decision` only when the checkpoint proves the gate decision did not commit. If the host cannot establish the step or gate state, it MUST fail the turn without sending `runtime/resumeTurn`.
- The Runtime MUST reject a `lastStep` that disagrees with the checkpoint, including omission for an answered step, with `invalid_request`. It MUST reuse a supplied decision without invoking `step.after`. If `lastStep` has no `decision`, the Runtime MUST invoke `step.after` at the [hook boundary](../contracts.md#hook-execution) using that step's committed response. If a matching `step.after` callback is repeated after commit, the host MUST return the committed gate reply without invoking handlers.
- For [late answers to questions](../contracts.md#questions), the host MUST send `runtime/continueOpenCalls` only when the session declares both `questionsOutlastTurns` and `lateAnswersStartTurns`, after committing the one continuation for the original turn. Its new `turnId` and `startedBy: { kind: "answer", id }` identify the continuation and the last answered request. The host MUST record the [continuation link](data.md#history-entries) to the original turn. The host MUST use the original call order, ids and attribution, as read from the original turn and its question records. Calls rerun with current authority. Reopening an interrupted continuation uses `resumeTurn` for its existing id, not a second continuation.
- The host MUST serialize cancellation against a committed turn outcome. If cancellation wins, the host MUST record one cancelled outcome, settle calls and hand back queued input by the [core rules](../contracts.md#input). The Runtime MUST stop, cancel its in-flight work and report a cancelled outcome, even if a callback saw the cancellation first. A late reply claiming completion cannot override a winning cancel. Process loss is interruption, not cancellation.
- The host MUST validate `TurnOutcome` against committed entries, accounted usage, actual open calls and the [host limit rules](#runtime-callbacks). It MUST reject `openToolCalls` that do not match qualifying calls under [Questions](../contracts.md#questions). A cancelled turn leaves no call open. An invalid outcome is a Runtime failure, not authority to write a forged `turnEnd`.

### Runtime callbacks

Every method or notification in this table also carries `parentRequestId: RpcId` for the turn. Bad scope, phase or identity is `invalid_request`; see [authority](#authority) and [transport](#transport).

| Plugin method | Other params | Result | Errors |
|---|---|---|---|
| `host/runtime/newId` | `{}` | `{ id: Id }` | Common errors only |
| `host/runtime/prepareStep` | `{ stepId: Id, usage: Usage }` | ModelRequest | `invalid_request` for an unallocated/reused step id or mismatched usage; `turn_limit` for a host limit |
| `host/runtime/model` | `{ request: ModelRequest, stepId: Id }` | Assistant message | `invalid_request` for an unauthorized request or attempt, or for a [Provider reply without its request callback](#the-host-asks-a-provider); `lost` for Provider loss; `turn_limit` for a host limit |
| `host/runtime/hook` | `{ hook: HookName, payload: object }` | Combined answer below | `invalid_request` for a wrong hook, payload or phase; `internal` for a failing non-gate, non-observe chain |
| `host/runtime/definition` | `{ toolName: string }` | ToolDefinition or `null` if not offered | Common errors only |
| `host/runtime/runToolCall` | `{ call: ToolCall }` | ToolResult or `{ callId: Id, pending: string }` | `invalid_request` for an unknown id or out-of-phase request; a name or input mismatch on an allowed call returns a terminal `refused` ToolResult |
| `host/runtime/record` | `{ entry: object }`, a draft [History entry](data.md#history-entries) | Committed history entry | `invalid_request` for a forbidden kind or mismatched entry; `lost` if the commit cannot be confirmed |
| `host/runtime/takeSteering` | `{ final?: boolean }` (`false` if omitted) | `{ entries: HistoryEntry[] }` | `not_supported` if steering is not offered |
| `host/runtime/hasSteering` | `{}` | `{ waiting: boolean }` | Common errors only |
| `host/runtime/report` | `{ type: string, data: JSON, stepId?: Id, toolCallId?: Id }` | notify | No reply |

| Host notification | Params | Result / errors |
|---|---|---|
| `host/runtime/modelEvent` | `{ parentRequestId: RpcId, event: ModelStreamEvent }`; id of the `host/runtime/model` callback | notify |

- `host/runtime/hook` MUST accept only `turn.start`, `step.after`, `tool.before`, `tool.after`, `model.failed`, `turn.result` and `turn.end`. The payload uses the [hook table](#from-core-hooks-to-wire-hooks) without `sessionId` and `turnId`, which the host derives from the parent and validates if supplied. The host MUST derive the tool definition and call attribution from its own state. Observe returns `null`; a gate returns `{ value: payload, refused?: string, pending?: string }` with at most one reason; a transform returns the complete payload; first answer returns the deciding answer or `null`. See [Runtime records and effects](#runtime-records-and-effects) for the additional `tool.before` refusal field. The Runtime MUST use `turn.end` at most once, as its last callback before answering; this is a pre-commit observation. The host MUST present the effective outcome after applying cancellation and any latched limit to the observers.
- The Runtime MUST allocate each step id through `newId`. It MUST report cumulative step usage for the turn in `prepareStep.usage` and `TurnOutcome.usage`, excluding host-owned auxiliary attempts. The host MUST verify the subtotal against committed step responses. It MUST count its own auxiliary usage in `turnEnd` and the applicable budgets. At a steering boundary `takeSteering` commits and returns the inputs the host selects. During a model request or tool round it MUST leave them queued.
- With steering support, the Runtime MUST call `takeSteering` with `final: true` at a steering boundary when it would otherwise finish the turn. The host MUST close steering admission to that turn in the same serialized operation as the check. It MUST refuse a final check outside a steering boundary with `invalid_request`. `hasSteering` does not take input or close admission.
- `prepareStep` returns the host's prepared request, including any [result feedback](../contracts.md#hook-execution). The Runtime MUST NOT add its own copy of the refusal reason. The host MUST admit only that request, an authorized recovery replay, or the validated replacement from the last failed attempt. It MUST admit one model attempt at a time, never twice under the same step id.
- When `prepareStep` or `model` refuses for a host limit, the host MUST return `turn_limit` with the limit name in `data.limit`. The Runtime MUST end the turn with `{ kind: "limit", limit }`, subject to the cancellation rule. The host MUST check the reported outcome against a limit it already signalled, including at `turn.end`.
- The host MUST latch a stopping limit reached after a step under [Limits and tenants](../contracts.md#limits-and-tenants) and keep it for that turn. It MUST signal the limit at the next `prepareStep` before preparing more work. If the Runtime ends without that callback, the host MUST use the latched limit outcome for both `turn.end` observation and `turnEnd`, without treating the unsignalled outcome as a Runtime failure. Winning cancellation takes precedence over the limit; a latched limit takes precedence over a simultaneous `step.after` refusal.
- The Runtime MUST submit a response for every model attempt the host answered with an assistant message, including a failure it will retry, before asking for a retry or dispatching calls. The host MUST enforce the [`step.after` boundary](../contracts.md#hook-execution) after the step's calls are settled or left open, including before accepting another `prepareStep` or a normal turn outcome. The host MUST bind `tool.before` to a call from a committed response or a pending call passed to this turn. The host MUST validate the id, name and original input before running the chain. A call lacking the [recorded offer](data.md#recording-order-and-ownership) cannot enter the chain; the host MUST return the gate refusal without running handlers. The host MUST enforce the [all-parallel-or-serial tool round](../contracts.md#tool-dispatch). The host MUST NOT prepare the next step before the current round is settled. The host MUST build the next request from the committed results in call order.
- Each call has one host-owned state: unstarted, allowed, dispatched or settled. `tool.before` MUST run only while unstarted, with concurrent requests for that transition refused. A completed allowance moves it to allowed; a refusal settles it. Registration invalidation returns an allowed, undispatched call to unstarted, with no allowance. The Runtime MUST obtain a fresh allowance through `tool.before` before submitting it again. Pending makes the call ineligible in that turn. The host MUST commit `toolPending` before returning a pending gate or call result, following [Questions](../contracts.md#questions). `runToolCall` MUST reject unknown ids and out-of-phase requests as `invalid_request` without recording a result. For an allowed id it MUST consume the allowance at the [final dispatch check](../contracts.md#tool-dispatch). If the submitted name or input differs from the allowance by [JSON value](data.md#general-rules), the host MUST record and return a terminal `refused` result for the allowed call without dispatching it. For other final check failures, the status is `refused`, or `outcomeUnknown` if an earlier dispatch remains ambiguous. A validated recovery may reenter unstarted only under the core repeat rules.

### Runtime records and effects

The host is the sole writer. The [shared ownership table](data.md#standard-kinds) lists each standard record, including host-owned `summary`. The host MUST accept only `response`, a matching committed `toolResult` or a Runtime-owned dotted kind via `record`.

With an in-process Provider, the host MUST commit the effective `modelRequest` before dispatch to inference, following [Recording order and ownership](data.md#recording-order-and-ownership). A remote Provider uses the [Provider request callback](#the-host-asks-a-provider), even when the Runtime is local. If the final dispatch check finds a limit after that commit, the host MUST commit a bookkeeping `response` before returning `turn_limit`: `message` is `{ role: "assistant", stop: "aborted", content: [] }`, with `data.recovery: true` and `modelVisible: false`. It has no usage or calls and is not eligible for replay. Without a committed intent there is nothing to settle. The Runtime MUST NOT submit a `response` when `host/runtime/model` returns an RPC error. See [The host asks a Provider](#the-host-asks-a-provider) for the error when a Provider skips its request callback.

If a returned model response would exceed the [call settlement reservation](../contracts.md#resource-reservations), the host MUST substitute the bounded failed response before returning the assistant message to the Runtime and latch `capacity`. The Runtime MUST record that response through `record` and run `step.after` as usual. If the Runtime ends without asking for another step, the host applies the latched limit in the outcome. A limit before a model attempt returns the existing `turn_limit` error instead of an assistant message.

#### Model attempt sequences

1. **Normal step:** The Runtime MUST allocate an id, take eligible steering and call `prepareStep`. The host MUST run `step.before` and the Provider request transform at their respective boundaries. The Runtime MUST call `model`, commit the answer through `record`, settle the call round, then run `step.after`.
2. **Failed attempt:** The Runtime MUST record the failure before `model.failed`. It MUST run `step.after` before retry and use a fresh step id and current limits for an accepted retry. The host MUST reset Provider state before retry; a validated replacement request still passes dispatch checks.
3. **Context overflow:** To request compaction, `model.failed` MUST answer retry without a replacement request. The Runtime MUST call fresh `prepareStep`. The host MUST compact there, committing its own auxiliary attempt and summary with lineage before preparing the new request. The auxiliary response is not an offer of tool calls. The [core compaction rule](../contracts.md#compaction) and [auxiliary attempt rules](../contracts.md#hook-execution) apply.
4. **Result refused:** If retrying after `turn.result` refuses the result, the Runtime MUST allocate a fresh id and call `prepareStep` before trying again. The host prepares the request with [recorded result feedback](data.md#context-and-interrupted-work).
5. **Crash recovery:** Before `resumeTurn`, for each unmatched `modelRequest` not eligible for safe repeat, the host MUST record a bookkeeping aborted response. For an eligible exact step request, the Runtime MAY ask `model` for that request under a fresh id instead of applying preparation transforms again. The host MUST handle its own unmatched auxiliary attempts rather than assign them to the Runtime. The host MUST match the latest unmatched attempt in that turn by exact effective request and model under [shared JSON equality](data.md#general-rules) and recheck repeat eligibility. It MUST close that attempt when committing the new intent. If it is not repeated, the host MUST settle the old attempt as aborted before a fresh `prepareStep` or turn end. A durable Runtime continues from a valid checkpoint; a transient Runtime ends the interrupted turn. Confirmed cancellation is not a recovery retry.

- The host MUST return `invalid_request` for a forbidden kind from `record`. It MUST fill the [shared record metadata](data.md#recording-order-and-ownership) and derive attribution from the parent and tracked work. For inherited calls see [continuation record scope](data.md#call-identities-and-mappings). A custom kind cannot stand for a standard record or change authority. Custom records are optional; their submission has no portable deduplication key.
- A `response` MUST match the host's `modelRequest` for that step and the assistant message returned by the host, with [canonical call ids](data.md#call-identities-and-mappings). The host MUST keep only one response per attempt and one terminal result per call. For an accepted `response` or `toolResult`, the host MUST return the existing entry on an identical repeat under an eligible parent. Conflicting content is `invalid_request`.
- The host MUST run `tool.after` once per terminal tool result and commit the checked result before replying. Failure follows [core settlement](../contracts.md#settlement). The Runtime MUST NOT construct or submit its own result for a call the host settled. If it acknowledges settlement through `tool.after` or `record`, it MUST use the host's result unchanged. A later `tool.after` MUST return the cached outcome, and a matching `record` MUST return the committed result. A conflicting or uncommitted result is `invalid_request`. If an outcome payload cannot fit the history page, the host MUST keep a minimal factual settlement and report `result_too_large` separately. For an oversized model response the host MUST preserve reported usage in a bounded failed response, with no call parts. The host MUST verify dispatch checkpoints fit before starting effects.
- A pending call has no terminal result. When `tool.before` refuses, the host MUST settle the call before returning `{ value: payload, refused: string, result: ToolResult }`, with `result` taken from its committed settlement. The host MUST itself record `notStarted` for a call it abandoned without starting or refusing. The host MUST reject a `notStarted` submission from the Runtime with `invalid_request` even if it already recorded that result. The host MUST use [Recovery and repeating work](../contracts.md#recovery-and-repeating-work) for other results during cancellation or interruption.
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
| `host/jobs/unfinished` | `{ sessionId: Id }` | `{ jobs: { jobId: Id, kind: string, key?: string, detail: JSON, actorId: Id, cleanup?: "unconfirmed" }[] }` in start order | `invalid_request` for a session that is not open |
| `host/jobs/resume` | `{ jobId: Id }` | `{}` | `invalid_request` for unknown, ended or foreign job, closing session, or recovery without required cleanup proof |
| `host/jobs/progress` | `{ jobId: Id, content: Content }` | notify | No reply |
| `host/jobs/end` | `{ jobId: Id, outcome: JobOutcome, result?: Content, report: boolean }` | `{}` | `invalid_request` for unknown/foreign job, conflicting or erased end, or inadmissible report; `lost` for an unconfirmed commit |

`JobOutcome` is `data.outcome` on `jobEnded` in [History entries](data.md#history-entries).

- The host MUST generate job ids unique across sessions, using at least 122 random bits or an equivalent source of uniqueness. The host MUST use the [core job key rule](../contracts.md#jobs) and its [shared fold](data.md#session-state) for keyed starts. It MUST commit `jobStarted` before answering a new start. The host MUST check `jobs` against the current effective rights of everyone behind the parent before admitting the request.
- On reopen, a plugin that needs `host/jobs/unfinished` or another session-scoped host request from `session.start` MUST complete that request before answering the hook. Once the plugin answers, the session can close at any time and a later request can return `invalid_request`. Only the owning plugin's current connection with a valid session writer may resume or end an unfinished job. A second resume of the same job on that connection MUST return `invalid_request`. The host MUST reject callbacks from a revoked execution and ignore progress outside an active job.
- The host MUST serialize resume, cancel and end for a job. The first committed end wins. With a retained live end, a retry from the current owner in an open session MUST return `{}` if `outcome`, `result` and `report` match by [shared JSON equality](data.md#general-rules). A conflicting or tombstoned end MUST return `invalid_request`. Neither retry creates a second end or report. A plugin MAY end its unfinished job without resuming its work. A request that exceeds the owner's current authority cannot take effect.
- The host MUST check the job's [current narrowed rights](../contracts.md#authority), including `input` for a report. The plugin MUST NOT request a report for a result it already returned in the starting call or when the session is closing. The host MUST apply [atomic admission and recovery](data.md#job-reports) before acknowledging `end`. The acknowledgement does not wait for a turn. Scheduling follows `startsTurnsUnasked` and the session's input queue. There is no wire field for externally measured job usage; the host accounts once for work it tracks.
- The host MUST use the [core job rules](../contracts.md#jobs) to decide when turn cancellation or session close cancels jobs, and when an absent owner leaves work unfinished. Process stop interrupts jobs and does not end them.
- To cancel a job with a live owner, the host MUST send `jobs/cancel` to the owner and wait at most five seconds for confirmation. The plugin MUST stop the job and have its end committed through `host/jobs/end` before answering `{}`. If the work already finished, the plugin MUST use its actual result. An answer without a committed end, a lost owner or an unconfirmed cleanup is not a successful cancellation. On cutoff the host MUST apply the [core unconfirmed cleanup rule](../contracts.md#jobs) and report `lost`. `host/jobs/unfinished` MUST show `cleanup: "unconfirmed"` for a job with unconfirmed cleanup under the [shared fold](data.md#session-state). For resumption the host MUST apply the [core cleanup check](../contracts.md#the-working-environment). A new connection is not proof that an older execution's work stopped.

## The host asks a command

| Host request | Params | Result | Errors |
|---|---|---|---|
| `command/run` | `{ name: string, args: string, sessionId: Id, actorId: Id }` | `{ output?: string }` | `invalid_request` for unknown command or invalid scope; `internal` for command failure |

`args` is the command's argument text, `""` if empty. The host MUST bind the command to the actor who gave it, including input transforms. `/1` does not support model-using remote commands, job-scoped environment callbacks or external job metering. Direct process effects are outside host enforcement. See [Commands](../contracts.md#commands) and [Security](../security.md#plugins).

## What a plugin may ask the host

| Plugin method | Params | Result | Errors |
|---|---|---|---|
| `host/ask` | `{ parentRequestId: RpcId, request: InputRequestDraft }` | [Terminal Answer](data.md#questions) or `{ requestId: Id, pending: true }` | `invalid_request` for bad question or parent; `not_supported` for unsupported waiting mode |
| `host/env/read` | `env/read` params plus `parentRequestId: RpcId` | As for `env/read` | As for `env/read`; `not_supported` if no environment |
| `host/env/write` | `env/write` params plus `parentRequestId: RpcId` | As for `env/write` | As for `env/write`; `not_supported` if no environment |
| `host/env/exists` | `env/exists` params plus `parentRequestId: RpcId` | As for `env/exists` | As for `env/exists`; `not_supported` if no environment |
| `host/env/exec` | `env/exec` params plus `parentRequestId: RpcId` | As for `env/exec` | As for `env/exec`; `not_supported` if no environment |
| `host/env/list` | `env/list` params plus `parentRequestId: RpcId` | As for `env/list` | As for `env/list`; `not_supported` if no environment |
| `host/tools/list` | `{ parentRequestId: RpcId }` | `{ tools: ToolDefinition[] }` | `invalid_request` for a bad parent; `not_supported` if the host does not run nested calls |
| `host/tools/call` | `{ parentRequestId: RpcId, name: Id, input: object }` | [ToolResult](data.md#tools) of the nested call | `invalid_request` for a bad parent, name or input shape; `not_supported` if the host does not run nested calls; `cancelled` if the parent was cancelled before the nested call was admitted |
| `host/hook` | `{ parentRequestId: RpcId, hook: "provider.request" \| "provider.response", payload: object }` from the [hook table](#from-core-hooks-to-wire-hooks) | Full transformed payload for `provider.request`; `null` for `provider.response` | `invalid_request` for wrong hook, scope, phase or payload, or a response before its attempt was committed; `internal` for a failed request transform; `lost` if the commit cannot be confirmed; `turn_limit` for a host limit |
| `host/credentials/read` | `{ provider: Id }` | `{ credential: Credential \| null }`, in the [shared shape](data.md#credentials); `null` if none | `invalid_request` for a Provider not registered by that connection |
| `host/history` | `{ sessionId: Id, parentRequestId?: RpcId, after?: Id, limit?: integer, all?: boolean }` | `{ entries: HistoryEntry[], next?: Id }` | `invalid_request` for invalid cursor, limit or session; `result_too_large` for an entry that cannot fit |
| `host/session` | `{ sessionId: Id, parentRequestId?: RpcId }` | `{ id: Id, project: string, settings: object, busy: boolean, actors: Actor[] }` | `invalid_request` for invalid session or parent |
| `host/declaration` | `{ sessionId?: Id, parentRequestId?: RpcId }` | [Declaration](acp.md#the-declaration) | `invalid_request` for invalid session or parent |
| `host/emit` | `{ sessionId: Id, parentRequestId?: RpcId, type: string, data: JSON }` | notify | No reply |
| `host/problem` | `{ where: string, message: string }` | notify | No reply |

| Host notification | Params | Result / errors |
|---|---|---|
| `host/env/output` | `{ parentRequestId: RpcId, chunk: string }`; id of `host/env/exec` | notify |

`host/tools/list` and `host/tools/call` are the wire form of [nested calls](../contracts.md#nested-calls). `host/tools/list` MUST return the session's registered tools that a plugin may start, as they stand at the request. `host/tools/call` MUST answer with the nested call's committed terminal result, whatever its status: a refused, failed or cancelled nested call is a ToolResult, not a protocol error. The host assigns the nested call's id and returns it as `callId`. The host MUST NOT forward the nested call's progress to the asking plugin. An unknown or unregistered `name` is a nested call that settles `refused`, so that it is recorded. `env/list` is optional: a caller MUST treat `not_supported` as absence and MAY fall back to `env/exec`.

`host/ask` MUST NOT return a secret value, only its stored name or the non-value fields of the [shared Answer](data.md#questions). For `host/emit`, the host MUST accept only dotted custom event names that do not impersonate standard events. The host MUST attribute them to the sending plugin and gate them as output. `host/problem` is operator diagnostics, not an event or a history write.

### Paging history

`all` defaults to false. The host MUST return the current branch in root-to-head order, or all entries in kept order with `all: true`, as defined in [Shared data](data.md#history-entries). `limit` MUST be from 1 to 500 inclusive, default 500. The host MUST page from immediately after `after`, or from the start when it is absent. A cursor not in the selected view is `invalid_request`. Each request reads the current view; the cursor is an entry id, not a snapshot. Appends, moves and erasure can change the view between pages.

The host MUST fit the whole `result` it sends, including any `next`, in 4 MiB. It MUST return `next` as the last returned id only when more entries remain. The host MUST include at least one entry when entries remain; if that entry and any required cursor do not fit, the host MUST return `result_too_large` rather than split or skip it. A host MUST NOT commit an entry that would make its own Runtime unable to page it. An external record already too large is a recovery failure, not an empty page.

### Authority

For a hosted connection, the host MUST resolve parent RPC IDs and plugin ownership in that connection's state, not across connections, even when the same service supplies multiple registrations or hosts. See [plugin services](websocket.md#a-plugin-service).

The host MUST reject invalid authority, scope, role, ownership or parent with `invalid_request`, or drop an invalid notification. It MUST check parent liveness at frame acceptance and recheck at dispatch, using the tracked scope rather than callback parameters. A supplied session MUST match the parent. The [transport cutoff](#transport) and [core final check](../contracts.md#tool-dispatch) also apply.

| Plugin method | Caller and required parent or scope |
|---|---|
| `host/ask` | Tool source, under its own live `tools/call`; question belongs to that call |
| `host/env/read`, `host/env/exists`, `host/env/write`, `host/env/exec` | The host MUST authorize a tool source only under its own live, dispatched `tools/call`, using the [environment callback check](../contracts.md#tool-dispatch). |
| `host/env/list` | As for `host/env/read` |
| `host/tools/list`, `host/tools/call` | Tool source, under its own live, dispatched `tools/call`. The nested call acts with the parent's actor and the rights behind the parent's work, and passes its own [checks](../contracts.md#nested-calls). |
| Same environment methods under `command/run` | The host MUST authorize a command handler only under its own live `command/run` and the invoking actor's current `tools`. Tool approval and `tool.before` do not apply to these [direct actions](../contracts.md#commands). |
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

A plugin is trusted code. It runs with the agent's permissions unless separately confined. Process separation and use of the plugin API do not make a sandbox. See [Security](../security.md#plugins) for what the host can observe and for tenant isolation and launch rules.

- The host MUST start only programs approved by the operator. The host MUST check [project trust](../contracts.md#configuration-and-trust) before starting a project plugin. The host MUST validate registration before enabling the plugin's callbacks or replacements.
- The host MUST read `MODULAR_AGENT_PLUGINS` at startup if set. It is a JSON array of `{ command: string[], env?: object, config?: object }`, or of the [network form](websocket.md#choosing-plugin-services-at-start) `{ url, tokenFile, config? }` for plugin services. `command` is a nonempty argument vector; its first item is the executable, with no shell expansion. `env` maps names to strings. Both optional objects default to `{}`. The host MUST reject malformed configuration before spawning programs from it. A build MAY support other configuration sources.
- The host MUST initialize these programs in array order after its own plugins. The host MUST apply approved `env` values to the minimal environment in [Security](../security.md#plugins), not inherit the host environment.
- If a configured program fails to start, exits before registration, or has its [registration refused](#starting-the-handshake), the host MUST NOT run without it. Refused registration includes a duplicate replacement or an unlisted collision. The host MUST tear down the programs it started and fail startup. Over ACP the agent MUST exit with a nonzero status without a successful `initialize` result. The host MUST NOT substitute a built-in part for a failed configured one.
- A plugin program MUST start in the minimal environment. It MUST NOT need variables the host isn't required to pass, such as `HOME`; its state folder is `home` from `plugin/initialize`.

## The conformance plugin

A host's conformance tests exercise the baseline roles and any Runtime tier the host claims. The transient and durable Runtime tiers are optional; neither is part of the baseline fixture. An environment's fixture advertises its actual containment, supported platforms and point support.

A build serving the conformance plugin MUST document its command and support the four baseline parts below. It MUST read `MODULAR_AGENT_PLUGIN_PARTS` as a comma-separated list of exact part names. If unset it MUST serve `provider,tools,environment,hooks`. The build MUST serve exactly the selected parts and reject empty, repeated or unknown names, unavailable parts and the combination of `runtime` and `durable-runtime`. Normal validation applies to fixture messages.

| Part | Registers | Replaces |
|---|---|---|
| `provider` | Provider `conformance`, model `echo`, as in [ACP conformance mode](acp.md#conformance-mode) | `provider:conformance` |
| `tools` | Source `conformance-tools` with `bash { command: string }` using `host/env/exec` and `read { path: string }` using `host/env/read`. A build that can ask for nested calls also registers `nest { name: string, input: object }` using `host/tools/call`. | `tool:bash`, `tool:read`, and `tool:nest` when registered |
| `environment` | Local environment; executes the fixture commands with Bash | `working-environment` |
| `runtime` | Transient Runtime | `runtime` |
| `durable-runtime` | Durable Runtime | `runtime` |
| `hooks` | `tool.before`, `turn.before` and `output`, as below | Nothing |

- `read` MUST return `completed` with one text part containing the file decoded as UTF-8, or `failed` with an explanation if the read fails. `bash` MUST forward each output chunk as a text progress part and return one text part containing combined output followed by a newline and `[exit code N]`, where `N` is the returned exit code or `null`. Its status MUST be `completed` only for exit code 0, and `failed` otherwise. Wire cancellation follows [Transport](#transport).
- `nest` MUST send one `host/tools/call` with its `name` and `input` and return the nested result's `status` and `content` unchanged. If the request fails with a protocol error it MUST return `failed` with one text part holding the error code's name. The fixture environment MUST answer `env/list` with the directory's entries or with `not_supported`.
- The `tool.before` fixture MUST refuse a call whose input JSON contains `conformance-forbidden`, with reason `refused by the conformance plugin`. The `turn.before` fixture MUST contribute `{ "system": "The conformance plugin is loaded." }`. The `output` fixture MUST replace `conformance-secret` with `[redacted]` in editable strings, including a match across text events within one segment, without making other changes.

## Changes

- **Proposed production rules.** Hosted callbacks resolve parent IDs and ownership within their connection. Reservation refusal uses `busy` before a new operation or `turn_limit` with `capacity` at the model boundary.

- **Edition 4** ([ADR 0023](../adr/0023-edition-4-draft.md), accepted by [ADR 0027](../adr/0027-sdk-0-1-and-edition-4.md)). Still `/1`: every addition is an optional method that an edition 3 peer answers with the method-not-found or `not_supported` error. `host/tools/list` and `host/tools/call` let a tool source in another process make nested calls (the standard configuration's code tool could not be served over the wire). `env/list` and `host/env/list` list a directory (its `find` and `list` tools had to shell out). A cancelled Provider request sends no `provider.response`, and `outOfReach` items are for people (both guessed by the Claude sidecar). The fixture gains the optional tool `nest`.

- **Production edition 3.** A configured plugin that fails at startup, including refused registration, stops the host with no built-in substitute. Plugins start in the minimal environment (Runtime D, TypeScript with Elixir: the launcher needed `HOME` and the host fell back to its built-ins; the probe kit separately expected registration refusals to be skipped). Optional project reads (Go P12, Rust PE2-02), Provider replies without the request callback (Go P13), unowned points (Go P11), the gate's own size limit (TypeScript), and callback lifetime on `session.start` (Elixir PE2-1). The host returns the committed result on refusal (Runtime A, Python and Go with TypeScript: the Runtime guessed a result). The Provider sends only the four response fields and the host ignores unknown members for validation (Runtime C, Elixir with Python: the Provider sent an extra request and the host refused it). Recovery settles ineligible calls before handoff and restores the last answered step's gate state (Runtime A-crash, Go with TypeScript: a non-repeatable call reached the Runtime; Runtime E, Go with Rust, Python and Elixir: unsettled calls and missing gate state; TypeScript with Rust and Python: missing gate state).

- **Production edition 2.** Non-mutating `env/checkPoint` (Elixir PE-5, Go P9, TypeScript, Python G82), commit at the wire Provider's `provider.request` callback (Elixir PE-3, TypeScript), terminal refusal for a changed allowed call (Python G92), and filtering settled calls at resume (Rust PE-09, TypeScript). A registration change requires a fresh allowance (Elixir PE-4). Size caps use actual bytes (Go P5). Depth errors and result feedback in `prepareStep` are specified (TypeScript).

- Production round two: host call states, recovery sequences, catalog errors, bounded cleanup and explicit remote role limits.

- **Production edition.** Defines protocol lifecycle, method schemas, callback authority, Runtime commit and dispatch ownership, environment confinement and containment, exclusive jobs and atomic reports, and validation of segmented held output. The binding remains `/1`.
  - Round three: explicit limit errors and steering cutoff, continuation-only pending calls, persisted cleanup, standard platform identifiers and direct command authority.
  - Round four: recorded tool offers and pending calls, continuation scope, environment callback authority and point identity, erased job-end retries and limit settlement.
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

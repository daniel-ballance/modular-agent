# ACP host binding: `modular-agent-acp/1` and `/2`

This binding defines how a host drives an agent as an [Agent Client Protocol](https://agentclientprotocol.com) (ACP) v1 client. [Contracts](../contracts.md) defines core behavior and [Security](../security.md) defines trust. Both versions use the [conformance and versioning rules](../conformance.md).

A build MUST use `schema/v1/schema.json` from [`@agentclientprotocol/sdk@2.7.0`](https://www.npmjs.com/package/@agentclientprotocol/sdk/v/2.7.0), except where this binding specifies otherwise.

## Names

Binding metadata MUST be an object under `_meta["modular-agent"]`. Each extension method name MUST start with `_modular-agent/`. Unknown fields MUST remain inert as in [shared data](data.md#general-rules).

## Versions

The agent MUST speak both binding versions over ACP `protocolVersion: 1`. The agent MUST select `/1` if `initialize` omits `binding`, and the exact requested version otherwise. The agent MUST reject an unsupported ACP protocol or binding version with `unsupported_version`, without falling back. The agent MUST reject malformed metadata, including a present non-object namespace or non-string `binding`, with `invalid_params`. A second `initialize` after success MUST fail with `already_initialized`. A withheld initialization reply MUST leave the connection uninitialized. The agent MUST refuse all other requests before successful initialization with `not_initialized`.

## Starting

The agent MUST use stdin and stdout for newline-delimited UTF-8 JSON-RPC, with one message per line and no other stdout output. Each message MUST fit in 64 MiB (67,108,864 [actual line bytes](data.md#general-rules), excluding the line ending). The receiver MUST reject an oversized request with `-32000` and `data.code: "message_too_large"` if it can safely recover its id, or close the connection otherwise. A sender with an oversized result or error MUST replace it with `-32000` and `data.code: "result_too_large"`. The agent MUST treat an oversized outbound update or question as withheld. A receiver of any other oversized frame MUST close the connection. Request ids MUST be strings or integers from −9,007,199,254,740,991 through 9,007,199,254,740,991. Peers MUST compare ids by type and value. A sender MUST NOT reuse an id in the same direction on that connection.

See [Stdio authentication](../security.md#authentication-on-each-wire) for the peer and [Authority](../contracts.md#authority) for the connection actor. The operator MUST configure the connection's allowed project scope outside client and project control, alongside its actor and allowed tenants (including whether no tenant is permitted). The operator MUST NOT expose the private pipe as an unauthenticated proxy. This binding defines no network ACP transport; network Interfaces follow [Security](../security.md#authentication-on-each-wire).

| Operator variable | Effect |
|---|---|
| `MODULAR_AGENT_DATA_DIR` | If set, the agent MUST keep agent-managed state under this directory instead of any default or path flag. If unset, the agent MUST use its configured paths or its normal defaults. |
| `MODULAR_AGENT_ACTOR` | If set to an [Id](data.md#general-rules), the agent MUST use it instead of its default connection actor id. The agent MUST use kind `host` for that actor unless the operator configures another kind. If the variable is set to a value that is not an Id, the agent MUST fail startup. See [Authority](../contracts.md#authority) for stable ids across builds and how rights are assigned. |

Agent-managed state includes local history, settings, trust and local credentials. Explicitly configured external stores and credentials supplied by the operator are not relocated. The agent MUST reject client or project attempts to set either variable, override its trusted state location or substitute the directory. The chosen directory MUST be writable only by the operator, the agent and other processes the operator trusts with its state.

## `initialize`

The agent MUST advertise `loadSession: true` and `sessionCapabilities.list`, `.resume` and `.close` as `{}`. It MUST advertise only the ACP `promptCapabilities` and `mcpCapabilities` it supports. It MUST return `authMethods: []` and the initialization fields in the [metadata table](#metadata). The connection's `actor` is the configured [Actor](data.md#actors), not a grant in any session. The agent MUST NOT use the client's `fs/*` or `terminal/*` methods, even if offered. Tools run in the agent's working environment.

### Metadata

Peers MUST use the following fields under `_meta["modular-agent"]` on the indicated messages. Fields marked optional are omitted when not applicable. For an update the namespace is on the ACP update payload (`params.update`); for a `/2` failed prompt it is under `error.data._meta`.

| Field | Where | Type and values |
|---|---|---|
| `binding` | `initialize` request (optional) and result | `"modular-agent-acp/1"` or `"modular-agent-acp/2"` |
| `declaration` | `initialize`, `session/new`, `session/load`, `session/resume` and `session/set_config_option` results; `config_option_update` when the declaration changes | Complete [declaration](#the-declaration) |
| `extensions` | `initialize` result | Array of offered extension names without `_modular-agent/` |
| `actor` | `initialize` result | [Actor](data.md#actors), with kind `user`, `host`, `agent` or `program` |
| `tenant` | `session/new` request (optional) | Tenant name (string); omitted for no tenant |
| `key` | `session/prompt` request (optional) | [Input key](#input-admission) |
| `inputId` | Admitted prompt result or post-admission error | Admission id; absent for an erased duplicate |
| `duplicate`, `erased` | Prompt result or post-admission error (optional) | `true` for a duplicate or erased receipt, respectively; omission means false |
| `disposition` | Prompt result or post-admission error (optional) | `handled` or `handedBack` for an admission settled without a turn |
| `outcome` | Prompt result with a turn, cancelled hand-back, or `/2` failed-turn error | [Outcome](#prompts): kind `completed`, `cancelled`, `limit` or `failed`; limit `steps`, `output`, `sessionTokens`, `tenantTokens` or a build-specific name |
| `openToolCalls` | Prompt result in `/1` or `/2`, or `/2` failed-turn error (optional) | Nonempty array of call ids left open; omission means none |
| `handedBack` | Cancelled prompt result; recovery result for `session/load` or `session/resume` when nonempty | Array of `{ inputId, content }`, with content in [shared Content](data.md#content) projected as in [Entry](#entry); `[]` if a cancelled prompt has nothing to report |
| `requestId`, `actorId` | `session/request_permission` and `elicitation/create` requests | Shared question id and the addressed actor id, both strings |
| `status` | Terminal `tool_call_update` | Shared [ToolResult status](data.md#tools): `completed`, `failed`, `refused`, `cancelled`, `notStarted` or `outcomeUnknown` |
| `parentToolCallId` | `tool_call` for a [nested call](#updates) | Call id (string) of the call that asked for it |

## The declaration

An agent MUST send every non-optional key and use only the values below. The session declaration is authoritative for that session. A build MUST declare the more restrictive supported behavior when it varies across cases. It MAY describe exceptions in build-specific keys.

| Key | Allowed values | Meaning or default |
|---|---|---|
| `inputDuringTurn` | boolean | Input can steer a running turn. |
| `waitingThroughRestart` | boolean | Recovery can ask an interrupted in-turn question again. |
| `continuesAfterRestart` | boolean | An interrupted turn can continue. |
| `rewinding` | boolean | `move` accepts `rewind: true`; implies `move` is offered. |
| `forking` | boolean | Implies `fork` is offered and usable for the session when quiescent. |
| `keepsStateAtProvider` | boolean | The Provider keeps conversation state. |
| `runsToolsAtProvider` | boolean | The Provider runs tools. Such sessions are not portable. |
| `liveSessions` | boolean | The agent supports live sessions outside this ACP profile. |
| `severalActors` | boolean | Implies all the [several-actors extensions](#several-actors). |
| `holdsOutput` | boolean | The output gate can hold streams. |
| `outputBypassesAgent` | boolean | Some output outside this binding bypasses the gate. |
| `cancellingTurnCancelsJobs` | boolean | Turn cancellation also cancels its jobs. |
| `pluginsDuringSession` | `false` | Fixed in this edition. |
| `erasure` | boolean | Implies `erase` is offered. |
| `inputKeys` | `true` | Fixed in this edition. |
| `questionsOutlastTurns` | boolean | An eligible non-approval question can stay open past its turn. Requires `lateAnswersStartTurns: true`. |
| `startsTurnsUnasked` | `never`, `jobReports` | Whether job reports start turns. Late answers are separate. |
| `queuedInputAfterRestart` | `handedBack`, `run` | Recovery policy for queued input. |
| `movingWithUnfinishedWork` | `cancels`, `refused` | Behavior when moving away from unfinished work. |
| `mixedActorInput` | `shared`, `refused` | Mixed input acts with shared rights, or is refused. |
| `settingsDuringTurn` | `nextTurn`, `refused` | Change from the next turn, or refuse during a turn. |
| `erasureDuringTurn` | `allowed`, `refused` | Whether erasure can run during a turn. |
| `commandContainment` | `strong`, `processGroup`, `none` | Lifetime containment as in [Working environment](../contracts.md#the-working-environment), not a limit on command reach. |
| `lateAnswersStartTurns` (optional) | boolean | One continuation when all the turn's open questions are answered. Default `false`. |
| `queuedJobReportsAfterRestart` (optional) | `handedBack`, `run` | Default: `queuedInputAfterRestart`. |
| `portableSessions` (optional) | boolean | [Portable sessions](data.md#portable-sessions). Default `false`. |
| `sessionLimits` (optional) | boolean | Implies `limit` is offered. Default `false`. |
| `tenants` (optional) | boolean | Implies `tenant` is offered. Default `false`. |
| `projectRoot` (optional) | string | Canonical absolute path of the sole served project. Omitted for no binding-level single-root restriction. |
| `confinesFiles` (optional) | boolean | File operations refuse paths resolving outside the project after symlinks. Default `false`. |
| `nestedToolCalls` (optional) | boolean | A running tool call can start [nested calls](../contracts.md#nested-calls). Default `false`. |

The table is the ACP projection of the core declaration; binding claims and extra hook names are published separately. In both versions a host MUST reject missing required keys, invalid values and the following inconsistent combinations:

| If true | Also required |
|---|---|
| `waitingThroughRestart` | `continuesAfterRestart` and a durable Runtime |
| `questionsOutlastTurns` | `lateAnswersStartTurns` |
| `portableSessions` | No Provider-run tools or live-session mode for that session |
| `rewinding`, `forking`, `erasure`, `sessionLimits`, `tenants` | Respectively `move`, `fork`, `erase`, `limit`, `tenant` in `extensions` |
| `severalActors` | All [several-actors methods](#several-actors) in `extensions` |

The agent MUST send a complete session declaration on open and settings replies. It MUST publish changes in `config_option_update` before work using the change. `extensions` is the connection's union of offered methods; a disabled feature fails `not_supported` in that session.

## Sessions

- **`session/new`:** The agent MUST validate the canonical project, the tenant and all supplied MCP server specifications before creating a session. The [setup rules](../contracts.md#input) govern when the session is kept. An unused closed session does not appear in later lists.
- **`session/load` / `session/resume`:** The agent MUST check the stored project and [authority](#authorization). For a closed session it MUST obtain the writer lease, validate the record, reconcile pending mutations and install interrupted work before admitting fresh work. Opening MUST NOT wait for recovered work or an actor answer. After the open result, the agent MUST allow authorized reads, answers and cancellation, queue fresh work behind recovered work, and publish live questions. An already open session MUST reuse its writer and work. A concurrent open during opening or close MUST fail `busy`. Both methods MUST report authorized recovery `handedBack` content in admission order, omitting an empty list.
- **Replay and live output:** Before first-attachment replay, the agent MUST authorize and gate the complete `session/load` result. If that gate withholds the result, the agent MUST send no replay for that load. Otherwise it MUST serialize replay for that session on the connection, oldest first with no intervening live updates, then send the already-gated result. The client MUST treat replay as provisional for the pending load of that session on that connection. On error or a lost result, it MUST discard that attempt's replay before retrying. The agent MUST render `input` as user chunks, visible responses as model chunks and call notices, and tool results as terminal updates, synthesizing the initial call notice for a visible direct refusal when needed. `resume` and repeat attachments MUST NOT replay. History is authoritative for reconstruction; ACP updates have no cursor or watermark and cannot be merged losslessly with paged history. Use `history` with `all: true` for kept order.
- **`session/close`:** The agent MUST apply the [core close authority rule](../contracts.md#authority) before making any change. Once authorized, it MUST stop admission, cancel any running turn and unfinished jobs, and close host-supplied servers. It MUST wait for settlement or the applicable cleanup deadline. If cleanup is unconfirmed it MUST report `lost` and leave affected work interrupted or unfinished. It MUST detach all views and release the lease after stopping old writes; reopen follows normal recovery and cannot infer cleanup from lease acquisition. Close without attachment MUST fail `not_open`; concurrent close MUST fail `busy`.
- **`session/list`:** The agent MUST list only kept sessions the connection may discover. With `cwd` it MUST filter by canonical project, not path spelling. Listing MUST NOT join an actor. The agent MAY page the list using ACP's cursor fields.

For `session/new`, `load` and `resume`, the agent MUST reject nonempty `additionalDirectories` and non-null `systemPrompt` with `not_supported` before changing state. This profile never enlarges the project or takes the client prompt as system authority.

A `cwd` MUST be an absolute existing directory canonicalized after symlinks. The agent MUST refuse a directory outside allowed scope or different from a declared `projectRoot` before discovery, plugin load or effects. Knowledge of a path or id grants nothing.

Disconnect MUST detach that connection without closing the session. A withheld open result MUST NOT attach the caller or mark it present. An opening with no viewers follows the deployment's idle lifetime policy.

The agent MUST apply the [`hostMcpServers` policy](../contracts.md#mcp-servers), including the `tools` check, to all supplied specifications before starting or connecting any server. The agent MUST return `forbidden` for a denied specification, `invalid_params` for a malformed one, and `not_supported` for an unoffered transport. An already open session MUST NOT change its server set on another load or resume. The agent MUST refuse a nonempty resupply that differs from the active specifications with `conflict`. Reopening a closed session takes a fresh list, never definitions from history. The agent MUST NOT put private headers, credentials or launch environments in logs.

### Authorization

The agent MUST check tenant and project access and the rights below before admitting work or returning session content. Rights in a session are [effective rights](../contracts.md#authority), checked again at the point of action. The agent MUST NOT admit a tenant outside the connection's allowance, including no tenant when a tenant is required. The agent MUST return the same `forbidden` response for an unknown session and for an inaccessible session, without revealing its project, tenant or existence. `not_open` is only for an accessible session not open on this connection. Every session call other than list, new, load and resume MUST name a session open on this connection.

The agent MUST apply the [connection actor rules](../contracts.md#authority), including the `joinOnOpen` default, before admitting an open. For this binding, `severalActors` declares whether the session supports a second member. Discovery tests whether `watch` would allow open without joining the actor.

| Method (extension names include the prefix below) | Required authority | Denied |
|---|---|---|
| `initialize` | Authenticated connection | Close unauthenticated transport |
| `session/new` | `input`, under configured project and tenant policy | `forbidden` |
| `session/list` | `watch` for each listed session; discovery uses the same recorded-or-prospective test as open | Omit inaccessible sessions |
| `session/load`, `session/resume` | `watch`; `tools` also for supplied MCP servers | `forbidden` |
| `session/close` | Session membership; also `cancel` if a running turn or unfinished jobs would be cancelled | `forbidden` |
| `session/cancel` | `cancel` | Ignore notification |
| `session/prompt` | `input` | `forbidden` |
| `session/set_config_option` | `settings` | `forbidden` |
| `session/update` (agent to client) | `watch` for recipient | Suppress |
| `session/request_permission` and its reply | Present addressed actor with `approve`, eligible for this question | Do not offer or accept |
| `elicitation/create` and its reply | Present addressed actor with `answer`, eligible for this question | Do not offer or accept |
| `$/cancel_request` (either direction) | Sender of the matching in-flight JSON-RPC request on that connection | Ignore |
| `_modular-agent/history`, `_modular-agent/requests`, `_modular-agent/jobs`, `_modular-agent/actors`, `_modular-agent/proposals`, `_modular-agent/tenant` | `watch` | `forbidden` |
| `_modular-agent/input` | `propose` for `when: "propose"`; `input` otherwise | `forbidden` |
| `_modular-agent/answer` | `approve` for approvals; `answer` otherwise; also question eligibility and the [approval route check](#request) | `forbidden` for missing rights; see [negative acknowledgements](#extension-methods) |
| `_modular-agent/fork` | `watch` and `settings`; authority to create in the source tenant and project | `forbidden` |
| `_modular-agent/move` | `settings`; also `cancel` if moving cancels work | `forbidden` |
| `_modular-agent/erase` | `erase` | `forbidden` |
| `_modular-agent/cancel-job` | `cancel` | `forbidden` |
| `_modular-agent/join` | `grant`; only rights the granter effectively holds | `forbidden` |
| `_modular-agent/leave` | `grant` for another actor; membership for self | `forbidden` |
| `_modular-agent/release` | `input`; a report release also requires the job's current `input` | `forbidden` |
| `_modular-agent/withdraw` | The connection's actor is the proposer, or has `input` | `forbidden` |
| `_modular-agent/limit` | `administer` and the [ceiling rule](../contracts.md#limits-and-tenants) | `forbidden` |
| `authenticate`, `logout`, `session/delete`, `session/set_mode`, `elicitation/complete`, ACP `session/fork`, `fs/*`, `terminal/*`, other ACP additions | Not part of this profile | `-32601` if requested; ignore notifications |

For a request with valid syntax but no required right, the agent MUST return `-32602` with `data.code: "forbidden"`, except for filtered lists and unauthorized agent-originated messages as above. A denied, unknown or stale notification MUST NOT change state. For agent-originated requests the agent MUST use the addressed actor's effective rights at send and answer time, including the rights of the actor behind a delegated connection.

### Errors

Unless another number is specified, the agent MUST return the following errors as JSON-RPC `-32602` with `data: { code }`. The JSON-RPC message is human-readable, not a machine discriminator. Validation and authorization errors contain no session content and take no effect.

| `data.code` | Condition |
|---|---|
| `invalid_params` | Malformed parameter or invalid option/value. |
| `invalid_request` | Request refused for [JSON depth](data.md#general-rules). |
| `unsupported_version`, `already_initialized`, `not_initialized` | Negotiation or initialization state as above. |
| `forbidden` | Inaccessible resource or missing authority as above. |
| `not_supported` | Known feature disabled or not offered, including `rewind: true` without `rewinding`. |
| `not_open` | Accessible session not open on this connection. |
| `not_found` | Unknown item in the authorized session/view, including an invalid history `after`. |
| `wrong_project` | Authorized session opened with a mismatched canonical project. |
| `busy` | Conflict with current work, close or recovery. |
| `held` | `-32000`, with `data: { code: "held", retryAfterMs }`; a retryable [history lease refusal on reopen](history-http.md#writing-one-writer-at-a-time). `retryAfterMs` is a positive integer in milliseconds. |
| `conflict` | Known item with an invalid transition, such as an already released proposal or prompt input handed back without a turn; also a [rewind target or point refusal](#extension-methods). |
| `lost` | `-32000`; cleanup of an affected part could not be confirmed. |
| `cancelled` | Request cancelled before its normal result is available. |
| `withheld` | `-32000`; the [output gate](#output-gate) withheld the reply, including if it could not fit the gate's limit. |
| `message_too_large` | `-32000`; message beyond its limit. |
| `result_too_large` | `-32602` for a fork that cannot fit its initial history HTTP append; `-32000` for a reply beyond its wire limit, including a history `result` over its page limit. |

The agent MUST check envelope, initialization and generic parameter syntax first, then mask inaccessible sessions, then check attachment, feature support, current state and action rights. It MUST return -32601 for unknown methods. An authorization or pre-admission error MUST NOT include an `inputId` or turn outcome. The [answer method](#extension-methods) has its own negative acknowledgements.

## Configuration options

The agent MUST use ACP `select` options with `id`, `currentValue` and `options` as in the pinned schema. Values MUST compare as exact strings. The agent MUST use these ids and values:

| Id | Values |
|---|---|
| `model` | `provider/model`, with `%` and `/` in each component encoded as `%25` and `%2F` before joining. |
| `thinking` | Supported levels in order: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. |
| `approval` | `off`, `ask`, `all`, `never`. |

An agent MUST omit `thinking` if the model declares no levels. On model switch it MUST apply the [portable reasoning fallback](data.md#context-and-interrupted-work), even for a non-portable session. For an unset reasoning level the agent MUST show `off` as `currentValue` if offered without setting reasoning on the request. The agent MUST omit `thinking` when reasoning is unset and `off` is unavailable, or when no supported level is at or below the prior selection. A recorded model no longer offered MUST stay selected, but not selectable, until changed. Hosts MUST accept `currentValue` absent from `options`, including `options: []`. An implementation decoding the value MUST split on the literal slash and decode only `%25` and `%2F` once. The agent MUST NOT substitute another model. Without any selected or offered model the agent MUST omit `model`. The agent MUST refuse unadvertised option ids or values with `invalid_params`, except that an explicit supported thinking level for the selected model can be set when the selector is omitted because there is no current level.

The agent MUST map a change refused under [`settingsDuringTurn`](../contracts.md#settings) to `busy`. The agent MUST return the full current `configOptions` after open and on a successful change, with model-dependent choices recomputed.

The agent MUST omit `approval` when no approval plugin is loaded. With the plugin loaded, ACP `currentValue` MUST show the effective [approval setting](../contracts.md#tool-dispatch). Changing the option does not change rights or bypass other gates.

## Prompts

`session/prompt` admits ACP input with an optional [key](#input-admission). The agent MUST wait for its turn or a terminal no-turn disposition. It MUST return the admission `inputId` except for an erased duplicate. A handled input MUST return `stopReason: "end_turn"` with `disposition: "handled"` and no turn outcome. A hand-back due to cancellation MUST map to `cancelled`. Other hand-backs MUST return `conflict` with `inputId` and `disposition: "handedBack"` in `error.data._meta` in both versions. Cancelling the RPC only detaches its waiter.

The agent MUST use the shared [`turnEnd`](data.md#history-entries) outcome and the ACP mapping below. In either version it MUST include `openToolCalls` when the turn left any calls open and omit it otherwise. In the prompt projection `outcome` contains `kind`, `error` (a string only for `failed`), and `limit` (a string only for `limit`). The agent MUST use `"Turn failed"` if a failed outcome has no message.

| Outcome | ACP result |
|---|---|
| `completed` | `stopReason: "end_turn"` |
| `cancelled` | `stopReason: "cancelled"`; `handedBack` as in [Cancelling](#cancelling) |
| `limit` with `steps` or a build-specific name | `stopReason: "max_turn_requests"` |
| `limit` with `output`, `sessionTokens` or `tenantTokens` | `stopReason: "max_tokens"` |
| `failed` in `/1` | `stopReason: "refusal"`, with `outcome.kind: "failed"` |
| `failed` in `/2` | JSON-RPC `-32000`, message equal to `outcome.error`, and `data: { _meta: { "modular-agent": { ... } } }` with the prompt metadata; no `stopReason` |

The agent MUST keep failed turns in history in both versions. The agent MUST report a Provider stop of `refused` that ends the turn as `failed`, retaining its history. This is not an ACP refusal that discards context. An aborted attempt that settles the turn as cancelled uses `cancelled`. A refused tool call is a tool result, not a turn outcome. Hosts MUST read `outcome` rather than infer success or failure from the stop reason. A turn settled as failed stays failed even if cancellation arrives later.

### Input admission

The two admission methods MUST share the [core key lookup](../contracts.md#input), retaining keys across branches and restarts. Externally supplied keys are scoped by session, configured submitter and attributed actor. New keys MUST be nonempty strings outside reserved prefixes. A refusal MUST NOT claim a key. An authorized erased duplicate MUST return exactly `{ duplicate: true, erased: true }` from `input`; a prompt MUST return `stopReason: "end_turn"` with only those two metadata fields and no turn outcome. A duplicate cannot start or cancel work.

The agent MUST decide admission and its receipt in the same serialized operation as the ready queue, installed recovery work and turn state. With no running turn, non-proposal input takes `now` only if it can run next without overtaking ready or recovered work; otherwise it queues with `after`.

| `when` | When idle and this input can run next | When a turn runs |
|---|---|---|
| `now` (also `session/prompt`) | Start a turn; receipt `now`. | Queue a new turn; receipt `after`. |
| `steer` | Start a turn; receipt `now`. | Before the [final steering check](../contracts.md#input) and with `inputDuringTurn`, queue steering; receipt `inTurn`. Otherwise queue a new turn; receipt `after`. |
| `after` | Start a turn; receipt `now`. | Queue a new turn; receipt `after`. |
| `propose` | Keep a proposal; receipt `proposed`. | Keep a proposal; receipt `proposed`. |

The agent MUST refuse mixed-actor steering under `mixedActorInput: "refused"` with `conflict`. It MUST acknowledge extension input without waiting for its turn and keep the initial `taken` with the admission. A duplicate MUST reuse that disposition, not infer it from current state. For a legacy admission without a provable `taken`, the agent MUST return `conflict` without running new work. A duplicate prompt MUST observe the original turn or no-turn disposition in the caller's version, except that an unreleased proposal returns `conflict`. Cancelling or losing a duplicate waiter MUST NOT affect work. A host MAY retry keyed input to reconcile admission.

## Updates

The agent MUST use `session/update` for live updates and replay. It MUST send `agent_message_chunk` for model text and `agent_thought_chunk` for readable reasoning only. The first update for a displayed call MUST be `tool_call` with the session's stable call id as `toolCallId`, the name as `title`, and the tool input as `rawInput` after gating. Calls MUST start with ACP `pending`, or `in_progress` if dispatch already started. Progress MUST use `tool_call_update` with `in_progress`. A call left open MUST have status `pending` until it settles, including if it settles in a continuation. A blocked initial call MUST NOT be followed by orphan updates on that connection.

A [nested call](../contracts.md#nested-calls) is displayed like any other call: its first update MUST be `tool_call`, and that update MUST carry `parentToolCallId`, the session's id of the call that asked for it, under `_meta["modular-agent"]`. A client that does not know the field shows the call as an ordinary one.

The agent MUST send a terminal `tool_call_update` after the final result is recorded, with status `completed` for a completed result and `failed` for each other terminal result. It MUST include the shared status in metadata and use ACP tool content blocks for renderable result content. Each result MUST settle its call exactly once; replay uses the same id. Final live updates for a turn MUST precede its prompt reply on that connection.

### Output gate

The agent MUST gate each recipient's outbound session content, including replay, raw tool inputs, permission and form requests, metadata, result bodies and error data. It MUST gate the content of non-session replies, including `initialize`, with `sessionId: null`. The agent MUST use the acting actor as recipient for a reply and the configured actor as recipient for updates and replay. It MUST use the addressed actor as recipient for permission and form requests. It MUST recheck the delivery rights of all actors behind a recipient, including `watch` for updates and replay. The agent MUST map output to [shared events](data.md#output-events) before sending ACP messages:

| ACP output | Gate event |
|---|---|
| Live model text and thought chunks | `text`, `reasoning` |
| Live tool start, progress and terminal result | `toolCall`, `toolOutput`, `toolResult` |
| Replay or history item | `entry` before rendering it into ACP; the page also passes `reply` separately. See [history paging](#extension-methods) for withheld entries. |
| Settlement of any turn | `turnEnded` before any related prompt `reply`; no separate ACP notification |
| Request result or error containing content | `reply` with the method and complete `result` or `error`, including metadata |
| Agent permission or form request | `request` with the method and complete ACP `params` |
| Config update | `request` with method `session/update` and complete ACP `params` |

The agent MUST apply the [shared size and redaction rules](data.md#output-events). In ACP payloads it MUST limit string changes to display content, readable reasoning, error messages, descriptive labels, and non-approval tool titles and inputs. A value accepted back from the client, a standard permission request or any field outside those display mappings is not redaction text. See [Request](#request) for the effect of redactions on approval projections. If `turnEnded` is blocked, the related prompt MUST return `withheld` in both versions. Otherwise the reply MUST use only the gated settlement, and then pass the reply gate. A later projection cannot reintroduce withheld or redacted fields. The agent MUST suppress a blocked update or request and send `-32000` with `data.code: "withheld"` for a blocked reply. A blocked reply does not roll back state. Hosts SHOULD reconcile lost or withheld mutation replies by authorized read or keyed retry.

## Approvals

The agent MUST use exactly the following options in `session/request_permission`:

```json
[
  { "optionId": "allow", "kind": "allow_once", "name": "Allow" },
  { "optionId": "refuse", "kind": "reject_once", "name": "Refuse" }
]
```

The permission request MUST show the exact current call name as `toolCall.title` and input as `toolCall.rawInput`, bound to its `toolCallId` and question id. Neither a separate call notice nor a previous gate pass supplies that view. The agent MUST obey [core approval view and route rules](../contracts.md#approval-policy). A valid `allow` permits only the displayed call; valid `refuse` or explicit permission cancellation declines. A failed route cannot displace a valid answer, and this method offers no persistent approval.

## Questions

The agent MUST apply the [core question rules](../contracts.md#questions) to eligibility, deadlines and reuse. An approval never outlasts its turn; after a deadline, a later approval check for the exact call uses a fresh request. Presence is not proof of human assent. Standard ACP responses MUST act only as the actor to whom the agent addressed that RPC, on the same authenticated connection. The client MUST NOT override that actor in its reply. The authorization and scope of `actorId` in the extension are in [Several actors](#several-actors).

| Kind | Standard ACP route while in the turn | Extension route |
|---|---|---|
| `approval` | `session/request_permission` to eligible present actors. | `allow` or `refuse`. Presence still required. |
| `text`, `choice` | `elicitation/create` with `mode: "form"` if the client advertised forms. | String or exact choice option. Also used with no forms or when left open past the turn. |
| `link` | No ACP URL/completion handshake in this profile. | The request supplies the link URI in `details`; the answer is a string acknowledgment, not proof of an external action. |
| `secret` | None. | Decline only; no secret value crosses ACP. |

For a form, the agent MUST use the question as `message` and a requested object schema with one required `answer` string, with the exact options as its `enum` for a choice. A form reply with `action: "accept"` MUST supply a valid `content.answer`. The agent MUST treat `decline` as a decline. A `cancel` or malformed reply MUST NOT authorize or settle the question as an actor's answer. The agent MUST NOT decline an ordinary question solely because forms are unsupported. For approval or form dispatch, the agent MUST use each eligible present actor's active route at most once per question at a time. The agent MUST decline a secret question not handled outside ACP without requesting a value. The agent MUST NOT log, record or echo a secret submitted in error.

All channels MUST use the same first-valid-committed check. The agent MUST cancel outstanding RPCs on settlement and remove a lost or invalid route without treating it as assent. It MUST apply [core approval route rules](../contracts.md#approval-policy) using the mapping in [Request](#request). Ordinary unanswered questions follow [core question rules](../contracts.md#questions).

The agent MUST follow the core [question recovery and continuation rules](../contracts.md#questions). `waitingThroughRestart` covers an interruption inside a turn. `questionsOutlastTurns` with `lateAnswersStartTurns` enables the same late-answer continuation in `/1` and `/2`, regardless of the Runtime's restart support. The host uses `requests` and `answer` after the turn.

## Cancelling

`session/cancel` is a notification. For authorized cancellation, the agent MUST target the running turn at the moment the notification is accepted, without altering a turn already settled. With no running turn the notification MUST do nothing. The agent MUST record the hand-back of accepted unconsumed turn input at that cutoff before acknowledging cancellation in a prompt reply. Unreleased proposals are not turn input. Input admitted after the cutoff MUST NOT be cancelled by that notification. Unanswered questions of the cancelled work MUST close with `cancelled`. Each affected call MUST settle once. Job scope follows the [core cancellation rules](../contracts.md#jobs).

The agent MUST apply the [core cancellation deadline](../contracts.md#parts-that-are-lost) without waiting beyond it for cleanup. A `session/close` uses the cleanup rules in [Sessions](#sessions). For a cancelled prompt it MUST include authorized `handedBack` in original admission order. Readers without `watch` MUST receive only their own items. If there was no prompt waiting, the recorded `turnEnd` and `inputHandedBack` provide the outcome via `history`. There is no general work timeout. `$/cancel_request` MUST cancel only the matching RPC, without stopping a session's turn. Use `session/cancel` to stop the turn. Cancelling a request does not imply rollback of an admission or any other committed effect.

## Extension methods

Each extension request MUST include `sessionId`. These four methods MUST be listed in `extensions` and implemented. Identifiers are nonempty strings. Optional fields are omitted unless supplied; `null` is allowed only where shown.

| Method | Params beyond `sessionId` | Result |
|---|---|---|
| `_modular-agent/history` | `after?` (entry id), `all?` (boolean, default `false`), `limit?` (integer 1 to 500, default 500) | `{ entries: [Entry], nextEntryId? }` |
| `_modular-agent/input` | `content` (string or ACP prompt blocks), `when`, `key?`, `actorId?` | `{ inputId, taken, duplicate? }` or the erased receipt from [Input admission](#input-admission) |
| `_modular-agent/requests` | none | `{ requests: [Request] }`, in admission order, including questions left open past their turns |
| `_modular-agent/answer` | `requestId`, `value?` (string), `declined?` (boolean, default `false`), `actorId?` | `{ accepted: true }` or `{ accepted: false, reason }` |

The agent MUST use a consistent view for each history request. `all: false` walks the current branch oldest first; `all: true` uses kept order across branches. A supplied `after` MUST name a kept entry in that view, including an erased tombstone. A page MUST contain at most `limit` entries. The final `result` MUST fit in 4 MiB of [actual encoded bytes](data.md#general-rules), including any `nextEntryId` and the post-gate `answerable` fields. When entries remain, the agent MUST return at least one entry unless all entries in the page were withheld or even the first deliverable entry cannot fit the wire page limit. In the latter case the agent MUST return `result_too_large`. The agent MUST omit entries withheld by the [entry gate](#output-gate) before gating the page reply. When more kept entries follow the last returned entry, the agent MUST use that entry's id as `nextEntryId`. The next request uses it as `after`. If all entries in the page were withheld, the agent MUST form the result as `{ entries: [] }` with no cursor. There is no opaque skip cursor, so catch-up can stop at a fully withheld page. Pages are live, not a snapshot across calls. If a move invalidates a branch cursor, the host MUST restart at a valid entry or use `all: true` to catch up in kept order.

Before lookup the agent MUST validate actor and generic syntax and require `answer` or `approve`. Unknown, hidden, ineligible, closed and losing requests MUST all return `{ accepted: false, reason: "not_open" }` without question-specific diagnostics. Once the caller is eligible and authorized to see the question, the agent MUST validate the value for its kind, rejecting invalid values and secret values with `invalid_params`. Missing `value`, explicit decline or approval `"refuse"` is a decline. Explicit decline ignores a non-secret value. Acceptance includes decline.

The following extensions are optional and MUST be listed if offered. Features named in the declaration table also follow its requirements.

| Method | Params beyond `sessionId` | Result |
|---|---|---|
| `_modular-agent/fork` | `entryId` | `{ sessionId }` with a fresh id |
| `_modular-agent/move` | `entryId`, `rewind?` (boolean, default `false`) | `{}` or `{ outOfReach: [toolCallId] }` |
| `_modular-agent/erase` | `entryIds` (nonempty array of entry ids in `sessionId`) | `{ erased: [{ sessionId, id }], pending: [{ sessionId, id }], outOfReach: [string] }` |
| `_modular-agent/jobs` | none | `{ jobs: [{ id, kind, state }] }`; `state`: `"running"`, `"unfinished"` or `"cleanupUnconfirmed"` |
| `_modular-agent/cancel-job` | `jobId` | `{}` |

- **Fork:** The agent MUST refuse unsupported forking or unfinished work with `not_supported` or `busy`, respectively. A fork MUST target a kept non-`position` entry in the source session and copy its branch with source lineage. The agent MUST apply the [core inheritance rules](../contracts.md#moving-and-rewinding) and [tenant inheritance](../contracts.md#limits-and-tenants). An unknown target MUST fail with `not_found`. A `position` target MUST fail with `conflict`. If the [history HTTP preflight](history-http.md#sessions) cannot fit the initial batch, the agent MUST return `-32602` with `data.code: "result_too_large"`. A fork MUST be reopened explicitly before use on this connection.
- **Move:** The agent MUST refuse a target outside the session with `not_found`. It MUST refuse a `position` target with `conflict`. For `rewind: true` it MUST refuse if rewinding is undeclared, and otherwise follow the target, environment, unfinished-work, restoration and rollback rules in [Rewinding](data.md#rewinding). The agent MUST map target or point refusal, including a point treated as `not_found` in preflight, to `conflict`. It MUST map unfinished work to `busy`. With rewind it MUST include `outOfReach` when there are open-world calls the restore could not undo. Without rewind it MUST follow the [core move rule](../contracts.md#moving-and-rewinding). Neither ACP operation takes a null target.
- **Erase:** The agent MUST validate and deduplicate targets before deletion, returning `not_found` for unknown and `forbidden` for protected records. An invalid request changes nothing. The agent MUST follow [Erasure](../contracts.md#erasure), listing affected sessions' copies under `pending` when held by another writer. It MUST return `busy` if `erasureDuringTurn` disallows starting the operation. The agent MUST deduplicate `erased` and `pending` by `(sessionId, id)`. For copies in sessions the actor may not see, it MUST omit the pairs and report only `"copies in other sessions"` in `outOfReach`. It MUST return each category at most once. Repeated targets do not cause duplicate erasure.
- **Jobs:** The agent MUST list unfinished jobs oldest first. It MUST use `state: "cleanupUnconfirmed"` when the [shared job fold](data.md#session-state) marks cleanup unconfirmed, `"running"` for other live jobs or `"unfinished"` otherwise. Cancellation MUST follow [Jobs](../contracts.md#jobs), returning `lost` for unconfirmed cleanup and `not_found` for unknown or foreign ids. Repeating cancellation of a terminal job MUST return `{}` without a second end.

### Entry

An ACP `Entry` is a recipient projection of a [shared history entry](data.md#history-entries), not a portable record. The agent MUST use the shared tombstone shape for erased entries, omitting `writer` and `jobKey` from the recipient view. For other entries it MUST keep `id`, `parentId`, `kind`, `time`, and applicable `turnId`, `stepId`, `toolCallId`, `jobId`, `actorId`, `inputId`, `requestId`, `continuesTurnId` and `sources`. It MUST keep the shared message fields except Provider-private fields. For `data` it MUST keep only the applicable fields below, in their shared shapes, subject to the gate:

| Entry kinds | Fields in `data` |
|---|---|
| `inputAccepted`, `input`, `inputHandedBack` | `inputIds`, `when`, `content`, `releasedBy`, `reason`, `parked` where present; no input keys |
| `turnStart`, `modelRequest` | `startedBy`, `model` where present |
| `toolStarted`, `toolResult` | `call`, `status` where present |
| `inputRequest`, `inputAnswer` | `request` using [Request](#request) below, or the shared Answer without `stored` |
| `resultFeedback` | `reason` |
| `turnEnd` | `outcome`, `result`, `usage` |
| `actorJoined`, `actorLeft`, `limit`, `tenant`, `erasure` | Standard fields from [Shared data](data.md#standard-kinds), except erased key reservations |
| `setting` | `key`, `value` for standard keys only; only standard children of a `settings` object |
| `jobStarted`, `jobEnded` | `kind`, `outcome`, `result`, `report`, `usage` where present |
| `jobCleanupUnconfirmed` | No `data`; `jobId` is in the envelope |
| `summary`, `position` | `summary`, `to` respectively |
| Other kinds | No `data` |

The agent MUST omit credential values, Provider-private state, working-environment points and launch details from this view. An unknown kind retains its envelope only.

The agent MUST use shared [Content](data.md#content) for `message.content`, `data.content`, handed-back input and proposals. It MUST preserve text, image `data` and `mimeType`, readable reasoning text, and tool-call `id`, `name` and `arguments`, subject to the gate. It MUST omit opaque reasoning and Provider data anywhere in that projection. A host MAY ignore unknown part types. For rendering ACP chunks, the agent MUST convert text and images to the matching ACP block, render readable reasoning only as thoughts, and leave other parts to their explicit tool or application mapping. For admission a plain string MUST become one text part. The agent MUST convert recognized ACP text and image blocks to the matching shared parts. It MUST reject other blocks unless handled by the declared ACP capabilities or the pinned ACP resource rules. The same normalization applies to both input methods.

### Request

The agent MUST project [InputRequest](data.md#questions) as `{ id, kind, question, answerable, options?, details?, toolCallId?, call? }`. `options` is present only for a choice, and `details` only for a link URI. For approval, `call` MUST be `{ name, input }` with the exact approved values. The agent MUST omit credential names and values. A client MAY poll `requests` even while a permission RPC is open.

The agent MUST omit `answerable` from each projected request presented to the gate, including nested projections in history. After gating, it MUST set `answerable` per recipient and route from the question's open state, current eligibility and deliverable view. For an approval it MUST set `answerable: false` on a projection that any gate stage changed, comparing without `answerable` by [JSON value](data.md#general-rules). A blocked reply remains withheld.

For approvals, the agent MUST apply the [core route rule](../contracts.md#approval-policy) as follows:

| Route | Approval view and answer |
|---|---|
| Permission RPC | A reply MUST refer to the unchanged `session/request_permission` sent to that actor on that connection. |
| Polling | The route is viable only for a present eligible actor with `watch` who can receive an unchanged `requests` view. The `answer` extension MUST require that the connection received an unchanged polling view with `answerable: true` for that actor and question. |
| History | The history projection MUST NOT authorize an approval answer. |

For example, `requests` can return `{ "requests": [{ "id": "q1", "kind": "choice", "question": "Which draft?", "options": ["first", "second"], "toolCallId": "c1", "answerable": true }] }`. Once `q1` settles it disappears from `requests`; a second `answer` gets `{ "accepted": false, "reason": "not_open" }`.

## Several actors

An agent with `severalActors` MUST offer and list all the following extensions. An agent that can park job reports or reopen them still parked MUST offer and list `proposals`, `release` and `withdraw` even without `severalActors`. Without `severalActors` it MUST refuse `when: "propose"` and represented actors with `not_supported`. The actor shape and rights are those of [shared data](data.md#actors).

| Method | Params beyond `sessionId` | Result |
|---|---|---|
| `_modular-agent/actors` | none | `{ actors: [Actor], present: [actorId] }` |
| `_modular-agent/join` | `actor`, `present?` (boolean, default `true`) | `{}` |
| `_modular-agent/leave` | `actorId` | `{}` |
| `_modular-agent/release` | `inputId`, `when` (`now`, `steer`, `after`), `declined?` (boolean, default `false`) | `{ inputId, taken }`; `handedBack` for a declined release |
| `_modular-agent/proposals` | none | `{ proposals: [{ inputId, actorId, content, time }] }`, pending proposals and parked job reports oldest first |
| `_modular-agent/withdraw` | `inputId` | `{}` |

The agent MUST record successful `join` and `leave` as session-wide grants and revocations, with the granter's id for grants. A rejoin MUST replace rights without changing the actor's kind. The agent MUST NOT let `join` replace the connection's configured principal or reclassify an existing actor id. Self-leave MUST revoke the configured actor, not an actor selected for delegation. Disconnect MUST remove that connection's presence and bindings without revoking durable rights.

Presence follows [Authority](../contracts.md#authority). On open the agent MUST mark the configured actor present. A `join` MUST set presence only for a represented actor, and `present: false` clears only presence. Leave MUST clear that actor's presence on every connection. On `input` or `answer` an explicit `actorId` MUST name a current member the operator configured this connection to represent. Joining an actor never confers representation. The agent MUST intersect attributed and configured actors' effective rights and record both identities. Without `actorId` it MUST use the configured actor. Other methods do not select a principal through `actorId`.

For `proposals`, `release` and `withdraw`, the agent MUST treat an unreleased parked job report as a proposal, whatever its recorded `when`. For `release` or `withdraw` the agent MUST check the proposal and commit its transition atomically with authorization. A successful release MUST record another `inputAccepted` with the same `inputId`, the new `when` and `data.releasedBy`. For a report release, `steer` behaves as `after` under [Input admission](#input-admission); attribution and authority follow [Jobs](../contracts.md#jobs). For other releases the agent MUST use the proposer and releaser's shared rights, including any delegating actor's rights. The [restart policy](../contracts.md#input) applies to reports only once ready. A decline or withdrawal MUST record `inputHandedBack` and take no turn. The agent MUST fail an unknown proposal id with `not_found` and a known no-longer-pending proposal with `conflict`.

For example, `proposals` can return `{ "proposals": [{ "inputId": "i1", "actorId": "guest", "content": [{ "type": "text", "text": "Check the draft" }], "time": 1760000000000 }] }`. A declined `release` of `i1` returns `{ "inputId": "i1", "taken": "handedBack" }` and removes it from this list.

## Limits and tenants

The agent MUST list `limit` if it declares `sessionLimits` and `tenant` if it declares `tenants`.

| Method | Params beyond `sessionId` | Result |
|---|---|---|
| `_modular-agent/limit` | `rights` (standard right names as an array, or `null`) | `{}`, after recording `limit` |
| `_modular-agent/tenant` | none | `{ tenant, rights, tokens }` |

The agent MUST apply the [session ceiling rule](../contracts.md#limits-and-tenants) to `limit`. No right comes from using ACP.

The agent MUST return `tenant: null`, `rights: null` and `tokens: null` for a session without a tenant. Otherwise it MUST return the tenant name, its configured ceiling as an array of standard rights, and `tokens: null` if unbudgeted or `tokens: { budget, used }` if budgeted. Tenant inheritance, budget checks and deployment-local accounting follow [Limits and tenants](../contracts.md#limits-and-tenants). The stop reason is in [Prompts](#prompts).

## Conformance mode

With `MODULAR_AGENT_CONFORMANCE=1` the agent MUST offer the fixture model `conformance/echo` and fixture tools `bash` (`{ command: string }`) and `read` (`{ path: string }`). The operator MUST use isolated, disposable test state and a test working environment. The agent MUST refuse conformance startup with production credentials, Providers or service endpoints configured. The fixture model and tools MUST NOT require or use network access or credentials. The agent MAY use a separately configured isolated test history service for portability tests. Fixture tools MUST use the normal checks and working environment; the fixture does not confer authority.

The fixture MUST select the last user message and concatenate its text parts without separators. It MUST ignore messages and results before that input. Missing user or text yields the empty string. For each model attempt it MUST return exactly the first matching case below and a shared Usage with every number zero. It MAY offer any thinking levels from the binding's list.

| Input | Required reply |
|---|---|
| Text starts with `fail:` | The model MUST return `stop: "failed"`, `error.kind: "other"`, and the suffix as its message. |
| Text starts with `tool:` but has no nonempty name before the first ASCII space, no JSON object after that space, or a name not in the request's tools | The model MUST return `stop: "failed"` with error `{ kind: "other", message: "Invalid tool directive" }`. |
| Valid `tool:<name> <json>` with no tool result after the latest user message | The model MUST return `stop: "toolUse"` with one call to that name and the parsed object as its input. |
| Valid `tool:<name> <json>` with a tool result after the latest user message | The model MUST return `stop: "finished"` and `done: ` followed by the first 200 Unicode code points of the first such result's text parts, concatenated without separators. |
| Other text | The model MUST return `stop: "finished"` and one text part `echo: <text>`. |

An agent that declares `nestedToolCalls` MUST also offer the fixture tool `nest` (`{ name: string, input: object }`). `nest` MUST start one nested call with that name and input and settle with the nested result's status and content unchanged.

The [conformance kit](../../conformance/acp/README.md) exercises this mode. See [Conformance and versioning](../conformance.md) for what passing the kit establishes.

## Changes

- **Edition 4 draft** ([ADR 0023](../adr/0023-edition-4-draft.md)). Both versions keep their numbers. The optional declaration key `nestedToolCalls`, the fixture tool `nest` for agents that declare it, and `parentToolCallId` on a nested call's first update.

- **Production edition 3.** Approval authority is per recipient and route (TypeScript, Python G100). Gate limits and the history page limit are separate (TypeScript). The operator can set a shared connection actor id (portable F2, TypeScript to Python and Rust: the kit used different principals and the builds misread key scope; F4, Go to TypeScript: the reopener retrieved another actor's receipt).

- **Production edition 2.** Idle close needs membership, not `cancel` (Elixir PE-1, Python G98). Approval projections compute `answerable` after gating (Elixir PE-8, Python G94). Reopen can return retryable `held` (Go P4, TypeScript). Limits count actual bytes (Go P5), and JSON depth errors and the `resultFeedback` entry projection are specified (TypeScript).

- Production round two: configured representation, exact approval views, erased receipts and bounded recovery and cleanup.

- **Production edition.** Pinned ACP schemas and declaration values; specified connection identity, tenant and method checks, answer races, gating and history bounds, cancellation and recovery, and deterministic fixtures. Binding versions are unchanged.
  - Round three: session-qualified erase results, fork size refusal, durable cleanup status and the steering cutoff.
  - Round four: provisional load replay, release of parked job reports and queue-aware input receipts.
- **2026-11-18, round six.** Listing and withdrawing proposals; presence on `join` (Go B28, Elixir R5-4); limits and tenants; a reply the gate withholds (Go B35); what a rewind couldn't reach (Go B34).
- **2026-11-18, round five.** The Entry section points to the shared data's kinds, and erased entries keep their identities there too (found by the TypeScript builder).
- **2026-11-18, round five.** `/2`, asked for in `initialize`, reports a failed turn as a JSON-RPC error rather than `refusal`; the conformance model's `fail:` makes one. Several actors: the extensions `actors`, `join`, `leave` and `release`, `actorId` on `input` and `answer`, and proposed input (Python G76, Go B26). `move` with `rewind`.
- **2026-11-18, after the portable-session matrix.** Opening joined the connection's actor to sessions written by another build (Elixir M3-2). The production edition replaces unconditional join on reopen.
- **2026-11-18, round four.** The optional declaration key `portableSessions`. The conformance model's "this turn" is everything after the last `user` message (Rust B-14).
- **2026-11-17, after round two.** Clarifications from the Rust, Python and Go builds' binding gaps:
  - the echo counts code points;
  - the data folder overrides path flags;
  - duplicates whose turn hasn't ended, or whose input was handed back;
  - the `inputId` link;
  - the limit names, and the question-deadline row;
  - handed-back input on load;
  - no declining for lack of forms;
  - the cursor scope, answer values, erasure fields, and history blocks;
  - optional declaration keys for late answers, job reports after a restart, and a single project root;
  - the `refusal` mismatch, noted for `/2`.

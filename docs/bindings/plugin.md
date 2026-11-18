# Plugin binding: `modular-agent-plugin/1`

How a Harness hosts a plugin that runs as a separate program, in any language. The binding turns the [interactions in Contracts](../contracts.md#interactions) into messages: what the Harness asks a tool source, a Provider or a working environment, and what a hook handler is given and may answer. A plugin is never sent a build's own plugin API, only these messages. So a plugin written once runs under any build that follows the binding, and one build's plugins run under any other.

All data uses the [shared data](data.md) shapes.

It covers:
- tool sources;
- Providers;
- the working environment;
- handlers at the standard hook points;
- commands;
- the Runtime (stage 2): a Runtime in one language running turns for another language's Harness.

History, credential and configuration stores are not hosted this way: history has [its own binding](history-http.md), and the other two hold secrets or are trivial.

The design follows prior art in PiG, which hosts extensions in four languages over one wire ([PiG reference](../research/pig-reference.md)). It takes PiG's:
- registration handshake;
- separation of host requests from plugin callbacks, linked by request;
- on-demand, paged history;
- frame cap, heartbeat and shutdown.

It doesn't copy PiG's approach of porting one plugin API to every language.

## Transport

- **The host starts the plugin** as a child process, and speaks JSON-RPC 2.0 on its stdin and stdout, one message per line. The plugin writes nothing else to stdout. Its stderr is the host's to show or log.
- **Requests go both ways,** with independent ids.
  - The host's requests are named `plugin/*`, `tools/*`, `provider/*`, `env/*`, `hook/*` and `command/*`.
  - The plugin's requests to the host are named `host/*`.
- **A plugin's request about a host request** carries `parentRequestId`: the id of the host request it belongs to. The host uses it to find the session, the actor and the authority. It also uses it to cancel the plugin's request when the parent request is cancelled. The parent must be a request this host sent on this connection and hasn't had answered yet. Once it is answered, a request naming it is refused with `invalid_request`.
- **Cancelling:** either side sends the notification `$/cancel { id }` for a request it sent. The receiver stops the work, and still answers: a result, or the error `cancelled`. That holds for the host's answers to `host/*` requests as much as for a plugin's, and for a request whose work hadn't started when the cancel arrived. A cancel for an id already answered, or never sent, is ignored. Cancelling never claims an outside effect was undone.
- **Both sides keep reading** while they work. A side handling a request may send a request of its own and wait for the answer, so it never stops reading its input to wait. Notifications are handled in the order they arrive, and before any answer that arrives after them.
- **Heartbeat:** either side may send `$/ping`. The answer is `{}`. Work has no timeout of its own; the caller's cancelling owns it.
- **Limits:** a message is at most 64 MiB. A result that would be larger is replaced by the error `result_too_large`.
- **Errors** are JSON-RPC errors whose `data` is `{ "code": "<code>" }`. The JSON-RPC `code` is -32601 for a method the receiver doesn't have, -32602 for `invalid_request`, and -32000 for the rest. A receiver reads `data.code`, never the number or the message. The codes:
  - `invalid_request`;
  - `not_found`: a file the request names doesn't exist;
  - `unknown_handler`;
  - `cancelled`;
  - `not_supported`;
  - `result_too_large`;
  - `lost`: a part this request needed was lost;
  - `internal`.
- **Ending:** the host sends `plugin/shutdown { reason }`, where the reason is `stop`, `reload` or `refused`, waits for the answer, then closes the plugin's stdin. A plugin exits when its stdin closes, whatever else it is doing. Whatever it started stops with it, as the working environment's rule requires.
- **A lost plugin:** if the plugin's process ends early, every request waiting on it fails with `lost`, and the host follows [Parts that are lost](../contracts.md#parts-that-are-lost).

## Starting: the handshake

The host's first message is `plugin/initialize`:

```json
{ "binding": "modular-agent-plugin/1", "data": "modular-agent-data/1",
  "host": { "name": "...", "version": "..." }, "project": "/abs/path", "home": "/abs/path",
  "config": { } }
```

- `project` is the Harness's project.
- `home` is the data folder the plugin may use for its own state.
- `config` holds the plugin's own settings, from the host's configuration.

The plugin answers with its registration. Registration is the only source of what the plugin provides. Nothing appears later, except a tool source's changed list.

```json
{
  "binding": "modular-agent-plugin/1",
  "name": "my-plugin",
  "providers": [ { "id": "conformance", "supports": { "keepsState": false, "runsTools": false }, "models": [ ModelInfo ] } ],
  "toolSources": [ { "id": "files", "tools": [ ToolDefinition ], "perSession": false } ],
  "workingEnvironment": { "containment": "strong" | "processGroup" | "none", "platforms": ["linux"] },
  "hooks": [ { "hook": "tool.before", "handlerId": 1, "order": "normal" } ],
  "commands": [ { "name": "hello", "description": "..." } ],
  "runtime": { "id": "durable", "supports": { "inputDuringTurn": true, "waitingThroughRestart": true, "continuesAfterRestart": true, "rewinding": false } },
  "replaces": [ "provider:conformance", "tool:bash", "working-environment" ]
}
```

- **Every field but `binding` and `name` is optional.** A binding the plugin can't speak gets the error `not_supported`.
- **`order`** is `first`, `normal` or `last`, as in [Hook points](../contracts.md#hook-points).
- **`replaces`** names items the host leaves out of its own plugins in favour of this one: `runtime`, `working-environment`, `provider:<id>`, `tool:<name>` or `command:<name>`.
  - **Only the named items go.** A host's own plugin that registered other items keeps them. Replacing `tool:bash` and `tool:read` leaves the host's `write` and `edit`. This is narrower than [replacing a plugin](../contracts.md#plugins-and-capabilities) inside a build, because a build's own plugins aren't visible on the wire.
  - **A named item the host doesn't have** is simply added, but the plugin must register it. Naming an item and not registering it is refused.
  - **Only the host's own items can be replaced.** An item another external plugin registered can't be, so naming one is refused.
  - **A plugin that registers a `runtime` replaces the host's Runtime,** whether or not it names `runtime`, since a session has only one.
  - **Otherwise a name the host already has is refused,** as [never shadowed](../contracts.md#plugins-and-capabilities) requires. A plugin that replaces nothing adds to the host.
- **A registration the host can't accept,** such as a refused replacement or a handler for a hook point it doesn't offer, means the host doesn't load the plugin. It sends `plugin/shutdown { reason: "refused", detail }`, reports the problem, and leaves its own items as they were. Nothing the plugin registered remains.
- **`perSession: true`** means the tool list can differ by session.

## The host asks a tool source

| Request | Params | Result |
|---|---|---|
| `tools/list` | `toolSource`; `sessionId` *(optional)* | `{ "tools": [ToolDefinition] }` |
| `tools/call` | `toolSource`, `sessionId`, `project`, `call` (a ToolCall) | a ToolResult without `callId`, or `{ "pending": "<why>" }` |

While a call runs, the plugin may:
- **send progress:** the notification `tools/progress { parentRequestId, content }`;
- **ask a question:** `host/ask { parentRequestId, request }`, with an InputRequestDraft, which returns an Answer. Questions in one call are keyed by their order in the run, as in Contracts. A call that left a question open answers `{ pending }`, and runs again from the top once the question is answered.
- **use the session's working environment** through `host/env/*` (below). A tool never uses a working environment of its own, unless its plugin is the session's working environment. Swapping the working environment then moves every tool with it.

When its list changes, the plugin sends the notification `tools/changed { toolSource }`. It sends it before it answers the request that caused the change. The host then reads the list again before it passes that answer on.

## The host asks a Provider

| Request | Params | Result |
|---|---|---|
| `provider/models` | `provider` | `{ "models": [ModelInfo] }` |
| `provider/available` | `provider` | `{ "available": boolean }` |
| `provider/request` | `provider`, `model` (`{ provider, id }`), `request` (a ModelRequest), `sessionId` *(optional)* | an assistant message |
| `provider/discard` | `provider`, `sessionId`, `erase` *(optional)* | `{}`. For a Provider that keeps state ([Provider state](../contracts.md#provider-state)). With `erase: true`, for [erasure](../contracts.md#erasure), the Provider also deletes the remote copies it knows of, and answers `{ "pending"?: [string], "outOfReach"?: [string] }`, describing what it couldn't delete yet and what it never can. The host awaits it before reporting the erasure. |

- **The response streams** as notifications `provider/event { parentRequestId, event }`, all before the result.
- **A model's failure is a result, not an error:** an assistant message with `stop: "failed"` and an `error`.
- **The Provider plugin runs its own hook points,** "before a model request" and "as the response arrives". It does so through `host/hook` (below), because the host owns the handlers. Over the wire, "as the response arrives" runs once per response, with the complete message, after the last `provider/event` and before the result. A handler that needs each piece runs in the host's own process.
- **Credentials:** a Provider plugin reads them with `host/credentials/read { provider }`, which returns `{ "credential": Credential | null }`, in the [shared shape](data.md#credentials). `null` means the host has none. The host refuses a provider this plugin didn't register. The Runtime never sees them.

## The host asks the working environment

Every request carries `cwd`, the session's project or a folder in it, and `sessionId`, the session whose work it is.

| Request | Params | Result |
|---|---|---|
| `env/read` | `cwd`, `path` | `{ "data": "<base64>" }` |
| `env/write` | `cwd`, `path`, `data` (base64) | `{}` |
| `env/exists` | `cwd`, `path` | `{ "exists": boolean }` |
| `env/exec` | `cwd`, `command`, `timeoutMs` *(optional)* | an ExecResult. `timeoutMs` is a positive number of milliseconds. A sender leaves it out for no limit, and a receiver treats `0` the same as leaving it out. When it passes, the command is stopped and the result has `timedOut: true`. |

- **A session's background work:** processes a command leaves running outlive the call and a cancelled turn, as [the working environment](../contracts.md#the-working-environment) requires. When the session closes, the host sends `env/sessionEnded { sessionId }`, which answers `{}` once they have stopped. They all stop when the plugin stops.
- **A missing file:** `env/read` of a file that doesn't exist answers the error `not_found`, and so does `host/env/read`. A reader tells a missing file apart from other failures by that code, never by the error's message, which is in each build's own words.
- **Output streams** as notifications `env/output { parentRequestId, chunk }`.
- **Cancelling `env/exec`** stops the command and everything it started, within 5 seconds, as the declared `containment` promises.
- **A plugin that isn't the working environment** reaches it with the same requests, prefixed `host/`: `host/env/read`, `host/env/write`, `host/env/exists` and `host/env/exec`, each with a `parentRequestId`. The host routes them to whichever plugin is the session's working environment, local or not. Output comes back as the notification `host/env/output { parentRequestId, chunk }`, where `parentRequestId` is the id of the plugin's `host/env/exec`.

## The host asks a hook handler

`hook/handle { handlerId, hook, payload }` runs one handler. The host combines the answers itself, by the hook point's rule: a plugin never sees another plugin's answer, except through the payload it is given.

| Rule | The handler answers |
|---|---|
| observe | `null` |
| gate | `null` to allow; `{ "refuse": "<reason>" }`; `{ "change": payload }` to allow with a changed payload; or `{ "pending": "<why>" }` to leave a tool call open |
| transform | `null` to pass on; `{ "value": payload }`; or `{ "value": payload, "stop": true }` |
| first answer | `null` to pass; or its answer |
| collect | `null`; or its contribution |

An error answer counts as a failing handler, per [Hook points](../contracts.md#hook-points).

**The standard hook points:**

| `hook` | Rule | `payload` | Answer, where it has one |
|---|---|---|---|
| `plugin.load` | gate | `{ name, origin, project }` | |
| `session.start` | observe | `{ sessionId, resumed }` | |
| `session.end` | observe | `{ sessionId }` | |
| `input` | transform | `{ sessionId, actorId, content, when }` | the same shape |
| `turn.before` | collect | `{ sessionId, turnId, input }`, where `input` is content | `{ system?: string, context?: content }` |
| `turn.start` | observe | `{ sessionId, turnId }` | |
| `step.before` | transform | `{ sessionId, turnId, stepId, model: ModelInfo, request: ModelRequest }` | the same shape |
| `step.after` | gate | `{ sessionId, turnId, stepId, response }`, where `response` is an assistant message | a refusal ends the turn |
| `tool.before` | gate | `{ sessionId, turnId?, call: ToolCall, definition: ToolDefinition }` | `change` is `{ call }`, where only the call's `input` may differ |
| `tool.after` | transform | `{ sessionId, call, result: ToolResult }` | the same shape |
| `model.failed` | first answer | `{ sessionId, request, error }` | `{ retry: true, request? }` |
| `turn.result` | gate | `{ sessionId, turnId, result: { text?, value? }, shape? }` | a refusal sends the model back with the reason |
| `turn.end` | observe | `{ sessionId, turnId, outcome, result }`, as on a `turnEnd` entry: `outcome` is `{ kind, error?, limit? }` | |
| `provider.request` | transform | `{ sessionId, provider, model, request }`, where `model` is `{ provider, id }`, as on `provider/request` | the same shape |
| `provider.response` | observe | `{ sessionId, provider, model, message }`, with `model` as above | |

- **Only the standard hook points** are offered to a plugin in another process in `/1`. A plugin can't define hook points over the wire, and a handler for any other point is [refused](#starting-the-handshake).
- **"Before output reaches a recipient" is not offered** to a plugin in another process in `/1`. Its handlers hold streamed pieces per recipient, which would cost a round trip per piece. A host refuses a registration for it with `not_supported`.

## The host asks the Runtime

A turn is one request from the host. The Runtime runs it, asking the host for what it needs through `host/runtime/*`, with the turn's request id as `parentRequestId`. It also reads the session's history with `host/history`, for example to rebuild its own records after a restart. Those two are all it uses. It never chooses the model, never sees credentials and never runs a tool itself ([Contracts](../contracts.md#harness-and-runtime)).

| Request | Params | Result |
|---|---|---|
| `runtime/runTurn` | `turn` | a TurnOutcome |
| `runtime/resumeTurn` | `turn`; `interrupted`: `{ turnId, calls }` | a TurnOutcome. The host sends it on reopening a session with a turn whose process stopped. A transient Runtime ends the turn; a durable one carries on. Every pending call ends with exactly one result. |
| `runtime/continueOpenCalls` | `turn`; `calls` | a TurnOutcome. The host sends it when every question behind calls left open past an earlier turn has its answer. Its `turn.startedBy` is `{ kind: "answer", id }`, with the last answer's request id. |

- **`turn`** is `{ sessionId, turnId, startedBy, model: ModelInfo, modelSupports, settings: { maxSteps?, reasoning?, maxOutput? }, resultShape? }`. `startedBy` is as on a `turnStart` entry. `modelSupports` is the Provider's `supports`.
- **Each of `calls`** is `{ id, name, input, stepId?, started, safeToRepeat }`. `started` says whether the call's start was recorded. `safeToRepeat` is `true` only if the recorded `toolStarted` said so, and the tool and the working environment promise it now. The Runtime runs a started call again only when it is `true`.
- **A TurnOutcome** is `{ outcome, result: { text?, value?, openToolCalls }, entries, usage }`. `outcome` is as on a `turnEnd` entry. `openToolCalls` lists call ids. `entries` lists the ids of the entries the turn recorded. `usage` adds up the turn's model responses; work the host does on its own, such as compacting, is recorded and counted by the host.
- **Who records what.** The host records `turnStart` and the input the turn takes before it sends `runtime/runTurn`, so a turn lost at once is still on the record. It records `turnEnd` from the TurnOutcome. It records each call's `toolStarted` before the call runs. The Runtime records the rest: responses, tool results and anything of its own. A Runtime doesn't record `turnStart` or `turnEnd`; a host given one returns the entry it has, or takes it as the turn's end, and never keeps two.
- **Parallel calls.** The Runtime records each result as soon as it has it, so a crash loses none. `host/runtime/prepareStep` gives the model the results in the order the response asked for them, whatever order they were recorded in.
- **A failed model request.** When `model.failed` answers `{ retry: true }`, the host discards any state the turn's Provider keeps. The Runtime then sends the answer's `request` if it has one, or asks `host/runtime/prepareStep` again.
- **Cancelling:** the host cancels a turn with `$/cancel` on its request. The Runtime stops at the next safe point, cancels what it asked the host for, records a result for every started call, and answers with outcome `cancelled`.
- **The Runtime's state lives in the history.** After a restart, the host starts the Runtime plugin's process again and sends `runtime/resumeTurn`. Nothing in the old process survives. The Runtime reads the turn back with `host/history`: its responses, results and step count are in the [standard kinds](data.md#history-entries). It may record kinds of its own through `host/runtime/record` too, but only to save work: a Runtime must recover a turn from the standard kinds alone, since another build may have started it ([portable sessions](data.md#portable-sessions)).
- **What stays with the host.** A tool call an Interface starts outside a turn is the host's to run, not the Runtime's. `/1` has no request for rewinding, so a host running a Runtime over the binding declares `rewinding: false`.

**What the Runtime asks the host.** Every request carries `parentRequestId`, the turn's request id.

| Request | Params | Result |
|---|---|---|
| `host/runtime/newId` | | `{ id }` |
| `host/runtime/prepareStep` | `stepId`, `usage` | the ModelRequest for this step, after "before each step": the context, tools and settings |
| `host/runtime/model` | `request` (a ModelRequest), `stepId` | an assistant message, from the turn's model. The host runs the Provider's hook points. Pieces stream to the Runtime as the notification `host/runtime/modelEvent { parentRequestId, event }`, where `parentRequestId` is this request's id. A model's failure is a result with `stop: "failed"`. |
| `host/runtime/hook` | `hook`, `payload` | the combined answer, by the hook point's rule: observe `null`; gate `{ value, refused?, pending? }`, where `value` is the whole payload as the handlers left it, and `refused` and `pending` are the reasons, as strings; transform the payload; first answer the answer or `null`; collect a list. Only for the Runtime's own hook points: `turn.start`, `step.after`, `tool.before`, `tool.after`, `model.failed`, `turn.result` and `turn.end`. The host adds `sessionId` and `turnId`. `turn.end` is the Runtime's last request in a turn, before it answers with the outcome, so its observers may not find `turnEnd` in the history yet. |
| `host/runtime/definition` | `toolName` | a ToolDefinition, or `null` |
| `host/runtime/runToolCall` | `call` (a ToolCall) | a ToolResult, or `{ callId, pending }` for a call left open. The host runs the tool and records its start. "Before a tool call" is the Runtime's to run, through `host/runtime/hook`, before it asks. |
| `host/runtime/record` | `entry`: an entry without `id`, `parentId`, `sessionId`, `time` or `turnId` | the recorded entry. The host adds those fields. |
| `host/runtime/takeSteering` | | `{ entries }`: input given for the running turn, now recorded |
| `host/runtime/hasSteering` | | `{ waiting: boolean }` |
| `host/runtime/report` | `type`, `data`, `stepId?`, `toolCallId?` | a notification, never a request: an event of the Runtime's own, which the host may pass on as it is |

`host/runtime/*` requests about a turn the host already has the outcome of are refused with `invalid_request`.

**The host emits the standard events about a turn itself,** since everything they describe passes through it:
- streamed model output, as `host/runtime/model` streams;
- a step starting, at `host/runtime/prepareStep`;
- tool calls starting, progressing and ending, as it runs them;
- every recorded entry.

A Runtime doesn't report these, and a host ignores a report that duplicates one. A host never depends on a report: a Runtime that sends none loses nothing. Interfaces then show a turn the same way whichever language its Runtime is written in.

## The host asks a command

`command/run { name, args, sessionId, actorId }` returns `{ "output"?: string }`.

## What a plugin may ask the host

Every request below names its session, directly or through `parentRequestId`.

| Request | Params | Result |
|---|---|---|
| `host/ask` | `parentRequestId`, `request` | an Answer |
| `host/env/*` | see [the working environment](#the-host-asks-the-working-environment) | |
| `host/hook` | `parentRequestId`, `hook`, `payload` | the combined result: the transformed payload, `{ refused }`, the collected list, or the first answer. Only for hook points this plugin's capability owns: "before a model request" and "as the response arrives" for a Provider. |
| `host/credentials/read` | `provider` | `{ "credential": Credential | null }`, only for a Provider this plugin registered |
| `host/history` | `sessionId`; `parentRequestId` *(optional)*; `after` *(optional)*; `limit` *(optional)*; `all` *(optional)* | `{ "entries": [entry], "next"?: id }`: the current branch, or with `all` every entry, in pages of at most `limit` (a whole number from 1 to 500; 500 if left out) entries and 4 MiB. Read only when the plugin asks; the host never pushes history. Raw, not gated: plugins may read the raw record. |
| `host/session` | `sessionId` | `{ id, project, settings, busy, actors }` |
| `host/declaration` | `sessionId` *(optional)* | the declaration, as in the [ACP binding](acp.md#the-declaration) |
| `host/emit` | `sessionId`, `type`, `data` | a notification: an event of the plugin's own |
| `host/problem` | `where`, `message` | a notification: a problem the plugin carried on past |

**Paging history.** `after` is an entry id; the page starts with the entry after it. `next` is the id of the page's last entry, given only when more remain, so the plugin passes it as `after` for the next page. An `after` that isn't in the list asked for is refused with `invalid_request`. An entry is never split or skipped: one that alone is over 4 MiB gives `result_too_large`.

**Authority.** A request whose authority, session or ownership doesn't hold is refused with `invalid_request`.
- **Requests that need a parent:** `host/ask`, `host/env/*`, `host/hook` and `host/runtime/*`. They act with the authority of the work behind the parent, never more, and only in its session. `host/hook` also needs the parent to be a request to the Provider whose hook points it runs.
- **Requests that may name a session directly:** `host/history`, `host/session` and `host/emit`. The session must be open in the host, with this plugin loaded. They read or report; they never act. With a `parentRequestId`, they belong to that work, as a Runtime's `host/history` does.
- **Requests about no session:** `host/declaration` without a `sessionId`, `host/credentials/read` and `host/problem`.

## Choosing plugins at start

A build reads the environment variable `MODULAR_AGENT_PLUGINS` when it starts. It holds a JSON array of plugins to start:

```json
[ { "command": ["/path/to/program", "arg"], "env": { "NAME": "value" }, "config": { } } ]
```

Each is started with its `env` added to the host's environment, then initialized, in order, after the host's own plugins. A build may offer its own way to choose plugins too.

## The conformance plugin

Every build can serve a conformance plugin, from a command it documents. It is used to test hosts and plugins across languages.

The environment variable `MODULAR_AGENT_PLUGIN_PARTS` chooses its parts. It is a comma-separated list from `provider`, `tools`, `environment`, `hooks`, `runtime` and `durable-runtime`. The default is the first four. `runtime` and `durable-runtime` are never served together:

| Part | Registers | Replaces |
|---|---|---|
| `provider` | Provider `conformance`, model `echo`, exactly as in the [ACP binding's conformance mode](acp.md#conformance-mode) | `provider:conformance` |
| `tools` | tool source `conformance-tools`, with `bash` (`{ command }`, using `host/env/exec`) and `read` (`{ path }`, using `host/env/read`); results as the build's own tools give them | `tool:bash`, `tool:read` |
| `environment` | a working environment on the local machine, with its true `containment`. It keeps each session's background processes until `env/sessionEnded` for that session. | `working-environment` |
| `runtime` | the build's transient Runtime | `runtime` |
| `durable-runtime` | the build's durable Runtime. It recovers a turn from the standard kinds alone, whatever wrote them. | `runtime` |
| `hooks` | a `tool.before` gate that refuses, with the reason `refused by the conformance plugin`, any call whose input, as JSON, contains `conformance-forbidden`; and a `turn.before` collect that contributes `{ "system": "The conformance plugin is loaded." }` | nothing |

`tools` uses `host/env/*`, never its own environment. So tools from one build run commands in another build's working environment, under a third build's Harness.

## Changes

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

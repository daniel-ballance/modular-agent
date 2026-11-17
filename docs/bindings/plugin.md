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
- **A plugin's request about a host request** carries `parentRequestId`: the id of the host request it belongs to. The host uses it to find the session, the actor and the authority. It also uses it to cancel the plugin's request when the parent request is cancelled.
- **Cancelling:** either side sends the notification `$/cancel { id }` for a request it sent. The receiver stops the work, and still answers: a result, or the error `cancelled`. That holds for the host's answers to `host/*` requests as much as for a plugin's. Cancelling never claims an outside effect was undone.
- **Heartbeat:** either side may send `$/ping`. The answer is `{}`. Work has no timeout of its own; the caller's cancelling owns it.
- **Limits:** a message is at most 64 MiB. A result that would be larger is replaced by the error `result_too_large`.
- **Errors** are JSON-RPC errors whose `data` is `{ "code": "<code>" }`. The codes:
  - `invalid_request`;
  - `not_found`: a file the request names doesn't exist;
  - `unknown_handler`;
  - `cancelled`;
  - `not_supported`;
  - `result_too_large`;
  - `lost`: a part this request needed was lost;
  - `internal`.
- **Ending:** the host sends `plugin/shutdown { reason }`, where the reason is `stop` or `reload`, waits for the answer, then closes the plugin's stdin. A plugin exits when its stdin closes, whatever else it is doing. Whatever it started stops with it, as the working environment's rule requires.
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
- **`replaces`** names what the host leaves out of its own plugins in favour of this one: `runtime`, `working-environment`, `provider:<id>`, `tool:<name>` or `command:<name>`. A plugin that registers a `runtime` replaces `runtime`, since a session has only one. Without it, a name the host already has is refused, as [never shadowed](../contracts.md#plugins-and-capabilities) requires. A plugin that replaces nothing adds to the host.
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
| `provider/discard` | `provider`, `sessionId` | `{}`. For a Provider that keeps state ([Provider state](../contracts.md#provider-state)). |

- **The response streams** as notifications `provider/event { parentRequestId, event }`, all before the result.
- **A model's failure is a result, not an error:** an assistant message with `stop: "failed"` and an `error`.
- **The Provider plugin runs its own hook points,** "before a model request" and "as the response arrives". It does so through `host/hook` (below), because the host owns the handlers.
- **Credentials:** a Provider plugin reads them with `host/credentials/read { provider }`, which returns `{ "credential": object | null }`. The host checks that the plugin registered that provider. The Runtime never sees them.

## The host asks the working environment

Every request carries `cwd`: the session's project, or a folder in it.

| Request | Params | Result |
|---|---|---|
| `env/read` | `cwd`, `path` | `{ "data": "<base64>" }` |
| `env/write` | `cwd`, `path`, `data` (base64) | `{}` |
| `env/exists` | `cwd`, `path` | `{ "exists": boolean }` |
| `env/exec` | `cwd`, `command`, `timeoutMs` *(optional)* | an ExecResult. `timeoutMs` is a positive number of milliseconds. A sender leaves it out for no limit, and a receiver treats `0` the same as leaving it out. When it passes, the command is stopped and the result has `timedOut: true`. |

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
| `tool.before` | gate | `{ sessionId, turnId?, call: ToolCall, definition: ToolDefinition }` | `change` is `{ call }` |
| `tool.after` | transform | `{ sessionId, call, result: ToolResult }` | the same shape |
| `model.failed` | first answer | `{ sessionId, request, error }` | `{ retry: true, request? }` |
| `turn.result` | gate | `{ sessionId, turnId, result: { text?, value? }, shape? }` | a refusal sends the model back with the reason |
| `turn.end` | observe | `{ sessionId, turnId, outcome }` | |
| `provider.request` | transform | `{ sessionId, provider, model, request }` | the same shape |
| `provider.response` | observe | `{ sessionId, provider, model, message }` | |

- **Handlers for hook points a plugin defines** use the same message, with that hook point's own name and rule.
- **"Before output reaches a recipient" is not offered** to a plugin in another process in `/1`. Its handlers hold streamed pieces per recipient, which would cost a round trip per piece. A host refuses a registration for it with `not_supported`.

## The host asks the Runtime

A turn is one request from the host. The Runtime runs it, asking the host for what it needs through `host/runtime/*`, with the turn's request id as `parentRequestId`. It also reads the session's history with `host/history`, for example to rebuild its own records after a restart. Those two are all it uses. It never chooses the model, never sees credentials and never runs a tool itself ([Contracts](../contracts.md#harness-and-runtime)).

| Request | Params | Result |
|---|---|---|
| `runtime/runTurn` | `turn` | a TurnOutcome |
| `runtime/resumeTurn` | `turn`; `interrupted`: `{ turnId, calls }` | a TurnOutcome. The host sends it on reopening a session with a turn whose process stopped. A transient Runtime ends the turn; a durable one carries on. Every pending call ends with exactly one result. |
| `runtime/continueOpenCalls` | `turn`; `calls` | a TurnOutcome. The host sends it when every question behind calls left open past an earlier turn has its answer. |

- **`turn`** is `{ sessionId, turnId, startedBy, model: ModelInfo, modelSupports, settings: { maxSteps?, reasoning?, maxOutput? }, resultShape? }`. `startedBy` is as on a `turnStart` entry. `modelSupports` is the Provider's `supports`.
- **Each of `calls`** is `{ id, name, input, stepId?, started }`. `started` says whether the call's start was recorded.
- **A TurnOutcome** is `{ outcome, result: { text?, value?, openToolCalls }, entries, usage }`. `outcome` is as on a `turnEnd` entry, and `entries` lists the ids of the entries the turn recorded.
- **Cancelling:** the host cancels a turn with `$/cancel` on its request. The Runtime stops at the next safe point, cancels what it asked the host for, records a result for every started call, and answers with outcome `cancelled`.
- **The Runtime's state lives in the history.** Whatever it needs after a restart, it records through `host/runtime/record`, and reads back with `host/history`. After a restart, the host starts the Runtime plugin's process again and sends `runtime/resumeTurn`. Nothing in the old process survives, so nothing can be relied on there.

**What the Runtime asks the host.** Every request carries `parentRequestId`, the turn's request id.

| Request | Params | Result |
|---|---|---|
| `host/runtime/newId` | | `{ id }` |
| `host/runtime/prepareStep` | `stepId`, `usage` | the ModelRequest for this step, after "before each step": the context, tools and settings |
| `host/runtime/model` | `request` (a ModelRequest), `stepId` | an assistant message, from the turn's model. The host runs the Provider's hook points. Pieces stream to the Runtime as the notification `host/runtime/modelEvent { parentRequestId, event }`, where `parentRequestId` is this request's id. A model's failure is a result with `stop: "failed"`. |
| `host/runtime/hook` | `hook`, `payload` | the combined answer, by the hook point's rule: observe `null`; gate `{ value, refused?, pending? }`; transform the payload; first answer the answer or `null`; collect a list. Only for the Runtime's own hook points: `turn.start`, `step.after`, `tool.before`, `tool.after`, `model.failed`, `turn.result` and `turn.end`. The host adds `sessionId` and `turnId`. |
| `host/runtime/definition` | `toolName` | a ToolDefinition, or `null` |
| `host/runtime/runToolCall` | `call` (a ToolCall) | a ToolResult, or `{ callId, pending }` for a call left open. The host runs the tool and records its start. "Before a tool call" is the Runtime's to run, through `host/runtime/hook`, before it asks. |
| `host/runtime/record` | `entry`: an entry without `id`, `parentId`, `sessionId`, `time` or `turnId` | the recorded entry. The host adds those fields. |
| `host/runtime/takeSteering` | | `{ entries }`: input given for the running turn, now recorded |
| `host/runtime/hasSteering` | | `{ waiting: boolean }` |
| `host/runtime/report` | `type`, `data`, `stepId?`, `toolCallId?` | a notification: an event of the Runtime's own, which the host passes on as it is |

`host/runtime/*` requests about a turn that has ended are refused with `invalid_request`.

**The host emits the standard events about a turn itself,** since everything they describe passes through it:
- streamed model output, as `host/runtime/model` streams;
- a step starting, at `host/runtime/prepareStep`;
- tool calls starting, progressing and ending, as it runs them;
- every recorded entry.

A Runtime doesn't report these, and a host ignores a report that duplicates one. Interfaces then show a turn the same way whichever language its Runtime is written in.

## The host asks a command

`command/run { name, args, sessionId, actorId }` returns `{ "output"?: string }`.

## What a plugin may ask the host

Every request below names its session, directly or through `parentRequestId`.

| Request | Params | Result |
|---|---|---|
| `host/ask` | `parentRequestId`, `request` | an Answer |
| `host/env/*` | see [the working environment](#the-host-asks-the-working-environment) | |
| `host/hook` | `parentRequestId`, `hook`, `payload` | the combined result: the transformed payload, `{ refused }`, the collected list, or the first answer. Only for hook points this plugin's capability owns: "before a model request" and "as the response arrives" for a Provider. |
| `host/credentials/read` | `provider` | `{ "credential": object | null }` |
| `host/history` | `sessionId`; `after` *(optional)*; `limit` *(optional)*; `all` *(optional)* | `{ "entries": [entry], "next"?: id }`: the current branch, or with `all` every entry, in pages of at most `limit` (default 500) entries and 4 MiB. Read only when the plugin asks; the host never pushes history. Raw, not gated: plugins may read the raw record. |
| `host/session` | `sessionId` | `{ id, project, settings, busy, actors }` |
| `host/declaration` | `sessionId` *(optional)* | the declaration, as in the [ACP binding](acp.md#the-declaration) |
| `host/emit` | `sessionId`, `type`, `data` | a notification: an event of the plugin's own |
| `host/problem` | `where`, `message` | a notification: a problem the plugin carried on past |

A request whose authority, session or ownership doesn't hold is refused with `invalid_request`. A plugin asks with the authority of the work behind its `parentRequestId`, never more.

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
| `environment` | a working environment on the local machine, with its true `containment` | `working-environment` |
| `runtime` | the build's transient Runtime | `runtime` |
| `durable-runtime` | the build's durable Runtime | `runtime` |
| `hooks` | a `tool.before` gate that refuses, with the reason `refused by the conformance plugin`, any call whose input, as JSON, contains `conformance-forbidden`; and a `turn.before` collect that contributes `{ "system": "The conformance plugin is loaded." }` | nothing |

`tools` uses `host/env/*`, never its own environment. So tools from one build run commands in another build's working environment, under a third build's Harness.

## Changes

- **2026-11-17, after the Runtime matrix.** A Runtime reads history with `host/history`, which Go's durable Runtime needed to recover and Python's host refused. Rust (B-18) and Python (G58) had both logged the gap. And a host answers a cancelled `host/*` request too: the Rust host left one unanswered, so a cancel that landed during a hook stalled the turn until a timer fired.
- **2026-11-17, after the first Runtime swaps.** The host emits the standard turn events itself, and `host/runtime/model` carries `stepId`. Go's Runtime reported streamed text as `model.delta`, and the TypeScript host expected `model.output`, so a TypeScript agent running Go's Runtime showed the client no streamed text. The host sees the stream anyway, so nothing needed naming.
- **2026-11-17.** Stage 2: the Runtime. `runtime/runTurn`, `runtime/resumeTurn` and `runtime/continueOpenCalls`, the Runtime host as `host/runtime/*`, and the conformance parts `runtime` and `durable-runtime`.
- **2026-11-17.** First version, stage 1.
- **2026-11-17, after the four-language matrix.** A missing file is `not_found`. Every environment reported it as `internal`, in its own language's words, and the Python host told it apart by looking for the text "No such file". That worked with Rust's and Python's environments, and failed every turn with Go's and TypeScript's.
- **2026-11-17, after the first swap matrix.** `timeoutMs: 0` means no limit. Go sent `0` for no limit and Rust read it as an instant timeout, so a Rust host with Go's tools, and a Go host with Rust's tools, cancelled every command at once. Each build passed on its own; only the swap found it. The plugin kit now checks both readings.

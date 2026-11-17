# Plugin binding: `modular-agent-plugin/1`

How a Harness hosts a plugin that runs as a separate program, in any language. The binding turns the [interactions in Contracts](../contracts.md#interactions) into messages: what the Harness asks a tool source, a Provider or a working environment, and what a hook handler is given and may answer. A plugin is never sent a build's own plugin API, only these messages. So a plugin written once runs under any build that follows the binding, and one build's plugins run under any other.

All data uses the [shared data](data.md) shapes.

**Stage 1** (this version) covers:
- tool sources;
- Providers;
- the working environment;
- handlers at the standard hook points;
- commands.

The Runtime follows in stage 2. History, credential and configuration stores are not hosted this way: history has [its own binding](history-http.md), and the other two hold secrets or are trivial.

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
- **Cancelling:** either side sends the notification `$/cancel { id }` for a request it sent. The receiver stops the work, and still answers: a result, or the error `cancelled`. Cancelling never claims an outside effect was undone.
- **Heartbeat:** either side may send `$/ping`. The answer is `{}`. Work has no timeout of its own; the caller's cancelling owns it.
- **Limits:** a message is at most 64 MiB. A result that would be larger is replaced by the error `result_too_large`.
- **Errors** are JSON-RPC errors whose `data` is `{ "code": "<code>" }`. The codes:
  - `invalid_request`;
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
  "replaces": [ "provider:conformance", "tool:bash", "working-environment" ]
}
```

- **Every field but `binding` and `name` is optional.** A binding the plugin can't speak gets the error `not_supported`.
- **`order`** is `first`, `normal` or `last`, as in [Hook points](../contracts.md#hook-points).
- **`replaces`** names what the host leaves out of its own plugins in favour of this one: `working-environment`, `provider:<id>`, `tool:<name>` or `command:<name>`. Without it, a name the host already has is refused, as [never shadowed](../contracts.md#plugins-and-capabilities) requires. A plugin that replaces nothing adds to the host.
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
| `env/exec` | `cwd`, `command`, `timeoutMs` *(optional)* | an ExecResult |

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

The environment variable `MODULAR_AGENT_PLUGIN_PARTS` chooses its parts. It is a comma-separated list from `provider`, `tools`, `environment` and `hooks`, and the default is all four:

| Part | Registers | Replaces |
|---|---|---|
| `provider` | Provider `conformance`, model `echo`, exactly as in the [ACP binding's conformance mode](acp.md#conformance-mode) | `provider:conformance` |
| `tools` | tool source `conformance-tools`, with `bash` (`{ command }`, using `host/env/exec`) and `read` (`{ path }`, using `host/env/read`); results as the build's own tools give them | `tool:bash`, `tool:read` |
| `environment` | a working environment on the local machine, with its true `containment` | `working-environment` |
| `hooks` | a `tool.before` gate that refuses, with the reason `refused by the conformance plugin`, any call whose input, as JSON, contains `conformance-forbidden`; and a `turn.before` collect that contributes `{ "system": "The conformance plugin is loaded." }` | nothing |

`tools` uses `host/env/*`, never its own environment. So tools from one build run commands in another build's working environment, under a third build's Harness.

## Changes

- **2026-11-17.** First version, stage 1.

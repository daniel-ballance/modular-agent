# Placement and durability

Two choices are made when an agent is put together, never in a plugin's code: where each part runs, and what survives a crash. This page sets out the choices, how a developer makes them, and what each one guarantees.

## The matrix

| Part | In the agent's process | In its own process | As a service |
|---|---|---|---|
| Tools and tool sources | yes | yes | needs a binding |
| Providers | yes | yes, request and response only | needs a binding |
| Hook handlers | yes | yes, for the [points the wire carries](api.md#hooks) | needs a binding |
| Commands | yes | yes | needs a binding |
| Working environment | yes | yes | needs a binding |
| Runtime | yes | yes | needs a binding |
| History store | yes | no | yes, the [history service](../bindings/history-http.md) |
| Credential store, configuration | yes | no | no |
| Interfaces | yes | no | no |
| The whole agent | embedded in an app | driven over [ACP](../bindings/acp.md) on stdio | needs a binding |

"In its own process" means the [plugin binding](../bindings/plugin.md): the agent starts the plugin as a child process and speaks JSON-RPC over its stdio. The two sides can be in different languages.

## A part in the agent's process

The default. A plugin passed to `createAgent` runs in the agent's process and is called directly. It is the fastest placement and the only one for in-process-only features.

Process separation is not a sandbox. A plugin in another process still runs with the agent's permissions ([Security](../security.md#plugins)). Moving a plugin out of process isolates crashes, not authority.

## A plugin in another process

A plugin moves into its own process without changing its code:

1. **Serve it.** A plugin program's entry point calls `serve(plugin)`. That one call speaks the binding on stdio: it answers the handshake with the plugin's registration, routes requests to its tools, Provider, hooks and the rest, and passes each request's context through as host callbacks. `serve` refuses an [in-process-only plugin](api.md#plugins) with `not_supported`.
2. **Load it.** The agent names the program in `processPlugins`: `{ command: ["python", "tides.py"], env?, config? }`. The command is an argument vector, never a shell line. The program can be written with any SDK, or without one.

Giving `processPlugins` makes the agent a plugin host. The agent loads its own plugins first, then `processPlugins` in order, then the programs in `MODULAR_AGENT_PLUGINS`, and validates each registration before enabling it. If a program fails to start or its registration is refused, `createAgent` fails ([Choosing plugins at start](../bindings/plugin.md#choosing-plugins-at-start)). A child process starts with the minimal environment the binding requires, plus the `env` the developer approved; it does not inherit the agent's.

A plugin host MUST read `MODULAR_AGENT_PLUGINS` at startup, as the binding requires. An embedded agent is not a plugin host by default: a library should not start programs named in its environment unless the app asks. An agent becomes one when the app gives `processPlugins` or sets `pluginHost: true`, and then reads the variable too. An agent that loads plugin programs is a plugin host, so `pluginHost: false` together with `processPlugins` is contradictory and raises `invalid_composition`. A program that claims the plugin-host role, such as an agent served over ACP, sets `pluginHost: true`.

If a plugin's process is lost while the agent runs, the agent treats the part as [lost](../contracts.md#parts-that-are-lost) and [settles](../contracts.md#settlement) its calls. A call that may have been dispatched is `outcomeUnknown`. A call abandoned before dispatch is `notStarted`. Neither is repeated except under the repeat rule below.

## Services

The history store is the only part with a service binding today:

- `serveHistory(store, { address, tokenFile })` serves a history store as the [history service](../bindings/history-http.md), if the store can keep the binding's promises: opaque JSON records committed durably, exact batch and tombstone behavior, and writer leases. It refuses any other store with `not_supported`, naming it, rather than substituting another backend. The memory store can be served only for tests, where losing everything on restart is acceptable; a build that does not offer that says so. Plain HTTP is served only on loopback.
- `httpHistory(url, tokenFile)` is a history store that uses one.

Agents in any language that share a history service and the same actor ids can reopen and continue each other's [portable sessions](../bindings/data.md#portable-sessions).

The other parts have no service binding yet. [ADR 0015](../adr/0015-parts-as-services.md) ran a working environment and a model gateway as services with private APIs, and they worked, but private APIs are not a placement the SDK can promise in four languages. The SDK offers service placement for a part only once the specification has a binding for it. That is a change to layer 1, made first.

## The whole agent

- **Embedded.** The app holds the Agent and calls it.
- **Over ACP.** `agent.serveAcp()` serves the agent on stdio. Any ACP client can drive it: an editor, T3 Code, or another agent. The ACP Interface authenticates the connection's actor ([ACP Authorization](../bindings/acp.md#authorization)).

## Durability

One option, `durability`, sets what survives the agent's process ending:

| `durability` | History | Runtime | After a crash or restart |
|---|---|---|---|
| `ephemeral` (default) | memory | transient | Nothing survives. Sessions end with the process. |
| `kept` | files under `dataDir`, or a history service | transient | Sessions reopen with their history. An interrupted turn ends `failed`. |
| `durable` | files under `dataDir`, or a history service | durable | An interrupted turn carries on when the session reopens. |

In both `kept` and `durable`, reopening follows the [recovery rules](../contracts.md#recovery-and-repeating-work):

- **A tool call that started and has no result** is repeated only when all of these hold: its registration is identical to the recorded one; the tool and the working environment both promised it is safe to repeat, then and now; and cleanup of the first attempt is confirmed. Read-only and containment alone are not enough. Otherwise it is settled `outcomeUnknown`.
- **A call that never started** is settled `notStarted`, or dispatched afresh if it is still eligible.
- **A model request** is repeated only as the same final request, from a Provider that declared it safe to repeat then and now.

The scenarios check this with a real `kill -9`.

`history` and `runtime` can still be given explicitly, for example a history service with `kept`. The agent checks the combination and raises `invalid_composition` for one that cannot keep its promise:

- a durable Runtime with history in memory;
- `kept` or `durable` with no persistent history store: files under `dataDir` by default, or an explicit one such as `httpHistory`;
- a part that keeps local recovery bookkeeping, such as the local working environment's record of running commands, with no `dataDir` to keep it in;
- a Runtime that does not declare `continuesAfterRestart` under `durable`.

The agent's [declaration](../contracts.md#declaration) states what it chose, so a client knows whether to expect a turn to continue after a restart.

## What placement must not change

Moving a part changes how fast it is and what happens when its process dies. It MUST NOT change the part's behavior otherwise: the same plugin, given the same requests, produces the same records and results in any placement. The [shared scenarios](testing.md#the-shared-scenarios) run every scenario with the fixture plugins in process, served by the same SDK, and served by each other SDK, and compare the results.

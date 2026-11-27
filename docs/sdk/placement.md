# Placement and durability

Two choices are made when an agent is put together, never in a plugin's code: where each part runs, and what survives a crash. This page sets out the choices, how a developer makes them, and what each one guarantees.

## The matrix

| Part | In the agent's process | In its own process | As a service |
|---|---|---|---|
| Tools and tool sources | yes | yes | yes |
| Providers | yes | yes, request and response only | yes, request and response only |
| Hook handlers | yes | yes, for the [points the wire carries](api.md#hooks) | yes, the same points |
| Commands | yes | yes, unless they use a model or ask questions | yes, with the same limits |
| Working environment | yes | yes | yes, where the service sees the same project path |
| Runtime | yes | yes | yes |
| History store | yes | no | yes, the [history service](../bindings/history-http.md) |
| Credential store, configuration | yes | no | no |
| Interfaces | yes | no | no |
| The whole agent | embedded in an app | driven over [ACP](../bindings/acp.md) on stdio | ACP on WebSocket; [AG-UI](../bindings/agui.md) on HTTP and SSE |

"In its own process" means the [plugin binding](../bindings/plugin.md): the agent starts the plugin as a child process and speaks JSON-RPC over its stdio. "As a service" means the same binding over the [WebSocket transport](../bindings/websocket.md): the plugin listens, and the agent connects to it. In both, the two sides can be in different languages.

## A part in the agent's process

The default. A plugin passed to `createAgent` runs in the agent's process and is called directly. It is the fastest placement and the only one for in-process-only features.

Process separation is not a sandbox. A plugin in another process still runs with the agent's permissions ([Security](../security.md#plugins)). Moving a plugin out of process isolates crashes, not authority.

## A plugin in another process

A plugin moves into its own process without changing its code:

1. **Serve it.** A plugin program's entry point calls `serve(plugin)`. That one call speaks the binding on stdio: it answers the handshake with the plugin's registration, routes requests to its tools, Provider, hooks and the rest, and passes each request's context through as host callbacks. `serve` refuses an [in-process-only plugin](api.md#plugins) with `not_supported`.
2. **Load it.** The agent names the program in `processPlugins`: `{ command: ["/usr/bin/node", "/srv/tides/tides.js"], env?, config? }`. The command is an argument vector, never a shell line. The program can be written with any SDK, or without one.

A child process starts with the minimal environment the binding requires, plus the `env` the developer approved; it does not inherit the agent's. Trace context crosses this boundary only on trusted [work operations](../telemetry.md#context-on-the-wire). A plugin that exports spans installs its own OpenTelemetry SDK and exporter. Starting it does not copy the host's exporter settings.

A nonempty `processPlugins` or `servicePlugins` list enables plugin hosting. An embedded agent with neither can opt in with `pluginHost: true`. An explicit `pluginHost: false` with either nonempty list raises `invalid_composition`. A program that claims the plugin-host role, such as an agent served over ACP, enables plugin hosting even if it has no explicit lists.

The host loads in-process plugins, then `processPlugins`, then `servicePlugins`, then the entries in `MODULAR_AGENT_PLUGINS`. It MUST read that variable at startup and load each list in order, validating each registration before enabling it. A configured plugin that cannot start, connect, initialize or register fails composition; see [Choosing plugins at start](../bindings/plugin.md#choosing-plugins-at-start) and [Choosing plugin services at start](../bindings/websocket.md#choosing-plugin-services-at-start).

If a plugin's process is lost while the agent runs, the agent treats the part as [lost](../contracts.md#parts-that-are-lost) and [settles](../contracts.md#settlement) its calls. A call that may have been dispatched is `outcomeUnknown`. A call abandoned before dispatch is `notStarted`. Neither is repeated except under the repeat rule below.

## Services

A plugin moves to a service without changing its code, as it moves to its own process. The same plugin value is served three ways: in the agent's process, as a program on stdio, or as a service on a WebSocket ([WebSocket transport](../bindings/websocket.md)).

1. **Serve it.** `serve(plugin, { listen, tokenFile, tls? })` listens on `listen`, an address such as `127.0.0.1:7401`, and serves each authenticated connection as a separate plugin instance. `tokenFile` holds the token clients must present. Without `tls: { certFile, keyFile }` it refuses any address that is not loopback. Port `0` picks a free port. Once it accepts connections, it returns a server with `url`, the `ws:` or `wss:` URL clients connect to, and `close()`, which stops accepting, closes each open connection and returns when their plugin instances have stopped. `serve(plugin)` with no options keeps serving on stdio.
2. **Load it.** The agent names the service in `servicePlugins`: `{ url, tokenFile, config? }`, with a `ws:` or `wss:` URL. A service can also be named in `MODULAR_AGENT_PLUGINS`.

Run registration once per connection, after receiving that connection's configuration. Allocate connection-local mutable state there. SDKs can also take a factory that supplies a fresh plugin for each connection; use one if the plugin captures mutable state outside setup. See [Languages](languages.md).

When the connection drops, the agent treats the part as [lost](../contracts.md#parts-that-are-lost), as it does when a plugin process exits. A served working environment stops the commands that connection started.

The history store has its own service binding:

- `serveHistory(store, { address, tokenFile, leaseTtl? })` serves a history store as the [history service](../bindings/history-http.md), if the store can keep the binding's promises. `leaseTtl` is the writer lease the service declares as `ttlMs`: 15 seconds unless set, at least 1 millisecond. A longer lease lets a writer ride out a stall of up to a sixth of it, since it renews by a third and is lost at half; a shorter one lets another agent take over a crashed writer's session sooner, after the lease plus one second. As with `serve`, port `0` picks a free port, and once it accepts connections it returns a server with `url`, the base URL clients use, and `close()`, which stops accepting connections and returns when the open ones have ended. The adapter preserves opaque JSON, durable commits, equality on append, filtered session lists, writer leases and erasure by tombstone. It refuses any other store with `not_supported`, naming it, rather than substituting another backend. A volatile memory store cannot be served as a conforming history service, since the binding requires entries to survive a restart; a build may offer a test-only in-memory service that is labelled as not conforming. A file store may serve from a separate namespace of opaque records rather than its native sessions; the SDK documents which, and whether existing native sessions can be opened through the service. Plain HTTP is served only on loopback.
- `httpHistory(url, tokenFile)` is a history store that uses one. It discovers the [pending-erasure registry profile](../bindings/history-http.md#pending-erasure-registry-profile-pendingerasure-1) from `GET /v1`.

In Rust and TypeScript, the HTTP adapter dispatches custom-store calls on separate connections independently. A renewal reaches the custom store while another session's storage call is suspended. The custom store owns the lease state and the atomic commit boundary. To keep renewal independent of another session's storage work, the store must yield during slow I/O and keep locks and queues shared with renewal out of that work. The store validates the current lease when it commits a leased mutation.

A history service credential has raw access to the whole service. Use [separate services and storage](../bindings/history-http.md#the-basics) when writers must be isolated.

Agents in any language that share a history service and the same actor ids can reopen and continue each other's [portable sessions](../bindings/data.md#portable-sessions).

### Serving named callers

[ADR 0035](../adr/0035-host-limits-from-the-ops-desk.md) adds `serve(factory, { listen, callers, tls? })` for a plugin service. `callers` is a nonempty operator list of `{ callerId, tokenFile }`. Each `callerId` is a nonempty, case-sensitive string. The token files must be readable only by their owner, as in the [WebSocket rules](../bindings/websocket.md#connecting). This form requires a factory. Reject a missing factory, empty list or ID, unsafe or unreadable file, duplicate ID or duplicate token value, even in different files. Reject options with both `callers` and `tokenFile`. These are `invalid_composition` errors before listening.

On each successful upgrade, call `factory({ callerId })` with the ID from the matched entry, never the token. The factory can bind the desk's `post` handler to that caller and select its storage and project limits. Run setup on the fresh instance; `plugin/initialize.config` cannot replace the ID. The operator can rotate a credential by replacing its file and restarting the listener with the same ID for the same caller. There is no live reassignment of an instance. The single-token form and its existing factories still work. Stdio and the agent's `{ url, tokenFile, config? }` load entry do not change.

## The whole agent

- **Embedded.** The app holds the Agent and calls it.
- **Over ACP.** `agent.serveAcp()` serves the agent on stdio. Any ACP client can drive it: an editor, T3 Code, or another agent. The ACP Interface authenticates the connection's actor ([ACP Authorization](../bindings/acp.md#authorization)).
- **As a service.** `agent.serveAcp({ listen, actors, tls? })` serves ACP on a WebSocket. `actors` lists, for each token file, the actor its connections act as: `{ tokenFile, actor: { id, kind, rights }, tenants?, projects?, represents? }`. A connection presenting no listed token is refused. The token, not anything the client sends, decides the actor ([WebSocket transport](../bindings/websocket.md#an-agent-service)). Once ready, the listener returns `url` and `close()`. Closing it stops accepting connections and closes the existing ones.

Omit `tenants` to allow only sessions without a tenant. Include `null` in an explicit `tenants` list to allow such sessions. `projects` matches exact canonical project paths, not subdirectories. Omit it to use the serving composition's project scope. An empty list permits nothing in its scope. At connection time the service intersects the token's rights with the actor's recorded grants; it does not rewrite the grants. Session and tenant authority checks still apply. `represents` names additional actors the operator permits the connection to act for; it does not join them. Stdio takes its scope and optional rights ceiling and representation from [operator options](api.md#the-agent).

### Serving AG-UI

Both SDKs implement this binding; the [AG-UI kit](../../conformance/agui/README.md) checks each.

Call `agent.serveAgui({ listen, actors, tls?, tenant?, acp?, origins? })` instead of `serveAcp` when the app speaks AG-UI. Set `acp: true` to serve ACP WebSocket upgrades at the same address. Do not start a second listener on that address. The listener handle has `url` (the HTTP origin) and `close()`. Closing it detaches streams; it does not erase sessions or confirm cancellation of external calls.

Use the same token files and actor entries as for `serveAcp`, adding a distinct `clientId` for each AG-UI client. The agent's project and the operator's optional `tenant` select the creation scope. The token must permit that scope. `origins` is the optional browser origin allowlist. The app makes authenticated requests to the [binding routes](../bindings/agui.md#listener-and-authentication), keeps its history cursor and replaces stale copies from a snapshot. Open the presence stream if the app will answer questions while the turn waits.

To let a client run a tool such as `pick_color`, include its definition in `createAgent({ interfaceTools: [...] })`. Set a unique `sourceId`, the client's configured `actorId`, and `routeId` equal to its AG-UI `clientId`. Set a finite positive `resultTimeoutMs` on each source and `callers: ["model"]` on each definition. Do not pass a tool handler: the Interface is the executor. The SDK rejects a conflicting registration, a nonpositive timeout or an incompatible Runtime at composition. Serving rejects a route that matches a different actor or is ambiguous. The SDK does not register tools from a browser request.

The app advertises an exact subset of the registered definitions for its session. The binding attaches the executor using the authenticated actor, configured route and connection scope. The Harness commits the handoff before the binding can send the executable request on that connection. Disconnect clears the executor's availability without settling the call.

On a live, eligible terminal event the app runs or declines the named calls, then supplies the results in a later run. The app does not execute from replay or use a tool message to approve a call. Another independently authenticated connection for the same actor and route can report the result without advertising tools. For a JSON result, send it as text or use a declared content part; this binding does not fill shared `ToolResult.value`. An application that needs durable result delivery can retain a report under the call ID until it is accepted or expires, subject to its own erasure policy.

To expose [shared state](../bindings/agui.md#shared-state), name the plugin that emits state events and supply a snapshot reader. The reader takes a session ID and returns the plugin's current revision and snapshot, or no snapshot. Do not use the client's input state as the snapshot.

**Host reads ([ADR 0035](../adr/0035-host-limits-from-the-ops-desk.md)).** An app can use the [wait cursor](../bindings/agui.md#wait-closures) from a thread snapshot without holding presence. On kept history it can look up its own [run receipt](../bindings/agui.md#run-receipts) if the snapshot offers it. Neither read changes the answer or handoff API. There is no SDK object for an inbox spanning agents.

## Durability

One option, `durability`, sets what session state survives the agent's process ending. It does not undo effects on files or services:

| `durability` | History | Runtime | After a crash or restart |
|---|---|---|---|
| `ephemeral` (default) | memory | transient | Nothing survives the process. |
| `kept` | files under `dataDir`, or a history service | transient | Sessions reopen with their history. An interrupted turn ends `failed`. |
| `durable` | files under `dataDir`, or a history service | durable | An interrupted turn carries on when the session reopens. |

In both `kept` and `durable`, reopening follows the [recovery rules](../contracts.md#recovery-and-repeating-work):

- **A tool call that started and has no result** is repeated only when all of these hold: its registration is identical to the recorded one; the tool and the working environment both promised it is safe to repeat, then and now; and cleanup of the first attempt is confirmed. Read-only and containment alone are not enough. Otherwise it is settled `outcomeUnknown`.
- **A call that never started** is settled `notStarted`, or dispatched afresh if it is still eligible.
- **A model request** is repeated only as the same final request, from a Provider that declared it safe to repeat then and now.

The scenarios check this with a real `kill -9`.

`history` and `runtime` can still be given explicitly, for example a history service with `kept`. The agent checks the combination and raises `invalid_composition` for one that cannot keep its promise:

- `ephemeral` with an explicit persistent history store or a history service. The error names `kept`; choose `kept` to retain sessions or `durable` to also continue interrupted turns;
- a durable Runtime with history in memory;
- `kept` or `durable` with no persistent history store: files under `dataDir` by default, or an explicit one such as `httpHistory`;
- a part that needs a local directory to keep recovery bookkeeping across restarts, with no `dataDir`. This includes the default local environment under `kept` and `durable`; under `ephemeral` its disposable bookkeeping can go in agent-owned scratch;
- a Runtime that does not declare `continuesAfterRestart` under `durable`.

The agent's [declaration](../contracts.md#declaration) states what it chose, so a client knows whether to expect a turn to continue after a restart.

## What placement must not change

Moving a part changes how fast it is and what happens when its process dies. It MUST NOT change the part's behavior otherwise: the same plugin, given the same requests, produces the same records and results in any placement. The [shared scenarios](testing.md#the-shared-scenarios) run every scenario with the fixture plugins in process, served by the same SDK, and served by each other SDK, and compare the results.

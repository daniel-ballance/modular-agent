---
status: accepted
date: 2026-11-20
---

# Parts and agents as services, over one WebSocket transport

[ADR 0024](0024-five-layers.md) left a gap: only the history store could run as a network service, because only it had a binding. The working environment service and model gateway of [ADR 0015](0015-parts-as-services.md) worked, but over private APIs, which no SDK could offer in four languages. The [placement matrix](../sdk/placement.md#the-matrix) marked every other part "needs a binding".

## Decision

Carry the existing plugin and ACP bindings over WebSocket, unchanged, as the [WebSocket transport](../bindings/websocket.md). The plugin service listens and the host connects; an agent service listens and the ACP client connects. The token in the upgrade request authenticates the connection and, for ACP, decides its actor. Closing the connection takes the place of a process ending.

## Considered options

- **A binding per part, shaped by its capability,** as ADR 0015 did. Each would need its own messages, error mapping and kit, and parts would behave differently in process, over stdio and over the network. Rejected: the plugin binding already says everything a part needs.
- **HTTP requests with server-sent events.** It fits request and response, but the plugin binding is two-way: a tool calls back into its host while the host waits for it. Carrying that over HTTP needs a second channel and correlation; a WebSocket is already one duplex stream, like stdio.
- **gRPC.** It would add a schema and code generation in four languages for messages that are already JSON-RPC.
- **Resuming a dropped connection.** It would need replay buffers and a session identity in the transport. A dropped connection is treated as a lost part, which the specification already handles; a reconnect is a new instance.

## Consequences

- Every part a plugin can provide, and a whole agent over ACP, can now run as a service. The SDKs offer it as a placement: `serve(plugin, { listen })`, plugin services in `MODULAR_AGENT_PLUGINS` and `servicePlugins`, and `serveAcp({ listen })` ([Placement](../sdk/placement.md#services)).
- The plugin and ACP kits gain a mode that connects to a service, so the same checks run over both transports.
- A working environment served over the network must see the host's project path, for example through a shared mount. Remote file systems with their own paths need a mapping this edition does not define.

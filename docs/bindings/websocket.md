# WebSocket transport

This binding carries the [plugin binding](plugin.md) and the [ACP host binding](acp.md) over a network: the same messages, one per WebSocket text message instead of one per line. It is what lets a part, or a whole agent, run as a service. [ADR 0028](../adr/0028-websocket-transport.md) records why.

The same listener can also serve the proposed [AG-UI HTTP binding](agui.md). Its routes are not WebSocket subprotocols.

Everything in the carried binding still applies, except for the transport rules on this page: how peers connect and authenticate, how a message is framed, liveness and what ends a connection.

## Roles

| Carried binding | Listens (server) | Connects (client) |
|---|---|---|
| Plugin, `modular-agent-plugin/1` | the plugin, as a **plugin service** | the host |
| ACP, `modular-agent-acp/1` and `/2` | the agent, as an **agent service** | the ACP client |

A server MAY accept many connections. Each connection is independent, with its own handshake and state: a plugin service serves each host connection as a separate plugin instance, and an agent service serves each client connection as a separate ACP connection.

## Connecting

- The client MUST open a WebSocket ([RFC 6455](https://www.rfc-editor.org/rfc/rfc6455)) to the URL the operator configured, offering the subprotocol `modular-agent-plugin-1` or `modular-agent-acp-1`. The server MUST refuse an upgrade that does not offer the subprotocol it serves, and MUST select it in its response. The ACP binding version is still negotiated in ACP `initialize`.
- The client MUST send `Authorization: Bearer <token>` in the upgrade request. The server MUST authenticate every upgrade as [Security](../security.md#authentication-on-each-wire) requires for network transports: a token of at least 128 bits of entropy compared in constant time, or mutual TLS. It MUST answer an unauthenticated upgrade with HTTP 401 and no WebSocket. Neither peer may log the token or pass it on a command line; operators supply it in a file readable only by its owner.
- Peers MUST use TLS (`wss:`), unless the listener and destination are loopback-only and the operator trusts every local account on the host, in which case `ws:` MAY be used. A server MUST refuse to listen on a non-loopback address without TLS. A client MUST verify the server's identity before sending the token.
- Trace context on the HTTP upgrade, if present, describes only the upgrade. A peer MUST NOT use it as the parent of work on the connection.

## Framing

- Each WebSocket text message carries exactly one JSON-RPC object, encoded as UTF-8 with no byte order mark and no batch. A peer MUST NOT send binary messages; a receiver MUST close on one with status 1003.
- The 64 MiB cap of the carried binding counts the bytes of one message. Receivers MUST bound a message before buffering it whole, and close with status 1009 on an oversized message. The carried binding's rules for oversized results and errors apply unchanged.
- All other message rules of the carried binding apply: ids, cancellation, notifications, ordering and errors. WebSocket ping and pong frames are not `$/ping`.
- Carry optional trace context per message in the [plugin](plugin.md#transport) or [ACP](acp.md#metadata) fields. Use no special frame or URL parameter. Absent or unknown fields leave work unchanged. See [Context on the wire](../telemetry.md#context-on-the-wire).

## Connection lifetime

The connection takes the place of the child process's pipes, and closing it takes the place of the process ending:

- **Loss.** A peer MUST treat a closed connection, a failed TLS session, a missed liveness deadline or any protocol close as the carried binding's connection loss: unanswered work settles once as `lost`, and the host applies [Parts that are lost](../contracts.md#parts-that-are-lost). The server MUST stop the work it started for that connection as the carried binding requires when its peer is lost. There is no resumption: a new connection is a new plugin instance or ACP connection.
- **Plugin liveness.** A plugin service client MUST send `$/ping` when a connection with pending work has been silent for an operator-configured interval, by default 30 seconds. The [plugin binding's](plugin.md#transport) `$/ping` and control deadline apply. WebSocket ping frames MAY also be used; they do not replace the plugin client's `$/ping`.
- **Plugin shutdown.** `plugin/shutdown` ends the plugin instance, not the service. After answering it, the plugin service MUST close the connection with status 1000. Where the stdio binding says a plugin exits on stdin EOF, a plugin service ends that instance when the connection closes.
- **Command lifetime.** A working environment served over this transport MUST treat the end of a host connection as the agent's loss in [Command lifetime](plugin.md#command-lifetime): it stops the commands that connection started within its declared containment.

## A plugin service

- **Instance.** The service MUST scope setup, mutable invocation state, callbacks, request IDs and cancellation to the connection. It MUST NOT route work or callbacks by a bare session, job, call or request ID across connections. Shutdown or loss of one connection MUST NOT stop or transfer another's work.
- **Paths.** `project` and `home` in `plugin/initialize` are the host's paths, not grants. A plugin service that does not use the host's files treats them as names. A working environment MUST serve the same absolute project path in its own file system, for example through a shared mount, or answer `plugin/initialize` with `not_supported`. The service MUST check every file, command and point request against the operator-assigned project reach of that host; it MUST refuse a scope violation with `invalid_request`. The service MUST NOT treat a host path or a point ID as permission to reach another host's resources. The operator MUST supply filesystem and command confinement when hosts must not share those resources.
- **State.** A stateful service MUST choose its storage and scope retained state by authenticated host identity before using names such as `home` or session IDs. Distinct isolated hosts MUST have distinct credentials and non-overlapping state; a shared credential cannot distinguish hosts. A listener that cannot make this distinction MUST serve only one host trust scope. A plugin service MUST NOT infer tenant policy from `/1` payloads. The operator MUST use separately confined instances when the plugin or its external resources cannot isolate the required scopes.
- **Raw reads.** A loaded plugin can read every session open in its host ([Authority](plugin.md#authority)). A host operator MUST treat a plugin service as trusted code with that reach, the same as a child process.

### Proposed named callers

[ADR 0035](../adr/0035-host-limits-from-the-ops-desk.md) proposes an optional operator table on the **plugin listener**. Each entry pairs a token file with a stable, nonsecret caller ID. Authenticate the upgrade under [Connecting](#connecting) before creating a plugin instance or reading `plugin/initialize`. Match one bearer token to one ID, even with TLS client authentication. Reject a missing or unknown token with HTTP 401. Bind the ID to that connection for its lifetime. Reconnect authenticates afresh. No ID or token is added to plugin messages.

The ID identifies a Harness to the service, not an actor in a session. It grants no rights, representation, project or tenant reach. Select the operator-assigned state and project bounds for that ID before using host-supplied names. Keep request IDs, callbacks, cancellations and shutdown local to the connection, even for the same ID. This does not confine trusted plugin code. Use separate confined instances when a service or its resources cannot enforce the separation. Single-token listeners, client configuration and the history service do not change. See the [proposed SDK option](../sdk/placement.md#proposed-serving-named-callers).

## Choosing plugin services at start

Each entry of `MODULAR_AGENT_PLUGINS` is either the stdio form `{ command, env?, config? }` or the network form `{ url: string, tokenFile: string, config?: object }`. `url` is a `ws:` or `wss:` URL; `tokenFile` is an absolute path to a file holding the token. An entry with both `command` and `url` is malformed. The [startup rules](plugin.md#choosing-plugins-at-start) apply to both forms: the host loads entries in array order, and a service it cannot connect to, that refuses the upgrade, or whose registration is refused, fails startup. The host MUST NOT substitute a built-in part for a failed configured one. Trace context requires the [plugin handshake](plugin.md#starting-the-handshake) on each connection, including after reconnect.

## An agent service

- **Liveness.** The agent service MUST accept `$/ping` with params `{}` and return `{}`. This rule applies before and after `initialize`; the request does not change session state. A client MAY use `$/ping` or WebSocket ping frames to check liveness; it need not use both. It MUST apply the five-second default control deadline, configurable by the operator, to the ping it sends and treat a missed deadline as loss. This does not change ACP on stdio.
- **Actors.** The token decides the connection's actor. The operator MUST configure the actor id, kind, rights and scope for each token outside client and project control. The same configuration supplies the list of actors that the connection may [represent](acp.md#several-actors), empty if omitted. `MODULAR_AGENT_ACTOR` does not apply to a network connection.
- **Scope.** If `tenants` is omitted, the token permits only sessions without a tenant. An explicit `tenants` list permits only the named tenants and permits sessions without a tenant only if it includes `null`. An explicit `projects` list matches canonical project paths exactly, not their subdirectories. If `projects` is omitted, the token permits only projects the serving composition serves. Neither list can enlarge what the composition serves. An empty list permits nothing in its scope.
- **Rights.** At connection time the service MUST use the token's rights as a ceiling: for a recorded actor its connection rights are the intersection of the token's rights and the actor's recorded grants. The service MUST NOT rewrite recorded grants to apply the ceiling. The [connection actor rules](../contracts.md#authority) still govern creation and join on open; prospective grants are also subject to the ceiling. The service MUST still apply ACP's [authorization checks](acp.md#authorization) at the point of action.
- **State.** `MODULAR_AGENT_DATA_DIR` applies to the agent service as a whole.
- **Client methods.** ACP's client file and terminal methods reach the client's machine, not the agent's. An agent service MUST NOT offer them to tools as the agent's working environment.

## Changes

- **2026-11-22.** Carry the binding's optional trace fields per message, not as connection context.

- **Proposed production rules.** Connection-local plugin instances, authenticated host scope for state and projects, and configuration of represented ACP actors.

- **New with [ADR 0028](../adr/0028-websocket-transport.md).** No method or shape changed; stdio builds are unaffected.

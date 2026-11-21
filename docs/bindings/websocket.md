# WebSocket transport

This binding carries the [plugin binding](plugin.md) and the [ACP host binding](acp.md) over a network: the same messages, one per WebSocket text message instead of one per line. It is what lets a part, or a whole agent, run as a service. [ADR 0028](../adr/0028-websocket-transport.md) records why.

Everything in the carried binding still applies, except the stdio rules this page replaces: how the peers connect and authenticate, how a message is framed, and what ends the connection.

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

## Framing

- Each WebSocket text message carries exactly one JSON-RPC object, encoded as UTF-8 with no byte order mark and no batch. A peer MUST NOT send binary messages; a receiver MUST close on one with status 1003.
- The 64 MiB cap of the carried binding counts the bytes of one message. Receivers MUST bound a message before buffering it whole, and close with status 1009 on an oversized message. The carried binding's rules for oversized results and errors apply unchanged.
- All other message rules of the carried binding apply: ids, cancellation, notifications, ordering, errors and `$/ping`. WebSocket ping and pong frames MAY also be used; they are not `$/ping`.

## Connection lifetime

The connection takes the place of the child process's pipes, and closing it takes the place of the process ending:

- **Loss.** A peer MUST treat a closed connection, a failed TLS session, a missed `$/ping` deadline or any protocol close as the carried binding's connection loss: unanswered work settles once as `lost`, and the host applies [Parts that are lost](../contracts.md#parts-that-are-lost). The server MUST stop the work it started for that connection as the carried binding requires when its peer is lost. There is no resumption: a new connection is a new plugin instance or ACP connection.
- **Liveness.** Because a network can stall without closing, the client MUST send `$/ping` when a connection with pending work has been silent for an operator-configured interval, by default 30 seconds, and treat no answer within the carried binding's control deadline as loss.
- **Plugin shutdown.** `plugin/shutdown` ends the plugin instance, not the service. After answering it, the plugin service MUST close the connection with status 1000. Where the stdio binding says a plugin exits on stdin EOF, a plugin service ends that instance when the connection closes.
- **Command lifetime.** A working environment served over this transport MUST treat the end of a host connection as the agent's loss in [Command lifetime](plugin.md#command-lifetime): it stops the commands that connection started within its declared containment.

## A plugin service

- **Paths.** `project` and `home` in `plugin/initialize` are the host's paths. A plugin service that does not use the host's files treats them as names. A working environment served over the network MUST serve the same absolute project path in its own file system, for example through a shared mount, or answer `plugin/initialize` with `not_supported`. A remote environment never gives the host access to the service's other files.
- **State.** `home` names state the host expects to keep; it does not authorize opening that path on the service. A stateful service MUST choose its own storage and keep each authenticated host's named state separate. It SHOULD use the authenticated token to distinguish hosts.
- **Raw reads.** A loaded plugin can read every session open in its host ([Authority](plugin.md#authority)). A host operator MUST treat a plugin service as trusted code with that reach, the same as a child process.

## Choosing plugin services at start

Each entry of `MODULAR_AGENT_PLUGINS` is either the stdio form `{ command, env?, config? }` or the network form `{ url: string, tokenFile: string, config?: object }`. `url` is a `ws:` or `wss:` URL; `tokenFile` is an absolute path to a file holding the token. An entry with both `command` and `url` is malformed. The [startup rules](plugin.md#choosing-plugins-at-start) apply to both forms: the host loads entries in array order, and a service it cannot connect to, that refuses the upgrade, or whose registration is refused, fails startup. The host MUST NOT substitute a built-in part for a failed configured one.

## An agent service

- **Actors.** The token decides the connection's actor. The operator MUST configure, outside client control, the actor id, kind, rights, allowed tenants and project scope for each token, as the ACP binding's [Starting](acp.md#starting) section requires for a stdio connection. `MODULAR_AGENT_ACTOR` does not apply to a network connection.
- **State.** `MODULAR_AGENT_DATA_DIR` applies to the agent service as a whole.
- **Client methods.** ACP's client file and terminal methods reach the client's machine, not the agent's. An agent service MUST NOT offer them to tools as the agent's working environment.

## Changes

- **New with [ADR 0028](../adr/0028-websocket-transport.md).** No method or shape changed; stdio builds are unaffected.

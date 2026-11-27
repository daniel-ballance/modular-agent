# Security

This document defines trust boundaries and security rules for a deployment. [Contracts](contracts.md#rules-every-implementation-follows) defines core behavior. The [bindings](bindings/README.md) specify wire checks. [Conformance](conformance.md) describes interoperability, not production readiness.

## Trust boundaries

| Party | What the deployment trusts it with | What that trust does not give it |
|---|---|---|
| Operator | Identities, rights, tenant access, code and deployment policy | No session rights merely by operating the deployment |
| Interfaces and their hosts | Carrying an authenticated actor's requests and delivering that actor's view | No right to choose the connection's identity or disclose the raw record |
| Actors | Actions allowed by their current effective rights | No authority from knowing a session id or tenant name |
| Plugins in the agent process | The agent's permissions and data | No authority to widen rights or forge records through the API |
| Plugins in another process | Trusted code with the agent's permissions unless separately confined | No sandbox from being in another process |
| MCP servers | The tools they serve and the data sent to them | No authority from tool descriptions or results; a server the agent starts runs with the agent's permissions |
| Project files | Content for the model, and configuration where the operator has trusted the project | No power to make the project trusted or to set authority |
| Providers | Model context sent to them and any credentials they need | No authority from model output |
| Working environment | Access to files, running commands and the containment it declares | No sandbox implied by process containment |
| History store | Keeping raw records, including authority and accounting | No power to decide who can open a session or which entries to erase |
| Other services | The data and effects the operator assigns to them | No access merely because they are on the same network |

## Authentication on each wire

- **Stdio.** In [ACP](bindings/acp.md#starting) and the [plugin binding](bindings/plugin.md#transport), the launcher and its child are the authenticated peers. The peers MUST keep the stdio connection private to those two processes. There is no further authentication exchange.
- **History service.** See [history HTTP](bindings/history-http.md#the-basics) for authentication, TLS and isolation of raw records.
- **Other network transports.** The receiver MUST authenticate every request using a bearer token with at least 128 bits of entropy or mutual TLS. Receivers MUST compare bearer tokens in constant time. Peers MUST NOT log them.
- **TLS for all network transports.** Peers MUST use TLS, including on loopback, unless the destination and listener are loopback-only and the operator trusts every local account on the host. Clients MUST verify the server identity before sending credentials or protected data over TLS.

See [MCP servers](contracts.md#mcp-servers) for programs an Interface asks the agent to start and [ACP initialization](bindings/acp.md#initialize) for client file and terminal methods.

## Authority

[Authority](contracts.md#authority) defines which actor a connection acts for, which rights it needs, and which rights it can grant. Reopening does not reset a recorded grant. The [ACP binding](bindings/acp.md#several-actors) maps those rules to requests on behalf of another actor.

The connection rules also give the `joinOnOpen` default. See [Limits and tenants](contracts.md#limits-and-tenants) for tenant access, inheritance and session ceilings.

Trace context is never identity or authority. A receiver MUST ignore context from outside the operator's trace trust scope. Authentication and scope checks still apply. A peer using the [telemetry profile](telemetry.md#context-on-the-wire) MUST NOT send, accept into work context or persist baggage.

### Connection scope

An Interface connection's project and tenant limits restrict which sessions and mediated operations it can reach. They do not confine trusted code, a Provider or a shell. The operator MUST separate agents, stores, credentials and working environments wherever the deployment requires isolation those parts do not enforce. This includes tenant-isolated deployments with loaded plugins that can read raw records. See [ACP authorization](bindings/acp.md#authorization), [plugin services](bindings/websocket.md#a-plugin-service) and [history HTTP authentication](bindings/history-http.md#the-basics).

## Plugins

[Configuration and trust](contracts.md#configuration-and-trust) covers approved code and project options. The operator SHOULD review the project's executable code, settings and dependencies before granting trust and when they change.

The [plugin API](contracts.md#plugins-and-capabilities) is not a sandbox. Plugins run with the agent's permissions, even in another process unless separately confined. The host sees interactions through the API, not effects outside it. See the [Runtime wire rules](bindings/plugin.md#runtime-records-and-effects) for host-owned checks and records. Loaded `/1` plugins have [raw read access](bindings/plugin.md#authority) to every open session in their host. An operator who needs isolation between tenants at this boundary MUST run separate agents for them.

A host MUST build a minimal launch environment for each plugin process, with only approved variables the process needs. It MUST NOT pass credentials it holds in the launch environment, arguments, configuration or inherited descriptors. The [credential callback](bindings/plugin.md#what-a-plugin-may-ask-the-host) is a separate, scoped exchange.

## Untrusted content and prompt injection

Putting project text such as `AGENTS.md` in a system prompt does not make it trusted. See [Authority](contracts.md#authority) for the sources treated as untrusted, [Commands](contracts.md#commands) for input transformed into a command, and [Shared data](bindings/data.md#general-rules) for unknown fields. A read-only declaration describes tool behavior, not permission to read or disclose data.

An Interface MUST NOT execute a UI payload or open a link just because it appears in untrusted content.

## Secrets and credentials

See [Secrets](contracts.md#secrets) for credential access and storing secret answers. The credential store, the plugin that uses a credential and the destination that receives it are trusted with that value. The agent MUST NOT capture credentials or secret answers in traces.

## Data: the record, views, the output gate and erasure

See [The output gate](contracts.md#the-output-gate) for raw records, recipient views and when bypass is disallowed, [Shared data](bindings/data.md#output-events) for valid redactions, and [ACP](bindings/acp.md#output-gate) for withheld replies. Even without Provider-side tools or conversation state, a model request can disclose data, incur costs or leave records with the Provider.

[Erasure](contracts.md#erasure) defines the Harness's role; [history HTTP](bindings/history-http.md#erasure) defines the service's. The operator MUST verify restored records against an authority and erasure freshness source independent of the restored backup. Without proof that newer revocations and deletions are enforced, the operator MUST keep the restore unavailable. A matching history and registry backup is not proof. A configured witness must be kept outside their rollback domain and checked before records are served or writers admitted; it must not be reset to match a restore.

[Authority](contracts.md#authority) lists the audit events and entries the operator needs. Operational logs SHOULD omit raw session content.

[Telemetry version 1](telemetry.md#no-content) MUST NOT capture content, even with export enabled. It records no disclosure markers; the exporter is not an erasure destination for session content.

## Resource limits and denial of service

The [plugin](bindings/plugin.md#transport) and [ACP](bindings/acp.md#starting) bindings cap single messages and give the errors for oversized messages. The [plugin](bindings/plugin.md#paging-history), [ACP](bindings/acp.md#extension-methods) and [history](bindings/history-http.md#sessions) bindings cap history pages. Wire caps do not bound total work or storage.

The operator MUST set finite limits on connections, open sessions, queueing, partial-message bytes and time, parser work, output buffering and storage. The Harness MUST enforce [work and settlement reservations](contracts.md#resource-reservations). This includes all ordinary paths to the store, not just external input; limits on individual frames do not supply settlement capacity.

The operator MUST provision control headroom for cancellation, authority revocation, recovery and erasure, including access to the store and the connection that carries control messages. The Harness MUST keep it unavailable to ordinary work and give authorized control work access to it under saturation. Control work MUST also be bounded: process it in bounded units where needed, leave unfinished durable obligations pending, and refuse new work rather than overcommit. A store refusing new work at a configured quota MUST still permit writes charged to reserved capacity. If old records consume all usable space, the operator MUST reclaim or add space before allowing more work; the Harness MUST NOT keep serving affected work or views when a required revocation or pending erasure check cannot be enforced. Slow recipients MUST NOT block settlement or cancellation; the Harness MUST drop optional output or detach them rather than exceed its buffers. These rules do not promise successful delivery on a failed transport or store.

The operator SHOULD test overload and recovery at these limits. [Output events](bindings/data.md#output-events) describes withholding. [Recovery](contracts.md#recovery-and-repeating-work) describes failures of reserved writes.

## Crash, failure and what recovery can't promise

See [Recovery and repeating work](contracts.md#recovery-and-repeating-work) for commit before dispatch and what can be retried, [history leases](bindings/history-http.md#writing-one-writer-at-a-time) for lease loss, and [Parts that are lost](contracts.md#parts-that-are-lost) for a lost connection. [Questions](contracts.md#questions) covers effects before a call is left open; [Jobs](contracts.md#jobs) covers unfinished work whose plugin is gone.

An outside effect can finish before its result is recorded. Losing a lease or getting a cancel reply does not prove that an outside effect stopped. Recovery does not promise exactly-once external execution or undo an outside effect.

## What an operator configures

The operator MUST NOT enable or keep enabled a production path that cannot enforce a protection the deployment requires. Check:

- [Principals, rights, tenant access and joining on open](#authority).
- [Project trust](#plugins), allowed plugins and destinations for model context and tool data, and [host-supplied MCP servers](contracts.md#mcp-servers).
- The [approval policy](contracts.md#tool-dispatch), including its default, and [direct commands](contracts.md#commands), which are not tool calls. Check whether policy requires an approval plugin, [output gating](#data-the-record-views-the-output-gate-and-erasure), or both.
- If you enable [approvals that wait](contracts.md#approvals-that-wait), set the maximum wait and restrict which writers can reopen the session. A writer that ignores the new records must not run the work. A checked tool name and input do not pin an external file or account: put required target and revision checks in the tool's contract.
- [Command containment and file confinement](contracts.md#the-working-environment). The operator MUST use a sandboxed working environment if policy limits what commands can reach. The operator MUST NOT enable rewind if agents in different processes share the project.
- [Authentication, tokens and TLS](#authentication-on-each-wire).
- [Resource limits and cancellation](#resource-limits-and-denial-of-service).
- [History writer clock](bindings/history-http.md#writing-one-writer-at-a-time). If the platform has no monotonic clock that advances during suspension, the operator MUST configure the deadline margin.
- [Pending erasure](contracts.md#cross-session-coordination). If deletion must finish in quiet sessions, the operator MUST arrange retries. Have the current writer perform an authorized history read, or reopen the session under authorized writer access when its lease is free. The Harness does not sweep all sessions on startup or in the background.
- [Retention, audit access and backup restore](#data-the-record-views-the-output-gate-and-erasure). The operator MUST set a retention policy for history and backups, including whether either is kept indefinitely.

## Deliberate limits

- This edition defines no named production profile or common policy management protocol. It does not define a wire for network Interfaces or other services beyond the bindings listed here.
- The bindings do not prove human presence or define portable delegation credentials, project trust attestations, tenant-scoped service roles or scoped credential handles. These are deployment concerns.
- There is no hard tenant budget, cross-deployment quota or general protocol to reconcile unknown external effects or erase and restore backups. Erasure cannot recall data already delivered.
- Cross-session deletion is not atomic. [Cross-session coordination](contracts.md#cross-session-coordination) makes pending content unavailable before per-session deletion. Raw `/1` readers bypass the Harness. The operator MUST restrict their access to components that enforce pending marks or keep such readers outside a deployment that promises complete shared erasure. The binding does not define a portable pending-state service.
- There is no portable reconciliation for an initial create whose acknowledgement was lost.
- A store with an unsupported private schema, unverifiable lease bounds or missing erasure authority stays unavailable. Fence its writers and keep its outstanding erasure obligations. Start new work only in a fresh, isolated store.

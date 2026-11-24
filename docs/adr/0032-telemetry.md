---
status: accepted
date: 2026-11-22
---

# The Harness owns OpenTelemetry instrumentation

An event follower can see the events it is allowed to receive. It cannot see every Provider request, tool dispatch, remote plugin call, history commit, lease renewal or capacity wait. It also cannot carry a turn's trace through recovery. The Harness already owns those boundaries and the turn checkpoint.

## Decision

The Harness owns trace context and records the spans at those boundaries. Each SDK uses its language's OpenTelemetry API without installing an OpenTelemetry SDK. The app, or `ma`, chooses its SDK, exporter and sampling. Without an installed OpenTelemetry SDK, instrumentation is a no-op.

The [draft profile](../telemetry.md) pins the Development GenAI conventions to v0.1.0. It uses the session as the conversation, the turn as the invocation and the Provider attempt as inference. A step includes more than inference. Other operations use `modular_agent.*`. The optional declaration `telemetry: 1` reports support, not export settings. The [research note](../research/opentelemetry-genai.md) records the upstream rules and the changes to the older metric names.

The Harness saves valid span context with a durable turn. After a restart it starts a new span in the same trace with a link to the preceding segment. It does not reopen the old span. Peers carry W3C context per operation, not per connection. Baggage is not part of this profile.

Version 1 records metadata only: no content leaves through telemetry, so the exporter holds nothing erasure must account for. Content capture comes in a later version. Its design is settled here so that version only implements it: capture is opt-in, uses only the view that passed the output gate for a telemetry recipient, removes known secrets before calling OpenTelemetry, records a content-free disclosure marker first, and reports the exporter in `outOfReach` on an affected erasure.

A plugin may receive trusted trace context for a work operation. Understanding the carrier does not require installing an OpenTelemetry SDK, enabling export or trusting the connection.

Tracing will grow in later versions: content capture, streaming detail, more metrics, traces across agents and correlated logs ([What later versions add](../telemetry.md#what-later-versions-add)).

## Considered options

- **Translate the event stream in a feature plugin.** Useful for its own reports, but cannot see some boundaries or checkpoint the authoritative trace context. Giving it the raw record would widen its access without fixing either gap.
- **Use one span for the session or reopen the turn span.** Sessions can be idle or move between builds. An ended span cannot be reopened, and a killed process may never export its span. A new trace with only a link would also lose the original trace ID.
- **Export raw payloads and filter at the collector.** Too late. The payload would already have crossed the output gate and reached a copy erasure cannot control.

## Consequences

The binding rules for telemetry are:

| Binding and section | Change |
|---|---|
| [Plugin: Transport](../bindings/plugin.md#transport) and [Choosing plugins at start](../bindings/plugin.md#choosing-plugins-at-start) | Allow `params.traceContext` on work requests and notifications in both directions. Responses and control messages carry no context. |
| [Plugin: Runtime callbacks](../bindings/plugin.md#runtime-callbacks), [What a plugin may ask the host](../bindings/plugin.md#what-a-plugin-may-ask-the-host) and [Jobs](../bindings/plugin.md#jobs) | Tie callback context to live `parentRequestId` or authorized job scope. No trace metadata can change those checks. Peer support is a wire concern, not an authority grant. `host/declaration` uses the ACP declaration projection. |
| [Plugin: The host asks the Runtime](../bindings/plugin.md#the-host-asks-the-runtime) and [Runtime records and effects](../bindings/plugin.md#runtime-records-and-effects) | Carry the new segment's context on `runtime/resumeTurn` through the common field. Reserve trace checkpoints and disclosure markers for the Harness; the Runtime cannot submit them. |
| [ACP: Metadata](../bindings/acp.md#metadata), [Prompts](../bindings/acp.md#prompts), [Approvals](../bindings/acp.md#approvals) and [Questions](../bindings/acp.md#questions) | Describe unprefixed W3C keys in supported request `_meta`, outside `_meta["modular-agent"]`, in both binding versions. Describe the starting input's context and that steering does not reparent work. |
| [ACP: The declaration](../bindings/acp.md#the-declaration), [Extension methods](../bindings/acp.md#extension-methods) and [Entry](../bindings/acp.md#entry) | Add optional `telemetry: 1`. Do not project private trace contexts to ordinary ACP history readers. |
| [History HTTP: The basics](../bindings/history-http.md#the-basics) | Allow W3C headers per authenticated HTTP request. There is no new endpoint or history-service declaration; it still stores opaque records. |
| [Shared data: Standard kinds](../bindings/data.md#standard-kinds) and [Recording order and ownership](../bindings/data.md#recording-order-and-ownership) | Add optional `turnStart.data.traceContext` and the host-owned `modular-agent.turnTrace` checkpoint. Specify the shapes, writer, visibility and commit order. |
| [Shared data: Portable sessions](../bindings/data.md#portable-sessions), [Append order and the branch](../bindings/data.md#append-order-and-the-branch), [Session state](../bindings/data.md#session-state) and [Context and interrupted work](../bindings/data.md#context-and-interrupted-work) | Fold the latest valid segment checkpoint for the interrupted turn only. Exclude telemetry control metadata from copied history and the model view. |
| [WebSocket: Connecting](../bindings/websocket.md#connecting), [Framing](../bindings/websocket.md#framing) and [Choosing plugin services at start](../bindings/websocket.md#choosing-plugin-services-at-start) | Use the carried binding's message fields and peer support rule. Do not use the upgrade context as the parent of work on that connection. |

MCP already defines the field in [SEP-414](https://modelcontextprotocol.io/seps/414-request-meta). Apply it in the tool source; no repository MCP binding or upstream change is needed. [Contracts](../contracts.md#declaration-rules) and [Security](../security.md#data-the-record-views-the-output-gate-and-erasure) would point to the profile for declaration, deployment trust and the no-content rule. The SDK specification and `ma` configuration would then describe operator options. An in-memory exporter can check the mapping, propagation, privacy and recovery without requiring a live Provider or collector.

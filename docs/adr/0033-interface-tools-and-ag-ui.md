---
status: accepted
date: 2026-11-23
---

# Interface-run tools and an AG-UI binding

[AG-UI 1.0](../research/ag-ui.md) lets an application run a tool and return its result in a later run. An editor or another agent can also perform work the agent cannot do in its own working environment. The Harness already owns the checks and records for dispatch. The [pressure test](../pressure-test/round-2/rung-4-maximal.md) also found that an Interface cannot rely on unknown AG-UI event types or fields reaching the application.

## Decision

1. **Run tools through an actor's Interface.** Add an optional, protocol-neutral tool source. The operator registers the tool and executor. The Harness checks gate, approval, current authority and output, and commits `toolStarted` before handoff. A handed-off call stays open, with a deadline, even if the connection goes away. A later result goes through `tool.after` and the usual settlement. It is data from the actor, not authority. Reuse the continuation queue; do not dispatch the open call again. See [Interface-run tools](../contracts.md#interface-run-tools).
2. **Keep the agent's history.** Compare the copy an AG-UI client sends to the view delivered to that client. Refuse disagreements. Only a new suffix can supply new input or matching results. Never rewrite the record from a client copy.
3. **Leave the shared document to a plugin.** The plugin owns the state and reports snapshots and deltas. The adapter projects them as AG-UI state events. Add nothing to the Harness for this document until a second Interface needs it.
4. **Add `modular-agent-agui/1`.** Use HTTP and SSE on the same listener as ACP over WebSocket, with the same TLS and token rules. A thread is a session. A run follows one turn or carries answers or results that continue one. AG-UI questions use interrupts and `resume`; frontend calls use unanswered tool calls and later tool messages. This is the upstream representation of the two kinds of wait, not an exception to dispatch or approval.

## Considered options

- **Let the adapter run tools outside the Harness.** That skips the normal start record and makes gates, replay and erasure depend on the binding. Treating a result as a new prompt would also lose its call identity.
- **Take the client history as the record.** A stale or edited copy could erase or invent facts. Taking no new messages at all would not allow an ordinary prompt or tool reply.
- **Make shared state a Harness store.** There is no second binding to show what would be common. Document merge and lifetime belong to the owner of the document.
- **Tunnel AG-UI through ACP or use an independent listener.** Neither is needed. The specified HTTP response works on the existing agent service listener. Protobuf and older unversioned clients are not part of this profile.
- **Let approval survive a turn.** Not needed to close an AG-UI stream. The optional presence route can carry an answer while the turn remains open. Without an eligible route the normal refusal applies.

## Consequences

- An interrupted stream does not prove a tool ran. The binding does not replay executable handoffs. It can accept a result from another connection on the same authenticated executor route. Deadline expiry settles an ambiguous start as `outcomeUnknown`.
- A Runtime that opts in must handle a continuation with results and no calls to rerun. ACP may later wrap its client file or terminal methods as tools on that actor's route, not as the agent's working environment. A2A may later use an authenticated peer's task result as a report for a registered call. Its task state cannot grant authority. Neither mapping is specified here.
- A stock AG-UI client works for ordinary conversations and Interface-run tools: the history cursor is optional, and without it the server checks the client's copy against the last snapshot it offered that client. Only a client that opens the optional presence route can answer approvals; without one the core refusal applies. Both choices are the owner's (2026-11-23). `CUSTOM` and `RAW` preserve gated extensions without changing the upstream schema.
- The [binding](../bindings/agui.md) and [SDK draft](../sdk/placement.md#serving-ag-ui) describe the proposal. The proposal did not claim implementation or kit coverage.

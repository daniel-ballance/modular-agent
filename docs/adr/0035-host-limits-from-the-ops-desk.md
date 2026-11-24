---
status: accepted
date: 2026-11-24
---

# What a host can learn from one agent

The [ops desk](../../demos/ops-desk/DESIGN.md#findings) drove three agents. Three [limits](../../demos/ops-desk/DESIGN.md#where-the-findings-went) remain: how a wait closed, how a lost run ended and which agent called a plugin service. Each concerns one agent or one listener. Under [ADR 0012](0012-one-agent-is-the-scope.md), the host still owns the combined inbox, routing and process lifetime.

## 1. Report why a wait closed

Today an AG-UI run can finish with an interrupt while the question stays open. Presence carries comments, not events. The desk rereads the snapshot before showing an answer button and again before sending the answer. The snapshot says nothing about why a question disappeared. The desk can label a deadline refusal because it controls the sole answer route. It also watches the plugin's `turn.end` hook before stopping the coder: closing its question did not end its turn.

**Proposal.** Give the thread snapshot a wait cursor. Offer a separate [read-only feed](../bindings/agui.md#wait-closures) from that cursor. Use the Harness's [ordered catch-up and live follow](../contracts.md#following-a-session). Report a question's first committed decision or an Interface tool wait's terminal settlement. Distinguish an answer, a decline and expiry. Label a revocation only when the writer recorded it as the cause of closure. Losing one answer route is not a decision. Gate the source facts and the notice for this viewer, on catch-up as well as live. Send no answer value or executable call. The feed does not mark presence or deliver an approval view.

**Not chosen.** Polling faster cannot distinguish two causes of disappearance. Adding events to presence would make watching an inbox keep an answer route alive. Appending to a finished run would change the AG-UI exchange. The host can merge feeds; the agent need not order closures across agents.

**[AG-UI kit](../../conformance/agui/README.md) check.** Take a snapshot just before an ACP answer commits. Subscribe after the commit; get that request ID and `answered` once, then the next live closure in order. Disconnect and resume after the last processed cursor. Exercise decline, deadline, recorded revocation and a settled Interface call. Dropping one of two answer routes or reaching a `leaveOpen` timeout produces no closure. Block the source at the output gate or revoke `watch` while a notice is buffered: no ID or reason escapes. The feed alone cannot answer an approval.

## 2. Look up the run, not the lost stream

After `SIGKILL` the desk could reopen the coder's thread. Its snapshot showed the interrupted tool's outcome as unknown and included the recovered reply. Neither was a terminal event for its run. It saves the thread ID before sending input, uses one thread per routed task and records “reopened.” It never runs a tool from the snapshot. A missing provisional thread is not grounds to start over.

**Proposal.** Offer a [run receipt](../bindings/agui.md#run-receipts) on kept history, by thread and run ID, to the same authenticated client. Bind it to the accepted work, including a run that delivers answers or tool results rather than new input. Report two facts: the terminal class the adapter can confirm for the exchange, and the committed disposition of the work it followed. For example, the run can end with an interrupt and the turn can later complete. If the process died before recording a terminal class, report `unknown` for that class even after recovery. Neither fact proves delivery or execution. Keep the link for the life of its source records, subject to erasure and the recipient's current view.

**Not chosen.** The last turn in a thread can belong to another run. An input key alone misses answer-only runs. Saving SSE frames or resending a terminal group would retain content and could repeat a frontend handoff. Reopening a stream is not needed to read a disposition.

**Kit check.** Kill the process before admission, after admission and after `turnEnd` but before terminal delivery. Reopen the thread. For an interrupted turn, expect `failed` with a transient Runtime and the actual settled outcome after durable recovery. Start another turn in the same thread; the first receipt still describes the first run. An interrupt run and its answer run retain distinct receipts. A receipt for a result-only run follows its continuation, not the completed origin. Repeat the GET and retry the POST: no second admission, decision or handoff. Try a sibling client of the same actor, a different tenant, pending erasure and a gate that blocks settlement. None gets the hidden fact.

## 3. Authenticate plugin callers at the listener

The desk runs three listeners. Each accepts one token file and closes over the name of that agent. `tools/call` identifies a session and a call. Neither identifies the connecting Harness.

**Proposal.** Let the operator give one [plugin service](../bindings/websocket.md#named-callers) a table of token files and stable caller IDs. Pass the matched ID to the [SDK's per-connection plugin factory](../sdk/placement.md#serving-named-callers). There is no caller field on `tools/call` or `plugin/initialize`. The token authenticates the connecting Harness. Its ID grants no session right, project access or callback authority. The desk still decides which caller may hand work to the coder. Live work stays connection-local, even on two connections for the same ID. Keep the single-token form. Keep [separate confined instances](0030-production-gaps.md#isolation-decisions) where a service cannot isolate its state and resources.

**Not chosen.** A model argument, a session ID or a name in initialization settings is a claim by the caller. A shared token cannot distinguish the callers. An ACP actor table would mix transport identity with rights in somebody else's session.

**Kit check.** Use the [plugin kit's one-listener isolation checks](../../conformance/plugin/README.md#plugin-service-isolation) with two tokens, overlapping request, session and call IDs, and the same claimed `home`. Have each caller claim the other's name in config and tool input. Only the credential selects the factory's ID and retained state. Cancel work on one connection; the other's callback still returns to its own Harness. Repeat with the same credential on two sockets. Reconnect and check the state and project bounds again. A wrong token gets 401 before setup; ambiguous token mappings fail startup.

## Owner decisions

Accepted as recommended on 2026-11-24: a separate optional per-thread feed of wait closures; a status-only run receipt for every accepted AG-UI exchange on kept history, kept on the serving deployment; and an opt-in operator table of named callers on one plugin listener. Implementations follow in 0.3.0.

All four SDKs and `ma --agui` implement it from 0.3.0.

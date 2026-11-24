---
status: accepted
date: 2026-11-23
---

# Approvals that wait past their turn

The [ops desk](../../demos/ops-desk/DESIGN.md#findings) uses three-minute deadlines. When someone opens the inbox hours later, the call has already been refused. Keeping the inbox row does not keep the approval open. [ADR 0033](0033-interface-tools-and-ag-ui.md) lets an Interface report a result after its turn. Here the call has **not started**. The missing fact is consent, not a result.

## Decision

1. **Make waiting a session choice.** Declare `approvalsOutlastTurns: true` only with kept history, an approval gate, a finite operator maximum and support for `portableSessions`, `questionsOutlastTurns` and `lateAnswersStartTurns`. The declaration reports support, not permission. Record a separate session setting, `approvalWait: "untilDeadline"`; the default is `"live"`. This does not change which calls the [approval policy](../contracts.md#approval-policy) allows, asks about or refuses. Start with its pre-dispatch gate on top-level model calls to server tools. An approval asked *inside* a running tool, including the desk's change tool, cannot undo that start.
2. **End the turn, not the call.** The Harness commits the bound `inputRequest` and a gate `toolPending` together. There is no allowance, `toolStarted`, executor handoff or effect from this call. The gate returns pending immediately, even if someone is online. Siblings follow the usual ordering. A normally completed turn lists the call in `openToolCalls`. Only then is this request answerable. An idle session can release its writer and the process can stop. Keep the call and settlement reservations, not a waiting thread or RPC.
3. **Bind one answer to one view.** An eligible member may be offline when asked. On return the approver needs current membership, scope, `watch`, `approve` and a place in the request's answerer set. Check representation and connection ceilings too. The Harness offers the immutable question, call ID, exact name, complete input and deadline on that actor's authenticated route, through the output gate. If changed or withheld it cannot be answered there. Accept the first valid answer on a route that delivered this exact view. Bind an allow to the request entry, the answering principals, route and rights ceiling. The entry already binds the call to its registration. No authority comes from a copied card or a client-supplied call.
4. **Check again at first dispatch.** Closure of all questions and settlement of any handed-off siblings make the existing [continuation](../contracts.md#questions) ready, once. This is not new input. An allow is not an allowance. Run the gates on the original call under the original work's ceiling and everyone's current rights. Recheck the approver and the bound view without requiring the approver to stay online. Compare the final call, including its input, plugin, source and whole definition, by shared JSON equality. Check policy, scope, availability, cancellation, erasure, writer and deadline through handoff. If the call changed, settle it as `refused`, not as a new question about a replacement. A valid allow buys one initial handoff, not a retry.
5. **Bound the wait.** Use the lesser of the requested time limit and `maxApprovalWaitMs`, or the maximum if no shorter limit was requested. Record an absolute deadline at ask time. At or after it, close an open question with `timeLimit` and settle the unstarted call as `notStarted`. This also bars a timely allow whose continuation sat in the queue too long. Never overwrite a committed answer.

## Reopen and delivery

- Reopen under writer access; reconcile erasure, terminal records, revocations and the saved deadline before offering anything. Restore neither presence nor a delivered view. A transient Runtime fails an interrupted origin; an ended origin needs no interrupted-turn support. Missing approval proof cannot start a call. After a committed start, reconcile the outcome; do not run it again on the late allow.
- Revocation cuts off that actor's route. Another eligible member can answer an open question. With no eligible member left, refuse the call. Revocation after allow but before dispatch invalidates the allow. Erasure invalidates affected views, decisions and queued effects. Refuse a fork while the call is open; a later fork copies no permission. A move cancels and settles work left behind or is refused.
- In [ACP](../bindings/acp.md#approvals), keep `session/request_permission` live-only. On a later connection use `_modular-agent/requests` and then `_modular-agent/answer` on that connection. In [AG-UI](../bindings/agui.md#interrupts-and-frontend-tools), open presence **when returning**, read the gated interrupt from the thread snapshot, then send `resume` in a later run on that presence route. No tool message or executable call comes from the inbox.
- With [telemetry](../telemetry.md#spans-and-events), end the origin's step and turn spans. Record question open and close on the operations that do that work. The continuation has a new turn span linked to its origin when available. Only actual dispatch has an `execute_tool` span. No span covers the idle hours or contains the view or answer.

## Considered options

- **Keep the turn or permission RPC alive.** This needs a running process and a live route. A longer timeout does not make either recoverable.
- **Use a text question, new prompt, job or frontend tool result.** None binds consent to the original unstarted call. A result would say the tool had already run.
- **Save an allowance or ask again on changed arguments.** The former spends yesterday's authority. The latter silently substitutes a different action for this call. Propose changed work as a new call instead.

## Owner decisions

Accepted as recommended on 2026-11-23: the per-session opt-in for the pre-dispatch gate on top-level model calls to server tools; an explicit finite operator maximum, applied through dispatch; and consent only from fresh, unchanged delivery on the answering route. The specification is accepted in 0.2.0; implementations follow in 0.3.0.

This changes no edition to pin. No build implements it yet.

## Amendment: approvals that cover nested calls

Added 2026-11-24 by the owner. `ma` offers the model one top-level tool, `codemode`; its writes and commands are nested calls. Nested calls cannot wait (decision 1), and each passed approval on its own, so an approval given hours later would end with every write asked again live and refused. With the operator's opt-in, an allow for a top-level call now also answers the approval check for the nested calls it makes in that dispatch ([rules](../contracts.md#approvals-that-cover-nested-calls)). The approver is told so in the exact view; each covered call records the allow that covered it. Rights, the other gates, registration and the final dispatch check still apply to each nested call.

The approver approves the code, not a list of effects. A script can read files and decide what to write from what it finds, so its effects depend on the project when it runs. `codemode`'s sandbox has no file, network, clock or entropy of its own, so the script and its tools' results decide what it does.

**Options not taken:** approve each nested call live (it cannot wait); let nested calls wait (a running script would have to pause for hours).


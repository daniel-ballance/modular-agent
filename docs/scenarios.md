# Scenarios

Worked examples of [Architecture](architecture.md) and [Contracts](contracts.md). See [Bindings](bindings/README.md) for wire mappings and [Security](security.md) for trust boundaries.

Unless noted, the agent uses a terminal Interface, a transient Runtime, a stateless Provider that runs no tools, and a local working environment with file confinement. It has built-in file and shell tools, a history store on disk, and a credential store. Feature plugins select the model, build the system prompt and context, and check approval. The user has the rights needed for the actions shown. The `approval` setting is `ask` unless a scenario says otherwise.

## 1. A request that uses a tool

The user types "Read config.json and summarize it."

1. The Harness takes the Interface's keyed input. It records acceptance and the receipt together. The input hook passes the text on. The Harness records the input and turn start before work starts.
2. The prompt plugin adds instructions and supplies the project's `AGENTS.md` as untrusted project content. Context management selects the permitted model-visible entries. The Runtime gets model access, not credentials.
3. The Harness commits the first `modelRequest` before sending it. The model asks for `read` with `config.json`. The response is recorded before any call from it is dispatched. Streamed pieces pass the output gate before the UI sees them.
4. The trusted `read` definition marks the tool read-only, so `ask` does not open a question. The Harness checks the caller's effective `tools` right, the tool offer and the gate decision for these exact arguments. The working environment checks the resolved path stays in the project. In this deployment, the file is also cleared for disclosure to this Provider. An escaped path or disallowed disclosure is blocked even though `read` does not write.
5. The Harness commits `toolStarted` before sending the call. The result is recorded when known, completing the step. The next request uses the call and result and gets its own `modelRequest` and response records.
6. There are no further calls. The turn ends as `completed`, with the summary, two steps and their usage. Records carry only the identities that apply to them.

## 2. A tool call that needs approval

The model requests a shell command to delete generated build files.

1. With `ask`, the approval handler opens a request for that exact call. The Harness records it with the user as an eligible answerer. The terminal UI shows it in context while the turn waits.
2. The user answers allow. The Harness checks the user's current `approve` right and records the answer before the gate continues. The answer is not model context.
3. The Harness checks the current rights behind the work and consumes the gate decision for the unchanged call. It records `toolStarted` before dispatch.

**Variations:** Refusal or no present eligible answerer gives the call a `refused` result. `never` refuses without opening a request. If a handler changes the input after approval, the whole gate chain sees the revised call on its second pass. The old approval is not approval for the new arguments. A second change on that pass refuses the call.

## 3. A question nobody answers in time

A read-only reporting tool asks which database to query. It asks before doing any outside work. The agent declares `questionsOutlastTurns` and `lateAnswersStartTurns`.

1. The tool opens a keyed choice with a time limit and chooses to leave the call open when the limit passes.
2. The deadline ends the wait, not the question. The turn ends with the call listed as open and no tool result. This works with either Runtime.
3. An hour later the user answers. Once all the originating turn's open calls have their answers, the Harness queues one keyed continuation behind any running turn. Repeating the answer does not start another turn.
4. The continuation reruns the call from the top, with the current checks. It reuses the recorded answer only if the answerer is still eligible. The call's execution or refusal produces its result, not the answer itself.

**Variation:** A question with no time limit waits in its turn. After a restart a durable Runtime with `waitingThroughRestart` asks again with the same key. Without that support, the Harness closes an interrupted in-turn question as `noLongerAnswerable`; this does not start a late-answer continuation.

## 4. The user adds a message while the agent works

The user types "use the staging config, not production" and chooses to steer the running turn.

1. The Interface sends the input as steering. This Runtime supports `inputDuringTurn`, so the input waits for the current round of calls to finish.
2. The turn takes the steering before its next model request. The model sees it in the next step.

**Variations:** The user can choose next-turn input instead. If steering is unsupported, the input waits for a new turn. If the user withdraws the input before it is taken, the Interface gets it back.

## 5. The user cancels

A long shell command is running when the user presses Escape.

1. The Interface acts with the user's `cancel` right. The Harness asks the Runtime to cancel the turn, stops starting new work and asks running calls and model requests to stop.
2. The executor confirms that the running call stopped. Its result is `cancelled`; any effects it already had remain. If the executor cannot be reached and the call may have run, the result is `outcomeUnknown`, not proof of a stop or rollback.
3. Open questions tied to the turn close. A cancelled permission response refuses the pending call. Queued input not yet taken goes back to its author or an authorized recipient. Resending it needs a fresh key.
4. The turn ends as `cancelled`. Recorded work stays in history. Here `cancellingTurnCancelsJobs` is false, so the jobs keep running. Closing the session would cancel them and wait for cleanup.

## 6. The conversation outgrows the model's context

The next request would be too large. The context plugin asks a model to summarize older entries. It records which entries the summary copies and keeps call and result pairs together. The next context contains the summary and recent entries. The old entries stay in history.

**Variations:** A model request can fail first with context overflow. The plugin compacts and retries the step once. Failure to summarize or a second overflow fails the turn. A stateful Provider starts again from the new view after compaction, rather than carrying over the history it replaced.

## 7. The process stops during a tool call

A turn has a recorded result for its first call. The process stops with the second call in flight and the third not yet dispatched. The history store survives.

- **Transient Runtime:** reopening ends the interrupted turn as `failed`. The first result stands. The second call gets `outcomeUnknown`; the third gets `notStarted`. The next turn sees those results and does not silently repeat unknown work.
- **Durable Runtime:** recovery starts from recorded progress and never reruns the first call. It can repeat the second call if its committed start says it was safe to repeat and the current tool and working environment both still promise that. It checks authority and gates again. If those safety promises are missing, or the repeat is refused, the earlier attempt remains unknown. A call not yet dispatched can run for the first time through the same checks.
- **No history store:** the session was ephemeral. There is nothing to reopen.

See [Recovery and repeating work](contracts.md#recovery-and-repeating-work) and [Portable sessions](bindings/data.md#portable-sessions) for the records used on reopen.

## 8. Handing a task to a subagent

A subagents plugin offers a `delegate` tool. The agent declares `startsTurnsUnasked: "jobReports"`.

1. The model calls the tool with a review task. This deployment permits an override among configured review models. The parent has `delegate` and `settings`. The tool checks those rights and access to the chosen model; it does not accept arbitrary models or other setting changes.
2. The plugin starts a job and a child session in the parent's tenant. The child inherits the project, plugins except host-supplied MCP servers, and copied settings with the permitted override. It gets the task, not the parent's history, and no wider rights than its parent.
3. The parent's tool result identifies the job. The parent finishes its turn while the child works.
4. The child asks a question naming the parent agent as an answerer. The parent answers if eligible, or asks its own user. The answer goes back through the recorded link.
5. When the child finishes, the Harness commits the job end and its keyed report together. The report acts with the job's narrowed rights and starts a parent turn.

## 9. Work starts with nobody present

A scheduler submits "check for dependency updates" every morning. The operator gives it a stable `program` principal in the session's tenant, with `input` and only the tool rights that task needs.

1. The scheduler gives the session keyed input. This is actor input, not an internal job-report turn.
2. This deployment sets `approval` to `ask`. It offers only a tool whose trusted definition marks it read-only and whose destination and data disclosure the operator has allowed. A call that would need approval is refused when nobody eligible is present.
3. Unattended questions have a finite deadline and decline policy in this deployment. The turn records its result for the user to read later without waiting indefinitely for an answer.

## 10. Changing the model mid-session

The user switches models with the `settings` right. This agent declares `settingsDuringTurn: "nextTurn"`.

1. The Harness records the new setting. A running turn keeps its pinned model, tools and prompt. It does not change models even when it retries a step.
2. The next turn gets access to the new model. The context plugin works from the session's current view and does not carry over opaque values from the old Provider.
3. The change resets Provider conversation state. Switching back is not a reason to pick up an old Provider conversation.

## 11. Two people in one session

The owner has `grant`, `watch`, `propose`, `input`, `steer`, `tools` and `approve`. The agent declares `severalActors` and `mixedActorInput: "shared"`.

1. The owner grants a colleague `watch` and `propose`. The Harness records the grant and its issuer. The colleague proposes "also check the tests". Nothing runs until the owner releases it with `input`.
2. The accepted proposal records both actors. The turn acts with their shared rights, which do not include `tools`. A destructive call is refused before approval. The owner's approval cannot add a missing right.
3. In a separate turn started solely by the owner, the same tool call needs approval. Only the owner is named as an answerer and the owner explicitly allows it. If another actor with `grant` removes the owner's `tools` right before dispatch, the Harness refuses the call despite that answer.
4. The Harness takes inputs in admission order. A colleague with only `propose` cannot steer. If both actors are later granted `steer` and their input joins one turn, that work uses shared rights; an agent declaring `mixedActorInput: "refused"` refuses mixed input instead.
5. A permitted tool returns sensitive account details. The deployment excludes known credentials before writing history. An account detail that remains in history is visible only in an authorized view. The output gate redacts it for the colleague on live delivery and again on replay. With `holdsOutput` declared, the gate can see a whole number before releasing redacted streamed pieces.

## 12. The Provider runs a tool itself

An in-process Provider can run web search. The agent declares `runsToolsAtProvider: true`. This session is not portable and this Provider is outside the plugin `/1` profile.

1. Before sending the model request the agent checks authority and sets the allowed Provider tools for that request. In this deployment a trusted definition identifies search as read-only, but the disclosure policy still limits it to public queries to the allowed search service. A private query or an effect the agent cannot authorize in advance is not allowed.
2. The Provider runs an allowed search. The response includes the search call and result. The Runtime records them and never dispatches the call again.
3. If the reply is lost and execution is uncertain, the turn cannot recover the step by repeating the request without an applicable safe-repeat promise. With that promise on the recorded attempt and supported on recovery, the Runtime can make a new recorded attempt through the same checks. Permission to run search by itself says nothing about repeat safety.

## 13. A voice conversation

This is a design sketch, not a portable or wire scenario. A live Provider could exchange audio while a user speaks and handle an interruption while replying. Any local call still goes through the Harness. Streamed pieces are live, not replay records. A transcript of completed steps would not prove what the user heard before interrupting. This edition does not specify [turn boundaries](open-questions.md#live-sessions) or [delivery evidence](open-questions.md#partial-output).

## 14. Moving back, and rewinding

The user wants to go back to the first `turnEnd`. The session is on that branch, with no running turn or unfinished work. This agent declares `rewinding: true` and `movingWithUnfinishedWork: "refused"`.

- **Moving only.** The Harness checks that moving is allowed, then records the new position. The view follows that position without deleting later history. The Provider starts again from the new view. Files are unchanged. If work is unfinished, this agent refuses before changing anything.
- **Rewinding.** There are points from this working environment on every later `turnStart` and out-of-turn `toolStarted`, and no job started after the target. The Harness selects the earliest such point after the target. It saves the current files as P0, records the new `position` with the chosen point and P0 as undo, then restores the point. The Provider starts again here too. The move reports any later `openWorld` call ids as `outOfReach`; their effects were not undone.
- **If interrupted or refused.** Reopen retries the restore before work when the last entry is that `position`. If restore fails, the Harness records a return to the previous head, restores P0 and refuses. Unconfirmed rollback blocks further effects until reconciled. A missing qualifying point, an unfinished-work refusal or a later job start prevents the rewind before anything changes. Lack of points alone does not prevent a move without rewind.

## 15. Erasing personal data

An actor with `erase` asks an agent that supports erasure to delete a user's personal data.

1. The Harness finds the entries and their transitive copies, including summaries and forked entries. It leaves authority and accounting records alone. It sends exact IDs to the history store; the store does not infer copies. If this Harness holds the lease, it uses that lease. If another writer holds it, the request is refused. With no writer, erasure is atomic for the session.
2. The history store removes the identified content and keeps the tombstone. The agent resets Provider conversation state and requests deletion of known remote copies. One remote deletion fails. The reply lists local success, the pending copy and anything out of reach, such as output already delivered.
3. During the pending deletion and after a crash, the data is not replayed or sent back as context. The agent uses its recorded deletion work to retry the same remote copy, not recreate it. If the reply were lost and the lease were no longer current, the Harness would read the session to see whether the tombstone was committed. It does not blindly resend under a new lease.

See [Erasure](contracts.md#erasure) and the [history service's erasure rules](bindings/history-http.md#erasure).

## 16. A background command

The model starts a dev server. This agent declares `startsTurnsUnasked: "jobReports"` and `cancellingTurnCancelsJobs: false`.

1. The shell tool starts a session job. Its tool result identifies the job. The turn ends and the Interface still lists the job as running.
2. The server crashes. The Harness commits `jobEnded` with the failed outcome and the keyed report's acceptance in one batch. The report enters as the job's input and starts a turn to look at the error. The job's usage counts once.
3. Cancelling a turn would leave the job running. Closing the session cancels the job and waits. A process stop instead leaves unfinished work for recovery.

## 17. Driven by a host

An outside host uses the agent's Interface. The operator configures a stable `host` actor and its allowed tenants. The host reads the declaration before it sends work.

1. The host sends keyed input. Its connection drops before the reply. On reconnect it opens the same session under its recorded rights and follows from its last cursor. Retrying with the same key returns the original receipt rather than starting a second turn. Replayed output passes the gate under current policy.
2. With `watch` but no `approve`, the host may show an approval request in an authorized view but cannot answer it. When the operator has authorized a host to act for an eligible user, both the host and user still need `approve`. The accepted answer covers the exact call. The Harness refuses dispatch if the work's tool rights are revoked before it runs.
3. The host's user visits another agent, then returns. The host submits a summary of the other agent's work as input, not as approval or a new setting.
4. The host reads `forking: true` and requests a fork at an earlier entry. The agent checks the actor's authority, tenant and unfinished work before making a fork. Without support, or with unfinished work, the attempt is refused before anything changes.
5. The host uses the declaration to know whether job reports or late answers can start turns. Following the session alone does not make the host present to answer a question.

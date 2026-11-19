# Gaps in the description

Each entry gives the source, missing detail, this build's decision and the swap test.

## Production edition 3

### G101. Portable grants need two distinct provenances

- Where: `data.md`, Standard kinds; `contracts.md`, Authority; portable F2 and F3.
- Finding: The earlier writer used the actor being admitted as the granter. The same session could look fine to its writer but look like a self-grant to another reader. The approval history projection also used the default actor after a different principal had opened the session.
- Choice: Record `operatorAdmission: true` and omit the envelope actor for creation, fork setup and authorized joins on open. Preserve the authenticated granter for ordinary grants. Use the configured ACP principal for every recipient projection.
- Swap test: yes. A strict reader can reject an otherwise usable session. Edition 3 defines operator admission, so this is a writer defect, not an open choice.

### G102. A keyed retry is not a session-wide lookup

- Where: `data.md`, General rules and Session state; `acp.md`, Starting; portable F2.
- Finding: A first admission or erased reservation in another principal's scope is neither a duplicate nor a reason to refuse a new admission. Looking at consumed inputs instead of first admissions can also change the receipt on replay.
- Choice: Look up first admissions and erased reservations by session, submitter, attributed actor and key, including across branches but excluding fork display copies. Default an absent `submittedBy` to the attributed actor. A legacy erased reservation with no recorded actor does not identify every actor in the session. Prefer explicit scopes for new erasures.
- Swap test: yes. Test both matching and different configured actor IDs, and both retained and erased first admissions.

### G103. The assistant message and step identity must survive ACP projection

- Where: `plugin.md`, The host asks a Provider and The host asks the Runtime; `acp.md`, Entry; `data.md`, Standard kinds.
- Finding: The Provider response observer must receive only the four specified fields, while a host receiving an extra field must ignore it. Separately, the Python ACP history projection omitted `stepId` from responses and rebuilt the assistant message without usage. The raw Runtime port had both values, so a recovery trace could look correct while ACP clients could not match the checkpoint to the answer.
- Choice: Send only the four Provider response fields, ignore unknown callback members on receipt and use the shared assistant-message projection in ACP, with the step's ID.
- Swap test: yes. It checks a normal reply through a strict host and recovery observed through both the Runtime and ACP ports.

### G104. The gate is a separately committed checkpoint

- Where: `contracts.md`, Recovery and repeating work; `data.md`, Recording order and ownership; `plugin.md`, The host asks the Runtime; Runtime E.
- Finding: An answer and its tool results prove the gate may run, not that it did or that it allowed the step. In an older record with neither a decision nor a tracking marker, the two cases cannot be distinguished.
- Choice: Commit one `modular-agent.stepAfter` entry before acting on the decision. Write a tracking marker on step attempts. On recovery send only eligible calls and the restored last answered step, preserving explicit `null` for allow. Refuse unknown or inconsistent checkpoints before resuming; do not infer a decision from a private step cache.
- Swap test: yes. Kill before and after the gate reply, and test a refused step and mismatched checkpoint. Legacy interrupted turns without sufficient evidence are deliberately not upgraded by guessing.

### G105. An ACP refusal is a decline in shared history

- Where: `acp.md`, Request; `data.md`, Answers; portable F3.
- Finding: After the grant fix, Elixir could reopen Python history with `allow` but rejected `inputAnswer` after a permission refusal. Python wrote the client's `refuse` option as an answer value.
- Choice: Normalize a refusal on either approval route to an actor decline. System closures carry their reason without an actor. Leave the string `refuse` alone in non-approval answers.
- Swap test: yes. In the minimal swap, an approval decline used to make the session unreadable. Writing `declined: true` instead lets Elixir reopen it and apply both key scopes.

### G106. The host must record a pending call before replying

- Where: `plugin.md`, Runtime callbacks; `contracts.md`, Hook execution and Questions; `data.md`, `toolPending`.
- Finding: The Python host sent a pending `runToolCall` reply but did not commit the disposition. The Python Runtime echoed it in a private record, hiding the bug. Other Runtimes correctly proceeded to `step.after`, which the host rejected.
- Choice: Commit `toolPending` with the invocation's `toolStarted` ID and the questions whose waits ended with `leaveOpen`, then send the pending reply. An old Python Runtime can still echo the reply without creating a second record. A call with neither a result nor a pending disposition still blocks the gate.
- Swap test: yes. The late-question kit checks that the original turn completes with the call open and that the answer starts one linked continuation. The binding already defines this behavior; the host was wrong.

### G107. Settled: a question deadline is not a turn limit

- Where: `contracts.md`, Questions; `bindings/data.md`, Outcome; `bindings/plugin.md`, The host asks the Runtime.
- Finding: `leaveOpen` ended only the question's wait. The older text left room for a Runtime to report `limit: questions` after the host committed the pending call and allowed the step gate.
- Resolution: The edition 3 clarification at `58928f0` requires the Runtime to report `completed` with the open calls unless a real limit, cancellation or failure ended the turn first. The host no longer converts the question limit to completion. It rejects that outcome and fails the turn. The host still commits `toolPending` before replying, as in G106.
- Swap test: yes. A successful late question must look like a completed turn to an ACP client. The regression checks that the host accepts a matching completion, rejects a question limit or a missing pending call, and preserves a real `steps` limit.

### Findings settled in this edition

- G100 and the remaining route question in G94: approval authority is per recipient and route. A changed polling view does not invalidate an exact permission route that is still live.
- G93: the host commits ineligible calls before handing the Runtime its resume list. W10 also closes the refusal acknowledgement issue: the result comes from the host, not from a guessed conversion of the refusal text.
- G58 and G60: the last answered step now has an explicit portable gate checkpoint, including a way to distinguish due from committed. This does not add a portable journal for every other hook.
- G97: `MODULAR_AGENT_ACTOR` lets peers agree on a stable principal without changing deployment policy. Operator admission remains a separate decision.
- G89, G91, G95 and the deployment coordination limit in G96 are not changed by these fixes.

## Production edition 2

### G100. Divergence risk: a redacted poll while the exact permission request is still live

- Where: `contracts.md`, Approval policy; `acp.md`, Request; the ACP approval projection check.
- Unclear: the core rule forbids a recipient whose approval view was changed from answering through any channel. The kit changes only the polling view and then answers the older, unchanged permission request for the same connection and question. It is not clear whether an exact view already delivered remains valid after a different route is redacted.
- Choice: a changed polling view is always unanswerable and never creates approval authority. An already delivered, unchanged permission request remains valid. If there is no exact route, refuse the call.
- Swap test: yes. A host reading both views could lose a valid permission request on one agent but not another. Specify whether a redacted view invalidates other exact views already delivered.

### Findings settled in this edition

- G88 and G99: leases have a fixed maximum encoded length. An otherwise eligible HTTP fork can publish its initial batch, and an oversized one is refused before PUT.
- G90: the new kit checks the entry envelope for `inputId`.
- G92 and G93: allowed-call mismatches settle as refusals, and settled calls are excluded from the resume list.
- G94 is partly settled: approval projections decide `answerable` after gating. The case with two simultaneous routes is G100. Build-specific reply fields still need deliberate protection.
- G98 and the idle-close part of G84: idle close needs membership only. Cleanup that would cancel a turn or job still needs `cancel`, and the fixture now gives the cleanup actor that right.
- G82: rewind can check remote points without restoring them. This does not create a transaction between files and history.
- G96 now has an explicit deployment limit. Complete shared erasure still requires coordination. G89, G91, G95 and G97 remain relevant.

## Production edition

### G88. Blocker: first fork append cannot be measured exactly

- Where: `history-http.md`, Sessions.
- Unclear: the preflight must account for the encoded lease before acquiring it. The service has no published length limit for the lease, even when a copied prefix is well below 64 MiB.
- Choice: refuse a fork over HTTP before creating any destination. We have no guaranteed lease bound. Local forks do not face this size problem.
- Swap test: yes. One build may refuse all HTTP forks while another assumes a bound and creates a destination it cannot publish. Negotiate a bound or give the size limit a lease-independent component.

### G89. Divergence risk: a renewal reply can arrive after both cutoffs

- Where: `history-http.md`, Writing; `security.md`, Resource limits and denial of service.
- Unclear: the rules specify the loss decision but not how a client's store component reports a lease cutoff to already running tool or Provider work. Checking only at the next append leaves a window where a fast result or environment callback can still cause effects.
- Choice: expose a nonblocking lease check for handoff and arm a separate local loss timer rather than relying on the renewal task to return.
- Swap test: yes for a host or Runtime that treats the store failure as a later write error instead of an immediate loss of dispatch authority.

### G90. Divergence risk: the ACP input assertion requires a legacy field location

- Where: `acp.md`, Entry; `data.md`, Standard kinds; `conformance/acp/run.mjs`, one acceptance and one consumption.
- Unclear: the Entry shape puts `inputId` in the envelope and does not list it among the retained data fields. The check counts entries only if `data.inputId` matches.
- Choice: send both locations for now, keeping the compatibility field to exercise the rest of the check.
- Swap test: yes. A host using just the normative paths should work, but a host following the fixture alone misses entries from a strict writer. The kit should check the envelope.

### G91. Friction: open, view authorization and replay have different boundaries

- Where: `acp.md`, Sessions and Authorization; `contracts.md`, Authority.
- Unclear: a withheld open leaves the session open but unattached. The rules do not give a common idle timeout or a buffering boundary for events from recovery that starts before attachment.
- Choice: hold attachment until the reply passes its gate. Replay then precedes live delivery on the connection. Recovery work is independent of the reply; replay uses committed records.
- Swap test: no for authoritative history. A peer relying on replay as a lossless live event subscription can see timing differences; the binding explicitly does not promise that.

### G92. Divergence risk: a changed dispatch has two plausible error paths

- Where: `plugin.md`, Runtime callbacks; `contracts.md`, Tool dispatch.
- Unclear: runToolCall accepts only an allowed call and out-of-phase requests get `invalid_request`. The final handoff rule also says an allowed attempt that fails a check gets a terminal refusal. The probe expects a changed input on the same call id to settle the call rather than return a request error.
- Choice: no allowance yields `invalid_request` without a write. A call with an allowance whose supplied input differs consumes the allowance and receives a committed refusal, without dispatch.
- Swap test: yes. A Runtime expecting to correct its request and present the old allowance again could find the call already settled. State explicitly whether a mismatch settles or allows correction.

### G93. Divergence risk: synthetic recovery places host settlement before resume

- Where: `plugin.md`, The host asks the Runtime and Model attempt sequences; `conformance/plugin/run.mjs`, synthetic recovery.
- Unclear: the text says the host sends unsettled calls. The fixture precommits `notStarted` and `outcomeUnknown` but still sends those calls in the interrupted list. A Runtime cannot assume those calls still need work, and must not submit its own `notStarted` even as a reference.
- Choice: treat the kept record as authoritative for already settled calls. Leave abandoned calls to the host, which can record ambiguous starts before asking the Runtime to resume so a later model request cannot see an unresolved call as fresh input.
- Swap test: yes. A peer that trusts the array more than history could repeat work or attempt duplicate settlement.

### G94. Divergence risk: protected output is clear for ids, not for every field used by a client

- Where: `data.md`, Output events; `acp.md`, Output gate; `plugin.md`, Held output.
- Unclear: normal replacement strings and actionable data can be in the same unknown object. There is no binding-wide list of text-only paths for every extension. Approval text can also render from several parts of the same request.
- Choice: protect structural keys and reject changes to the exact permission request rather than treating a change to visible approval text as harmless. Arbitrary extension fields are not production-certified.
- Swap test: yes. A host that redacts input arguments instead of withholding the approval can get an approval for a call other than the one the user saw.

### G95. Friction: the portable kit does not certify a production history client

- Where: `conformance/acp/README.md`, crash and portable checks; `history-http.md`, Writing.
- Unclear: the prescribed disposable service has a 15-second TTL, but the late-renewal test requires 1 to 10 seconds. The service can also lag the snapshot during the round. A green invocation at 15 seconds would not show that writer dispatch is fenced when a successful reply arrives after its cutoff.
- Choice: use 15 seconds for the requested matrix and exercise late success separately in an offline client regression. The build is a client and does not claim the service role.
- Swap test: no for the wire. Yes for acceptance evidence if an operator mistakes a skipped check for a pass.

### G96. Blocker: pending cross-session erasure requires deployment-wide coordination

- Where: `contracts.md`, Erasure; `data.md`, Session state; `history-http.md`, Erasure.
- Unclear: the Harness must durably mark known copies before deleting and stop other readers and writers from exposing them. A lease on the source does not fence another session, and the history service intentionally does not interpret erasure intents or provide a cross-session barrier.
- Choice: reserve input keys and persist the source intent before erasing; delete remote copies under a lease and report incomplete work. Do not claim complete erasure across independently running shared-history readers or backups.
- Swap test: yes. A reopener that reads only its own log can expose a copy still pending in another writer's session. Either specify a common pending index for participating readers or explicitly scope the claim to a trusted erasure coordinator.

### G97. Divergence risk: known actors and session limits meet at open, discovery and recovery

- Where: `contracts.md`, Authority and Limits and tenants; `acp.md`, Authorization.
- Unclear: `joinOnOpen` uses the deployment's “single-user local” classification. An address on loopback, local stdio or a named tenant does not alone settle that classification.
- Choice: treat the single configured stdio launcher as one local principal. Preserve recorded grants and refuse departed actors, including across branch changes. No ACP request grants the launcher representation of somebody else.
- Swap test: yes. The same absent member can be joined by an operator-approved local opener and refused by a multi-user opener. Swaps should configure the same recorded principal or explicitly agree on operator admission.

### G98. Blocker: portable cleanup fixture lacks the right to close

- Where: `acp.md`, Authorization; `contracts.md`, Authority; `conformance/acp/run.mjs`, portable authority fixture.
- Unclear: the fixture seeds the cleanup actor without `cancel`, then calls `session/close` after checking an unfinished job. The rules require `cancel` for close, and this is not merely detaching an idle view.
- Choice: refuse the close instead of restoring or ignoring rights. The fixture aborts its remaining queue checks in that attempt. Add `cancel` to the cleanup actor in the kit or disconnect without closing and run the queue test independently.
- Swap test: yes. Accepting this close lets a watcher affect an unfinished job without cancellation authority. A correct reopener should not have to do that to complete the queue check.

### G99. Friction: declaring an HTTP fork that cannot start

- Where: `acp.md`, The declaration and Extension methods; `history-http.md`, Sessions.
- Unclear: `forking: true` means a quiescent session can use the feature, but the HTTP preflight has no guaranteed lease-size bound. Declaring false skips the preflight probe which checks the zero-write refusal.
- Choice: support local forks and refuse HTTP forks without an external bound. Report the coverage limitation separately; the refusal was tested while running the requested portable matrix.
- Swap test: yes. The session declaration should let a client tell ordinary fork support from a transport-wide refusal. The kit should independently probe unsafe requests without requiring a true declaration.

## Round six

### G82. Rewind preflight is missing from the environment wire

- Where: `data.md`, Rewinding; `plugin.md`, Working environment.
- Missing: a rewind checks whether the target point exists before saving a rollback point. The environment wire has `env/save` and `env/restore` but no way to check a point without restoring it. There is also no joint transaction for a restore and a history write.
- Choice: check the point locally. With a served environment, save the rollback point, then rely on `env/restore` to refuse an unknown point before changing any files. If recording the move fails, restore the rollback point. If that rollback also fails, report the failure. This supersedes G78's old behavior after a history write failure.
- Swap test: yes. A foreign environment must reject an unknown point without changing files. A shared preflight request would let the host check before taking the rollback snapshot.

### G83. Tenant budgets use recorded usage, not a reservation ledger

- Where: `data.md`, Limits and tenants and Rewinding; `history-http.md`, Write leases and Erasure.
- Missing: the tenant budget covers several sessions, but leases cover single sessions. There is no shared operation for reserving usage before requests in flight or keeping accounting when every record holding that usage is erased.
- Choice: count all recorded branches of all sessions in the tenant, including closed sessions. Count a finished turn from its `turnEnd` and an unfinished turn from its recorded responses. Do not count our history copies on forks as new use. Check at model boundaries; concurrent steps that started below budget can both contribute. If all records of some usage are erased, it cannot be reconstructed from the shared history.
- Swap test: yes. Shared records give another build the same starting point for accounting if it follows the same rules. Strict concurrent admission and accounting that survives erasure would need a shared rule or operation.

### G84. Tenant creation and idle close

- Where: `acp.md`, Sessions and Limits and tenants; `data.md`, Actors and Limits and tenants.
- Missing: a tenant entry must be first and never erased, while unused sessions leave nothing behind. The binding also does not say whether closing an idle attachment requires `cancel`.
- Choice: record tenant assignment on creation, so a tenant session has an authority record and is kept even if it never runs a turn. An ordinary unused session is still not kept. Closing an idle attachment needs no cancellation right; a close that stops a turn or job needs effective `cancel`.
- Swap test: yes. A client can see different session lists and different close errors if builds make different choices about these cases.

### G85. Two kit assertions use a weaker shape than the rule

- Where: `conformance/plugin/run.mjs`, clean output test; `conformance/acp/run.mjs`, tenant budget test; shared Data, Output events and Limits and tenants.
- Missing: the plugin kit's clean `entry` event sends `data.text` instead of `data.entry`. The tenant check called "without a model request" checks for no `response`, not for no `modelRequest`. The new split check does join the deltas, so it fixes G80.
- Choice: leave both kits unchanged. The served gate tolerates unknown data and leaves clean data alone. The offline tenant regression asserts that no `modelRequest` was recorded, and the output probe sees actual entries with `data.entry`.
- Swap test: yes. A gate that validates shared shapes could reject the malformed fixture. A host could start a request but record no response and pass the tenant assertion.

### G86. No lower reasoning level is offered

- Where: `data.md`, Models and Portable sessions.
- Missing: the nearest accepted level may not exist if the model only lists levels above the session's choice.
- Choice: use `off` when there is no accepted level at or below the choice. Do not increase reasoning. A model change preserves the nearest lower accepted level when one exists.
- Swap test: yes. A Provider that interprets `off` as an invalid level rather than turning reasoning off can fail that request. The description should say what to send to such Providers.

### G87. The background heartbeat check can report a live process as stopped

- Where: `conformance/plugin/run.mjs`, the environment heartbeat checks.
- Missing: the check takes two reads of a file that a concurrent writer truncates and rewrites. It immediately fails if the first read is empty or the file has not changed by its second read.
- Choice: leave the kit unchanged. One parallel suite run reported `[true,false]` for two background processes, then passed the later check that the second process was still running, with no restart between them. Rerun the affected suite with a separate cgroup and no other suites running.
- Swap test: the heartbeat assertion can fail under load or if it reads during a write, even when the environment keeps the process alive. Waiting for a nonempty heartbeat and polling for a later value would distinguish this from a stopped process.

## Round five

### G78. Rewind point lifetime and branch scope

- Where: `data.md`, Rewinding; `plugin.md`, Working environment; `acp.md`, Extension methods.
- Missing: point retention, how to rewind to a different branch, and how to make a history write and a filesystem restore one transaction.
- Choice: save the project files (not the agent's own state) in private snapshots owned by the environment for the open session. Refuse an unknown point, a rewind off the current branch, or a rewind across a recorded job. Stage the files before changing the project. Restore before recording the move. A store failure after a successful restore is not transactional with the filesystem.
- Swap test: yes. The binding should make it clear which moves and point lifetimes a host can rely on. No build may restore another environment's point.

### G79. Erased identities on the history wire

- Where: `history-http.md`, Erasure; `data.md`, History entries; `acp.md`, Entry; the ACP portable checks.
- Missing: the ACP Entry section still describes a tombstone without the four identities. The portable checker skips tombstones rather than checking the required identities. The supplied history service may write older tombstones.
- Choice: expose the shared data tombstone on ACP and the plugin wire, keep the identities in SQLite, and record identity-only metadata with erasures for open sessions so this build can reconstruct older HTTP tombstones. A different reader of the older service can still receive the incomplete tombstone.
- Swap test: yes. A reader without the identities can mistake settled work for interrupted work. The portable kit passing is not evidence that the supplied history service preserves the identities.

### G80. Output redaction check does not prove split chunks were redacted

- Where: `plugin.md`, Output; `conformance/plugin/run.mjs`, hook output check.
- Missing: the test checks a split secret and an unsplit secret together, then looks for a replacement anywhere and searches the serialized JSON for a contiguous secret. Redacting just the unsplit entry can pass.
- Choice: leave the kit unchanged and assert the concatenated text of split deltas in the Python regression suite as well as leaving raw history intact.
- Swap test: yes. A client reassembles split chunks. Independent redaction of each chunk would give it the complete secret.

### G81. Job names and split registrations

- Where: `plugin.md`, Jobs and Choosing plugins at start.
- Missing: a name identifies the owner of a job, but several processes may register disjoint parts under the same name. It is not clear which can take up a job.
- Choice: keep disjoint registrations possible, as in the split conformance plugin tests. A registered name has one route for new jobs and cancellation; a duplicate route cannot start jobs for that name. Record the registered name, never the process index.
- Swap test: yes if two processes with the same name both expect to be independent job owners. Use distinct names for those plugins.

## After the portable-session and Runtime swaps

### G75. The connection actor has no shared namespace

- Where: acp.md, The connection's actor; data.md, Actors and Portable sessions.
- Missing: the new join rule settles the different-id case in G70, but it does
  not say how builds avoid two distinct actors choosing the same id. It also
  does not say how a build distinguishes an unfamiliar right from a right an
  older build spelled differently.
- Choice: keep the advertised local ACP identity `user`. If that id already
  exists, it is the same key, and the new join replaces its known rights when
  they differ from the local policy. Retain unknown names without granting
  them, and leave every other actor as recorded. Do not treat the old
  `tool` spelling as `tools` in shared records.
- Swap test: yes. Two builds that reuse an id for different principals can
  disagree about who owns historic work. Older custom actors with private
  right names may have fewer effective rights when reopened.

### G76. Proposed input and subagent jobs

- Where: data.md, Actors; acp.md, Prompts and Extension methods; contracts.md,
  Authority and Jobs.
- Missing: ACP has no operation to propose input and no operation to release
  a proposal. The rights table also does not say how `delegate` and `jobs`
  combine when starting a subagent uses a job record.
- Choice: recognize `propose` without letting it submit or steer input. Do
  not invent an ACP proposal operation. Require `delegate` for the
  subagent action and `jobs` for creation of its backing job.
- Swap test: yes. Hosts cannot request or release proposals portably, and a
  role with `delegate` but not `jobs` may behave differently across agents.

### G77. A refusal before a repeat is not a result from the tool

- Where: data.md, Interrupted turn; plugin.md, `host/runtime/runToolCall`.
- Missing: the Runtime can see a gate refusal or a failed request, but an
  ordinary ToolResult reply does not say whether the host recorded a fresh
  `toolStarted` before returning it.
- Choice: the served Runtime treats a refused gate or rejected replay request
  as `outcomeUnknown`. The host rejects calls that lose authority before
  execution and checks its own start record before keeping a result from a
  Runtime. A saved result from an earlier execution still wins over a guess.
- Swap test: yes. A host that returns an ordinary `refused` result without
  recording a new start can lead a swapped Runtime to report a refusal
  rather than the unknown effect of the previous run.

## Round four

### G66. The supplied history service does not send a retry hint

- Where: history-http.md, Writing and What the service declares.
- Problem: the supplied service returns HTTP 409 with `code: "held"` and a
  message, but no `retryAfterMs`. Its `GET /v1` declares `ttlMs: 15000`.
  Observed by making two lease requests with different owners, without reading
  the service. The portable ACP crash check exposed this.
- Choice: use `retryAfterMs` when present. If absent but the TTL is declared,
  try every 250 ms within that TTL. The service remains the sole authority that
  can grant the lease. Never reacquire a lease that this writer lost.
- Swap test: yes. A client that requires the documented retry field cannot
  reopen through this service until a human retries.

### G67. Accepted but not yet taken input has no standard entry

- Where: data.md, Portable sessions and `input`; acp.md, Prompts and Cancelling.
- Missing: the receipt exists before input is taken, but the standard `input`
  entry is only written when input is taken. There is no kind for handing back
  a receipt without taking the input either.
- Choice: record queued and withdrawn receipts under `python.*`; copy the key
  and receipt id into the standard taken input. Standard history suffices for
  taken inputs and keys, but another build cannot restore an outstanding
  Python receipt it does not understand.
- Swap test: yes. A crash between receipt and admission can lose untaken input
  on a swap. A shared queued-input and withdrawal shape would settle it.

### G68. A started model request has no standard record

- Where: data.md, History entries; plugin.md, The host asks the Runtime;
  contracts.md, Recovery and repeating work.
- Missing: the standard entries do not distinguish a step that has not called
  the model from a step whose model request may already have outside effects.
  They also do not say whether a recorded failed response had a retry authorized.
- Choice: the public Runtime rebuilds its step count and usage from recorded
  responses, uses the host's repeat-safety decision for tools and treats a model
  request that left no response as unrecorded. The native Runtime can use its
  own model request record to avoid repeating an unsafe native request.
- Swap test: yes for a Provider that runs tools, and for retry budgets at the
  crash boundary. A portable effect-safe model admission record is needed.

### G69. Call continuation and question identity across hosts

- Where: data.md, Questions and Portable sessions; plugin.md, The host asks the
  Runtime and What a plugin may ask the host.
- Missing: there is no common mapping from a reissued ask to a previously answered
  question after a swap. `answerable` is named but its type is not given. A
  continued call is sent with the old call id, but has a new turn.
- Choice: use the standard request id and answer to restore question state, and
  the originating response plus `turnEnd.result.openToolCalls` to link late
  continuations. Retain native ask-key and owner details for exact native
  reattachment. Keep old call ids when continuing a call.
- Swap test: yes. A different host may be able to accept the answer but ask the
  same question again when the interrupted tool resumes.

### G70. Session identity and replay rights are not portable yet

The refreshed ACP and data bindings settle the connection join and the right
names. G75 records the remaining questions.

- Where: data.md, `actorJoined` and Portable sessions; acp.md, Names and
  `initialize`; contracts.md, Authority.
- Missing: no vocabulary for rights, no mapping from an ACP host actor id
  to the recorded actor, and no rule for actor-less old records.
- Choice: replay the recorded actors and their rights in insertion order. Use
  the bound local `user` actor for simple sessions without actor records; do
  not claim that arbitrary recorded identities are authenticated by ACP.
- Swap test: yes. A build using another actor id or rights vocabulary can refuse
  even an otherwise readable session. This needs a shared actor mapping.

### G71. A turn snapshot is required before its input is taken

- Where: data.md, `turnStart`; plugin.md, The host asks a hook handler and
  Who records what.
- Missing: `turnStart` needs the system prompt and tools, but `turn.before`
  contributes to the prompt and may expect to see the input on the branch.
  There is no standard representation of its contributed non-system context
  before the first model response.
- Choice: give the hook the admitted input directly, write the snapshot, then
  record the input. Recovery uses the recorded system text. A failed
  preparation records the failure without sending a model request.
- Swap test: yes for hooks that inspect history instead of their payload, and
  for non-system context that has not reached a response yet.

### G72. Page size and notification reentry need an exact boundary

- Where: plugin.md, Transport and Paging history.
- Missing: whether bytes include the envelope and cursor, and what order to
  use when applying a notification requires a nested request whose answer
  arrives after that notification.
- Choice: count UTF-8 JSON, leaving space for the page wrapper and cursor.
  Apply ordered notifications before delivering ordinary responses. A reply
  to work initiated by that notification may satisfy it first.
- Swap test: yes at the byte limit or with a notification that refreshes tools.
  A literal wait for every prior notification can deadlock.

### G73. Erasure acknowledgements and stateful Providers

- Where: history-http.md, Erasure; plugin.md, `provider/discard`;
  data.md, Portable sessions.
- Missing: the binding does not prescribe stable identities for pending or
  unreachable copies, or which Providers may still have state for an old
  session after its Provider has changed.
- Choice: await the loaded stateful Providers for the affected sessions,
  preserve their reported names and report an unavailable Provider as pending.
  Erasure never claims to recall already delivered output.
- Swap test: yes for retries and what a host can promise the user. Provider
  ownership and pending-copy identifiers need shared meaning.

### G74. Runtime wire kinds during question continuations

- Where: plugin.md, `runtime/continueOpenCalls` and `host/runtime/record`;
  data.md, History entries.
- Missing: a started call with a saved unanswered question is not necessarily
  safe to repeat, but a tool left open past the turn starts again after an
  answer. There is no standard checkpoint for in-turn question suspension,
  distinct from an unsafe interrupted effect.
- Choice: distinguish explicit late continuation from interrupt recovery and
  use `safeToRepeat` for the latter. Native question replay can use its
  question journal, but the public Runtime does not infer a repeat promise
  from the presence of a question.
- Swap test: yes. A build needs to distinguish resuming a safe waiting point
  from reexecuting an effect that may already have run.

## Bindings

Round two follows `modular-agent-acp/1`; round three follows
`modular-agent-plugin/1`. These entries supersede the original
ACP wire choices in G36 to G38 where they differ. Legacy Python extensions remain
available as additional methods, but hosts using the shared binding use its
`sessionId` envelopes and unwrapped results, not the old `session`/`value` aliases.

### G44. Cancellation during command admission

- Where: bindings/acp.md, Cancelling; conformance/acp/run.mjs, cancel check;
  architecture.md, Working environment; contracts.md, Runtime cancel and
  effects-before-answer.
- Missing: the binding's five-second cancellation check reaches a startup window
  not covered by the description's command lifetime rule. A watcher can receive
  lifetime EOF before its forked child has entered the command cgroup.
- Choice: the child acknowledges successful cgroup admission through a pipe.
  Before acting on EOF, the watcher waits for acknowledgement or child failure.
  It then kills the populated group and reaps every child. A deterministic test
  delays admission and cancels in that window. The unchanged kit reproduces the
  original five-second fallback and passes after this fix.
- Swap test: yes for cancellation completion and the lifetime guarantee, not for
  the private acknowledgement mechanism. A host must not race a surviving call.

### G45. The spontaneous-turn enum omits late answers

- Where: bindings/acp.md, declaration `startsTurnsUnasked`; architecture.md,
  Waiting for an answer; scenarios.md 3.
- Missing: the binding permits only `never` and `jobReports`, but the frozen
  description also allows a late answer to settle open calls and start a turn.
- Choice: retain that required late-answer behaviour. Declare `jobReports`, the
  closest allowed value, and add `lateAnswersStartTurns: true` to the declaration.
  A binding regression answers a question after its completed turn and observes
  the resumed work. No extra scheduling or autonomous input is added.
- Swap test: yes. A host reading only the enum could wrongly assume that job
  reports are the only source of unasked turns. The enum needs a late-answer case
  or an explicit statement that this continuation is outside its meaning.

### G46. Restart hand-back has no named response field

- Where: bindings/acp.md, declaration `queuedInputAfterRestart`, Prompts and
  session/load/resume; contracts.md, Runtime cancel; scenarios.md 7 and 9.
- Missing: the declaration permits `handedBack` after restart, but only cancelled
  prompt responses have a defined place to return the input and its content.
  There may be no pending prompt connection after a restart.
- Choice: the transient Runtime records each untaken input as withdrawn, rather
  than accidentally running it with a later submission. Load/resume additionally
  returns `_meta["modular-agent"].handedBack` for input returned during recovery.
  This is gated output, as are the corresponding history entries and optional
  events. Durable recovery declares `run` and drains that input instead.
- Swap test: yes for delivering returned input to a host. The declaration alone
  is insufficient without a common place and shape for the returned content.

### G47. Admission identity and duplicate-result correlation

- Where: bindings/acp.md, Prompts, input and Entry; contracts.md, Input and history.
- Missing: whether `inputId` must equal the visible input history entry's ID, and
  which turn a resent key describes after later turns have run or after restart.
- Choice: `inputId` is the persisted admission receipt's identity. Taking it makes
  a separate visible input entry that links to that identity. A duplicate returns
  the outcome of the turn which took that admission, not the most recent Runtime
  task's result. Completed duplicates do not wait for unrelated running work.
  Additional private fields remain on history entries, alongside the binding's
  required IDs, millisecond time, message roles, kinds and outcome object.
- Swap test: yes if a host assumes `inputId` always names a visible `input` entry.
  The binding should say which identity it names or define the link explicitly.
  Private additional entry fields are not portable host inputs.

### G48. Provider names in model option values

- Where: bindings/acp.md, Configuration options; contracts.md, Model access.
- Missing: `provider/model` fixes the syntax but not the provider's identifier,
  including when the transport is Claude Code rather than a direct vendor API.
- Choice: expose `claude/claude-haiku-5-5`, `fake/fake` in offline scripted tests,
  and the binding's exact `conformance/echo` only in conformance mode. Translate
  those IDs at the ACP boundary; private persisted model access is unchanged.
  Approval similarly translates `off`, `ask`, `all`, `never` into existing policy
  names. Model changes select thinking `off`, then offer that model's real levels.
- Swap test: yes for hosts reusing a saved model ID without reading the catalog.
  Hosts discovering options work. Shared real-model provider IDs need agreement
  if saved selections are intended to transfer between builds.

### G49. Project scope versus fixed startup composition

- Where: bindings/acp.md, Starting and Sessions; architecture.md, plugins and
  project; this build's fixed startup composition.
- Missing: whether an ACP connection must accept arbitrary project roots, even
  when its executable plugins and trust were selected for one startup project.
- Choice: keep the existing one-project-per-process restriction for new/load/resume,
  declared by the Interface's `one_project_per_process` field. Refuse a different
  cwd before changing anything. A host launches in the desired project or passes
  `--project`. Listing is read-only and now covers all kept projects without cwd,
  or exactly the supplied cwd. `MODULAR_AGENT_DATA_DIR` overrides `--home` for all
  built-in internal state, including trust and command journals. Tool file effects
  still belong in the project, not the internal data directory.
- Swap test: yes for a host that changes project roots on an existing connection.
  The binding should allow a declared single-root agent or require a separate
  composition per project. This build does not silently reuse another project's
  executable settings or widen trust. The kit's fresh startup project is supported.

### G50. Session-wide token budgets have no stop-reason row

- Where: bindings/acp.md, Prompts stop-reason mapping; contracts.md, limits.
- Missing: the mapping covers step and model output limits, not an existing total
  session input-plus-output token budget.
- Choice: use `max_tokens`, with `outcome.kind: limit` and
  `outcome.limit: "session token limit"`. A step budget uses `max_turn_requests`;
  the Provider's output limit uses `max_tokens` and `"output limit"`. Failed and
  cancelled outcomes remain distinct, including failed duplicate prompts.
- Swap test: yes if hosts interpret every `max_tokens` as a single model output
  truncation. The outcome's limit string disambiguates this build, but its values
  are not standardized by the binding.

### G51. Working-environment requests have no session lifetime

Settled in round four: environment requests carry `sessionId`, and `env/sessionEnded` stops only that session's background work.

- Where: bindings/plugin.md, The host asks the working environment and Ending;
  contracts.md, The working environment.
- Missing: `env/*` has `cwd`, not a session identity, and there is no session-close
  request for the working environment. Two sessions may have the same cwd. The
  description requires background processes to survive calls and cancelled turns,
  but stop at session close, which cannot be expressed by these messages alone.
- Choice: do not invent a mandatory extension or kill another session's work.
  The conformance environment groups command lifetimes by cwd, keeps completed
  commands' background children until plugin shutdown or stdin EOF, and uses the
  existing strong Linux cgroup containment. Cancelling an unfinished exec kills
  its whole command tree before answering. A local environment still cleans up on
  native session close. Remote background cleanup at individual session close is
  not expressible in stage 1 and remains a known limit.
- Swap test: yes. Strong agent-lifetime containment is portable and tested,
  including EOF and setsid. Session-close cleanup needs a session identity and a
  lifecycle request, or an explicit rule that environment plugins register a
  session-end handler and how it relates cwd-only execs to sessions.

### G52. Replacements name items rather than whole native plugins

Settled in round four: only the named items are replaced, and the host refuses the whole registration before exposing any part of it.

- Where: bindings/plugin.md, Starting and The conformance plugin;
  contracts.md, Plugins and capabilities.
- Missing: the description removes everything a replaced plugin registered, while
  the binding names individual tools. This build's file source owns read, write,
  edit and bash together. Also, the conformance plugin always names replacement
  targets even on a host which did not install those defaults.
- Choice: take the binding's item identities literally. Remove local read and
  bash definitions from their source, retain write and edit, unload the local
  Provider and working-environment plugins, and remove named command registrations.
  A replacement of an absent local item is an addition. It must actually provide
  the named item. A second external claimant is refused even if it says replaces;
  the binding says replacements are of the host's own items. No local item remains
  behind a dispatch shadow. Startup failure cleans up the external registration.
- Swap test: yes. Item replacement versus whole-source replacement changes which
  tools remain. Requiring an absent target would prevent the prescribed conformance
  plugin from adding its Provider outside conformance mode.

### G53. Callback authority, bootstrap reads and credential representation

Settled in round four: the authority table separates live parents, direct session access and session-free methods. Credentials now have a shared `type` and `key`.

- Where: bindings/plugin.md, Transport and What a plugin may ask the host;
  data.md, Questions; contracts.md, Authority and Secrets.
- Missing: some callback params have a parent request, others only a session, and
  credential reads have neither. The wire has Provider identities, while this
  build's credential store uses names and may hold strings rather than objects.
- Choice: effects, questions and Provider hook calls require active parent work.
  Reject forged parents, mismatched sessions, unowned Provider hooks and foreign
  credential reads. Environment calls inherit the initiating actor, tool-call
  ceiling and all turn contributors' current rights. A gate may change tool input,
  never the actor or authority lineage; cwd must be in that session's
  project. Direct session/history/declaration reads may name an open session using
  that plugin. Credentials are read only for a registered Provider's identity;
  missing credentials return null, stored objects pass through, and strings become
  `{ value }`. Secret questions cannot overwrite registered Provider credentials.
  Unattended questions use the existing recorded decline/pending rules.
- Swap test: yes. A credential object's vendor-specific contents and bootstrap
  access policy are not standardized. Hosts and plugins must agree on its meaning.
  Parent lineage, session ownership and narrowing are observable security rules,
  not transport details. No credentials are passed through the Runtime.

### G54. History pages, oversized entries and multi-setting records

Settled in round four: `after`, `next`, limits and oversized-entry errors are fixed, as is the `settings` key.

- Where: bindings/plugin.md, `host/history`; data.md, History entries.
- Missing: the meaning of `next`, what to do if one entry exceeds 4 MiB, and how to
  represent a native setting entry that changes several keys atomically. The
  shared shape has only one `data.key` and `data.value` per entry.
- Choice: `next` is the last returned entry identity, suitable for the next
  `after`. Refuse unknown cursors and invalid limits. Count UTF-8 JSON bytes,
  including cursor overhead, and never split an entry. An entry too large to fit
  alone gives `result_too_large`, not an empty page that loops forever. Translate
  required entry/message fields, preserve additional fields and unknown content,
  and return only the four required identity/tombstone fields for erased entries.
  A multi-setting record uses `key: settings` and the whole change object as value,
  while retaining the original fields. A single setting uses its actual key.
- Swap test: yes. Cursor interpretation, large-entry fallback and multi-setting
  semantics need agreement for a portable history reader. None needs the private
  SQLite layout or native entry spelling to be standardized.

### G55. A list-change notification is an effect barrier

Settled in round four: both peers must keep reading, with notifications applied before the later answer.

- Where: bindings/plugin.md, tools/changed; contracts.md, Interactions.
- Missing: a notification has no acknowledgement, yet its list refresh must
  finish before the answer behind it is passed on. A naive serial reader can
  deadlock by waiting for tools/list while refusing to read that response.
- Choice: keep reading full-duplex requests and responses while ordered
  notification handlers run. An answer waits for earlier notification processing;
  a list refresh initiated by that processing can receive its own answer without
  waiting on itself. Cache lists separately for per-session sources, reserve
  names across those lists and reject duplicate contributions. There is no
  arbitrary work timeout. Cancellation propagates through nested callbacks and
  waits for their cleanup; shutdown has a bounded process-close fallback.
- Swap test: yes for effects-before-answer and cancellation completion. The task
  scheduling mechanism is internal. The tests change lists through a command,
  immediately inspect both sessions, and cancel/loss-test nested command work.

### G56. Provider response hooks carry messages, not stream events

Settled in round four: the hook runs once, with the complete assistant message, after the stream.

- Where: bindings/plugin.md, The host asks a Provider and standard hook points;
  contracts.md, Hook points and Provider middleware.
- Missing: the prose says "as the response arrives", while `provider.response`
  takes an assistant `message`, not the stream-event shape. It does not say whether
  that is a partial snapshot for every event or one completed message.
- Choice: adapt a native Provider's request and completed response at its
  capability boundary, with the shared request/message shapes. External Providers
  own and invoke these hooks themselves through host/hook, and every authorized
  invocation is delivered; the host does not double-fire them. Text and other
  Provider events stream independently before the result. Unknown response fields,
  content parts and providerData survive history and the next model request.
- Swap test: yes for an observer depending on per-piece callback count or partial
  message semantics. The binding should say when this message hook runs and how
  partial messages are marked. The conformance Provider invokes it once per reply.

### G57. Missing-file errors needed a shared code (closed)

- Where: bindings/plugin.md, Transport and The host asks the working environment;
  the 2026-11-17 change after the four-language matrix.
- Missing: the earlier binding had no missing-file code. This build returned a
  generic error and its prompt plugin recognized missing AGENTS.md by English
  message text. Other environments' messages broke otherwise valid turns. The
  updated binding closes this gap with `not_found` for env/read and host/env/read.
- Choice: native text and binary reads translate FileNotFoundError to `not_found`.
  The served environment uses the same binary read path. Host callbacks preserve
  that code from local, private-process and public-wire environments. The prompt
  ignores only `not_found`, never message text; other errors still fail the turn,
  even if their message contains "No such file". Offline regressions cover a
  non-English external error, both native reads and both callback placements.
- Swap test: yes. A missing optional context file must not prevent a turn just
  because another environment describes its absence differently. The shared code
  is necessary for interchange; the human-readable message remains build-specific.

### G58. The restart envelope carries calls, not the rest of the turn journal

Settled in round four: durable recovery reads the standard entries with `host/history`. The public Python Runtime no longer needs the private checkpoint.

- Where: bindings/plugin.md, `runtime/resumeTurn` and the `host/runtime/*`
  table; bindings/data.md, History entries; contracts.md, Recovery and repeating work.
- Missing: `started` does not distinguish an unfinished effect from a completed
  effect whose result was not yet published. The envelope also has no prior
  replay promise, containment declaration, step count, usage, last recorded
  response or indication that a model request was interrupted. A prepared model
  context is not the journal. Provider `supports` has no shared safe-to-repeat
  promise.
- Choice: the Harness derives `interrupted.calls` from the current branch and
  uses response call parts to repair incomplete admission. It never sends a
  call that has a recorded result. With just the standard envelope, the served
  durable Runtime runs the unstarted calls and marks started calls unknown.
  The Python Harness also supplies an optional `pythonRuntimeCheckpoint` and
  a prior `safeToRepeat` on a call where known, computed from the journal after
  reopening. Its Runtime can reuse a receipt, resume from the last response,
  restore step count and usage, and repeat a started call only with recorded and
  current promises and containment. It fails closed on a recorded interrupted
  request to a stateful or tool-running Provider. Other hosts and Runtimes do
  not need to know those extra fields to run the standard recovery case.
- After the Runtime matrix: the binding now permits `host/history`. The Python
  Harness accepts it with the active turn's `parentRequestId` and the same session,
  using the turn's effective `watch` authority. Non-Runtime plugins can still use
  direct session reads (G53); a plugin registering a Runtime must supply parent
  work even if it also registers other capabilities. This closes the matrix
  failure, but raw history does not standardize receipt or checkpoint records.
- Swap test: yes. Peers must agree on `host/history` and turn scoping to recover.
  Portable replay beyond the basic interrupted-call case still needs shared
  recovery records or a richer restart envelope to avoid losing completed work,
  repeating effects, or resetting turn limits.

### G59. Who records turn admission and recognizes tool calls?

Settled in round four: the host records admission, starts of effects, and the turn's outcome. The Runtime records responses and results.

- Where: bindings/plugin.md, `runtime/runTurn`, `host/runtime/record` and
  `host/runtime/runToolCall`; bindings/data.md, History entries.
- Missing: the first input and its stable input ID are absent from `turn`.
  `takeSteering` only describes input for the running turn. The Runtime can
  write `turnStart`, but a crash before that callback would be invisible to
  reopening. The binding says the host records tool starts, but it defines no
  portable start or call entry kind.
- Choice: the Harness commits turn admission and the first input before it
  delegates, and a Runtime recording `turnStart` gets that same entry. The
  recorded response's `toolCall` parts are the portable call list. The Harness
  also normalizes a `toolCall` record or creates local call entries as needed
  for tool updates and recovery. The parent request, not a plugin-supplied
  actor or session, owns authority, entry identity and turn association.
- Swap test: yes. Independent implementations must agree on whether initial
  input is already recorded and on which committed records identify unfinished
  work. The exact local journal kinds can otherwise differ.

### G60. The Runtime hook boundary lacks gate and end-order details

Settled in round four: gates return a payload and reason, and the Runtime's last request is `turn.end`.

- Where: bindings/plugin.md, `host/runtime/hook`, `host/runtime/runToolCall`
  and the rule refusing callbacks about ended turns; contracts.md, Hook points.
- Unclear: the Runtime gate result does not type `refused` or `pending`.
  `tool.before` changes only `{ call }` in the handler table, while a combined
  gate returns `{ value }`. A `turn.end` observer should see a committed end,
  but calling its hook after recording `turnEnd` is a callback about an ended
  turn. There is no separate call for acknowledging an approved tool input.
- Choice: refusals and pending reasons are strings, as in the kit. A combined
  tool gate returns the whole payload in `value` with its transformed call.
  The Harness consumes a single-use approval for that exact call and input
  when `runToolCall` arrives. The served Runtime asks for `turn.end` before
  recording `turnEnd`. The Python Harness delivers end observers once after
  the committed end and refuses further callbacks for that parent.
- Swap test: yes. A peer that omits the gate, assumes a boolean refusal or calls
  the end hook after closing the journal can skip a check, lose a reason or
  receive `invalid_request`.

### G61. Runtime reports have no shared event vocabulary

Settled in round four: the host emits standard live output itself. The Runtime supplies `stepId` and no longer reports live text.

- Where: bindings/plugin.md, `host/runtime/report`, `host/runtime/model` and
  `host/runtime/runToolCall`; bindings/data.md, stream events.
- Missing: `report` is called a notification but is listed with requests, and
  it has no named event types or payload shapes. Tools can stream progress to
  the Harness, but there is no Runtime-side tool progress notification.
- Choice: the served Runtime sends `modelOutput` as a notification with the
  stream event in `data`. The Harness also accepts a request and common spelling
  variants, applies the output gate, and otherwise uses recorded response text
  for ACP. It publishes tool progress directly from the tool callback, through
  the same gate. Unrecognized reports stay generic events.
- After the first Runtime swaps, the binding tells the host to emit standard
  events itself and adds `stepId` to `host/runtime/model`. Python still uses the
  Runtime's report for live model text and sends `host/runtime/model` without
  `stepId`, using the step saved at preparation on the host. This was not changed
  in the history correction.
- Swap test: yes for live streaming, even when final history and outcomes agree.
  A Runtime that follows the clarified binding and does not report model text
  can lose live text on this host. A host requiring `stepId` on model requests
  can refuse this Runtime's request.

### G62. Result immediacy and call order use different records

Settled in round four: record completed results immediately and order the model's view by the original calls.

- Where: contracts.md, Running turns and tools; bindings/plugin.md,
  `host/runtime/record`; conformance/plugin/run.mjs, parallel Runtime checks.
- Conflict: Contracts says each parallel result is recorded at once and the
  model sees call order. The kit tests that the visible `toolResult` records
  themselves are in call order. For a fast second tool and slow first tool,
  one record per result cannot meet both requirements.
- Choice: the served Runtime records an invisible `toolFinished` receipt as
  soon as a result passes `tool.after`, then publishes one visible `toolResult`
  in request order. The recovered Python Runtime reuses the receipt rather than
  rerunning the call. The receipt kind is not portable (G58).
- Swap test: yes for crash recovery and history observers. A shared receipt
  or an explicit distinction between commit order and view order is needed.

### G63. The Runtime binding covers turns, not every Runtime operation

Settled in round four: UI tool calls stay with the host and a hosted Runtime cannot rewind.

- Where: bindings/plugin.md, the Runtime methods and `turn.settings`;
  contracts.md, Running turns and tools; bindings/acp.md, The declaration.
- Missing: no public Runtime method for a tool call a UI starts, no callback
  for checking host-wide budgets, and no parameter for local policies such as
  a model retry count. The declaration also separates waiting for an open
  question from continuing a turn, while the older native Runtime uses one flag.
- Choice: the Harness retains input admission, keyed receipts, question and
  session lifecycle, and the existing checked UI tool path. It passes the
  shared settings, maps the two restart claims independently, and the served
  Runtime defaults to at most one model retry. Local session token budgets and
  full starting snapshots are not certified for public Runtime swaps.
- Swap test: yes for extensions that depend on which Runtime owns UI tool calls
  or on exact budget and retry behavior. Neither is in the stage 2 kits.

### G64. A cancel before callback dispatch can leave no reply

Settled in round four: cancellation before work starts must still be answered.

- Where: bindings/plugin.md, Transport, Cancelling (clarified after the Runtime
  matrix).
- Found: an in-flight `host/*` handler stops and sends `cancelled`. When a request
  and its `$/cancel` are read from the same buffer before dispatch starts, the
  receiver cancels the callback task before it can send a reply. A local probe
  reproduced three missing replies while the peer still answered `$/ping`.
- Choice: leave this separate transport race out of the Runtime history
  correction. A follow-up needs to send `cancelled` for a queued request without
  dispatching its work, as well as answering when cancellation lands in flight.
- Swap test: yes. A peer that waits for the reply as required can hang even
  though the cancelled handler never ran.

### G65. Runtime registration alone does not replace the native Runtime here

Settled in round four: registering a Runtime implicitly replaces the one native Runtime, but never a Runtime already registered by another external plugin.

- Where: bindings/plugin.md, Starting: the handshake, `runtime` and `replaces`.
- Found: the binding says that registering a Runtime replaces the host's Runtime
  automatically. The Python host still refuses that registration unless it also
  includes `runtime` in `replaces`. The history regression fixture exposed this
  during setup.
- Choice: the fixture and the served Runtimes declare the replacement explicitly.
  Changing startup validation is outside this correction.
- Swap test: yes. A Runtime that relies on implicit replacement cannot start on
  this host, even though explicit replacement works.

## G43. Concurrency hidden by in-process scheduling

- Where: contracts.md, Interactions, "An answer comes after its effects";
  architecture.md, Sessions, Jobs and keyed input.
- Missing: whether observing a committed job end also confirms report admission,
  and which session changes must be serialized when a store or Runtime yields.
- Choice: jobs.wait admits the keyed report before answering, including when it
  observed an end during report delivery. Per-session Runtime admission locks
  make concurrent submissions of one key exactly one admission. Per-session
  Harness append locks span the durable write, but release before event delivery
  so event handlers can re-enter the API. Transient lifecycle flags changed
  during a store write are preserved when that write returns. Re-reading the
  live session under the lock avoids overwriting a concurrent append.
- Swap test: yes for observable ordering and idempotence. Locks are internal.
  Moving plugins exposed a real earlier wait/report race; no sleep or retry
  was used to hide it.

## G39. Process placement and the private binding

- Where: architecture.md, Goals, Out of scope and What plugins can do;
  contracts.md, Interactions; ADR 0010.
- Missing: startup placement, framing, callback addressing and version negotiation.
- Choice: `ma-process` wraps an unchanged plugin at startup. Placement names
  plugins or roles, or all, through embedding, CLI or environment; a trusted
  configured factory can override its own placement. A private socket pair carries
  length-prefixed JSON frames with request IDs in both directions. The API remains
  version 1; a child runs the identical installed Python environment. Capabilities,
  hooks, commands, event followers and stream callbacks get connection-local
  addresses. Hooks still combine only in the Harness under the original owner.
- Swap test: the wire format is rightly left to this build. API versions,
  addressed data and hook/error semantics would break independently written
  plugins, so they require an implementation-level binding contract.

## G40. Cancellation and stream acknowledgement across processes

- Where: contracts.md, Harness and tool source, Runtime and Provider;
  scenarios.md 5; architecture.md, Surviving interruptions.
- Missing: whether cancellation confirms cleanup or merely dispatch, and how a
  stream consumer can slow a producer.
- Choice: every stream piece is an acknowledged nested request. The reader keeps
  dispatching during outstanding requests, including callbacks into the sender.
  Cancellation follows each awaited request and waits for its terminal reply,
  including nested cleanup, before returning. Completed responses win normally;
  dropped connections cannot claim that an effect was cancelled.
- Swap test: yes for completion and cleanup guarantees; framing and IDs are internal.

## G41. Plugin-process loss and failed lifecycle observers

- Where: architecture.md, Guarantees and Surviving interruptions; contracts.md,
  tool results and hook points.
- Missing: the consequence of losing one plugin while the Harness remains alive.
- Choice: EOF fails all waiting calls with `process_lost`, identifying the
  plugin. The Harness emits `plugin_failed` through the output gate. An affected
  started tool gets one unknown result and the Runtime may continue. There is
  no silent restart or effect replay. Lost observe-only lifecycle handlers are
  skipped after reporting; lost collect sources contribute nothing (including
  their unavailable tools). Failed gates still refuse and failed transforms
  still fail closed. Losing a Runtime or essential history service cannot promise
  continuation and is reported rather than replaced.
- Swap test: yes. Failure classification and whether effects replay affect hosts
  and plugins; the process supervisor's mechanics do not.

## G42. Startup construction and process ownership

- Where: architecture.md, Hosting plugins, Working environment and Declared support;
  contracts.md, Plugin and Harness.
- Missing: how plugin construction moves, when resources may open, and whether
  commands die when only the Harness process stops.
- Choice: exec a clean interpreter. A private anonymous inherited file carries
  trusted pre-start construction using cloudpickle 3.1.2, never untrusted input
  or durable storage. Plugins acquire live resources in start, not constructors;
  already-running tasks, open SDK sessions and uncopyable construction are
  refused, not silently kept local. The child inherits only stdio and its own
  bootstrap/socket descriptors. Harness EOF cancels incoming work and stops the
  plugin, including independent Runtime tasks and command lifetimes. Normal stop
  joins/reaps every worker; a bounded shutdown escalates by its exact PID.
- Swap test: construction is an implementation constraint for plugin authors.
  Resource ownership and command lifetime are observable host guarantees.
  A fork-only prototype failed when inherited asyncio/SDK descriptors were reused;
  it was replaced with exec before acceptance testing.

## G32. Configured plugin names, options and trust records

- Where: architecture.md, Configuration and What plugins can do; contracts.md,
  plugin about to load; open-questions.md, Plugin lifecycle and Configuration.
- Missing: plugin discovery syntax, the division between session defaults and
  executable plugin settings, and who can persist project trust.
- Choice: settings name installed Python factories as `module:attribute`, with
  JSON `options` and optional explicit `replaces`. `plugin_settings` is a separate
  map, merged by factory name one level deep (`mcp` names the built-in adapter). Project session defaults still apply
  without trust. Only an explicit local `--trust-project` action writes the
  canonical path to the data directory's trust file; project files cannot grant
  trust. Revocation applies on next startup. The Harness runs its load gate before
  importing configured code. A load failure stops the partial composition.
- Swap test: yes. Names, options, trust persistence and activation boundaries affect
  plugins and hosts. The trust file encoding is internal.

## G33. Project composition and fixed plugin lifetime

- Where: architecture.md, Configuration, Sessions and Declared support;
  open-questions.md, Plugin scope; contracts.md, Session.
- Missing: how project executable settings coexist with fixed process-wide plugins
  and sessions that may name different projects.
- Choice: the runnable composition binds to its startup `--project`. It may host
  many sessions of that project, including subagents. A different project is
  refused before it can start work, rather than leaking trusted plugins to it.
  Reopening from the CLI without `--project` selects the saved session's project
  before loading executable settings. Embedding without a bound project loads only
  global plugin configuration.
  Project plugins and plugin options are selected once at startup. No hot loading.
- Swap test: yes. A host needs to know the project binding and must start another
  agent for a different project. This is an explicit declared limitation, not an
  assertion that the description requires one process per project.

## G34. MCP tool identity, hints and unsupported server features

- Where: architecture.md, Tool source and Declared support; contracts.md, Tool
  definition and Harness and tool source; published MCP tools specification.
- Missing: naming across servers, annotation defaults, concurrency, and the scope
  of MCP features beyond tools.
- Choice: tool names use a readable shortened tool name plus a stable hash of server
  and original name, fitting the Provider's tool naming limits. Definitions preserve
  the original MCP metadata. Read-only and idempotent annotations supply the
  safe-to-repeat hint; destructive and open-world defaults are conservative. Hints
  do not bypass approval or authority. MCP has no concurrency hint, so calls are
  sequential. Tool lists are paginated and refreshed before steps and calls;
  changes are reported. Sampling, server elicitation, resources, prompts and legacy
  SSE transport are not advertised. Tool content, structured results and metadata
  are retained. A failure before dispatch is failed; losing the server after dispatch
  is an unknown outcome that explicitly tells the model to check external state.
  Neither case performs extra inference in the tool source.
- Swap test: yes. Names, hint defaults, supported transports and feature negotiation
  affect plugins and hosts. Hashing and connection-task mechanics are internal.

## G35. MCP connection scope and ephemeral host configuration

- Where: architecture.md, session-specific tools and Working environment;
  contracts.md, Session and tool source; ACP session setup specification.
- Missing: connection sharing, host-server overrides, recovery setup ordering and
  whether host connection secrets belong in history.
- Choice: settings servers connect once and serve all sessions. Host servers connect
  per session, before recovery can run, close on session close or process shutdown,
  and are not inherited by subagents. Duplicate server names and shadowing a settings
  server are refused. Host server env and headers stay in Interface/lifecycle data,
  never session settings, history or declarations. Reopening must supply them again.
  Official SDK stdio teardown is used; unlike the working environment, these
  external servers do not promise cgroup-based SIGKILL containment. This difference
  is declared. Streamable HTTP uses the official transport, with no SSE fallback.
- Swap test: yes. Lifetime, inheritance, secret storage and override rules affect a
  host. Choice of task owner for SDK scope teardown does not.

## G36. Mapping the host contract onto ACP v1

- Where: architecture.md, Being driven by a host and Declared support; contracts.md,
  Interface and Harness; scenarios.md, Driven by a host; ACP v1 specifications.
- Missing: which protocol version and how to expose operations ACP does not name,
  actor authentication, and translation of outcomes and content.
- Choice: official Python SDK 1.0.0, ACP v1 over stdio. The stdio owner is one
  local host, bound to the enrolled `user` actor; client metadata cannot select an
  actor or raise authority. Model, thinking and approval are select configuration
  options. Close is idempotent; loading an already active Interface session refuses
  until close. Listing includes unused active sessions without forcing persistence.
  One standard prompt may wait per session. Advertised `_modular-agent/` methods
  expose keyed asynchronous input, steering, withdrawal, follow-from-entry, commands,
  move, fork, erasure, jobs, questions and UI tool calls. Events are sent only when
  the client opts in. Cancellation maps directly; limits map to max_turn_requests,
  failures to refusal with the original outcome in gated metadata. Only text input
  is advertised. Unknown output has a plain JSON display, while the record retains it.
- Swap test: yes. Protocol, extension names, identity binding and translation affect
  hosts. This is a local adapter contract, not a change to the frozen description.

## G37. ACP elicitation, SDK drift and sensitive input

- Where: architecture.md, Waiting for an answer and Declared support; contracts.md,
  Input request and answer; published ACP v1 elicitation specification.
- Missing: how to bridge a named secret request when a host only has form elicitation,
  and what to do when published protocol and SDK stability labels differ.
- Choice: approvals offer allow-once and reject-once permission options, never an
  unimplemented always-allow option. Text and choice use a flat answer form, only
  after explicit client form capability negotiation. Decline, cancel, invalid values
  and unsupported form mode decline the question. Secrets never enter a form.
  Without an out-of-band URL intake service they are explicitly declined; no secret
  transport is advertised over ACP. The SDK still labels elicitation unstable even
  though the published v1 spec has stabilized it. Its opt-in switch enables that
  documented method; this does not opt into ACP v2.
- Swap test: yes. Capability negotiation, secret refusal and SDK compatibility affect
  hosts. The local credential store still supports safe terminal secret intake.

## G38. Host replay and disconnection boundaries

- Where: architecture.md, Being driven by a host and Surviving interruptions;
  contracts.md, Interface and Harness; ACP session setup and prompt turn.
- Missing: ordering history replay against recovered work, whether transport loss is
  a declined question, and cleanup after a partially opened session.
- Choice: load replays the gated current branch before Runtime recovery can start;
  resume restores without replay. The follow extension returns all durable entries
  after an insertion-order point, plus answerability, not missed live stream pieces.
  Live model pieces are not displayed again when their complete response is recorded.
  A closed ACP transport is not an answer. EOF suspends work and leaves unanswered
  requests for Runtime-specific recovery, rather than recording a decline and
  accidentally allowing another model step. A failed session start suspends attached
  resources and releases its history lock. Host resource attachments are ready before
  recovery. Explicit close cancels work; cancelling a turn still leaves jobs running.
- Swap test: yes. Replay ordering, question liveness and disconnect semantics affect
  a reconnecting host. The SDK connection-task layout is internal.

## G01. Callable contracts and content encoding

- Where: contracts.md, Information and Interactions; ADR 0010.
- Missing: names, signatures, encodings, errors and protocol versions.
- Choice: addressed async operations with JSON objects and streamed JSON progress.
  Content is a list of typed objects; unknown types are retained. IDs are UUID hex
  strings. API version 1 is local to this build.
- Swap test: different signatures break plugins, but not the described behaviour.
  A shared binding would need to specify these details.

## G02. Registration, scope and replacement

- Where: architecture.md, Capabilities; open-questions.md, Plugin lifecycle and scope.
- Missing: collision policy, replacement cleanup and load-time failure semantics.
- Choice: fixed plugins per agent, unique capability/command names, collisions fail.
  Replacement explicitly names an installed plugin, stops it and removes all its
  registrations before installing the replacement. Replacement with open sessions
  is refused. Session-specific state is keyed by session ID.
- Swap test: yes. Plugins relying on implicit shadowing or hot replacement differ.

## G03. Exact hook composition

- Where: contracts.md, Hook points.
- Missing: tie ordering among first/last handlers, hook payloads, exception handling
  outside gates, and ownership of standard Runtime hooks when Runtime is replaced.
- Choice: stable first/normal/last bands in load order. Owners are capability names.
  Gate exceptions refuse. Other exceptions fail the operation; output exceptions
  block delivery. Transform may stop with an explicit handled result.
- Swap test: yes. Handler ordering, errors and payloads affect plugin behaviour.

## G04. Persistent format and unused sessions

- Where: architecture.md, History store; contracts.md, History entry.
- Missing: durable format, lock lifetime, transaction boundary, and what counts as use.
- Choice: SQLite transactions, OS advisory per-session locks, entries plus session
  metadata. Persistence begins with the first recorded mutation, not settings reads.
  Entry IDs are idempotent; reuse with different content fails. No expiry yet.
- Swap test: file format is internal and does not break a plugin using the API.
  Mutation/idempotency and lock semantics do affect a host.

## G05. Limits and settings during turns

- Where: open-questions.md, Turn limits and Changing the model mid-turn.
- Missing: defaults, retry budget and exact boundary for settings changes.
- Choice: settings supply max_steps (16) and max_retries (1). Settings commands
  refuse while a turn runs, so model access is fixed per turn. Limit outcomes
  use the value `limit` and name the limit in the error field.
- Swap test: yes. A host or plugin may expect a different change boundary.

## G06. File tools and local command lifetime

- Where: contracts.md, Tool definition; architecture.md, Working environment.
- Missing: tool input schemas, validation, edit atomicity, output capture and the
  difference between shell background children and explicit jobs.
- Choice: UTF-8 file tools; exact unique non-overlapping edits checked before any
  write. JSON Schema 2020-12 validation. Calls run sequentially. Bash uses regular
  output files so inherited descriptors cannot delay return, streams reads while
  the foreground shell runs, and tracks process groups until session close.
  Background children of a completed shell are not job reports in milestone 1.
  Cancelling a later turn leaves earlier groups alone. SIGKILL and escaped-group
  cleanup are explicitly unsupported until milestone 2. G19 and G20 supersede
  those milestone 1 execution and cleanup limitations.
- Swap test: tool schemas and lifetime affect plugins and hosts. Capture mechanics
  and file format do not.

## G07. Input admission and cancellation

- Where: open-questions.md, Input during a turn, Cancellation, Keys for repeated input.
- Missing: exact receipt, duplicate scope, steering boundary and queue representation.
- Choice: queue entries record keyed admission; taking or withdrawing appends a
  record. Keys last for the session, across reopen, not just one connection. Steering
  enters before the next step after the current tools settle; follow-ups start a
  separate turn. Cancellation returns all unconsumed content as gated events.
- Swap test: yes. These boundaries and receipts are observable by a host.

## G08. Compaction and summary provenance

- Where: ADR 0007; scenarios.md, scenario 6; open-questions.md, What history records.
- Missing: token estimate, summary boundary, overflow retry count and summary model.
- Choice: estimate JSON length divided by four, compact above 75 percent of the
  declared context window (or context_budget setting). Summarize older complete
  turns, or the whole view if one turn is too large, using the selected Provider
  with no tools. Keep all original entries; track summary covers and copy references.
  A context-too-large failure compacts and retries within the configured budget.
- Swap test: summary quality and estimates are internal. Copy provenance and whether
  a current task survives compaction matter to a host.

## G09. Output gate scope and holding policy

- Where: contracts.md, Hook points; architecture.md, Who sees what.
- Missing: flush signal, recipient identity and trusted raw access.
- Choice: the optional guardrail buffers each model/tool stream per recipient until
  its final marker when secrets are configured. With no secrets it streams live.
  Complete events and replayed entries are recursively redacted. Gate failures
  block delivery. Trusted plugins read raw records; the Interface gates return
  values before rendering them. Stream pieces are not durable.
- Swap test: yes. A guardrail needs explicit flush boundaries and raw-access policy.

## G10. Erasure of derived data and native state

- Where: architecture.md, History and Erasure; scenarios.md, scenario 15.
- Missing: how to discover paraphrases, results that quote an input, and cached copies.
- Choice: conservatively mark each model response as copying all entries in its
  request, each call as copying its response, and turn results as copying their
  responses and tool results; tool results copy their originating calls. Summaries
  and forks explicitly name their sources. Input admission receipts and taken
  input are one canonical payload. Exact fork copies also trace back to their
  originals, so erasing a fork copy reaches originals and sibling copies.
  Erasure follows those edges transitively, replaces content and metadata with
  erasure records, vacuums SQLite, clears plugin caches and discards Provider state.
  Erasure refuses while any turn is active or an affected session has another writer.
  Already delivered output is reported as out of reach.
- Swap test: yes. Incomplete provenance could leave a controlled copy undeleted.

## G11. Stateful Claude Code as a transport

- Where: architecture.md, Provider and Declared support; contracts.md, Model access.
- Missing: native tool-name mapping, replay format, state equivalence and how a
  request ends while Claude Code is waiting for tools.
- Choice: only claude-haiku-5-5, with no fallback. A persistent SDK worker owns each
  native conversation and its async scopes. Exact tool schemas are exposed by an
  official MCP Server as mcp__agent__ names. A tool response ends our model request;
  the MCP callback waits for the Runtime's canonical result. The SDK convenience
  helper was rejected after reading its source: it validates arguments before
  calling the handler, which could resume native inference before our Runtime.
  The public MCP Server instead leaves validation to this agent and preserves
  failed/refused result status. Calls with identical names and arguments match
  callbacks FIFO because the Python SDK tool callback has no native tool-call ID.
  Native state is used only for a matching prompt/tools/settings and a prefix of
  the supplied view. Otherwise it is discarded. A fresh process receives a
  labelled JSON text record, not native vendor-message replay. Context and output
  limits are conservative catalog values, not a promise that the vendor honors
  output-limit settings. Claude Code's own compaction, memory, hooks, tools,
  skills, plugins, settings and session persistence are disabled.
- Swap test: yes. Tool names, callback identity and native replay differ across
  Providers and must be declared. The worker mechanism is internal.

## G12. Credentials and file settings

- Where: architecture.md, Credential store and Configuration; scenarios.md preamble.
- Missing: how a store represents a machine login rather than an API key, config
  locations, merge depth and trust before project plugin loading exists.
- Choice: the credential store supplies a reference to Claude Code's existing
  login directory, never a token to the Runtime. The SDK reads that login itself.
  The Provider rejects a non-subscription account before submitting a prompt and
  neutralizes inherited API/cloud routing and parent-session variables. Global
  settings.json lives in the chosen agent data directory; project defaults are
  in .modular-agent/settings.json under the session project. Top-level project
  values override global defaults, and saved session settings survive reopening.
  Project plugin configuration is ignored until milestone 4 adds trust.
- Swap test: login internals and paths do not break an API consumer. Merge
  semantics and trust behaviour can affect hosts.

## G13. Terminal controls and model-free commands

- Where: contracts.md, Interface and Harness; ACCEPTANCE.md, milestone 1 commands.
- Missing: line-mode input protocol, process exit codes, and the tension between
  commands involving no model and /compact needing a Provider summary.
- Choice: line mode remains responsive while a turn runs; ordinary lines steer,
  /after queues and /cancel cancels. /quit exits after waiting for accepted work.
  Print mode returns 0 on completion and 1 otherwise. JSON mode prints gated
  events and the declaration. Commands never start an agent turn; /compact may
  make its documented auxiliary summary request without the Runtime.
- Swap test: yes. An Interface and a host depend on admission and command semantics.

## G14. Vendor usage is not an additive map

- Where: contracts.md, Usage and Model request and response.
- Missing: normalization of nested vendor metadata and which usage fields add.
- Choice: Providers return only numeric input_tokens, output_tokens, cached_tokens
  and cost_usd to the Runtime. The first real run returned a correct answer but
  failed while adding a nested SDK usage value. An offline regression reproduced
  it; normalization now removes the vendor's non-additive nested breakdowns.
  Cost is the SDK's estimate, not a statement about subscription billing.
- Swap test: yes. Without a scalar usage contract a Runtime and Provider disagree.

## G15. Forking internal input and provenance references

- Where: contracts.md, Session and History entry; architecture.md, History.
- Missing: which identities change in a copied branch and whether consumed input
  could be taken again there.
- Choice: a fork allocates new entry IDs and remaps entry parents, queued-input
  references and summary covers. Tool-call and turn identities are retained as
  historical identities. Copy references preserve both local lineage and the
  original fork source. An offline audit caught and fixed readmission caused by
  leaving input receipt references at their old IDs.
- Swap test: remapping mechanics are internal. Replaying already-consumed input or
  failing to erase fork copies would break a host's observable guarantees.

## G16. Settings after a position move or fork

- Where: architecture.md, Sessions and History; open-questions.md, Configuration.
- Missing: whether settings are branch-local or session-wide after moving back.
- Choice: settings belong to the session. Moving changes the model-visible branch,
  not the session's current settings. Forks inherit the current settings snapshot,
  even when the selected history point is earlier. Each setting change and the
  updated snapshot are committed in one history-store transaction.
- Swap test: yes. A host must know whether moving also changes its model or limits.

## G17. Runtime recovery journal and hook replay

- Where: architecture.md, Surviving interruptions; contracts.md, Harness and Runtime;
  open-questions.md, Transient and durable Runtimes.
- Missing: checkpoint format, atomic model-response/call admission, hook replay,
  recovery scheduling and the boundary between completed work and lost replies.
- Choice: the Runtime records progress as hidden history entries. A response keeps
  its full call list so missing call entries can be reconstructed without another
  model request. Completed tool receipts precede ordered model-visible results.
  Recovery reuses the turn and step identities and original step budget. Gates run
  again before retried calls. Hooks must tolerate replay; arbitrary external hook
  effects are not made exactly-once. Opening schedules recovery; runtime.wait joins
  it without new user input. The transient Runtime settles and fails instead.
- Swap test: journal layout is internal. Hook replay, wait semantics and when a
  finished call may run again affect plugins and hosts and need a shared contract.

## G18. Safety hints and interrupted model requests

- Where: contracts.md, Tool definition (hints are not promises); architecture.md,
  Surviving interruptions and Declared support.
- Missing: how a safe-to-repeat hint becomes authority to replay, and how stateful
  Providers without native tool effects differ from ones with outside effects.
- Choice: replay a started call only when both the recorded and current tool
  definitions explicitly say safe_to_repeat, and the working environment declares
  crash cleanup. Missing hints mean unsafe. Never-started calls run normally.
  Discard Provider state on recovery. Retry an interrupted model request only if
  the Provider explicitly declares it runs no tools, or declares
  requests_safe_to_repeat. A missing Provider declaration is not authorization.
  Otherwise fail clearly rather than repeat unknown outside effects.
- Swap test: yes. Builders interpreting hints or Provider state differently could
  duplicate effects. The description needs an explicit replay authorization rule.

## G19. Parallel execution and ordered results

- Where: contracts.md, Tool definition and Tool result; ACCEPTANCE.md, milestone 2.5.
- Missing: admission policy for mixed steps, result ordering and crash recovery of
  a later call that finishes before an earlier one.
- Choice: run together only when every requested tool explicitly allows parallel
  execution. Otherwise keep the whole step sequential. Progress may interleave;
  result receipts persist on completion and visible results follow request order.
  Cancellation waits for every started call to stop before settling the rest.
- Swap test: yes. A host may depend on ordering and a tool on exclusive execution.
  The receipt encoding is internal.

## G20. Local crash cleanup platform and supervisor loss

- Where: architecture.md, Working environment and Declared support; ACCEPTANCE.md,
  milestone 2.4.
- Missing: platform prerequisites, how to contain setsid descendants, who cleans up
  if a cleanup process dies, and how recovery avoids racing an old command.
- Choice: Linux cgroup v2 with a writable delegated subtree, one cgroup and a
  subreaper supervisor per command. Journal ownership before admitting a process;
  move the child into the cgroup before exec. A private lifetime pipe detects agent
  death. cgroup.kill stops every descendant, including setsid and double forks.
  Startup removes stale cgroups before a session can recover, even if its supervisor
  died too. Refuse commands when containment is unavailable, without a weaker
  process-group fallback. This is process lifetime containment, not a sandbox
  against same-user code deliberately modifying the agent's own cgroups or files.
- Swap test: containment internals do not break plugins. Platform availability,
  refusal behaviour and the guarantee before replay are observable to a host.

## G21. Cleanup discovery across agent data directories

- Where: architecture.md, Working environment; ACCEPTANCE.md, milestone 2.4.
- Missing: whether "the next agent" means one using the same history directory,
  and how to distinguish stale ownership from a recycled PID.
- Choice: discover stale command cgroups across the delegated per-user subtree,
  not only the current data directory. Names contain owner PID and kernel start
  time; local journals also contain boot identity. A different agent data directory
  still cleans stale groups before recovering anything. Live owners are left alone.
  A dying /proc entry or zombie owner counts as stopped.
- Swap test: discovery details are internal. Leaving a command alive merely because
  the next agent uses another directory breaks the host's cleanup guarantee.

## G22. Active plugins when a session is reopened

- Where: contracts.md, Session; architecture.md, Runtime and Declared support.
- Missing: whether a saved session's plugin list is a historical snapshot or a
  demand to restore the old composition when the process starts with new plugins.
- Choice: it is the running composition, not a restore instruction. Reopening
  refreshes that metadata, so replacing transient with durable is visible without
  changing any other plugin or requiring a new session.
- Swap test: yes. A host must not be told the old Runtime is still active when the
  current Runtime declares recovery support.

## G23. Authority representation and trusted plugin boundary

- Where: architecture.md, Actors and authority; contracts.md, Actor and Interactions.
- Missing: permission vocabulary, actor enrollment, revocation and authentication.
- Choice: named permission sets, intersected with administrator, tenant, session
  and current parent authority. The local Interface supplies an authenticated actor
  identity; transport authentication belongs to a later Interface. A grant requires
  delegate authority and may grant only the grantor's current permissions. Trusted
  installed plugins use the plugin API; Interfaces cannot bypass checks by calling
  a low-level tool source or history operation. Turn and job work retain the
  initiating actor and an authority ceiling, including after that actor is narrowed.
- Swap test: yes. Permission names, identity binding and revocation affect hosts.

## G24. Question identity, liveness and time limits

- Where: architecture.md, Waiting for an answer; scenarios.md 3 and 7;
  contracts.md, Input request and answer.
- Missing: key scope, incompatible reuse, presence detection, and inconsistent
  wording about whether a durable turn ends at a finite question time limit.
- Choice: keys are scoped to session and asker; incompatible question details
  cannot reuse an answer. Answer reuse requires the current branch and current
  answer authority. Interfaces explicitly connect as answerers. Approval without
  an eligible connected actor declines immediately. No timeout means wait in the
  turn; a finite park timeout leaves the call open with either Runtime, as
  acceptance 3.5 requires. Transient interrupted, non-parked requests become
  unanswerable; durable ones are announced again when their checks replay.
- Swap test: yes. Presence, key scope and timeout semantics affect a host/plugin.

## G25. Late results, branches and replay from the top

- Where: architecture.md, Waiting for an answer and History; contracts.md, Tool result.
- Missing: resume scheduling, view representation and safe replay of question tools.
- Choice: persist deferred-call markers, never placeholder results. Once every
  question for the original step is answered, queue keyed continuation input.
  The next turn runs the original calls through all checks before requesting the
  model. Context synthesizes waiting markers only in the view and labels late
  results. Moving away cancels abandoned open calls and questions. Question tools
  and delegation declare safe replay because their durable keys prevent duplicate
  effects; arbitrary tools still obey G18. Approval keys bind the effective
  arguments and are checked again immediately before the tool starts.
- Swap test: yes. Resume boundaries and view semantics affect hosts and tools.

## G26. Secret intake and storage

- Where: architecture.md, Credential store; contracts.md, Input request and answer.
- Missing: secret write API, storage format, error handling and Interface routing.
- Choice: secret answers go directly from the Interface to credential-store intake.
  The store validates the question, atomically writes a mode-0600 JSON file, and
  records only the requested name. The reserved Claude login cannot be overwritten.
  No Runtime or question API accepts raw secret values. Store errors never echo
  supplied values. Missing names or stores decline before asking.
- Swap test: intake signatures affect hosts/plugins. The private file format does not.

## G27. Job reporting and process shutdown

- Where: architecture.md, Jobs; contracts.md, Plugin and Harness: jobs.
- Missing: owner authorization, report redelivery, and clean process interruption.
- Choice: a jobs plugin records owner-tagged starts and ends; only the owner can
  complete a job. Report input uses the job ID as an idempotency key, bypasses slash
  commands, and retains the job's narrowed authority. Recovery redelivers a committed
  end whose input was not admitted. Session close cancels work; process stop uses a
  separate suspension hook and leaves unfinished jobs and turns recoverable.
  Runtime suspension and cancellation run before environment cleanup, so cleanup
  cannot accidentally let the turn start another model step.
- Swap test: yes. Redelivery, cancellation and stop/close differences affect plugins.

## G28. Subagent continuation and variants

- Where: architecture.md, Working with other agents and Jobs; scenarios.md 8.
- Missing: delegation schema, wait/report choice, model defaults, depth and recovery
  with a Runtime of different durability.
- Choice: delegate accepts task, background/wait and an optional existing child.
  A fresh child inherits project and settings, never parent history, with a default
  maximum depth of three. Each follow-up is a new keyed job on that child. Waiting
  jobs return through the tool only; background jobs report as input. Both variants
  share the same contract. Transient jobs report unknown after interruption. Durable
  jobs reopen the child and resume; if its Runtime is transient, it first settles
  interrupted effects conservatively, then continues in a new turn from that record.
  No extra real model choice is exposed beyond the build's allowed Haiku model.
- Swap test: yes. Recovery and delegation semantics affect tools/hosts. Task mechanics
  remain internal to the plugin.

## G29. Forwarding questions through subagents

- Where: architecture.md, Waiting for an answer; open-questions.md, Agents working together.
- Missing: links between successive parent requests, secret routing and late answers.
- Choice: each parent session records its own keyed question linked to the child
  request. The top actor answers that parent question; only the answer (or credential
  name) propagates down one level at a time, attributed to the parent agent and
  checked against current authority. Forwarded questions do not themselves start a
  model turn in the parent. The child's job report remains separate input, not a
  user command or approval. Losing a child question closes its parent proxies;
  cancelling a parent's turn leaves its background jobs' questions answerable.
  Parent answers accepted before a child reopens synchronize when it opens.

## G30. Pending work at branch, UI and budget boundaries

- Where: architecture.md, History, Actors and authority and Jobs; open-questions.md,
  Tool calls outside a turn and Turn limits.
- Missing: pending-work forks, UI cancellation/restart, job-budget checkpoints and
  the trust boundary of an in-process embedding API.
- Choice: moving cancels pending calls, questions and jobs on the old branch before
  recording the move. Forking pending work refuses, rather than duplicating active
  work. Completed forked jobs are historical and never redeliver reports. UI calls
  use the Runtime tool gate, hold the session busy, are cancellable, and interrupted
  non-parked UI calls get conservative terminal results on reopening. They do not
  ask the model unless a deferred answer or job report supplies new input. Session
  max_tokens counts model and job usage and is checked before each new model step;
  it cannot stop a request whose final usage is not yet known. Installed Interfaces
  receive a role-bound checked API. h.api() is a trusted Python embedding API, not
  an authentication boundary against code already inside the host process.
- Swap test: these policies are observable to hosts/plugins, so yes. The internal
  task and accounting representations are not themselves part of the contract.

## G31. Unattended questions and Interface disconnection

- Where: scenarios.md 2 and 9; architecture.md, Waiting for an answer;
  contracts.md, Input request and answer.
- Missing: how print mode advertises that it cannot answer, and what an indefinite
  non-approval question does when the last answerer disconnects.
- Choice: print mode never registers as an answerer. Approval and indefinite
  questions decline when no eligible Interface remains. Finite non-approval park
  requests stay open for a later connection. Line and JSON modes disconnect on EOF
  before joining the turn, so an unattended approval cannot deadlock process exit.
  A resumed question is still announced, with the decline recorded if unattended.
- Swap test: yes. Connection presence and unanswered-question fallback affect hosts.
- Swap test: yes. Routing identities, attribution and late-answer links affect hosts.

# Gaps in the description

Each entry gives the source, missing detail, this build's choice, and the swap test. Frozen `docs/` is not edited.

## Production edition 3

P11, P12 and P13 are settled by the edition 3 rules. The Go path refuses unowned points, skips optional project reads on `not_found` or `not_supported` without switching environments, and does not start or record a model answer when the Provider skipped its request callback. Edition 2's resolutions for P1, P3, P4, P5, P7, P9 (point lookup) and P10 still hold. P2, P6 and P8 are not closed by this round.

### P14: Legacy interrupted turns may not prove the gate state

- Where: Contracts, Recovery and repeating work; Shared data, Recording order and ownership; Plugin, The host asks the Runtime.
- Finding: A retained response without a decision and without `tracksStepAfter: true` cannot distinguish a gate that ran before the crash from one that was never reached. The same problem occurs with an erased decision. The edition 3 rules settle the recovery behavior, but do not provide a migration for these older turns.
- Choice: Fail the turn closed and settle abandoned calls. Do not add a marker to imported requests or infer allow from an answered step. For an intact checkpoint, an omitted decision means due and an explicit `null` means allow. A repeated matching callback receives the committed reply.
- Swap test: Yes. A host that guesses from a missing decision could rerun a gate or continue a turn that a conforming peer stops. Do not promise recovery of legacy interrupted work solely because it can be opened and read.

### Implementation follow-up: Portable approval answers and agent identity

- Where: ACP, Starting and Request; Shared data, Questions and Standard kinds; Contracts, Authority.
- Finding: In F3 Go wrote a self-grant for its connection actor. After fixing that, Elixir reached two more invalid records. Go persisted a reject option as `value: "refuse"`, which is an ACP option id, not a shared approval answer. The `input` that took a job report used the Go-only job principal as its `actorId`, instead of keeping the attribution on the report admission.
- Choice: Record operator admissions on create and reopen, with `operatorAdmission: true` and no granter. Record a rejected approval as an actor decline with no `value`. Write the canonical `requestId` association and omit the actor field when the system closes a question. Keep the report's admission actor and `jobId` on the taken input, without changing the job's execution authority.
- Swap test: Yes. A strict reader may reject the whole session. A reduced Go-to-Elixir job report run failed before the attribution change and loaded after it. Approval-only and unkeyed input controls loaded in both runs.

### Implementation follow-up: The new principal probe exposed an unscoped Go lookup

- Where: ACP, Input admission; Shared data, General rules and Standard kinds.
- Finding: Go accepted `MODULAR_AGENT_ACTOR` for the connection but still looked up retries by session and key alone. When Go reopened a portable session as a different principal, it returned the old actor's receipt.
- Choice: Match both submitter and attributed actor on live and erased receipts. Record `submittedBy` for represented admissions and retain it on erasure. For old Go admissions, read `go.viaActor` if there is no standard field. Do not guess ownership for a reservation without an actor.
- Swap test: Yes. Same-principal retries must still find the original receipt; different principals must not see it.

### Implementation follow-up: Edition 3 wire checks

- Go now returns the committed result on a `tool.before` refusal. It projects the four `provider.response` members and ignores extra envelope members received from a Provider. ACP history preserves the committed assistant message and step id, rather than projecting only its content.
- A refused configured plugin now fails startup, including duplicate replacement names. The launch passes a small set of environment variables and the operator-approved additions, not `HOME` or the host's credentials. The synced edition 3 kit tests the negative cases separately from successful agent startup.
- An ACP client could see a permission request and cancel its turn before the SDK finished sending the request. The request's wait context also cancelled its send, so the peer sometimes got no cancellation notification. Go now separates the send and wait lifetimes and explicitly cancels the submitted request. The focused cancellation test passed 25 iterations for each native Runtime without relaxing any deadline.
- See `PROGRESS.md` for the matrix and kit commands and results.

## Production edition 2

The second edition settled P1 (lease length), P3 (the final request recorder), P4 (retryable reopen), P5 (encoded byte counts), and the point lookup part of P9 and B38. P10 is settled in the kit: the plugin check runs directly and tests the file heartbeat. P7's test setup issue is settled too: the delayed renewal check now covers the supplied service's 15-second TTL. The distinction between service durability and agent portability still holds. P2, P6, and P8 are still open.

### Divergence risk P11: Legacy snapshots without session ownership

- Where: Shared data, Rewinding; Plugin, Paths and points.
- Unclear: A point made before session-scoped lookup may identify only its project. The binding says what a lookup means now, but not whether such a point can be assigned to a session as part of migration.
- Choice: Do not infer a point's owner from a referencing entry. Refuse an unscoped point. An unresolved rewind with an unverifiable undo point needs repair, not a guess about the files.
- Swap test: Yes. An agent that accepts such a point based on the history alone may restore another session's files. An agent that refuses it cannot rewind some older histories.

### Friction P12: Point-only fixtures and optional project text

- Where: Plugin, Paths and points; Contracts, Configuration and trust.
- Unclear: A fixture can expose the point operations but refuse file reads. The project prompt plugin needs to distinguish an unsupported operation from a supported read that failed.
- Choice: Skip optional project text only when the environment explicitly does not support reads. Do not try a different environment. Keep permission and I/O failures visible.
- Swap test: Yes for availability. A host that treats an unsupported optional read as fatal cannot exercise points through that fixture. A host that falls back to a different environment may read unrelated files.

### Divergence risk P13: A Provider fails before a model request can be recorded

- Where: Plugin binding, The host asks a Provider; Runtime records and effects.
- Unclear: A Provider can return or fail without calling `provider.request`. The host must not accept that answer. The Runtime callback does not name a distinct error for this case, and a failed assistant message would have no matching request.
- Choice: Return a protocol error if no request committed. If an already dispatched attempt fails, return the failed assistant response for settlement. Use `turn_limit` for the separate limit path.
- Swap test: Yes. A Runtime that records a response even when no attempt was admitted cannot work with a host that refuses orphan responses.

### Implementation follow-up: Long local history delayed ACP cancellation

- Where: ACP, Cancelling; Contracts, Parts that are lost; Plugin, Command lifetime.
- Finding: The 150-second split-plugin watchdog caught slow agent work, not just a growing test harness. The checkpoint's two external durable failures both lacked a command-start marker, so those results did not establish whether an active command stopped. A focused test on the checkpoint with 300 old responses also missed the start check. A diagnostic run waited for that command to start at 15.23 seconds, then tested the unchanged five-second cancellation deadline and missed it. This was a defect, not a reason to give cancellation more time.
- Choice: The local store reuses encoded history only when the disk file and the supplied prefix still match its last verified save. Otherwise it runs the full validation. The Harness copies snapshots without a JSON round trip. The focused ACP regression checks dispatch, cancelled prompt settlement, and that the command cannot finish. It passed with dispatch in 0.63 seconds and settlement in 0.59 seconds. No watchdog, wire deadline or capability declaration changed.
- Swap test: No new binding rule. A peer can observe a late reply, but the binding already forbids it. The local snapshot optimization does not change the shared wire format.
- Verification: `GOMAXPROCS=2 GORACE=atexit_sleep_ms=0 mise exec -- go test -race -v -count=1 ./cmd/modular -run '^TestExternalDurableCancelsCommandWithLongLocalHistory$'` exited 0 after the fix. `GOMAXPROCS=2 GORACE=atexit_sleep_ms=0 mise exec -- go test -p 2 -count=1 -timeout 15m ./...` and `GOMAXPROCS=2 GORACE=atexit_sleep_ms=0 mise exec -- go test -race -p 2 -count=1 -timeout 15m ./...` each passed 29/29 test packages and exited 0. See `PROGRESS.md` for the kit commands and results.

## Production edition 1

### Blocker P1: Fork preflight needs a lease length bound

- Where: History HTTP, Sessions.
- Missing: A writer must prove the initial append body fits before PUT, but the binding puts no upper bound on encoded lease length. An entropy minimum does not give an upper bound.
- Choice: Do not infer a portable bound from the Go service's fixed length. A client without deployment-specific proof must refuse rather than publish metadata for a fork it cannot prove will fit. Specify a maximum wire length or advertise it before PUT.
- Swap test: Yes. A client that assumes the Go token size could pass preflight and create a destination that another conforming service cannot fill atomically.

### Divergence risk P2: Reopening with an already established writer

- Where: History HTTP, Writing: one writer at a time.
- Unclear: An acquire from the same owner returns a full TTL without extending it. The timing rule refers to sending the latest successful grant or renewal, not every successful acquire. The wire cannot distinguish a new grant from an existing one.
- Choice: Keep the local lease and its original deadlines rather than reacquire it. Require a timely renewal after any ambiguous acquire before use. State explicitly that the response's full TTL does not prove a fresh grant.
- Swap test: Yes. A client that starts a fresh budget on every acquire may dispatch while another conforming client already holds the lease.

### Friction P3: Record requirements span three ownership boundaries

- Where: Contracts, Recovery and repeating work; Shared data, Recording order and ownership; Plugin binding, Provider requests and Runtime records.
- Unclear on first read: The Runtime prepares the request, but neither its prepared tool list nor the turn-start list proves what was offered. The Provider adapter transforms even a request that came from a remote Runtime. The wire's Provider callback is then a binding check, not another transform.
- Choice: Treat the dispatch record as the only source of offer proof and carry the intent's entry ID into the response's sources. Put the final-request checkpoint at the Provider adapter boundary when it transforms a request. Add an ownership example with both a remote Runtime and a remote Provider.
- Swap test: Yes, if implementations confuse the boundaries. A host can wrongly run a call removed by middleware or refuse one that middleware added.

### Divergence risk P4: A restart hold can be longer than the reopen budget

- Where: History HTTP, Writing: one writer at a time.
- Unclear for operators: A service that restarts from 6 seconds to 1 second may correctly advertise 1 second and correctly report a wait close to 6 seconds. The client must stop if the next retry cannot fit within 2 seconds. The binding does not say whether a service that lowers its TTL should delay readiness or whether opening clients should treat this as a reason for an operator or separate caller retry.
- Choice: Keep the service available for reads and enforce the full hold. Do not try to acquire before the suggested wait. A fresh open attempt after a refusal is separate from extending the budget for this request. Add this example to the reopen rule.
- Swap test: Yes for availability. A client can fail a reopen on one conforming service while the same reopen succeeds on a service with preserved leases or a fixed TTL. Neither result is evidence of a fencing defect.

### Divergence risk P5: Compact JSON is not a canonical byte representation

- Where: History HTTP, Sessions and Entries; Shared data, General rules.
- Unclear: A longest-prefix page is measured in compact UTF-8 JSON. Peers can encode the same value with different string escapes or decimal spellings. A record near the limit may fit on one service and be refused on another. A client preflight cannot infer the receiver's serialization size from JSON equality.
- Choice: Count the service's own actual compact serialization, including cursor and metadata. For requests count the actual outgoing body. Do not normalize opaque numbers to floating point. State explicitly that two valid servers may choose different page cuts or entry acceptance at the boundary, or specify a byte encoding if identical cuts are required.
- Swap test: Yes near the cap. A valid entry or its tombstone could be accepted by one store and rejected by another. Cursor walking remains interoperable when both stores accept the records.

### Divergence risk P6: Tombstones of opaque records can contain incomplete usage

- Where: Shared data, Entry fields and tombstones and Messages; History HTTP, Erasure.
- Unclear: Usage normally requires five fields, with zeros for missing fields from a partial meter. The service accepts opaque records and strips malformed additions on erasure. It is not explicit whether to drop all usage, preserve only valid fields, or fill in zeros when an old meter omitted fields or kept a malformed cost.
- Choice: Keep valid standard numeric fields when both input and output are valid. Do not invent token counts. Ask for an explicit projection rule for opaque partial Usage, with an erasure fixture for it.
- Swap test: Yes. Billing and soft budget reconstruction from a partially reported legacy job or attempt can differ after erasure.

### Friction P7: Portability is not the restart ability of a service or Runtime

- Where: Shared data, Portable sessions; ACP, The declaration; history and ACP kit READMEs.
- Unclear on first read: The history kit can establish that raw records and lease exclusions survive a service restart. It cannot establish that a Runtime can read those records and enforce the recorded authority and queue. The supplied service also used a 15-second TTL, outside the delayed-renewal probe's 1 to 10 second fixture range.
- Choice: Test both services but treat the delayed-renewal probe as a separate Go-service check when the supplied service skips it. Do not use a history pass or a same-build reopen as a claim of a portable Runtime or production deployment.
- Swap test: Yes if declarations are interpreted incorrectly. A host can select a Runtime it expects to resume work based solely on a passing history service.

### Divergence risk P8: Represented actor presence on a new connection

- Where: Contracts, Authority; ACP, Sessions and Several actors.
- Unclear: Open marks the configured actor present, and join may set presence only for a represented actor. There is no presence-only operation for a represented actor who already has a retained grant when a connection reconnects. Repeating join requires `grant`, and representation does not imply `grant`.
- Choice: Keep the represented identity eligible for attributed input under current rights, but do not mark it present on open merely because the launcher permits representation. An explicit authorized join may set its presence. Define a presence-only operation or state the reconnect behavior for these actors.
- Swap test: Yes. A host without `grant` may be unable to receive an approval on behalf of a retained, represented actor in one agent and able to do so in another.

### Friction P9: The fork and rewind rules use different facts from the journal

- Where: Contracts, Moving and rewinding; Shared data, Rewinding; Plugin, Paths and points.
- Unclear on first read: A remote environment exposes save and restore, not a point lookup. The agent needs to verify the provenance before touching the project, yet the point value cannot attest its environment unless the host has a separate mapping. Only the environment can distinguish an unknown or expired point and it does so during restore.
- Choice: Keep point identity local to the environment and never infer it from a foreign ID. The existing Go restore path is not the production rewind journal. If preflight of all later points is required over the plugin wire, add a read-only capability to verify them without applying them.
- Swap test: Yes. A host that requires preflight cannot rewind with a conforming environment that implements only save and restore; a host that tries restore to discover ownership can change files prematurely.

### Friction P10: The old PID workaround is no longer the plugin kit oracle

- Where: Plugin kit, command lifetime and setsid escape probes; B27 and B40 below.
- Unclear at first: The previous round's scripts put the kit in a PID namespace to avoid interpreting a namespace-local PID on the launcher. The new setsid test measures the escapee's file heartbeat, not that PID.
- Choice: Run the production plugin kit directly with the absolute plugin command. The containment check passes without the old workaround. Treat the remaining Runtime failures as implementation gaps, not this kit defect.
- Swap test: No for the binding. This changes how the fixture observes containment, not the wire promise.

### Implementation status at the first edition checkpoint

The existing declaration is not a production profile. `portableSessions` still lacks a complete standard fold, recovery provenance and exact replay. `rewinding` lacks the journal and project exclusion. `forking` lacks the interoperable pre-PUT bound and an atomic standard prefix. `erasure` lacks durable copy-set intent, session-qualified reporting and erased receipt retention. `tenants` and `sessionLimits` have local checks but not complete deployment accounting and dispatch checks. Several actors now require explicit operator representation, but discovery and current rights are not fully checked on all paths. `inputDuringTurn` lacks the remote Runtime's final admission cutoff. Late answers work in some live scenarios but not through the required standard pending and continuation checkpoints. Neither ACP version nor either served Runtime has a production conformance claim. These are implementation failures, not reasons to change the kit to accept old behavior.

## Round six

The new rules resolve the protocol questions in B28, B29, B30 and B35. They also specify the rewind order and how to report calls outside the project (B32 and B34).

### B36: Clearing a session limit is different from granting another right

- Where: `docs/bindings/data.md`, Limits and tenants; `docs/bindings/acp.md`, the `limit` extension; `conformance/acp/run.mjs`, session limits.
- Unclear: the authority rule forbids raising the ceiling above current effective rights, but the kit clears the ceiling with `rights: null` and expects rights outside the old ceiling to work again.
- Choice: `null` means no session ceiling, not an empty ceiling. Only a current administrator can clear it. An explicit array remains subject to the effective rights check. Neither form can change a tenant ceiling.
- Swap test: yes. Hosts that interpret `null` as no rights would lock out the session instead of clearing the ceiling.

### B37: The history service has no tenant-wide token reservation or usage record

- Where: `docs/bindings/data.md`, Limits and tenants; `docs/bindings/history-http.md`, Writing and Erasing.
- Missing: how to order two model steps in different sessions that reach the same budget together, and how to count usage after the entries holding it are erased.
- Choice: count recorded input and output usage across the configured history store, including other branches and closed sessions. Check before starting a model request and after recording a step. An already-started step can take usage over the budget. If both the response and the turn's usage total are erased, their tokens are no longer in the record.
- Swap test: yes. Hosts cannot promise a hard cross-process quota or retain erased usage in the same way without a shared accounting rule.

### B38: The stdio environment cannot check a point without restoring it

- Where: `docs/bindings/data.md`, Rewinding, order step 1; `docs/bindings/plugin.md`, working environment.
- Missing: a standard existence check for a saved point. `env/exists` checks a project path, not a point.
- Choice: check locally when the environment offers a point check, then save the backup and restore. For stdio environments the host must save the backup before finding out whether the point exists. The restore must refuse an unknown point without changing files. No branch move happens on refusal.
- Swap test: yes if a host tries an invented check method or assumes a point created by another environment is still available.

### B39: A model may accept no lower reasoning level

- Where: `docs/bindings/data.md`, Models and Portable sessions.
- Missing: what to send if the model accepts no level at or below the recorded level, including when it lists no levels.
- Choice: omit the reasoning level in that case instead of raising it. Otherwise choose the nearest accepted lower level in the shared order.
- Swap test: yes. A build that picks the lowest advertised level even when it is higher can change what the Provider is asked to do and how much it costs.

### B40: The plugin kit still checks a namespace-local setsid PID

- Where: `conformance/plugin/run.mjs`, strong containment; `docs/bindings/plugin.md`, working environment.
- Wrong: the strong containment check probes the reported PID in the kit's namespace, not the command's namespace. It can report an unrelated process or miss a live escapee. This is the remaining case from B17 and B27.
- Choice: run the unchanged kit in an isolated PID namespace with low PID slots passed over. The independent local tests exercise containment and session lifetime without treating the shell's PID as a host PID.
- Swap test: yes for the kit. A heartbeat or another observation that crosses PID namespaces would test the actual process.

## Round five

### B27: The setsid check still uses a namespace-local PID

- Where: `conformance/plugin/run.mjs`, the `strong` containment check; `docs/bindings/plugin.md`, working environment.
- Wrong: `setsid` prints a PID in the command's namespace, but the kit tests that number in its own namespace. The number alone cannot identify the escapee and could name another process. The newer background-session checks correctly use heartbeats.
- Choice: run the unchanged kit in an isolated PID namespace with the low PID slots already used. The local environment also has offline marker-based containment and cancellation tests.
- Swap test: yes. The kit needs an observation that works across PID namespaces, such as an escapee heartbeat.

### B28: Several actors need a presence and receipt convention

- Where: `docs/bindings/acp.md`, Several actors; `docs/bindings/data.md`, Actors and History entries.
- Missing: what makes a joined actor present; what `taken` says on a declined release; and how to record the host's share of the rights when acting for another actor.
- Choice: joining sets membership only. An open connection counts for its own actor, and other actors may answer through it with shared rights. A decline hands the input back and returns `taken: "handedBack"`. Record the delegating actor in `go.viaActor` and keep the standard `releasedBy` separately.
- Swap test: yes. A host may mistake membership for presence, or an importer may enforce only one side of a delegated admission if it ignores the extra field.

### B29: A job's name and one actor may not identify all its authority

- Where: `docs/bindings/plugin.md`, Jobs; `docs/bindings/data.md`, `jobStarted`.
- Missing: what a host does with two plugins of the same name, or if the plugin cannot acknowledge cancellation. `actorId` names one actor even when two or more actors supplied the authority for the original work.
- Choice: duplicate plugin names can still provide separate capabilities, but none of them can own jobs by that name. An error on cancel leaves the job unfinished unless the plugin already recorded its end. Go keeps additional authority contributors in `go.contributors` and checks their current rights when the report acts.
- Swap test: yes. A host must not guess a job owner or treat a cancellation transport error as a recorded end. A reader that ignores the contributors might widen a job's rights.

### B30: The output hook names an event wrapper, not the event types or payloads

- Where: `docs/bindings/plugin.md`, output hook; `docs/contracts.md`, The output gate.
- Missing: a common vocabulary for streams, non-streamed payloads and recipient identities beyond `{ type, data }`.
- Choice: Go identifies ACP subscribers by actor, groups model and tool progress separately, uses `model.output` with a channel and `delta`, and keeps the Harness event types for other output. The served redactor handles text in nested payloads and secrets split across adjacent deltas.
- Swap test: yes. A generic redactor can walk all text, but a plugin that blocks certain types of events or redacts a named field needs a common shape.

### B31: Portable closure, retry promises and erasure synchronization

- Where: `docs/bindings/data.md`, History entries and Portable sessions; `docs/bindings/plugin.md`, Provider and Runtime registrations; `docs/bindings/acp.md`, Entry.
- Missing: a wire field for a Provider's explicit safe-to-repeat promise, and a rule for the actor on an automatic question close. The ACP Entry paragraph also says an erased entry keeps only four fields, while shared data and history HTTP keep its execution identities.
- Choice: record safe repeat only with proof, and do not infer it for a stateful or tool-running Provider that lacks a wire promise. Automatic closes record a reason without impersonating an answerer. Go uses the shared tombstone identities, including in ACP history. A portable erasure marker hides targets during recovery, but a marker-only import is not itself confirmation that remote copies were physically scrubbed. Question closure after an authority change is checked when the question is settled, not broadcast immediately on every rights change.
- Swap test: yes. An unsafe repeat can have effects outside the Harness, and missing tombstone identities can reopen work that is already settled.

### B32: File rewind and history commit do not share a transaction

- Where: `docs/bindings/data.md`, Rewinding; `docs/bindings/plugin.md`, `env/save` and `env/restore`.
- Missing: what to do if file restore succeeds but writing the new branch position fails, or an editor changes the same files during restore.
- Choice: validate the branch first, refuse work whose outside effects cannot be ruled out, and save a backup before restoring. Roll back files on a handled commit failure. The local environment stages renames and keeps a backup if a competing file change prevents rollback. Points are local to their environment. Root projects, nested mounts and unsupported special files are refused rather than copied.
- Swap test: yes if a host assumes a cross-service transaction or tries to restore another environment's point. There is no guarantee of atomicity across a crash between file restore and history commit.

### B33: The actor check does not wait for the released turn to finish

- Where: `conformance/acp/run.mjs`, the end of several actors and the start of rewinding; `docs/bindings/acp.md`, Prompts.
- Wrong: the kit waits for a `response` entry after releasing the proposal, not for the matching `turnEnd`. It then sends a new prompt during the finish of the released turn. This showed up most often with a race-instrumented agent and a separate Runtime process.
- Choice: leave the kit unchanged. Queue ACP prompts behind finishing work admitted through other channels. This does not merge input from different actors; overlapping ACP prompts on the same connection are still refused.
- Swap test: yes. If queuing is not part of the binding, the kit should wait for the released turn to end first.

### B34: An open-world hint does not identify a tool's working environment

- Where: `docs/bindings/data.md`, Tools and Rewinding; `docs/bindings/plugin.md`, The host asks a tool source.
- Unclear: the tool hint borrows the cautious MCP defaults, but the stdio binding routes tools through the selected working environment. TypeScript's shell tool sets `openWorld: true`; Rust's leaves it out. Both run in the selected environment and both were refused by Go before `env/restore`.
- Choice: keep the hint, but for stdio tools use the binding's working environment rule when recording rewind coverage. Jobs, recorded outside effects, and points the selected environment cannot restore are still refused. This trusts plugins to follow the binding and does not turn a saved file point into a sandbox or a rollback of network effects.
- Swap test: yes. A host that reads the hint as proof of separate effects will refuse a rewind that works with its own tools.

### B35: ACP needs an error for an answer the output gate withholds

- Where: `docs/contracts.md`, The output gate; `docs/bindings/plugin.md`, the `output` hook; `docs/bindings/acp.md`, Extension methods.
- Missing: what an ACP request receives if the output gate blocks its reply or the handler fails. Go's request listing could return `-32603` with the handler's error, and the `answer` acknowledgement bypassed the gate.
- Choice: pass the acknowledgement as `interface.answer`. If a gate blocks or fails on a reply, send JSON-RPC `-32000` with `output gate withheld the response`, without the response or hook error. This does not undo an operation that already ran.
- Swap test: yes. A client should not hang, confuse withheld output with a host failure, or treat it as proof that the request had no effects. A plugin that filters acknowledgements also needs a common event name.

## Round four

### B17: The plugin kit probes a PID in the wrong namespace

- Where: `conformance/plugin/run.mjs`, the background process and session-end checks; `docs/bindings/plugin.md`, the working environment.
- Wrong: the kit reads `$!` from a shell and calls `process.kill` on that number outside the shell's PID namespace. In this build each command has its own PID namespace, so both calls can print the same number. The kit can report a living process as gone, or signal an unrelated process. Its escapee check uses the same probe.
- Choice: leave the plugin and kit unchanged on this point. Run the kit in a separate PID namespace with the low PID slots unused. The two live-background assertions fail there. A Go regression uses file markers to show that both commands keep running, that ending one session stops only its command, and that the other command keeps running.
- Swap test: no host needs to interpret an arbitrary shell's PID. This is a kit portability bug. Use file markers or a wire operation that reports liveness, not a PID from shell output.

The refreshed kit uses heartbeats for background work. It passed 105/105 in five isolated runs, and the Go test now requires all 105 checks. One run alongside the other suites missed a heartbeat. The setsid check still uses a PID, so the wrapper still isolates it.

### B18: A held lease can come back without a retry hint

- Where: `docs/bindings/history-http.md`, Writing and What the service declares.
- Wrong: the supplied service advertises `ttlMs: 15000` but its `409 held` omits `retryAfterMs`. Also, `GET /v1` may omit `ttlMs`, so the binding cannot always supply the upper bound it asks the client to obey.
- Choice: our service includes `retryAfterMs`. With only a retry hint, bound the wait by that hint. With only an advertised TTL, retry once after that TTL. With neither, fail instead of looping. Never renew or take over a held lease as another owner.
- Swap test: yes. A client that requires the hint cannot reopen a crashed writer's session on the supplied service.

### B19: Admission and withdrawal before an input is taken

- Where: `docs/bindings/data.md`, History entries and Portable sessions; `docs/bindings/acp.md`, Prompts and `input`.
- Missing: `input` is written only when taken. Standard entries cannot represent queued input, a key before it is taken, the promise made by an input receipt, or withdrawal when cancellation hands input back.
- Choice: Go keeps the existing dotted intake and withdrawal records for work which has not yet reached a turn. Taken keys, actor, content and the link to a turn are all in the standard `input`; another build can ignore intake records and still recover and deduplicate taken inputs. No private checkpoint is needed for a taken turn. Cross-build recovery of an unconsumed admission is not covered by the standard kinds as written.
- Swap test: yes, if an agent dies after the receipt but before taking input. Either specify admission, withdrawal and handback entries, or make that boundary explicit in the portability promise.

### B20: Who may attach to a foreign session, and answer which question

- Where: `docs/bindings/data.md`, Questions and Portable sessions; `docs/bindings/acp.md`, `initialize`.
- Missing: actor IDs are local and recorded, but a reopening Interface has a new connection's identity. The shared rights and question shapes do not say how to map the connection to a previous actor, or name a question's eligible answerers. Open questions are portable, but an unhandled request has no standard draft-matching key when an older build left it out.
- Choice: the local ACP operator attaches as the recorded host/user if its own identity was not recorded. Retain those recorded rights. Default an unscoped foreign question to the session actor and check rights again at answer time. This does not grant client-supplied identities or override a recorded denial. Go-specific forwarding and eligible-answerer details remain extensions.
- Swap test: yes. One build could refuse all access, while another could grant a different actor the right to see or answer. Specify attachment identity and question recipients, including the rights vocabulary.

### B21: Tombstones, replay and private job records

- Where: `docs/bindings/data.md`, History entries and Portable sessions.
- Missing: a tombstone for a result loses its call or job identity. `erasure.entryIds` names the removed entry, not the effect it settled. Also, no standard job kinds carry a child-session authority ceiling, and legacy Go HTTP checkpoints are not standard history.
- Choice: keep strictly shaped tombstones. Go-owned job completion IDs tie tombstones to the original job without retaining its payload. Jobs and child permissions are not a foreign-session promise; never manufacture the deleted payload or grant missing rights. Old local Go files remain readable; use a fresh service or convert old nonportable HTTP history before pointing this build at it.
- Swap test: yes for a result erased in isolation if the receiving build cannot tell what it settled, and for unfinished jobs where the receiving plugin is absent. Job ID conventions are private and cannot be a general correction.

### B22: Model identity and defaults after a swap

- Where: `docs/bindings/data.md`, Models, History entries and Portable sessions.
- Missing: Provider names may be build-specific, and several turn settings are optional. No rule says what to do when the recorded model is unavailable in the importing build or a setting was omitted.
- Choice: retain the recorded Provider/model reference. Resolve it against the available catalog including qualified names. Fill omitted settings from the current session/defaults, and fail rather than silently choose a different unavailable model. Installing a matching Provider or changing the session setting can support new turns.
- Swap test: yes for continuation and recovery unless the agents install compatible Providers and agree on defaults. A portable on-disk shape alone does not guarantee identical inference.

The first Rust to Go swap exposed this for the shared echo model. The ACP binding allows echo to offer any reasoning levels. A writer chose `low` and Go only offered `off`, so Go could not select the recorded turn's model settings and never called the Runtime. Go echo now accepts every standard level without changing its output. A common required set of levels for echo, or a rule for resuming an unsupported level, would prevent this failure between builds.

### B23: Decisions that occur between standard entries

- Where: `docs/bindings/plugin.md`, The host asks the Runtime; `docs/bindings/data.md`, History entries and Portable sessions.
- Missing: standard entries do not identify an in-flight model request, the last result gate decision, the effective model retry request, or in-flight step counts. A `turnStart` has no separate hook-contributed context field. Safety for an unrecorded outside Provider effect is not inferred from `toolStarted`.
- Choice: recover recorded responses/results without running them again. Derive steps from responses. A new attempt may re-run a hook or re-prepare a model request that has no completed response. Go retains a few native step records and turn context fields for local optimizations and conservative recovery of an unknown stateful model effect. Unsafe tool repetition always uses the start proof, not a missing record.
- Swap test: yes at a crash between a gate or outside model effect and its recorded result. Standard durable step and effect markers would make that boundary predictable.

### B24: What remote erasure reports identify

- Where: `docs/bindings/plugin.md`, `provider/discard`; `docs/bindings/acp.md`, `_modular-agent/erase`.
- Missing: the Provider's `pending` strings need not be history entry IDs, but the ACP result requires those IDs. `provider/discard` erases by session, not by list of entries. The bindings do not say how to track retries for copies a closed session once made at an unavailable Provider.
- Choice: await erasure for affected open sessions. Report their affected entry IDs as pending if erasure fails or if the Provider reports pending copies. Preserve Provider descriptions for out-of-reach copies. Another erase of those entry IDs retries the operation; the Provider owns any remote tracking it needs. A missing Provider cannot confirm remote deletion.
- Swap test: yes. Two hosts can report different pending IDs for the same failure. A binding that wants exact remote deletion reports needs a correlation key between local entries and copies, plus a rule for closed sessions.

### B25: Correlating tool-list updates and credential requests

- Where: `docs/bindings/plugin.md`, The host asks a tool source, The host asks a Provider, and What a plugin may ask the host.
- Missing: `tools/changed` identifies its source but not the request that changed it. With concurrent work, the host cannot attribute it to a specific answer. A parentless credential read identifies a Provider but not which part of a multi-capability process sent it.
- Choice: refresh changed lists at the ordered notification boundary rather than infer which request caused them. Grant credential reads only for Providers registered on that plugin connection. A native Runtime has no credential port; a mixed external process is one trust boundary and must isolate its own parts if it needs finer control.
- Swap test: yes for a host that hands an answer to its caller before refreshing the tools. For credentials, process-level authority interchanges, but stronger isolation across parts cannot be enforced by the host without a separate identity or process.

### B26: The proposal right has no ACP operation

- Where: `docs/bindings/data.md`, Actors; `docs/bindings/acp.md`, Prompts and `input`.
- Missing: `propose` permits input that waits for another actor to release it. ACP has no proposal or release operation. Queuing input for the next turn is not a proposal because it runs without anyone releasing it.
- Choice: recognize and preserve `propose`. Never treat it as `input`. This build does not offer proposal or release operations.
- Swap test: yes if a host expects to use this right through ACP. Standard rights alone do not give a host a way to propose or release input.

## Bindings

### B13: A Runtime can write its history but has no Runtime history-read port

- Where: `docs/bindings/plugin.md`, The host asks the Runtime, and What a plugin may ask the host; `docs/contracts.md`, Recovery and repeating work.
- Missing: `resumeTurn` carries unfinished calls but not the last response, completed steps, usage, or the Runtime's private checkpoints. The Runtime is told to use `host/runtime/*`, which has a write port but no read port.
- Choice: use the existing paged `host/history` on the current branch, with the turn's `parentRequestId`, for restart and late-call reconstruction only. Go stores private checkpoints with `host/runtime/record`. Live model, tool, hook and input work uses only Runtime ports. Reopening an interrupted turn uses a fresh process, not the plugin's home. This does not migrate an in-flight turn between different Runtime implementations.
- Swap test: yes. If a host refuses `host/history` to a Runtime, a new process cannot recover its private checkpoints or tell whether the last response and its completed results can be reused. Specify a read port or explicitly authorize the general history port.

Round four settles this: `host/history` is explicitly available to the Runtime, and recovery from foreign standard records is required and tested.

### B14: Safe repetition needs a working-environment promise

- Where: `docs/bindings/plugin.md`, Runtime turn and interrupted-call parameters; `docs/contracts.md`, Recovery and repeating work.
- Missing: `started` and the tool definition cannot tell a durable Runtime whether the previous working environment stopped everything. The turn does not carry that promise. There is also no standard field for the original definition.
- Choice: Go's Harness sends an optional `turn.environmentStopsOnCrash` fact. Go's Runtime records the definition before asking the host to run the tool and checks both the recorded and current definitions. Missing cleanup or definition proof means no repeat of a started call; it gets `outcomeUnknown`. A never-started call needs no such proof.
- Swap test: yes. Without an agreed promise, a swap can change safe retries to unknown results, or worse, repeat a call while the first is still active. The checkpoint encoding is private; the cleanup fact is not.

Round four settles this with `toolStarted.data.safeToRepeat` and the `resumeTurn` call's effective `safeToRepeat`.

### B15: Turn records, terminal callbacks and streamed events

- Where: `docs/bindings/plugin.md`, TurnOutcome, Runtime hook, record and report ports; `docs/bindings/data.md`, History entries.
- Missing: it is not explicit which side guarantees the initial and terminal turn records or when `turn.end` is callable relative to recording `turnEnd`. Tool starts have an owner but no agreed history kind. The report port has no event vocabulary or rule for duplicate relays from `modelEvent`. The text also does not say how cancellation can leave enough authority to settle effects.
- Choice: the Harness guarantees one start and one end. It returns the existing start on a Runtime's start write, accepts a Runtime end or records the returned outcome, and records tool starts before execution. It permits the end observer while the parent RPC is still open, but not new work after an end record. On cancellation it permits settlement and cancels outstanding outside work. Live ACP model and tool updates come from the host's Provider, tool and committed-record events; Runtime relays do not create a second copy. A lost Runtime is reported, not replaced.
- Swap test: yes. Without these boundaries hosts can miss interrupted turns, duplicate records or output, or reject essential cancellation writes. The host and Runtime should agree on lifecycle ownership and either define report types or state that they are optional diagnostics.

Round four settles turn record ownership, `turn.end` ordering and host-owned standard events. Cancellation during settlement still requires keeping the turn parent live until its outcome.

### B16: Runtime declarations and operations outside a model turn

- Where: `docs/bindings/plugin.md`, runtime registration and Runtime requests; `docs/contracts.md`, Harness and Runtime.
- Missing: the declaration can advertise rewinding, but there is no rewind request. The binding also has no model-free UI tool operation. For late calls it gives call IDs, not the actor or original arguments in the returned open list.
- Choice: the Go host does not advertise rewind or route direct UI tool calls through a hosted Runtime. Normal model calls and answered late calls use the standard requests. The host joins returned open IDs to the existing recorded calls to retain their arguments and authority; a late call does not get a new identity.
- Swap test: yes for rewind and direct UI calls, which a swap cannot preserve with the current request set. The host's lookup of its own call records is internal as long as identities remain stable.

Round four clarifies UI calls and rewind are not delegated in `/1`, and defines continued calls and the returned open IDs.

### B12: Intermittent short-command output notification loss

- Where: `docs/bindings/plugin.md`, The host asks the working environment, Output streams; `conformance/plugin/run.mjs`, env/exec streamed env/output check.
- Missing: no unclear binding rule. One direct plugin-kit run during the missing-file fix returned the correct command output but failed the streamed env/output check. This is an implementation follow-up, not a new wire gap. The unchanged rerun and the normal and race suites passed all 42 checks.
- Choice: reproduced in stage 2: 10 of 250 short commands returned the right result but lost their notification with GOMAXPROCS=1. The separate exit pipe could overtake stdout. The command supervisor now sends output frames and the final exit on one pipe. The regression fails on the old code and passes with the fix, and the same wire probe now streams 250/250 before the reply. Evidence: `/tmp/modular-go-stage2-b12-{before,after}.log`.
- Swap test: a host relying on live notifications needs the output before the final answer. This was a Go implementation defect, not a reason to change the binding.

### B7: Item replacement versus whole-plugin replacement

- Where: `docs/bindings/plugin.md`, Starting and Choosing plugins; `docs/contracts.md`, Plugins and capabilities.
- Missing: the description replaces a loaded plugin and all its registrations, but the binding replaces individual items, possibly only two tools from a four-tool source. It does not say what an absent local target means, whether one external plugin may replace another, or whether two processes may register the same plugin/source name.
- Choice: remove only the named local items before loading the external registrations. Filtered sources cannot run their removed tools even through direct source access. Retain unrelated local items. An absent local item is a no-op, so an external Provider can be the only Provider. Refuse collisions without replacement and attempts to replace earlier external items. Tool-source IDs are scoped to a process; internal plugin identities include their launch-list position. A failed replacement leaves no partial external registration and does not silently restore the old item. Plugin state folders use the stable launch-list position under the data folder.
- Swap test: partial removal is essential to tool swapping. Absent-target semantics, external-on-external replacement and process identity can change whether a composition starts. They should be explicit. Internal names and folder layout do not cross the wire.

Round four settles item replacement, absent local items, external-on-external refusal and restoring local registrations on rejection.

### B8: Callback lineage and direct session access

- Where: `docs/bindings/plugin.md`, Transport and What a plugin may ask the host.
- Missing: some callbacks require a parent request, while history/session/declaration and emitted events name sessions directly. The binding does not give direct session requests an actor or a separate grant protocol. Credentials are an object without an agreed object schema. Question answer values and link/secret metadata are not fully typed.
- Choice: require active parent work for questions, environment operations and Provider hook dispatch. Link cancellation to both the parent and the callback; recheck current actor rights. Refuse session changes and unowned hook/credential access. Registered, trusted plugins may directly read raw open sessions and declarations or emit their own namespaced events, as local plugins may. Credential reads consult only an explicitly installed credential store, never the experiment key file: JSON credentials remain objects; legacy string credentials become `{key: value}`. No-store returns null. Questions use string answers, preserve draft metadata, key unnamed questions by call identity and ordinal, return pending for open questions, and return declined for time limits/unavailable secret destinations. Provider credential names are reserved; secret answers contain only the stored name.
- Swap test: the lineage checks are required for authority and cancellation to survive a swap. Direct session scope, credential object members and answer/credential types need specifying for arbitrary third-party plugins. Conformance needs no credentials.

Round four settles the live parent boundary, direct session access and Credentials. The question recipient gap is B20.

### B9: Standard hooks over different private hook APIs

- Where: `docs/bindings/plugin.md`, The host asks a hook handler and The host asks a Provider; `docs/contracts.md`, Hook points and Provider state.
- Missing: the wire has gate/collect points where this build originally had private transform points. The binding says Provider response hooks run as the response arrives, but its payload is a whole assistant message rather than a stream event. It mentions plugin-defined hook points without a registration shape for defining their name and rule.
- Choice: translate standard payloads and combination rules rather than export private Go structs. Collect turn additions independently; record the resulting system/context with turn-start settings and reuse them on recovery. Tool gates retain the refusal reason and cannot change call authority or identity. Step refusal ends the turn; result refusal asks the model again. Provider hooks work for local and external Providers; the conformance server streams events and then observes the complete assistant message before returning it. Unsupported hook names, including output gates, are refused with not_supported. The adapter exposes provider/discard, but the old native Harness still lacks general stateful-Provider invalidation on navigation/erasure. This is recorded in PROGRESS.md rather than expanded into this stateless conformance assignment.
- Swap test: the standard payloads/rules permit swapping. Per-piece versus whole-message observation and defining custom hook points need more wire specification. Stateful Provider lifecycle remains a known refreshed-rule difference; the conformance Provider declares keepsState false and runsTools false.

Round four settles whole-response hooks, disallows custom hook definitions on the wire, and specifies stateful Provider discard with erasure.

### B10: Shared-data defaults and native history encodings

- Where: `docs/bindings/data.md`, General rules, Tools, Questions and History entries; `docs/bindings/plugin.md`, host/history.
- Missing: tool callers have no stated default or mapping for provider/tool origins; settings have no standard per-key history encoding. History paging does not say what to do with one entry larger than 4 MiB. Old native erased entries did not retain their original kind.
- Choice: keep opaque wire fields alongside native values, including unknown content, reasoning/Provider data, message fields, nested hints and exact unknown JSON numbers. Add cache-write and cost accounting. Omitted callers means all callers, an explicit empty array means none, provider-origin calls count as model work and tool-origin calls as plugin work. Model-only tool lists and the checked call pipeline both honour explicit callers. Encode whole-setting updates as key `settings` with the native settings object as value. Translate known history kinds, include keyed-input metadata, and use entry identities as exclusive page cursors. A single oversized entry returns result_too_large rather than an empty looping page. New local/remote-history tombstones retain the original kind; legacy tombstones fall back to erasure. No migration invents an erased payload.
- Swap test: unknown-field preservation is required for forwards compatibility. Caller defaults/origin mapping, setting keys, oversized entries and legacy tombstones need declaring where hosts rely on them. Native persistence layout remains private.

Round four settles paging and the 4 MiB result cap, and defines standard entry and setting shapes for portable sessions.

### B11: Environment lifetime and failure details

- Where: `docs/bindings/plugin.md`, Transport, The host asks the working environment and The conformance plugin; `docs/contracts.md`, The working environment.
- Missing: env requests contain cwd but no session identity or session-close operation. An environment shared across sessions therefore cannot associate a completed command's background children with their owning session. Filesystem error meanings were originally not fixed. The 2026-11-17 matrix follow-up now requires not_found for missing-file reads. Other filesystem error meanings and the numerical JSON-RPC error values, except ordinary method-not-found, remain unspecified.
- Choice: preserve this build's namespace-supervised process lifetime. Cancelling an active command, closing stdin, stopping the plugin or losing its agent kills all its descendants, including setsid escapes. Completed background commands live until their environment process closes, not until one session closes. Advertise strong containment only for the supported platform; weaker external declarations never grant crash-safe repetition. Return real exit codes, null for killed execution and timedOut for an explicit environment deadline. Missing-file reads now use not_found for env/read and host/env/read, including callbacks routed to an external environment. Received not_found errors match Go's fs.ErrNotExist, so existing readers, including the system prompt's optional AGENTS.md read, treat local and external absence alike. Neither message text nor an exists preflight decides the read's error. Other filesystem failures remain internal; exists distinguishes missing paths. Use -32602 for invalid_request, -32601 for unknown methods and -32000 plus data.code for other binding errors. RPC work has no general timeout; cancellation gets a four-second cleanup window, then a non-cooperating peer is lost and torn down. Shutdown has bounded control-message cleanup and exact-PID kill/wait fallback.
- Swap test: background session lifetime cannot be implemented by an external environment from these messages alone. It needs a session/lifetime handle or close operation. Clients must inspect data.code rather than language-specific messages or unspecified numerical errors. The missing-file swap failure is closed by the revised binding and this adapter fix. Internal process supervision and shutdown timing do not affect a cooperating peer's wire behavior.

Round four settles environment session lifetime and JSON-RPC error numbers. The PID check is a separate kit defect, B17.

### B1: Append-only entries do not describe mutable agent state

- Where: `docs/bindings/history-http.md`, Sessions and Entries; `docs/contracts.md`, history store.
- Missing: the binding stores immutable opaque entries and immutable session metadata, but the Go Harness also persists settings, actors, plugin selections and the current branch position. It does not specify an encoding for those, or whether another language must open this build's sessions.
- Choice: follow the binding. Native history entries have `parentId`; separate opaque `go.session/1` entries checkpoint session metadata without duplicating history content. The latest checkpoint supplies mutable state. The agent, not the service, follows copy provenance for erasure. Go-specific sessions are reopened only by the Go adapter; a service can store any language's entries unchanged. Old pre-binding service snapshot files require a fresh state folder, not silent conversion.
- Swap test: service substitution works. Opening another language's private agent state is not promised by this binding; that would require a separate shared history-content contract.

Round four settles the shared persisted state with standard entries. Go no longer writes `go.session/1` checkpoints.

### B2: Lease acquisition before a session's project is known

- Where: `docs/bindings/history-http.md`, Sessions and Writing; `docs/contracts.md`, lazy history.
- Missing: the binding creates a session before leasing it, while this build's Store acquires by ID before the Harness has supplied project metadata. It does not define leasing an unknown session or deleting unused session metadata.
- Choice: defer remote creation and leasing for a new unknown ID until the first save. Existing sessions acquire immediately. An unused session leaves no remote record. All operations use the binding once a project is known. A lost lease permanently disables writes on that handle; it is never silently reacquired.
- Swap test: other services need only the published paths and shapes. The adapter's lazy acquisition is internal. Clients that assume leasing unknown sessions succeeds would not be portable.

### B3: History edge cases and erasure scope

- Where: `docs/bindings/history-http.md`, Errors, Entries and Erasure.
- Missing: malformed-request codes, unknown erasure IDs, numeric JSON equality, restart tokens and cross-session erasure atomicity are not fixed. A literal promise of the same answer on a resend conflicts with `kept` counting only new entries.
- Choice: malformed bodies use `400 invalid_request`; unknown erasure IDs are ignored, and the response lists known targeted IDs even if already erased. JSON numbers compare by exact mathematical value without floating-point rounding. A resend has the same effect, but `kept` becomes zero. Restart invalidates leases. Erasure is atomic per session only; the agent preflights affected sessions and explicitly lists every copied entry. Tombstones retain the original kind, or null when no kind existed. No service cache or journal retains erased payloads, and restart removes crash-left temporary snapshots. Resending pre-erasure entry content against a tombstone conflicts instead of restoring the erased data.
- Swap test: these choices can affect clients at the edges and warrant clarification. Cross-session erasure cannot be made transactional through the specified per-session API. The service correctly does not follow copies.

### B4: ACP project scope and initialization declarations

- Where: `docs/bindings/acp.md`, Starting, The declaration and Sessions; existing G29/G30.
- Missing: the binding does not say how launch-scoped project trust and configured plugins constrain cwd, or how initialization can describe every possible future session Provider.
- Choice: retain the existing one-project-per-process boundary. New/load/resume refuse a cwd outside the configured canonical project; the additional declaration key `projectRoot` exposes this. Initialization describes the installed Runtime and local composition; each session declaration additionally describes its selected Provider. Host identity is connection-owned. Its audit record is deferred until first input or UI tool use, so creating and closing an unused session leaves no history.
- Swap test: a host that assumes any cwd can be opened in one process must instead launch per project. The binding should explicitly permit or forbid this scope restriction. Session Provider declarations remain the authoritative values for session behavior.

### B5: Isolated conformance startup and state precedence

- Where: `docs/bindings/acp.md`, Starting and Conformance mode.
- Missing: whether DATA_DIR overrides explicit state/settings flags, what happens to project-local settings, whether the extra echo model requires configuring a real Provider, and how to count the 200 characters of result text.
- Choice: DATA_DIR overrides local state/settings flags and relocates project settings under a canonical-path hash in that directory. Trust remains invocation-only. User project instructions and tool effects are not agent state. An explicitly chosen remote history service owns its state separately. Conformance startup supplies only the extra echo Provider, ignoring gateway/script selection, so even a missing gateway token cannot cause a network/key access. Normal launches never install it. Truncation counts Unicode code points, not UTF-8 bytes.
- Swap test: hosts need the precedence rule for reproducible isolated runs; echo runs must work without production credentials. Character counting can differ for combining sequences. The binding should name its intended character unit. These choices do not change normal Haiku-only inference.

### B6: ACP cursors, late questions and outcomes

- Where: `docs/bindings/acp.md`, Prompts, Questions, Entry and Extension methods.
- Missing: whether a history cursor outside the selected branch is valid, the vocabulary for outcome.limit, the answer value type for this build's string questions, and precisely which copies outOfReach names. The earlier adapter automatically declined a question when forms were unavailable, contrary to the new binding.
- Choice: follow the binding rather than the old fallback. Questions without forms remain available through requests/answer, including after their turn; no form is issued for a question whose turn has already ended. History cursors must occur in the requested view, so an off-branch cursor needs all:true. Limits are named step/output. Answer values are strings, or omitted for a decline. Erasure reports delivered output and working-environment effects out of reach. Model/thinking/approval settings all apply next turn; tool approval uses the turn's recorded settings, not newly selected settings. Cancelled prompt retries reconstruct handedBack from durable intake-return records, and queued later turns do not replace the original prompt's outcome.
- Swap test: the named wire shapes now permit host substitution. Cursor scope, answer types, limit names and outOfReach granularity still need clarification to avoid host assumptions. Removing a keyed input's receipt through explicit erasure also removes that key, as in this build's existing erasure contract.

## G35: HTTP host identity, replay and acknowledgements

- Where: `docs/architecture.md`, Being driven by a host, Who sees what and Declared support; `docs/contracts.md`, Interface and Harness; `docs/scenarios.md`, 17.
- Missing: HTTP host authentication/identity, a replay cursor, atomic replay/live handoff, slow followers, responder presence, and which operations can be retried after a lost answer.
- Choice: a version 1 authenticated JSON Interface serves one configured project and one operator-controlled host actor. Wire input cannot forge actor, answer forwarding or job provenance. Session lifecycle, input, answers, cancellation, settings, commands, tools, navigation, jobs and erasure use the existing plugin API. Input keys use the existing durable receipts; losing an acknowledgement never cancels accepted input. Session creation and arbitrary commands/tools are not declared retry-safe. A disconnected event follower does not stop the turn. Only a live follower counts as an available approver; requests expose current answerability. Secret collection is explicitly refused without a credential destination. Full API and launch instructions are in `SERVICES.md`.
- Choice: an entry ID is the reconnect cursor. NDJSON replay scans the gated snapshot in append order, not just the selected branch or history.added events, then polls it for new records. This includes every recorded entry even when the Harness did not emit a matching event. Gated live pieces use a bounded queue and may be dropped for slow followers; missed pieces are represented by their complete records on reconnect. Unknown cursors refuse before streaming. Write deadlines disconnect blocked followers. No separate indefinite event log retains erased content. The binding uses one authenticated host identity, not an invented multi-tenant identity service.
- Swap test: replay coverage, cursor exclusivity, lost-answer behavior, responder presence and declared retry/secret limits affect hosts. JSON/NDJSON, polling and endpoint names are binding choices. The description correctly requires replayed records rather than replay of every streamed piece, but cursor/authority/presence behavior needs declaring.

## G34: Credential-owning model gateway

- Where: `docs/architecture.md`, Provider and Credential store; `docs/contracts.md`, Model access and Asking the credential store; ADR 0005 and ADR 0010.
- Missing: how model access moves across a credential boundary, whether transport retries can repeat a vendor request, and whether agent-side sign-in is required with remote access.
- Choice: the gateway alone loads the Anthropic Provider and credential-store plugins. Agent composition no longer installs a credential store or a direct real Provider. The gateway plugin fetches the catalog and carries chosen-model requests over authenticated HTTP; NDJSON preserves streamed parts, the complete response, usage and classified model errors. Generation is never automatically retried by the transport. An interrupted response is explicitly unknown; normal durable Provider declarations still decide whether Runtime recovery can retry it. Stateless Anthropic access offers only `claude-haiku-5-5`. Tests use scripted Providers or a dummy-key loopback vendor fixture. CLI real inference now requires a gateway URL and service-token file. Agents have service authentication tokens, never model credentials or the experiment key path.
- Swap test: preserving Provider state/tool declarations, error kinds and unknown outcomes affects plugins and recovery. An Interface must decline secret/sign-in collection when its agent has no credential destination. The HTTP endpoints and stream encoding are binding choices; moving the credential store with the Provider follows the existing separation rather than giving the Runtime credentials.

## G33: Remote sandbox and agent lifetime

- Where: `docs/architecture.md`, Working environment and Surviving interruptions; `docs/contracts.md`, Harness and working environment; `docs/scenarios.md`, 7 and 16.
- Missing: what a sandbox exposes, path/symlink rules, remote agent lifetime, live-output framing and background-shell behavior across disconnects.
- Choice: the service owns one canonical folder. Go `os.Root` confines file operations, including symlink traversal; projects and absolute paths must be within that folder. Commands run inside a per-agent Bubblewrap worker with only that tree writable as host storage, read-only `/usr` and the worker executable, private `/tmp`, `/dev` and `/proc`, no host home or `/etc`, cleared environment, and isolated network/IPC/PID/user namespaces. The tree is mounted at its original absolute path so file and shell tools agree. The Harness/configuration still require that project folder to be locally visible at the same path; arbitrary remote project mapping is not offered. An authenticated persistent connection owns the worker. Its EOF, failed write or explicit close tears down every command; each command stream also cancels on disconnect. NDJSON carries live output and a final result. Unsafe writes/commands are not retried after transport loss. A lost worker is reported explicitly rather than silently replaced. Bubblewrap and Linux namespaces are required and failure is closed. The operator must supply an ordinary folder, without mounted sensitive filesystems, host device nodes or sensitive hard-link aliases. This is not resource metering or a hostile-kernel boundary.
- Choice: an agent's worker keeps the existing namespace supervisors, so bare shell backgrounding still returns without killing its descendants. The supervisors now mount a private namespace-correct `/proc`. Their setup capability exists only in the new user namespace and is cleared on the locked OS thread before command creation. This was needed because Bubblewrap and other namespace-aware tools inspect their own PIDs through `/proc`.
- Swap test: confinement, exposed filesystem/network, environment loss, backgrounding and disconnect lifetime affect tools and hosts. Bubblewrap, the persistent connection and NDJSON are binding choices. Agent death is detected through TCP closure, so network partitions cannot promise instantaneous cleanup. Slow/dead stream writes have five-second deadlines.

## G32: Remote history ownership and lost answers

- Where: `docs/architecture.md`, History and Surviving interruptions; `docs/contracts.md`, Harness and history store; ADR 0010.
- Missing: how a remote store detects a dead writer, fences a paused writer, retries acquisition and writes, and coordinates erasure between agents.
- Choice: authenticated version 1 JSON HTTP operations adapt the existing Store and Lease capabilities. Random server lease tokens fence every load/save/renew; heartbeats renew a three-second lease. Expiry or release is final, even for a delayed old request. Acquisition and saves have stable retry identities; a lost answer is retried with the same identity. Saved snapshots retain the existing immutable-prefix and atomic synced replacement checks. Server restart invalidates every token, while snapshots survive. Erasure refuses while any different client owns a lease. Unused sessions still leave no snapshot. HTTP service tokens are separate from model credentials, supplied from files. Plain HTTP is allowed only on loopback; other client URLs require HTTPS and redirects are refused.
- Swap test: fencing, ownership loss, retry semantics and erasure coordination affect plugins. Hosts need to know takeover is bounded by lease expiry, not instantaneous. JSON endpoints, token encoding and the heartbeat mechanism are binding choices. A lease-lost agent fails closed on further history writes rather than acquiring again behind its Runtime.

## G31: ACP version, identity and protocol translation

- Where: `docs/architecture.md`, Interface, Being driven by a host and Declared support; `docs/contracts.md`, Interface and Harness; `docs/scenarios.md`, 17.
- Missing: which ACP version, how authentication maps to actors, how internal outcomes and content map to ACP, and which host operations need extensions.
- Choice: stable ACP v1 through Caelis Labs' maintained Go SDK, listed by ACP, pinned to official schema 1.31.0. ACP v2 remains a draft. The locally launched stdio peer acts for the local owner, recorded as an actor of kind host, with no right widened on attach. Sessions are bound to that connection and launch project. Wire intake cannot forge actor, job, copy provenance or replay-call identities; those fields stay within trusted plugin access. Initialization declares lifecycle and MCP HTTP support and namespaced extension metadata; new/load/resume return the active declaration. Models and thinking levels come from the actual Provider catalog as select config options; approval is another selector. Model and thinking changes are accepted during generation but apply to the next turn, and this boundary is declared. A running or recovered turn keeps its recorded selection. This extends G08's original idle-only rule for model settings. Approval-policy and limit changes still require an idle turn. Unsupported client system prompts, extra roots, transports and rich prompt types are refused before effects. Baseline resource links become descriptive model text with the original block retained.
- Choice: approvals use allow-once/refuse permission requests; only a valid explicit allow is accepted. Text and choice use form elicitation only after explicit client form support, with returned types and choices checked again. Missing support, declines, cancellation and invalid replies decline safely. ACP forbids secrets in forms, so this Interface declines secret collection rather than downgrading it. It offers neither a sign-in URL flow nor client-owned filesystem/terminal execution. Tools still use this build's working environment.
- Choice: standard load replays the gated conversation before answering; resume does not replay. Events during load are buffered and already represented records are not replayed twice. EOF interrupts sessions for Runtime recovery; explicit close cancels session work and releases session MCP servers. Concurrent ACP v1 prompts are refused; an advertised input extension offers steering, queued input, keys and withdrawal. Other extensions expose gated full-record follow by entry cursor, slash commands (including navigation, erasure and jobs), model-free UI tool calls and answers. Live extension events are opt-in; reconnect uses the recorded entries, not missed deltas. Keyed duplicate prompts return their original recorded outcome without another model call. Cancelled and limited turns map to ACP stop reasons; failed turns are protocol errors. All output, including replay and duplicate outcomes, comes from gated views.
- Swap test: yes. Version, identity, declared limitations, lifecycle, replay, keys and permission/elicitation translation affect hosts. Extension names and Go types are binding choices.

## G30: MCP naming, hints, scope and errors

- Where: `docs/architecture.md`, Tool source; `docs/contracts.md`, Tool definition, Tool result and Harness and tool source.
- Missing: MCP naming, conservative hint defaults, rich results, connection failure handling and server lifetime.
- Choice: the official MCP Go SDK owns stdio and Streamable HTTP protocol details. Tool names are `mcp_SERVER__TOOL`; server names cannot contain the `__` delimiter. Names are limited to this Provider's 64-character identifier space; incompatible names fail attachment. Read-only, destructive, idempotent and open-world annotations become standard hints. Read-only or idempotent implies safe repeat; missing destructive and open-world hints default true. MCP has no standard parallel hint, so its tools stay serial. Full definitions/results, non-text parts, output schemas and structured results are retained. Configured servers are shared by every session; ACP servers belong only to their session, are supplied again on reopen, cannot shadow shared names and close on session close or process stop. Attachment is all-or-nothing. Tool-list changes refresh the source for subsequent turns; calls route against the current list. Tool failures are failed results; transport loss is unknown, with an explicit warning to check effects; cancellation is cancelled. No sampling, remote elicitation, OAuth sign-in or legacy SSE transport is advertised. Explicit HTTP headers are allowed and redirects are refused. Stdio runs trusted plugin programs, not sandboxed commands; the direct child dies with the agent and orderly close also kills its process group.
- Swap test: yes for names, hints, lifecycle, visibility and unknown outcomes. SDK internals and JSON encoding are binding details. MCP server annotations are trusted hints, not proof of safety.

## G29: Configured plugin discovery, trust and project scope

- Where: `docs/architecture.md`, What plugins can do and Configuration; `docs/open-questions.md`, Plugin scope, lifecycle and trust.
- Missing: plugin discovery format, option merging, how trust is granted, and how fixed process-wide plugins coexist with several project roots.
- Choice: settings name compiled-in factories with JSON options. Embedders can add factories; no source downloading or Go shared-object ABI is invented. Global plugins load without a project grant. Only an explicit invocation's `--trust-project` enables project plugins and project overrides of global plugin options. Options merge by top-level key in first-appearance order; duplicates within one file and unknown factories fail startup. Session defaults apply even without trust. Trust is not remembered, inferred from files, or granted over ACP. A configured process is bound to its canonical launch project, refusing other roots before opening or creating a session. Reopening through the CLI selects the recorded project first; a trust grant must explicitly match it. This prevents project plugin code and options leaking between roots while plugins remain fixed.
- Swap test: yes for trust, merge order and project scope. A host must launch another process for another project. JSON and the compiled factory catalog are binding choices.

## G28: UI call recovery and final checks

- Where: `docs/architecture.md`, Tool source and Where plugins can step in; `docs/contracts.md`, Tool call and Hook points; `docs/open-questions.md`, Tool calls outside a turn.
- Missing: which part owns a UI call without a turn, how it recovers, whether its result starts inference, and how a late gate interacts with an earlier approval.
- Choice: the Runtime exposes a model-free call operation using the identical checks, body and result pipeline. An external.start record keeps the original call and definitions, including the boundary before tool.call exists. Reopen delegates interrupted external calls to the selected Runtime: transient repair or durable continuation using the same saved/current repeat-safety rules. A timed-out UI question may resume with a keyed model turn after its answer; ordinary UI calls do not start inference. UI calls serialize with turns and drain job reports queued while running. Approval proofs are revalidated after all gates and immediately before execution, against both the final arguments and current actor authority. Result-check reasons become recorded input within the same turn, bounded by the normal step limit.
- Swap test: yes. Hosts need model-free call, replay, approval-binding and final-check semantics; the external journal encoding is internal.

## G24: Job recovery, reporting and usage

- Where: `docs/architecture.md`, Jobs; `docs/contracts.md`, Plugin and Harness: jobs.
- Missing: start idempotency, cancellation races, report delivery after a lost acknowledgement, and usage aggregation.
- Choice: keyed starts return the original job. The owner plugin decides how unfinished jobs resume. A completed job is recorded before its keyed report is admitted as input; reopen retries delivery, so a crash in that interval cannot lose or duplicate the report. Waiting jobs do not report separately. Cancellation of finished jobs returns their recorded state. Session usage adds its turns and job usage, not the same report twice. The model-facing delegate tool uses the selected session model; it cannot select a different real model.
- Swap test: yes for keys, reports, cancellation and accounting. Goroutines and journal layout are internal.

## G25: Subagent continuation and forwarded authority

- Where: `docs/architecture.md`, Working with other agents and Waiting for an answer; `docs/scenarios.md`, 8; `docs/open-questions.md`, Agents working together.
- Missing: child identity and follow-up grammar, depth, recovery when Runtime and subagent durability differ, and how secret/approval provenance passes through parents.
- Choice: delegate takes task, optional child session and background (default true). A job records its child before input starts. Follow-ups use that same finished child, narrow its ceiling again, and get a new job. The default depth is three. Every question is mirrored one parent at a time with a recorded forwarding link; the answer returns through those links, carrying actor references and only a secret's credential name. A transient subagent reports unknown after interruption. A durable one resumes its child; with a transient Runtime it first accepts that Runtime's repair, identified by a standard interrupted outcome field, then starts a continuation keyed by the interrupted turn so repeated stops cannot strand the job. That continuation must inspect unknown effects. A child with open calls keeps its job unfinished until its final result, not just until the first turn ends.
- Swap test: yes. These choices affect tools, hosts, durability and authority. Child session layout is internal.

## G26: Late model views and navigation

- Where: `docs/architecture.md`, Waiting for an answer and History; `docs/contracts.md`, Tool result.
- Missing: how to present a still-open exchange to a vendor that requires adjacent tool results, and what moving or forking does to live jobs and questions.
- Current rule: [Context and interrupted work](../../../docs/bindings/data.md#context-and-interrupted-work) specifies the model view. Tool results follow their assistant message in call-part order. For a call left open past its turn, the view uses a waiting tool result until the call settles. The raw record never gets that stand-in.
- Navigation choice: Moves, forks and erasure are refused while calls or jobs are unfinished, and navigation into unfinished boundaries is refused. Finished job/question records copied into forks are provenance, not live work. Forks retain actor ceilings rather than regaining root authority.
- Swap test: yes. Model-context shape and navigation limitations affect plugins and hosts. This conservative limitation avoids resuming abandoned outside work.

## G27: Stopping, closing and erasure of job results

- Where: `docs/architecture.md`, Jobs and History; `docs/contracts.md`, Job and History entry.
- Missing: how a clean process shutdown differs from closing a session, and provenance for job results crossing session boundaries.
- Choice: Harness shutdown first refuses new intake and job starts, then interrupts every job and its sessions in that order, without recording cancellation as their final result. This order prevents a parent mistaking its stopped child's in-memory outcome for a finished job; an explicit session close cancels jobs and closes child sessions. SIGKILL requires no shutdown hook. Job starts copy their initiating call, child task input names the job start, job ends copy child results, and report input copies the job end. Erasure follows those links. An erased job result is not mistaken for unfinished work to restart. File effects remain outside history erasure as before.
- Swap test: yes for shutdown semantics and copy provenance; cancellation implementation is internal.

## G20: Authority grants and actor identity

- Where: `docs/architecture.md`, Actors and authority; `docs/open-questions.md`, Several actors; `docs/contracts.md`, Actor.
- Missing: authentication, grant and revocation operations, concrete rights and propagation to descendants.
- Choice: the in-process Interface authenticates its caller and supplies actor identity. New root sessions have the local user with all supported rights. A recorded grant requires grant authority and every right being granted. Child actions intersect their recorded ceiling with their parent's current authority recursively. The plugin API remains trusted, not a security sandbox. Concurrent steering from different actors is refused rather than widening an existing turn. No tenant budgets or external identity provider are invented here.
- Swap test: yes. Hosts and plugins need the grant, revocation and action-attribution rules. Authentication transport remains a binding concern.

## G21: Question replay, deadlines and approval policy

- Where: `docs/architecture.md`, Waiting for an answer; `docs/scenarios.md`, 2 and 3; `docs/open-questions.md`, Waiting for an answer.
- Missing or contradictory: whether a durable turn must always wait, key collisions, stale answers, the meaning of a connected approver, and whether approvals can outlast a turn.
- Choice: the asking plugin chooses a timeout and whether to leave the call open, with either Runtime. Question identity binds the key to kind, call, asker, options, credential name and prompt. Changed requests with the same key are refused. A saved answer is reused only on the selected branch and while every actor in its forwarding chain still has authority. Otherwise a new question is recorded. Approval waits up to one minute, never outlasts its turn, and refuses without a connected authorized responder. Policies are off (the compatibility default), ask-unless-read-only, ask-always, and never (refuse all calls without asking). Approval keys also bind transformed arguments. Live Interface presence is not persisted.
- Swap test: yes. These rules affect waiting, late answers, policy and the meaning of cached allows. Timer implementation is internal.

## G22: Open calls and continuation

- Where: `docs/architecture.md`, Waiting for an answer; `docs/contracts.md`, Turn input and outcome and Input request and answer.
- Missing: continuation identity, multi-question batches and how an unrelated input can coexist with an unfinished tool exchange.
- Choice: a timed-out deferred call has a tool.open checkpoint but no tool.result. The turn completes with open call identities. When every question for that turn's remaining open calls has an answer, keyed follow-up input starts one new turn, reruns checks and tools from the top, and records the original calls' one late result each. Questions whose call has settled are no longer answerable. Cancellation settles the active calls. A replay of an explicitly parked call is not a repeat of an unknown outside effect.
- Swap test: yes. Hosts and tools depend on settlement, grouping and replay semantics. Checkpoint encoding is internal.

## G23: Credential writes and secret routing

- Where: `docs/architecture.md`, Credential store and Waiting for an answer; `docs/contracts.md`, Input request and answer and Asking the credential store.
- Missing: a credential-write API, collisions, write failures, destinations and authority provenance through parents.
- Choice: a writable credential-store interface receives the raw value directly from the answering Interface through the questions plugin. Only the destination name is recorded, emitted or returned. A failed write leaves the question unanswered and returns a generic error. Names overwrite the corresponding credential, but the experiment's anthropic credential is reserved. Local secret files use hashed names, private permissions and atomic synced replacement beside the configured key file, never in history. Forwarded secret answers carry only the name and the actors who authorized them.
- Swap test: yes for overwrite, failure and forwarding behavior; file layout is internal. The credential-store write boundary needs describing.

## G01: API shapes and wiring

- Where: `docs/adr/0010-describe-parts-not-wiring.md`; `docs/contracts.md`.
- Missing: concrete signatures, encodings, identity and error formats.
- Choice: one Go module, standard-library interfaces, random hexadecimal IDs, typed content with JSON extension data, errors at local boundaries. Persistence uses versioned JSON snapshots.
- Swap test: these are binding choices, not semantic gaps. Another binding needs an adapter, but can preserve the described behavior.

## G02: Capability conflicts, scope and replacement

- Where: `docs/open-questions.md`, How many of each capability, Plugin scope and Plugin lifecycle.
- Missing: duplicate behavior, replacement disposal, session scope and reload behavior.
- Choice: reject duplicate named capabilities, commands and hook definitions. Explicit replacement removes the target's registrations before loading the replacement, but preserves other plugins' handlers when the replacement redefines the same owned hook with the same rule. Incompatible replacement rules are refused. If replacement setup fails, its registrations are removed; the stopped target is not restarted automatically. The plugin set is fixed while sessions are open. Session-specific tools are computed from the session's project. No live reload in milestone 1.
- Swap test: yes. Plugins depending on silent shadowing or live replacement need a declared rule.

## G03: Hook decisions and owner identity

- Where: `docs/contracts.md`, Hook points; ADR 0006.
- Missing: the fixed rule for each standard point, error behavior outside gates, and how owner-only invocation is checked.
- Choice: identity-bound API handles; standard points use observe, transform, gate, collect or first-answer as published in the Go API. First and last are stable groups, not reversed stacks. Errors stop transforms and first-answer chains; gate errors refuse. Explicit plugin replacement can redefine its owned points.
- Swap test: yes. Combination rules and failure semantics affect plugins.

## G04: Position moves and forks

- Where: `docs/architecture.md`, History; `docs/scenarios.md` 14.
- Missing: whether the move entry becomes part of the selected branch, and fork copying details.
- Choice: an audit move records its target but the current position is exactly that target. New entries branch from it. Settings remain session-level settings; moving does not restore earlier settings. Forks copy the selected ancestry with globally unique new entry IDs and provenance pointing to each source entry. A `session.fork` transform lets each plugin remap references in its own metadata, including the context plugin's covered-entry IDs. Forks inherit the source session's current settings. Rewinding is refused before changes. G19 adds explicit limits on moving or forking into unfinished turn boundaries.
- Swap test: yes for current-position semantics and provenance; snapshot layout is internal.

## G05: Compaction policy

- Where: ADR 0007; `docs/scenarios.md` 6; `docs/open-questions.md`, What history records.
- Missing: size estimation, summary shape, retained tail, retry bound and failure behavior.
- Choice: estimate text by bytes divided by four, reserve output space, summarize older complete exchanges with the selected Provider, keep the newest input or complete model/tool batch, record summary usage and transitive copy provenance, and rebuild the view. Earlier steps within a single long turn can be summarized. If the retained batch alone is still too large, compaction refuses rather than splitting a tool call from its result. One overflow compaction retry per step; failed summaries fail the turn without deleting history. Manual compaction uses the same operation.
- Swap test: thresholds are internal; preserving tool pairing, summary provenance and bounded retries affects plugin and host behavior.

## G06: Input timing, keys and cancellation

- Where: `docs/open-questions.md`, Input during a turn and Cancellation; `docs/contracts.md`, Interface and Harness.
- Missing: steering cutoff, key lifetime, queued input recording and what a duplicate with different content means.
- Choice: steering joins after the current response and all its tools, before the next request, even after a final text response. Follow-ups start new turns. Keys last while the acceptance receipt is retained, across branches and restarts; erasing that input also removes its receipt and key; the first receipt wins regardless of resent content. Queued input is recorded separately from model-visible intake. Cancel returns unconsumed content to the Interface. A returned keyed input remains acknowledged; a deliberate resubmission needs a new key.
- Swap test: yes. Hosts depend on timing and idempotency scope.

## G07: Local commands and jobs across milestone boundaries

- Where: `docs/architecture.md`, Working environment and Jobs; acceptance milestones 1 to 3.
- Missing: how bare shell backgrounding relates to managed jobs before the jobs milestone.
- Choice: `bash` waits for the shell, not descendants holding pipes open; tracks process groups for clean shutdown. Turn cancellation kills the active foreground command group, not earlier background groups. No managed job API in milestone 1. Milestone 1 declared no guarantee for agent SIGKILL or descendants that escape the group. G18 supersedes that limit in milestone 2.
- Swap test: yes. Lifecycle guarantees must be declared. Full job reporting is explicitly milestone 3.

## G08: Settings and malformed model calls

- Where: `docs/open-questions.md`, Changing the model mid-turn and Turn limits; `docs/contracts.md`, Tool call.
- Missing: when settings can change, defaults for limits, and malformed or repeated call IDs.
- Choice: model and thinking changes are refused during a turn. Configuration supplies positive step and output limits. Calls ran sequentially in milestone 1; G17 defines milestone 2 concurrency. Missing or duplicate call IDs within a response receive local IDs; unavailable tools and invalid input receive failed results rather than crashing the turn. The fake Provider exposes two models to prove model selection without real inference on a disallowed model.
- Swap test: yes. Mid-turn changes, limit outcomes and malformed-response handling affect hosts and plugins.

## G09: Disk erasure coordination

- Where: `docs/architecture.md`, History; `docs/scenarios.md` 15.
- Missing: coordinating erasure with active turns and writers, and physical deletion guarantees.
- Choice: erasure requires all sessions in this Harness to be idle and refuses if any stored session has another writer. It computes transitive copies across the store, replaces affected snapshots and reloads open sessions. It reports delivered output as out of reach. Logical content is removed from all live files and cached turn outcomes; secure overwriting of filesystem blocks and backups outside agent control is not promised. Intake and model-visible records of one input are treated as aliases, so erasing either reaches both. Model responses conservatively name all context sources as dependencies, so more derived text may be erased than strictly necessary. Project files changed by tools are user-owned outside effects, not managed history exports; the command reports controlled history copies and already delivered output as its scope.
- Swap test: yes for coordination and scope. Snapshot replacement and block reclamation are internal.

## G10: Prompt, configuration and command conventions

- Where: `docs/architecture.md`, Configuration and System prompt; `docs/open-questions.md`, What history records.
- Missing: file locations, merge rules, command grammar and request replay detail.
- Choice: global JSON settings are overlaid by `<project>/.modular-agent/settings.json`, then recorded session changes. New sessions use current file defaults; reopened sessions keep recorded settings. The prompt reads only the project's `AGENTS.md` through the working environment and records prompt changes. Slash commands run through the input transform without starting a Runtime turn. Keyed slash commands are explicitly refused, not silently deduplicated after side effects. Model inputs support keys. History records settings, prompts, responses and copy dependencies, not an exact byte-for-byte vendor request snapshot.
- Swap test: file paths and JSON are binding choices. Merge precedence, command key support and replay detail affect hosts and plugins and need declarations.

## G11: Holding output and recipient views

- Where: `docs/architecture.md`, Who sees what; `docs/contracts.md`, Output gate.
- Missing: buffering scope, flush boundaries and how non-streaming outputs reach the gate.
- Choice: the optional secret guardrail holds model text until a request attempt ends, then redacts across pieces. With secrets configured it also holds tool progress until the complete result. Without secrets, bash output remains live. Events, history views, command results and turn outcomes all pass the same gate. Trusted plugins may read raw snapshots; Interfaces must not deliver those directly. Delivered output is out of reach for erasure.
- Swap test: yes. Flush boundaries and raw access distinguish a usable guardrail from a leaky one.

## G12: Call identities and opaque content

- Where: `docs/contracts.md`, Content and Tool call; `docs/architecture.md`, Guarantees.
- Missing: whether vendor call IDs are unique across steps, and how to preserve opaque vendor blocks while exposing standard content.
- Choice: preserve each vendor block in a content part's extension data, including thinking signatures and unknown types. If a call ID is missing or repeats in the session, assign a fresh local ID while retaining its original reference. Results carry both references so Providers can answer their own call IDs. A panic after a call starts produces an unknown outcome, not a claim that it never started.
- Swap test: yes. Plugin bookkeeping and Provider tool-result matching depend on the distinction between local identities and vendor references.

## G13: Vanilla tool and Interface policies

- Where: `docs/examples/vanilla-pi.md`; `docs/contracts.md`, Tool definition and Interface and Harness.
- Missing: the exact file tool behavior, shell timeout defaults, and line-mode grammar.
- Choice: read returns file text, write creates parent folders, and edit requires exactly one nonempty exact match. Local paths may be absolute or outside the project because this milestone's working environment is not a sandbox. Bash defaults to 30 seconds with an optional 1 to 600 second timeout. The line Interface uses ordinary input as steering, `/after text` for a follow-up, `/cancel` to cancel and `/quit` to leave. `/fork` prints a session ID to reopen; it does not silently switch the Interface. Print mode emits the final text; JSON mode emits gated events. An Interface owns and closes its line input stream to unblock cancellation.
- Swap test: tool input shapes and terminal flags are binding choices. Match semantics, timeouts and input timing affect callers and should be declared.

## G14: Commands and auxiliary inference

- Where: `GLOSSARY.md`, Command; `ACCEPTANCE.md`, milestone 1 items 6 and 12; ADR 0007 and `docs/scenarios.md` 6.
- Unclear: commands are described as running without the model, but `/compact` must run the same compaction operation whose summary is written by a Provider.
- Choice: commands bypass the Runtime's model/tool turn. Most commands make no model request at all. `/compact` can make one direct auxiliary Provider request to summarize, as the context-management description requires. It still uses only the session's chosen allowed model and normal credential-store boundary.
- Swap test: yes. A host that assumes every command is free of inference would observe different usage or failures. The description should distinguish no agent turn from no auxiliary model request.

## G15: Recovery boundaries and declarations

- Where: `docs/architecture.md`, Surviving interruptions; `docs/contracts.md`, Harness and Runtime; `docs/open-questions.md`, Transient and durable Runtimes.
- Missing: exact progress records, recovery of a response before its individual calls are recorded, lost intake, and compatibility when tool definitions change.
- Choice: both Runtimes use the same history-backed turn runner and hooks. The Harness reopens unfinished turns on the current branch automatically, preserving their identity, input and limits. Intake not yet consumed is reconstructed from receipts. Model responses are committed before any tool starts; missing call records are reconstructed from that response. Starts are committed before execution. Completed results are never repeated. A durable retry requires both the recorded and current tool definitions to say safe to repeat, and a working environment that promises crash cleanup. Missing tools fail rather than silently disappear. Interrupted requests may be retried only for stateless Providers that run no tools; those properties are declared on model access. Step completion records preserve decisions, counts and usage. A transient reopen settles calls and fails without a new model request. Runtime and working-environment declarations are explicit capability methods. A changed plugin composition on reopen updates the session's active plugin list and adds an audit entry; it does not rewrite old entries.
- Swap test: yes. These declarations and recovery semantics affect plugins and hosts; the journal encoding is internal.

## G16: Recovering hook side effects

- Where: `docs/examples/durable-agents.md`, Pydantic AI on a durable engine; `docs/architecture.md`, Surviving interruptions.
- Missing: a standard API for naming or checkpointing a plugin's outside operations.
- Choice: incomplete step/tool checks can run again from the top. Hooks must make their own outside operations idempotent and record their own progress through the existing history API. Tool input after checks is recorded at the start boundary. No general durable-operation API is invented in milestone 2.
- Swap test: yes. A plugin that assumes a hook runs exactly once would break on recovery. Exactly-once arbitrary outside effects cannot be inferred from the description.

## G17: Parallel batches

- Where: `docs/contracts.md`, Tool definition; `ACCEPTANCE.md`, milestone 2 item 5.
- Missing: mixed-batch scheduling and hook/result order.
- Choice: a batch overlaps only if every requested tool is known and explicitly allows parallel execution. Checks and start records run in request order, tool bodies overlap, and after hooks and result commits run in request order. A mixed batch stays sequential. Recovery uses the same order and skips recorded results.
- Swap test: yes. Ordering and concurrency affect plugins. The number of goroutines is internal.

## G18: Local command lifetime and platform

- Where: `docs/architecture.md`, Working environment and Declared support; `ACCEPTANCE.md`, milestone 2 item 4.
- Missing: mechanism, supported platforms, cleanup latency and supervisor failure behavior.
- Choice: Linux only. Each bash call has a small supervisor as PID 1 in a fresh unprivileged user/PID namespace. A private pipe detects agent death; namespace teardown kills all descendants, even after setsid, double forks or environment clearing. Kernel teardown also applies if the supervisor itself is killed. A synced registry records host PID/start-time/boot identity and owning agent before commands can start; startup kills abandoned supervisors before any recovery. No writable cgroup or privileged daemon is needed. Unsupported namespace creation fails explicitly. Files and working directories remain the local machine, not a filesystem sandbox. Shell PIDs are namespace-local; tests identify host PIDs through /proc and unique command markers. Numeric UID and primary GID stay unchanged, but supplementary groups are unavailable in this unprivileged mapping. Background shells still return and earlier background commands survive turn cancellation, but not agent exit.
- Swap test: yes. Lifetime guarantees, Linux requirements and PID visibility affect tools and hosts. Namespace and registry formats are implementation choices.

## G19: Intake and branch boundaries during recovery

- Where: `docs/architecture.md`, History and Surviving interruptions; `docs/open-questions.md`, Input during a turn.
- Missing: whether queued input survives a crash, how a deliberately truncated branch differs from an interrupted turn, and what a transient Runtime does with unused steering.
- Choice: untaken receipts are reconstructed. An input already recorded as taken is not recorded twice. Durable recovery makes steering recorded after a saved response reach the next model request. After transient repair, untaken queued input starts a new turn; already-taken steering belongs to the failed turn. Moves and forks into the middle of a turn are refused before changes, so a truncated branch cannot accidentally replay historical effects as crash recovery. Forking while a turn runs is also refused. Completed boundaries and ordinary history-only entries remain supported.
- Swap test: yes. Input ownership and branch navigation limits affect hosts and plugins. These limits are explicit rather than treating every unmatched historical start as a crash.

# Gaps in the description

## Production edition 3

### Settled in this edition

- PE-09: The host settles ineligible interrupted calls before handing off. The shared `modular-agent.stepAfter` decision and `modelRequest.data.tracksStepAfter` distinguish a gate already committed from one that is due. A missing marker in older history is not evidence that a gate can run. Rust fails the turn closed when it cannot establish the state.
- PE2-02: `not_supported` and `not_found` now both omit optional project instructions; an internal error stays an error. Neither skip bypasses the configured environment.
- PE-04: ACP now defines approval authority per recipient and route. The earlier open question about speculative polling is not permission to treat a redacted or stale view as an approval.
- Portable F1 to F3 were build defects, not gaps in the binding. An imported call is a working view. Kept entries name its real response or start record, not its synthetic id. Receipts and erasure reservations are scoped to the authenticated submitter and attributed actor. ACP creation and authorized join on open are operator grants without a granter; a member grant still names the granter.
- Runtime E was a build defect and exposed the missing checkpoint rule. The served Rust Runtime now rejects an inconsistent step or unsafe unresolved call before running hooks. The Rust host records a decision before replying and returns it on a matching repeated callback.

### PE3-05: OpenAI uses a different name for reasoning off

- Where: Shared data, General rules and Context and interrupted work; ACP, Configuration options; [OpenAI Responses API, Create a response](https://developers.openai.com/api/reference/resources/responses/methods/create/).
- Finding: Elixir recorded the shared level `off` for gpt-6-luna. Rust passed it through on recovery and OpenAI rejected it. The shared rules were clear. This was a Provider bug, not a gap in the binding.
- Choice: advertise all six shared levels in order. ACP shows and accepts `off`, and the portable fallback keeps it when the model offers it. OpenAI receives `none` for `off`; `minimal`, `low`, `medium`, `high`, and `xhigh` pass through unchanged. The OpenAI-only `max` is not a shared choice. History keeps the shared spelling.
- Swap test: yes. An agent that writes `off` can expose the bug when Rust reopens its session. The fixture Provider bypasses the OpenAI request, and the prior Rust catalog did not offer `off` on a real model. See [PROGRESS.md](PROGRESS.md#edition-3-openai-portable-reasoning) for the live check.

### PE3-04: Leaving a call open is not a limit

- Where: Contracts, Questions; Shared data, Outcome; Plugin, The host asks the Runtime. Reported by the Python builder as G107.
- Finding: Rust's served and native Runtimes treated a `leaveOpen` expiry as a questions limit. The edition 3 rule resolves this. A turn that stops because its remaining calls were left open is completed, unless a real limit, cancellation or failure ended it first.
- Choice: the Runtime reports completion with the open calls in call order. The Rust Harness records the pending call before acknowledging it and checks the reported ids and outcome against committed work. It rejects an invented limit or a mismatched list as a Runtime failure rather than converting it to completion. Winning cancellation and a real host limit that was latched but not signalled still follow the Plugin binding.
- Swap test: yes. The TypeScript host recorded the old Rust limit and failed the kit's late-question check. A host that rewrote the reply would conceal the Runtime defect. See [PROGRESS.md](PROGRESS.md#edition-3-late-question-outcomes) for the rerun.

### PE3-01: Before-turn contributions do not specify how to report lineage

- Where: Plugin, From core hooks to wire hooks, `turn.before`; Shared data, Recording order and ownership.
- Missing: `turnStart.sources` needs the history copied into system or context. A hook can read history and produce a contribution, but the standard reply has no field for its source ids.
- Choice: the built-in prompt identifies its contribution as carrying no history. The Harness accepts explicit source ids from trusted contributions and checks them against the live branch. For an unlabelled, nonempty contribution, it conservatively names real live branch entries. It never records virtual calls as sources.
- Swap test: yes. Equivalent contributors can produce a different erasure copy set unless the binding provides a way to name sources.

### PE3-02: The Rust value answer used the wrong union form

- Where: Shared data, Questions and Standard kinds, `inputAnswer`.
- Finding: once Elixir accepted Rust's operator grant, it refused the Rust approval answer with `invalid portable history: inputAnswer`. The stored record had both a string value and `declined: false`. The value form does not include that member. In addition, `"refuse"` is an ACP option, not a valid value for a portable approval answer. A system closure must not name an answerer.
- Choice: normalize an approval refusal to an actor decline before recording it. Write only the applicable answer variant and keep the request association. Preserve support for the old Rust closure extension on reads. This is a writer defect, not an ambiguity.
- Swap test: yes. A reader accepting the old boolean shape can hide the defect in self-swaps.

### PE3-03: Job report attribution on admission and consumption

- Where: Shared data, Job reports and Standard kinds, `inputAccepted` and `input`.
- Finding: the Rust store exposed a synthetic `job:<id>` actor on a report's admission and consumption. After the approval answer fix, Elixir rejected that admission. Changing only the admission then exposed the mismatched actor on consumption.
- Choice: use the job's starting actor in both portable records. Keep the job identity and record its authorizer and rights on the admission. The native Runtime still uses the internal job actor to narrow authority. This is a writer defect, not an ambiguity.
- Swap test: yes. A reader that already knows Rust's internal actor convention can conceal the problem in self-swaps.

## Production edition 2

### Resolved by the edition 2 text and kits

- PE-01: the History HTTP lease alphabet and 128-byte ceiling make fork preflight deterministic for each sender encoding.
- PE-03: the lease clock rule gives deployments without a suspension-aware clock a margin requirement. Rust uses Linux boot time when available.
- PE-08: the refreshed service includes `retryAfterMs`; the client no longer guesses a retry delay for the earlier service.
- PE-09: the Plugin binding now explicitly excludes committed results from `resumeTurn`'s interrupted calls.
- PE-07 is partly settled: the kit no longer asserts an initial parked disposition for a job report that starts a turn. It still needs a separate seeded parked case to exercise release.
- PE-04 is partly settled: `answerable` is defined after gating for each recipient. The original question about how long to cache a prospective polling gate pass remains distinct.

### Settled in the Rust build

- Stale kit counts: the default `mise exec -- cargo test --workspace --locked --offline --no-fail-fast` at `6b8586e` had five failing Rust assertions even though the nested kits passed: ACP basic 104/104, ACP crash 111/111 in all three Runtime selections, and Plugin 139/139. The Rust tests now require those totals. This is a test integration error, not a binding gap.
- Plugin background command timeout: a forked shell can inherit the command journal's `flock` descriptor and stop before `exec`. Closing the parent's descriptor does not release the lock while the shell holds its copy. The tracer needs the lock to journal the stopped shell before it can continue it. The journal guard now unlocks explicitly. `mise exec -- cargo test --locked --offline -p environment-local releasing_the_journal_lock_does_not_wait_for_a_forked_child_to_exec` failed with `WouldBlock` before the fix. `mise exec -- cargo test --locked --offline -p environment-local` then passed 4/4, including the regression. This is a Linux containment bug, not a wire ambiguity.

### Settled by the refreshed ACP kit: An invalid fixture directive and a refused dispatch have different outcomes (PE2-01)

- Where: ACP, Conformance mode and Prompt completion; Plugin, The conformance plugin; the ACP kit's session-limit and tenant-ceiling checks.
- Resolution: `4fa141d` accepts either safe outcome and checks that no command ran or tool dispatch was recorded. The new assertions also distinguish a refusal result from the absence of a result. No change to the Harness's offers was needed.
- Original issue: the kit expected `end_turn` after a `tool:bash` directive in a session without `tools`. If the request omits the now unauthorized tool, the fixture specification instead requires `stop: "failed"` and `Invalid tool directive`. The standalone Plugin kit tests that rule directly. A failed turn is not a successful turn with a refused call.
- Choice: keep the fixture's validation and keep unauthorized tools out of the prepared request. Do not turn a failed model response into a completed turn. A separate scripted Provider can return an unoffered call to exercise refusal at dispatch, and an authority change while a step is in progress can exercise revocation after a tool is offered.
- Original swap risk: the same prompt could complete with a refusal result or fail before a call existed, but the old kit accepted only the first path.

### Settled by the refreshed ACP kit: The remote rewind fixture needs ordinary preparation (PE2-02)

- Where: Plugin, Paths and points and The host asks the working environment; ACP kit, remote point preflight.
- Resolution: `4fa141d` adds `env/read` to the point fixture and returns `not_found` for a missing file. The Harness can now reach the point checks after an ordinary preparation read.
- Original issue: the point fixture offered a replacement working environment, but had no `env/read` handler. The Rust Harness reads optional project instructions before it saves a turn point. An unsupported read is not a missing file.
- Choice: optional project instructions can be omitted when the remote peer has no read method. A registered method returning `not_supported` or another read failure still fails preparation. Do not fall back to the host filesystem. The supplied remote point preflight now passes.
- Original swap risk: a host that did not read a project file during startup could use the old fixture; a host making a valid read request could fail before rewind.

### Settled by the refreshed ACP kit: The Runtime probe must not depend on process lifetime (PE2-03)

- Where: Plugin, The host asks the Runtime; ACP kit, remote Runtime host.
- Resolution: `4fa141d` selects the probe case from the turn's recorded input instead of a process counter. The per-session Plugin lifetime was unchanged.
- Original issue: the probe switched behavior by counting turns in a child process, but created new sessions for the unoffered tool and latched limit cases. The binding scopes Runtime work to a session and does not require sharing a child process across those sessions.
- Choice: keep Rust's per-session Plugin lifetime. Exercise the unoffered call and latched limit through independent offline fixtures; do not manipulate the supplied probe's counter.
- Original swap risk: a host that shared the process tested the intended methods; a host starting a fresh process for each session ran the first case again.

Verification from `conformance/acp`: `node run.mjs --crash-checks --plugin-checks --probe-checks --job-checks -- "$a" --acp` passed 199/199, exit 0, in all three local plugin configurations. See [PROGRESS.md](PROGRESS.md#workspace-follow-up) for the launch settings, workspace commands and logs.

## Production edition

### Blocker: The fork size proof needs a lease bound (PE-01)

- Where: History HTTP, Sessions and Writing: one writer at a time; Shared data, General rules.
- Missing: the client must prove the whole initial append fits before PUT. The lease is not available before PUT, and the service declares no maximum encoded lease size. An Id has no size limit in Shared data.
- Choice: the Rust history client uses a deployment bound of 4,096 encoded bytes for the lease value. Preflight refuses before PUT if the batch cannot fit with that allowance. If a service issues a bigger value, the client cannot write under it. A service-verified guarantee is still needed for general interoperability.
- Swap test: yes. A different service can issue an arbitrarily large valid ID, and a different client can refuse a fork that Rust accepts. Publish a binding-level maximum or a required service declaration that a client can verify before PUT.

### Divergence risk: Sending time for a successful acquire after a lost reply (PE-02)

- Where: History HTTP, Writing: one writer at a time.
- Unclear: the service returns the same lease and full TTL on repeated acquire without extending its expiry. The writer then has to renew before use, but the text does not say which acquire send establishes the cutoff for that first renew if the original reply is lost.
- Choice: do not automatically repeat an ambiguous acquire. Reopen after the old writer expires. This is less available, but cannot use a stale grant.
- Swap test: yes. A peer using the second acquire send as its cutoff can use a generation that a more conservative peer has already abandoned. Define the first send as the outer deadline or give the renew attempt its own specified deadline and forbid effects until success.

### Divergence risk: Late lease cutoffs and the local clock (PE-03)

- Where: History HTTP, Writing: one writer at a time; Security, What an operator configures.
- Unclear: the binding requires a monotonic clock that includes suspension, but does not say what to do on a supported build target without a verified clock of that kind. POSIX monotonic time is not enough on Linux.
- Choice: use Linux boot time and refuse the history HTTP client on other targets rather than promise a weaker cutoff.
- Swap test: no wire fork. Deployment choices differ, and a peer expecting the client on all advertised environment platforms would need a separate history client feature or platform declaration.

### Divergence risk: Approval view probes and when a polling route exists (PE-04)

- Where: ACP, Questions; Contracts, Approval policy.
- Unclear: a polling route is viable when the exact requests reply can pass the gate. The gate can depend on the whole reply, including other live questions. The section does not say whether a speculative gated view establishes viability, how long it lasts, or when to reconsider a poll that has not happened.
- Choice: treat an actual exact delivery as distinct from a prospective gate pass. The existing host did not enforce this distinction in every path; the probe exposed it. Do not treat an altered view as an authorization.
- Swap test: yes. One host may refuse immediately after a gate block while another keeps the same approval open for a new view. Specify the timing of prospective gate checks and what invalidates a cached delivered view.

### Divergence risk: Recovering reservation before physical erasure (PE-05)

- Where: Shared data, Session state, Input keys; History HTTP, Erasure.
- Unclear: the client commits the reservation before tombstoning but no service operation commits both actions. A reader can see a live entry after the reservation exists and before deletion succeeds. The binding does not put a completion state in the erasure journal.
- Choice: append the erasure record before issuing fenced deletion. A Rust reader treats the entry as unavailable once the reservation is kept. The HTTP client still needs explicit reconciliation for a lost delete reply.
- Swap test: yes. A peer projecting live data until it sees a service tombstone can disclose content a peer treats as already erased. Define the portable read and retry behavior for that interval.

### Friction: Previous shapes were easy to confuse with current ones (PE-06)

- Where: ACP, The declaration, Several actors and Extension methods; Shared data, Standard kinds; Plugin, Runtime records and effects.
- Hard to use: `questionsOutlastTurns` alone is not a valid declaration. Erasure pairs and content-free duplicate receipts are in prose. Shared metadata and adapter-local metadata also used some of the same words for different shapes. The history table and the Runtime callbacks table must be read together to see that a Runtime never owns `notStarted`.
- Choice: test the public declaration and receipt shapes with the unmodified kits, and keep Runtime attempt and settlement checks separate from the ACP reply schema.
- Swap test: yes if either peer implements the historical shape. This is discoverability friction, not conflicting normative text.

### Divergence risk: The jobs kit promises a parked case for an agent that schedules its reports (PE-07)

- Where: ACP kit README, `--job-checks`, and `conformance/acp/run.mjs`, Job reports check.
- Unclear: the README says this option checks an initial disposition of parked. The check accepts ready instead when the agent declares `startsTurnsUnasked: "jobReports"`. A pass for that agent says nothing about a parked report.
- Choice: treat the assertions and README as coverage descriptions, not additional rules. Count a parked report only when exercised through the portable seed or an offline regression.
- Swap test: no protocol conflict. It affects which behavior a passing report proves. Give the kit a way to demand each disposition when a host supports both.

### Friction: The pre-edition service emits a legacy lease envelope (PE-08)

- Where: History HTTP, Writing: one writer at a time; supplied history service.
- Hard to use: the service supplied for this round did not have an `UPDATED` marker during the first portable run. A held reply without `retryAfterMs` needs a fallback to work with the old service. The production binding requires that field.
- Choice: bounded 250 ms polling for the pre-edition reply, with the same overall reopen budget. Do not claim service conformance from this compatibility path. I reran both selections once the refresh marker appeared. The tombstoned batch hand-back then passed, without changing the client; four build-side failures remained.
- Swap test: yes. A strict production client can refuse to reopen an otherwise recoverable session on a service emitting the old envelope.

### Divergence risk: What to do with a matched but abandoned call on a remote restart (PE-09)

- Where: Plugin binding, Runtime records and effects and Model attempt sequences; Shared data, Context and interrupted work.
- Unclear: the Runtime receives an interrupted call list, but only the host can settle an abandoned call. It is not explicit whether the host removes a call it already settled from that list or leaves the Runtime to filter the list against history.
- Choice: commit the abandoned results before invoking the reopening Runtime. Pass only recoverable calls in that parent's list. A started unsafe call settles as `outcomeUnknown`, not `refused`. Preparing a new model request before that result can make the Provider ask for the same effect again.
- Swap test: yes. A Runtime that trusts an unfiltered list can ask to dispatch work the host already settled. Define the list as a snapshot after host-owned recovery settlement, or require a portable settled flag.

### Friction: Offline checks from the prior edition are not an acceptance oracle (PE-10)

- Where: Plugin binding, Transport and Runtime records and effects; existing Rust offline fixtures.
- Hard to use: the old transport test expects an error reply to a reused id and then a usable connection. Production requires closing it. The old Runtime fixture writes `turnEnd` through `record`, which is now a host checkpoint. The older conflict-refresh assertion expects a failed tool result, even though production separates a completed result from a refresh failure.
- Choice: keep the production envelopes and preserve returned tool results. Report the older failures rather than counting them as passes. Some older fixtures still need a rewrite, not just a new expected count.
- Swap test: yes. An old fixture can keep sending data on a production peer's closed stream. A Runtime that needs to write a host-owned checkpoint cannot swap into a strict host.

### Blocker in this build: Implementation limits at this checkpoint (PE-11)

- Where: Implementer's guide, a build plan, steps 4, 6, 7, 8 and 9.
- Missing in this build: the full host callback phase machine and final approval handoff checks, complete pending and continuation checkpoints, parked report release on imported history, off-branch cleanup status, and the two-record rewind journal. This is not a claim that the applicable rules are undefined. Restoration and local erasure work on the tested paths, but passing those paths does not establish the portable variants. Likewise, joining and tenant ceilings work in the local fixtures, but deployment principal and tenant isolation are not established.
- Choice: stop short of a production conformance claim. The existing profile declarations exercise the paths rather than hiding failed checks by skipping them. Do not deploy based on those declarations. Cross-build tests were not run because the clean room did not provide an authorized second build command.
- Swap test: yes. A reopener may lose the disposition of a parked report or fail to prove that it finished a restore. A stricter host can refuse callbacks that this host still accepts.

## Round six

### R6-01: Tenant accounting across stores, concurrent work and erasure

- Where: bindings/data.md, Limits and tenants and Portable sessions.
- Unclear: the binding does not specify reservation of tokens, accounting across independent stores, or how to count usage that was erased or copied into a fork.
- Choice: check recorded usage in the configured store across projects and sessions, also including open sessions in the Harness. Count each completed turn from its `turnEnd` usage, or count its settled responses while it is unfinished. Treat the budget as a stop rule, not a reservation. Steps already in flight can overshoot together. Erased usage no longer counts, and copied usage counts if the store lists it in the fork.
- Swap test: yes. An agent using the same store and unmodified history can make the same stop decision. Concurrent reservations, erase, and fork can change the decision if builds choose different accounting rules.

### R6-02: A rewind point cannot be checked over the plugin binding

- Where: bindings/data.md, Rewinding; bindings/plugin.md, Working environment.
- Unclear: a host must check that the point exists before saving a rollback point, but the binding has no request to check a point without restoring it.
- Choice: the native environment checks the point directly. The host tracks which points each external environment saved in this process and rejects unknown or foreign points before saving. If a remote environment lost a point it had saved, `env/restore` is the final check and the history does not move.
- Swap test: yes. A remote environment that keeps points across its own process restart has no way to prove that a point in reopened history still belongs to it.

### R6-03: No supported reasoning level at or below the saved level

- Where: bindings/data.md, Models and Portable sessions.
- Unclear: a model can omit `thinking` or list only higher levels. Neither case gives a supported level to lower to.
- Choice: use `off` when the model has no listed level at or below the saved level. Do not silently raise it. Keep the recorded setting and use the effective level when preparing the turn.
- Swap test: yes. A Provider can interpret `off` as disabling reasoning or reject it as unsupported. The binding now says to omit reasoning when no supported level qualifies. Rust still uses `off` for that generic case. That is separate from [PE3-05](#pe3-05-openai-uses-a-different-name-for-reasoning-off), where the OpenAI model now advertises `off` and the fallback matches it exactly.

### R6-04: Distinguishing served plugin selections

- Where: bindings/plugin.md, Starting and The conformance plugin.
- Unclear: parts can be served together or in separate processes, but the binding does not assign a name to each such registration.
- Choice: the default selection keeps `rust-conformance`. Other selections get a name derived from the sorted parts. A second registration with the same name is refused even when it has no conflicting capability.
- Swap test: yes for plugin identity, especially when reopening jobs. Run the same selection in both processes when they are meant to be the same plugin.

### R6-05: The ACP tenant check tests for a response, not a request

- Where: conformance/acp/run.mjs, `tenants: without a model request`; bindings/data.md, Limits and tenants.
- Wrong assertion: the check looks for a `response` entry, not a `modelRequest`. Sending a model request that failed without recording a response could pass it.
- Choice: leave the kit unchanged. The Rust regression checks both record kinds and counts Provider calls, with a nonzero shared budget and a second session.
- Swap test: yes. A build that spends tokens on an unanswered request can pass the kit but violate the budget rule.

## Round five

### R5-04: Saved points and the project directory

- Where: bindings/data.md, Rewinding; bindings/plugin.md, Working environment.
- Unclear: how long a point must live, what else should happen to a process with the project as its current directory, and how to coordinate a file restore with the history write.
- Choice: keep points in the environment instance. Copy regular files, directories and symlinks without following the symlinks. Restore the contents rather than replacing the directory itself. Stage the replacement and roll back failed moves. Refuse a rewind that needs a missing or foreign point, or crosses a recorded job. Some projects cannot be snapshotted, for example a project containing the environment's own state or a special file. Work in those projects can still run, but a rewind across an unsaved step is refused. An outside writer or abrupt process exit during restore is not covered by the rollback.
- Swap test: yes for point lifetime and identity. An Interface cannot assume that points survive a process restart. The host can use an external environment with its own policy and obey a refusal.
- Follow-up: the binding does not require a restore to preserve the project directory itself. A fake environment replaced it and reproduced a swap failure: the host was still in the removed directory and could not start another session. The host now uses the explicit project path for plugin loading and its hook payload. It keeps point strings unchanged in history and on the wire, never as file names. An unused session needs no point or history file to close.

### R5-05: Output entries and delivery after close

- Where: bindings/plugin.md, The host asks a hook handler; bindings/acp.md, Updates.
- Unclear: the output envelope specifies `type` and `data` but does not give a shared vocabulary for every event type. A session close also removes the handler needed to gate its reply.
- Choice: pass event kinds as types and event content as data. Gate ordinary replies as a single result event. Prepare and gate the successful close reply before shutting down the session's plugins; send it only if the close succeeds. Handler RPC errors block delivery.
- Swap test: yes if a handler depends on a particular type or data layout instead of handling text in any event. The bundled redactor handles nested text as well as a secret split across pieces.

### R5-06: Erased identities in the two bindings

- Where: bindings/acp.md, Entry; bindings/data.md, History entries; bindings/history-http.md, Erasure.
- Unclear: ACP still says an erased entry keeps only four fields. The shared data and history service now keep turn, step, call and job identities as well.
- Choice: keep identities that are present, even in ACP. The HTTP client does not infer an identity that the service omitted. The portable kit does not exercise erasure against the service; a separate offline fixture covers the refreshed tombstone shape.
- Swap test: yes for recovery. A reader that receives an erased result without the call identity cannot use that result to tell that the call was settled.

### R5-07: Recording a report and running it are separate

- Where: bindings/plugin.md, Jobs; bindings/data.md, Portable sessions.
- Unclear: a report is an input, but a running turn may mean the report cannot be taken immediately. An end reply also cannot promise the report's turn will finish.
- Choice: keep the end and admission of the keyed report together. Take it as input when the report's turn starts. A restart may still run that admitted report without ending the job again. An unfinished job owned by an absent plugin stays unfinished.
- Swap test: yes if an owner assumes that acknowledging the end means the report has already run. The record distinguishes a queued report from a taken report.

### R5-08: A full history entry and its cursor

- Where: bindings/plugin.md, Paging history.
- Unclear: an entry can fit by itself, but not with the mandatory cursor when there are more entries.
- Choice: count the UTF-8 JSON of the result with the cursor it needs, not the JSON-RPC envelope. If even the first entry needs a cursor that makes the page too large, report `result_too_large` rather than removing the cursor or skipping the entry.
- Swap test: yes for clients relying on a gapless read. Every accepted page has the information needed to continue.

No failing kit check was found to be wrong. The kits and frozen description were not changed.

## After the supervisor's full matrix

### R5-01: A callback can see cancellation before its Runtime does

- Where: bindings/plugin.md, Transport and The Runtime; bindings/acp.md, Cancelling.
- Unclear: the tool callback and the turn are separate RPC requests. A callback can see the host's cancellation before the Runtime handles the turn's own cancel notification. The binding permits a cancelled callback to return a result or a cancelled RPC error. It does not say what the host should do if a Runtime then reports a failed turn.
- Choice: a failed reply, or a transport error, during a host-requested cancellation settles as cancelled. The host preserves a completed reply and does not claim to undo an outside effect. The turn parent stays live while the Runtime finishes its callbacks. A local fixture stopped a running tool, got its callback reply, called `step.after` and `turn.end`, and returned a failure. Rust used to record failed, which ACP maps to refusal. The regression now records one cancelled turn and does not wait for the lost-plugin timer.
- Swap test: yes. A Runtime that treats a callback error as a turn failure can expose the difference. This reproduces a path to the reported symptom, not the supervisor's exact timing. The failing peer trace was not available. A genuine failure arriving at the same time as a host cancel cannot be distinguished from a failure caused by it in /1.

### R5-02: Distinguishing the host actor from imported actors

- Where: bindings/acp.md, Sessions; bindings/data.md, Actors and Portable sessions.
- Unclear: the binding names the connection's host actor but doesn't assign a naming scheme to prevent different agents from choosing the same id. It also doesn't carry a list of permitted answerers on a portable input request.
- Choice: Rust advertises `modular-agent-rs/acp-host`. It joins once with stable rights and leaves imported entries and rights unchanged, even for an imported actor literally named `user`. The ACP host can answer a default host question only if the host and the work both have the required right. The join is kept in memory on a new session until the session is used.
- Swap test: distinct ids let a new host take new input without borrowing the old actor's rights. Two unrelated agents that choose an identical id still cannot tell the owners apart from /1 records alone.

### R5-03: A portable setting unsupported by the new Provider

- Where: bindings/data.md, Portable sessions; bindings/acp.md, Prompts and Configuration options.
- Unclear: a setting can be valid for the original model but not for the model offered by the reopening host. The binding does not say how to reconcile an unsupported reasoning level.
- Choice: this round did not change model selection. A trial fixture used `off` with Rust's fake model, which offers `low`, `medium` and `high`. Reopen succeeded but turn preparation failed before recording the input as taken, leaving the ACP prompt waiting for a result. The actor regression uses a supported level. Returning the preparation failure to the waiting prompt and handling unsupported imported settings remain follow-up work.
- Swap test: yes. A real swap whose model or reasoning choices differ can hit this path. The requested HTTP runs use a model and settings both sides support.

## Bindings

### B-01: Conformance composition and state-directory precedence

- Where: bindings/acp.md, Starting, Configuration options and Conformance mode.
- Missing: the conformance model's thinking levels, whether it replaces the ordinary Provider, whether character counts mean bytes, Unicode scalars or grapheme clusters, and whether the data-directory environment variable wins over explicit path flags.
- Choice: add a separate stateless Provider, conformance/echo, only when MODULAR_AGENT_CONFORMANCE=1. It offers off and low thinking, reports zero usage and never reads credentials or uses the network. The result's 200-character prefix counts Unicode scalar values, not bytes or grapheme clusters. The ordinary Provider remains offered and is still restricted to gpt-6-luna for real inference. The environment directory overrides data/config path flags and contains history, commands, Provider inventory, global settings and trust. Project configuration remains a read-only source. The credential path is an external input, not copied state.
- Swap test: differing thinking levels are discoverable through configuration options and do not break a conforming host. Character-count choices can produce different expected echoes for Unicode, so the binding should define the counting unit. Directory precedence can break isolation when launching tests or services, so this build gives the binding's isolation promise precedence.

### B-02: Admission receipts, in-flight duplicates and scheduling

- Where: bindings/acp.md, Prompts, Cancelling and the input extension; contracts.md, Interface and Harness.
- Missing: how a duplicate describes an unfinished original turn, whether taken is an admission-time decision, and what to return for an input handed back before any turn took it. The original ACP adapter required an explicit drain, which cannot satisfy the kit's asynchronous input behavior.
- Choice: the ACP Interface owns a joined, session-local queue driver, not a new Harness turn engine. Input returns immediately after admission, then the driver calls the same next-turn API. Input and job-report wakes are serialized with prompts. Receipt timing is persisted at admission. A duplicate prompt waits for the original result and returns its original completed, failed, cancelled or limit outcome, even after moving or restarting. A returned input with no turn is refused rather than assigned an invented outcome. Cancellation records the returned input identities under that turn, so later duplicates cannot pick up another turn's returned content. Those records follow erasure provenance.
- Swap test: yes. Hosts depend on prompt retries not starting another turn and on input acknowledging before a tool or question finishes. The binding should state the unfinished and never-taken duplicate cases explicitly. Driver machinery is internal.

### B-03: Declarations cannot express mixed unfinished-work and restart policies

- Where: bindings/acp.md, The declaration and move; architecture.md, History and Jobs; M3-07 in the earlier implementation notes.
- Unclear: the declaration has one movement choice and one queued-input restart choice. The Rust Harness cancels open calls/questions when moving but refuses live jobs. It hands ordinary input back after restart but restores keyed job reports.
- Choice: the shared move extension refuses all unfinished calls, questions, jobs and queued input before changing anything. It declares refused, while the legacy extension retains its old behavior. Declare handedBack for ordinary input and add queuedJobReportsAfterRestart: run to disclose the report exception. The initial declaration describes the launch-directory composition without creating a session; new/load/resume and configuration responses describe the session and its selected model. Stateful OpenAI and stateless conformance/echo therefore report different keepsStateAtProvider values. The host actor is fixed to user regardless of client metadata.
- Swap test: yes for movement refusals and job-report restart behavior. A binding consumer cannot represent the mixed policies using only the listed choices. The extra declaration field makes this build's exception explicit instead of claiming all queued input is returned.

### B-04: Questions past their turn and non-step limits

- Where: bindings/acp.md, Prompts, Updates and Questions; architecture.md, Waiting for an answer; scenarios.md, A question nobody answers in time.
- Unclear: the binding permits completed turns with open calls but names only step/output limits in its stop mapping. This build records a question deadline as a limit, neither of those. The old ACP adapter also declined text questions when forms were unavailable.
- Choice: retain the internal question-limit outcome and open call, but represent that wire outcome as completed with end_turn and pending calls. The history extension uses the same wire outcome. No-form questions remain answerable through requests/answer instead of being auto-declined. A later accepted extension answer wakes the driver to continue in a new turn. Secrets still fail closed and are never forms. Already-sent forms or permissions can remain outstanding after a deadline; the host can use the extensions for the open question.
- Swap test: yes. A host needs to distinguish a waiting call from an exhausted step budget and must not mistake unsupported forms for a user decline. The binding should name question deadlines explicitly if it needs the original limit classification.

### B-05: History blocks, readable reasoning and branch cursors

- Where: bindings/acp.md, Entry, Updates and history.
- Missing: the vocabulary of history message blocks, erased-entry shape, and whether after may name an entry outside the selected branch.
- Choice: text uses ACP text blocks; assistant tool calls and opaque parts keep typed blocks, and data retains the original payload. Fixed kinds and parentId/time/actorId/turnId/toolCallId are adapted without rewriting the store. Erased entries have no data or message. An after cursor must belong to the selected branch, or to all entries when all=true; otherwise return -32602. Readable reasoning text/summaries become thought chunks, including replay and a final-response fallback when the Provider did not stream them. Opaque or encrypted reasoning is never rendered as text. New history results and all configuration updates pass the output gate.
- Swap test: yes for block schemas, cursor scope and erased entries. The binding needs a block vocabulary for hosts that render more than text. Store encoding and fallback chunk timing are internal if the same gated content arrives before the prompt response.

### B-06: Failed turns use ACP refusal without deleting history

- Where: bindings/acp.md, stop-reason mapping; ACP v1 PromptResponse/StopReason documentation; contracts.md, History and Outcome.
- Conflict: ACP's refusal reason says the refused prompt and later content will not enter the next prompt. The binding maps every failed turn to refusal, including temporary failures whose history this build keeps for retry or inspection.
- Choice: follow the binding exactly on the wire: refusal plus outcome.kind failed and its error. Do not silently erase or hide recorded input merely because a turn failed. Erasure and movement remain explicit operations. The otherwise unspecified outcome.limit string is steps or output. Tests distinguish failed, output-limit, step-limit and cancelled results and preserve those outcomes on keyed retries.
- Swap test: yes. A host assuming ACP refusal always removes context can misdescribe a failed turn. The binding should clarify whether its failed-to-refusal mapping also changes future context, rather than only the displayed stop reason.

### B-07: Erasure completion versus pending remote deletion

- Where: bindings/acp.md, erase; contracts.md, erasure; M5-02.
- Missing: what pending identities mean, and how to report local success when deleting known Provider copies fails.
- Choice: keep the existing awaited erasure contract. Success returns erased, pending: [] and outOfReach. A remote cleanup failure returns an error, not a successful empty-pending response; the durable retry barrier and inventory remain, and a retry must finish cleanup. Delivered output and unaddressable vendor copies are reported out of reach. The legacy method retains its old result field names.
- Swap test: yes. A host must not read a failed remote deletion as completed erasure. The binding needs pending-ID semantics and retry behavior before builds can exchange partial-progress reports safely.

### B-08: Item replacement versus whole-plugin replacement

- Where: bindings/plugin.md, Starting and The conformance plugin; contracts.md, Plugins and capabilities.
- Conflict: the description removes everything a replaced plugin registered. The binding instead replaces individual tools, commands, Providers or the working environment. One local plugin here supplies four tools, but the conformance plugin replaces only two. Its Provider replacement may also name a local conformance Provider that was never enabled.
- Choice: apply wire replacements transactionally to local items, before registering the external items. Filter read and bash out of the local source, retaining write and edit. Remove the local Provider or environment capability itself. A missing local target is harmless if the external plugin actually provides the named replacement. A second external plugin cannot replace the first external plugin's items. Failed setup retains the original registry.
- Swap test: yes. Removing a whole source would unexpectedly remove unrelated tools. Requiring every local target to exist would prevent an external conformance Provider from loading outside ACP conformance mode.
- Round four settles item replacement and requires shutdown with reason refused. The host rejects the registration without losing its own items or stopping composition.

### B-09: The credential object's schema

- Where: bindings/plugin.md, host/credentials/read; bindings/data.md.
- Missing: the credential is an object, but no fields or provider-specific convention are defined.
- Choice: this build's existing credential store holds strings. Return an API-key credential as { apiKey: value }, or null when unavailable, only to the plugin that registered that Provider identity. Do not send credentials to the Runtime, history, command arguments or diagnostic logs.
- Swap test: yes. A Provider expecting token, key or a typed credential object cannot use apiKey without an agreed schema. The conformance Provider needs no credential, so neither kit settles this.
- Round four supplies the shared Credential shape. Rust wraps its bare strings as type apiKey with a key field.

### B-10: Authority for callbacks without a parent and history page edges

- Where: bindings/plugin.md, What a plugin may ask the host and tools/call.
- Missing: how a persistent plugin acquires access to a directly named session, how much authority such a request has, and what a history page does when one entry alone exceeds 4 MiB.
- Choice: expose sessions at preparation, retain their work scope and recheck current authority on every query. A supplied parent must be live and belong to that same plugin connection and session. Environment requests and questions require a parent; Provider hook calls additionally require a parent Provider request and that Provider's registration. Global declarations and owned Provider credentials are the explicit sessionless exceptions. Link questions use the existing text-answer UI, retaining their original kind, details and unknown metadata in the keyed question and extension view. A history cursor must belong to the requested branch or all-entry list. Pages stop before 4 MiB, and an individually oversized entry fails rather than being silently truncated or skipped.
- Swap test: yes for callback authority, cursor scope and an unpageable entry. The binding needs rules here before plugins can rely on persistent subscriptions or arbitrarily large raw records.
- Round four settles parent liveness, session authority, cursors, page limits and oversized entries. See R4-06 for the remaining sessionless-declaration wording.

### B-11: Stateful Provider erasure has no wire operation

- Where: bindings/plugin.md, provider/discard; contracts.md, Erasure and Provider state.
- Missing: discard resets conversation context, but stage 1 has no operation to delete a Provider's controlled remote copies or report pending deletion.
- Choice: send discard on invalidation before further inference, and await discard during erasure. For a stateful external Provider, report its unaddressable remote-copy deletion as out of reach. Do not claim that resetting a pointer deleted remote data. Local OpenAI's stronger deletion protocol is unchanged.
- Swap test: yes. A host cannot meet the description's remote erasure guarantee with a plugin that interprets discard only as reset. A separate erasure operation or a stronger discard contract is needed.
- Round four adds erase: true to provider/discard. The host awaits the Provider and reports its pending work and out-of-reach copies.

### B-12: Provider response observations and custom hook definitions

- Where: bindings/plugin.md, Provider hooks, the standard hook table and handlers for plugin-defined points.
- Unclear: the description observes each arriving piece, while the binding gives provider.response an assistant message rather than a stream event. Registration also has handlers but no way to declare a custom point's owner or combination rule.
- Choice: stream provider/event pieces before the result, then observe the complete assistant message at provider.response. The local-model bridge follows the same complete-message shape. Remote handlers receive every named standard point, with the specified combination rules. Refuse output-gate registrations and unknown custom point registrations as not_supported rather than guessing their rule or exposing another capability's invocation token.
- Swap test: yes. Piece-count-dependent observers and plugins defining new points need more wire agreement. The supplied conformance plugin defines no custom point and does not count response observations.
- Round four requires one complete response observation after the last piece, and restricts remote handlers to standard hook points.

### B-13: Working-environment lifecycle and error detail

- Where: bindings/plugin.md, env/*, Ending and The conformance plugin; contracts.md, The working environment.
- Unclear at stage 1: env/read errors had no missing-file discriminator, environment shutdown is process-wide rather than session-specific, and the binding has no declaration for early background cleanup. B-17 below supersedes the missing-file part. The refreshed description now requires background commands to survive the call, unlike this build's previous policy.
- Choice: use env/exists before reading optional instruction files instead of depending on Rust error downcasts across RPC. Preserve binary file bytes as base64. Reuse the existing Linux ptrace environment, truthfully declaring strong containment, and retain its stricter cleanup at command end. EOF cancels and joins work; normal host shutdown sends plugin/shutdown, closes stdin and reaps the child. File operations are bound to the actual session and cancellation scope, including when several sessions share one project.
- Swap test: yes for error discrimination and expected background lifetime. Binary transport and cancellation are now explicit binding requirements. The conformance kits test those, but not background survival after a successful call.
- Round four supplies sessionId and env/sessionEnded. The served environment now retains successful background work by session, and the kit checks it.

### B-14: Conformance turn identity is absent from a model request

- Where: bindings/acp.md, Conformance mode; bindings/plugin.md, provider/request; bindings/data.md, ModelRequest.
- Missing: echo distinguishes results in this turn from older results, but a ModelRequest carries messages and optional sessionId, not turnId, inputId or an input-versus-context marker. A latest user message can also be steering or collected context rather than the turn's initial input.
- Choice: the served Provider uses the latest user message as the input boundary and considers tool results after it. It keeps no hidden conversation state. This is correct for the supplied kit's ordinary one-input turns and respects the authoritative context supplied by a foreign host. It does not read raw history to recover content the host may have deliberately omitted from the model view.
- Swap test: yes for steering, collected context and resumed calls. Hosts with different model-context construction can produce different conformance behavior even while supplying valid ModelRequests. Explicit turn/input metadata would remove that ambiguity.
- Round four defines the latest user message as the boundary. Collected context travels in the input's content instead of becoming a newer user message.

### B-15: Zero command timeouts across plugin boundaries

- Where: bindings/plugin.md, env/exec and host/env/*, clarified after the first swap matrix.
- Previously ambiguous: whether timeoutMs: 0 means no limit or an immediate timeout. Both this build's served environment and its host callback adapter created an immediate cancellation timer. Same-build tests omitted the field, hiding the mismatch.
- Choice: accept zero, null and omission as no limit at both receivers. Only a positive millisecond value starts a deadline. Existing tool and remote-environment senders already omit timeoutMs for no limit. The native environment receives cancellation tokens, not a numeric timeout. Regressions cover serving and host forwarding into both local and separate-process environments, plus positive deadlines.
- Swap test: yes. The original difference cancelled another build's commands immediately. The refreshed binding now settles the behavior, and the plugin kit checks zero and positive timeouts.

### B-16: Tool-call content arguments are not ToolCall input

- Where: bindings/data.md, Content and ToolCall; bindings/acp.md, Entry.
- Implementation mismatch: the binding already says a toolCall content block uses arguments, while the distinct ToolCall request object uses input. The ACP history adapter incorrectly reused input for the content block. This was not a missing contract.
- Choice: emit arguments in history tool-call content blocks, retain input as a legacy alias, and leave the store's original payload unchanged. Add an ACP regression checking the call identity, name and arguments through _modular-agent/history.
- Swap test: yes. A host following the documented content shape would lose the call's arguments. Extra fields are permitted, so retaining the old alias does not prevent conforming hosts from reading arguments.

### B-17: Missing files across local and external working environments

- Where: bindings/plugin.md, Errors and The host asks the working environment, clarified after the four-language matrix on 2026-11-17; B-13 above.
- Previously ambiguous: there was no shared missing-file error. Generic Rust I/O failures became internal on env/read, and local host/env/read failures became invalid_request. The optional AGENTS.md reader used an existence check, which cannot protect against a file disappearing before the read. The refreshed binding now requires not_found and forbids message-based detection.
- Choice: emit not_found for typed local missing-file errors and preserve external wire faults. Normalize an external env/read not_found to std::io::ErrorKind::NotFound at the environment adapter, so native readers and host/env/read forwarding treat local and external files alike. Read optional AGENTS.md directly and ignore only that typed missing-file error. Other errors still fail the turn, even if their message says "No such file". Three regressions cover a completed turn with local and external missing AGENTS.md, non-missing failures, and host callbacks through local, served and independently worded fixture environments. The mandatory plugin kit now expects all 42 checks.
- Swap test: yes for the wire error code and optional-file handling. The refreshed binding settles these requirements. Normalizing the wire code to a Rust I/O kind is internal and would not break another host or plugin. No further binding ambiguity was found in this correction.

### B-18: A Runtime can write checkpoints, but resume has no way to read them

- Where: bindings/plugin.md, the Runtime host port and resumeTurn; contracts.md, Settings and Recovery and repeating work.
- Missing: resumeTurn supplies only unresolved calls and a started bit. It does not supply the committed response, completed results awaiting publication, remaining step budget, the disposition of an in-flight model request or the saved replay promises. prepareStep returns model context, not raw checkpoint state. Generic host/history is outside host/runtime.
- Choice: the served Runtime writes private checkpoints using record. It advertises the optional supports.recoveryEntries flag. This host then includes the committed response and private turn checkpoints in interrupted.entries, and includes an environmentSafeToRepeat promise when the environment makes it. It omits the extension if the frame would be too large. Required calls alone still support conservative recovery: never retry a started call without the saved tool and environment promises, and never assume that a stateful or tool-running Provider request is safe. The host also honors authorized generic history reads for external plugins that choose that route; this served Runtime makes none.
- Swap test: yes. A started safe tool can run again on one host but be unknown on another. A Runtime on a calls-only host cannot always recover an exact step count or tell that a final response already committed. A bounded Runtime history read or standard resume checkpoint would resolve this.
- After the Runtime matrix: the refreshed binding names host/history as the standard recovery path. The Rust host already accepts authorized history reads from a Runtime, and the cancellation regression proves that the Runtime can still read history after cancelling its in-flight requests. The served Rust durable Runtime still uses the negotiated recovery payload and conservative fallback above. Moving it to the standard read path is outside this host cancellation correction.
- Round four settles the transport and replay promises. The served durable Runtime now pages through host/history and no longer negotiates a recovery payload or requires private records. See R4-02 for the crash windows that remain.

### B-19: Record ownership and the turn-ending boundary

- Where: bindings/plugin.md, host/runtime/record and the rule that callbacks about ended turns are refused; bindings/data.md, History entries.
- Missing: the binding does not say who commits turnStart before a Runtime can be lost, whether turn.end runs before or after the turnEnd record, or how a host identifies a tool call between the response record and a separate start record. There is no shared tool-call history kind.
- Choice: the host writes the initial checkpoint before the RPC and treats a Runtime's turnStart record as a request for that existing entry. It derives call identities from the committed response, and commits tool starts before dispatch. It accepts the turn.end hook before turnEnd, then refuses further Runtime host requests. On loss it reports failure and settles unresolved calls, rather than replacing the Runtime mid-turn. Private entry kinds cannot masquerade as the host's authority or session records.
- Swap test: yes. A Runtime that ends the record first and then asks for turn.end will get invalid_request. Adapters also need shared rules for deriving the resume list, and for who settles it if the Runtime is lost.
- Round four puts turnStart, input and turnEnd with the host and makes turn.end the Runtime's last request.

### B-20: Step correlation and Runtime report vocabulary

- Where: bindings/plugin.md, host/runtime/model, host/runtime/hook and host/runtime/report; bindings/data.md, Stream event.
- Missing: model and hook requests can lack a stepId outside the payload, and report has no standard vocabulary or stream-end convention. The provider's event has no stream-end type even though the output gate needs an end.
- Choice: use the most recent prepareStep identity when a callback does not give one, and prefer the recorded call's step for tool work. Relay provider pieces as modelEvent, report model.delta, model.thought and model.tool_input, then model.end. The host also accepts a report that wraps the data binding's stream event, and closes remaining streams at the end of the turn.
- Swap test: yes. Agreeing only on transport can lose live output or leave it held until the turn ends. A standard report event and end marker would permit interoperable streaming without aliases.
- After the first Runtime swaps: the refreshed binding says the host emits standard events directly and requires stepId on host/runtime/model. The Rust host still relies on Runtime reports to deliver streamed model output to Interfaces, so a Runtime that stops sending duplicate reports can lose live output on this host. That existing mismatch was not changed in the cancellation correction.
- Round four puts stream delivery with the host. The host emits the Provider stream and the served Runtime sends no standard reports.

### B-21: Model retry preparation and Provider state

- Where: bindings/plugin.md, prepareStep, model and model.failed; contracts.md, Compaction and Provider state.
- Missing: model.failed may request a retry but there is no Runtime callback to discard state or say whether a replacement request should go through prepareStep again. Usage for auxiliary host-side model calls such as compaction has no named return field.
- Choice: the host marks an accepted retry and discards the bound model's state before the next model callback. This Runtime sends a supplied replacement as-is; without one it prepares the step again. The Runtime's wire usage sums assistant message usage it sees. The host retains its normal context and output checks and can account for its auxiliary work in history.
- Swap test: yes. A host and Runtime that assign retry preparation or discard differently can send stale or differently transformed context. End-to-end turn usage can differ when the host performs auxiliary requests.
- Round four settles who discards Provider state, when to prepare again, and who accounts for auxiliary work.

### B-22: Open-call continuations and standalone tool calls

- Where: bindings/plugin.md, continueOpenCalls and TurnOutcome; bindings/data.md, turnEnd; bindings/acp.md, tool extension.
- Missing: openToolCalls has no item shape in the plugin binding, and there is no Runtime request for a standalone tool call from the Interface. The answer identity for startedBy is also not carried with a continued call.
- Choice: send open call IDs in TurnOutcome and accept IDs or call objects when hosting, verifying them against persisted unsettled calls. Send continueOpenCalls when all questions in the group are answered. Keep standalone UI calls on the existing local mediated tool path, not a fabricated turn. Use the continued call's ID for the answer-started turn when no distinct answer ID is present at admission.
- Swap test: yes for continuations and origin metadata. Standalone tools are a gap if a remote Runtime is expected to own that path too.
- Round four specifies call IDs, the answer request's identity and host-owned UI calls. The wire Runtime does not rewind.

### B-23: ACP history status spelling on recovery

- Where: bindings/data.md, ToolResult; bindings/acp.md, History; ACP kit --crash-checks.
- Implementation mismatch: ACP history used the Rust enum spellings unknown and not_started. The crash check expects the shared outcomeUnknown for a started interrupted call.
- Choice: normalize both spellings at ACP history serialization without changing the store. The crash check now gets the same wire status from local and remote Runtimes.
- Swap test: yes. Consumers following the shared data vocabulary cannot recognize the old values. No change to the supplied kit was needed.

### B-24: A cancelled host request still needs a reply

- Where: bindings/plugin.md, Transport and Runtime cancellation, clarified after the Runtime matrix on 2026-11-17.
- Implementation mismatch: the Rust host signalled cancellation but waited for the callback to return. Hook dispatch does not necessarily observe the token. In the matrix the Runtime waited for a reply to its cancelled tool.before callback and the turn hit the host's five-second wait. A local wire fixture reproduced the stall with tool.before and prepareStep both in flight.
- Choice: settle explicit callback cancellation at the host request boundary. Return cancelled immediately for callbacks such as hooks, or allow cooperative work such as command shutdown and history publication to finish first. If that work has not settled after four seconds, stop waiting and return cancelled. This limit applies only after cancellation, not during ordinary work, and leaves room before Rust's five-second caller fallback. Dropping a nested RPC sends its own cancel and removes its pending scope. Cancelling the parent still signals cooperative work but does not refuse new cleanup callbacks, such as recording turnEnd.
- Swap test: yes for the reply. Omitting it stalls a peer that waits as the binding requires. The cleanup limit is a Rust policy, not a new wire requirement. A cancelled reply does not promise that an outside effect was undone.
- Round four makes a reply mandatory even for work cancelled before it starts. The host answers, and the probe checks the early case.

## Round four

### R4-01: The supplied history service reports no retry delay

- Where: bindings/history-http.md, Writing; conformance/acp/README.md, portable example.
- Problem: the supplied service answers a second owner with HTTP 409 and code held, but no retryAfterMs. This was observed over HTTP, not by reading the service. The first portable run consequently failed at reopening. The README also gives a service path that is not part of this repository.
- Choice: use retryAfterMs when sent. For a legacy held answer, poll every 250 ms only within the ttlMs declared by GET /v1. Never break another writer's lease. Start the supplied service from the path in the assignment.
- Swap test: yes. An implementation that requires the new field cannot recover on the original supplied service. The ACP kit works with the fallback and was not changed.
- Update after the first portable-session swaps: the refreshed supplied service now gives `retryAfterMs` with `409 held`. Verified over HTTP with two owners of the same session. The client keeps the fallback for older services.

### R4-02: The standard record cannot distinguish all crash windows

- Where: bindings/data.md, Portable sessions; bindings/plugin.md, Runtime recovery.
- Missing: with no response, the record cannot distinguish a request that never went out from one that reached a Provider which runs tools. With a response but no turnEnd, it cannot distinguish a final result already checked by a hook from one still awaiting that check. A refusal that asks for result feedback also has no standard meaning or origin.
- Choice: the served Runtime stops conservatively when an unrecorded model request might have run Provider tools. Otherwise it reconstructs the step count and usage from responses, does not repeat settled tools, and re-evaluates the last recorded response. A retry may start a fresh stateless request. Native checkpoints can retain decisions from this build. Runtime-generated result feedback has no portable standard kind.
- Swap test: yes. Different builds can end a turn differently after the same crash. A standard model-request marker and a standard result-decision entry would remove the ambiguity.

### R4-03: Nonstandard settings, actor rights and Provider names

- Where: bindings/data.md, History entries and Portable sessions.
- Missing: actor rights are an open named set, but the binding does not name a common set. Approval mode is exposed by ACP but is not a standard history setting. There is no portable fallback when the saved Provider or model is absent.
- Choice: interpret known rights, preserve the launch actor, and never infer a missing right for another actor. Store this build's wider settings in settings values alongside the canonical keys. Select the saved model when installed; otherwise an interrupted turn may fail rather than silently switch Providers.
- Swap test: yes. Two builds can reopen the same record with different tool authority, approval policy or model choices.
- Update after the first portable-session swaps: the data binding now names the rights. Rust keeps unknown names in actor records without granting authority for them. The approval and Provider gaps remain.

### R4-04: Questions closed without an actor's answer

- Where: bindings/data.md, Questions and Portable sessions; bindings/plugin.md, host/ask.
- Missing: no standard entry distinguishes a timeout, a declined answer from the host, expiry on cancellation, or invalidation after an authority change. The draft does not name the valid responding actors or routes. There is also no portable rule for recognizing a resumed tool's derived question key.
- Choice: write a declined inputAnswer for closure and invalidation, with a namespaced qualifier for the host to distinguish them from answers that resume tools. Read another build's standard questions and answers, defaulting their route to the session and the answerer to the host actor subject to current rights. A question relying on private closure or routing metadata cannot always be reconstructed identically elsewhere.
- Swap test: yes. Another build might show a closed question as open, or be unable to identify a reissued question. The standard record needs explicit closure and routing semantics.

### R4-05: Pending remote erasure has no entry mapping

- Where: bindings/plugin.md, provider/discard; bindings/acp.md, erase.
- Missing: Provider pending is a list of strings describing copies. ACP pending is a list of entry IDs. The wire operation gives the Provider only a session ID, not the entries involved.
- Choice: await discard with erase true. If any Provider reports pending copies, conservatively list the affected erased entry IDs as pending. A repeated erasure requests deletion again. Preserve outOfReach strings.
- Swap test: yes. Hosts that treat Provider strings as entry IDs would give clients unusable cursors for retries.

### R4-06: Optional and implicit callback scope

- Where: bindings/plugin.md, What a plugin may ask the host and The host asks the working environment.
- Unclear: the introduction says every callback names a session, but the authority rules list sessionless requests. A declaration with sessionId appears in the table but not in the direct-session authority list. The environment introduction also says every request has cwd although sessionEnded lists only sessionId.
- Choice: allow a global declaration and owned credentials without a session or parent, and a scoped declaration for an accessible session. Treat sessionEnded as taking only sessionId. Treat unknown methods as method-not-found, regardless of their parameters. Sessionless problem notifications do not grant or resolve authority.
- Swap test: yes. A stricter reading can refuse otherwise useful declarations and session cleanup.

### R4-07: The page budget and reporting names

- Where: bindings/plugin.md, Paging history and Runtime events.
- Unclear: the 4 MiB budget does not say if it counts just entries, their result wrapper, or the full RPC frame. Standard event names are not reserved in a list, so a host cannot recognize every possible alias a Runtime could use for a duplicate.
- Choice: count the serialized history result, including next. Do not split entries. Ignore reports in native standard event namespaces and run standard streams directly from the Provider. Send no reports from the conformance Runtime.
- Swap test: yes, at the exact size edge or if a Runtime reports under a private alias that looks like a separate event.

The ACP README also joins the crash-check and probe-check descriptions into one bullet. The runner implements them separately, so this did not change the results.

### R4-08: Private work and portable guarantees

- Where: bindings/data.md, Portable sessions and shared history entries.
- Missing: the promise excludes plugin sets and jobs, yet it does not define a portable standalone UI call before toolStarted, a queued input admission before a turn takes it, a handed-back queue entry, or a replay-safe keyed slash command.
- Choice: keep these as namespaced records for local use. Read keyed standard input on any branch without needing an admission cache. Do not claim that a foreign host can duplicate native queue, command or job behavior. The shared history binds completed and interrupted model turns, settings, actors, and standard questions.
- Swap test: yes. A build with additional interface features can otherwise appear to lose unfinished work or a keyed command receipt after a swap.

## Original milestones

The earlier entries describe the original implementation choices. Bindings entries above supersede the old ACP wire names and behaviors where they differ. Frozen docs/ files were not edited.

## M5-01: State identity, reconciliation and auxiliary requests

- Where: contracts.md, Model access and Runtime and Provider; architecture.md, Provider and History; scenarios.md, 6, 10 and 14.
- Missing: who owns the identity and lifetime of cached Provider state, how fresh bindings share it, and how to detect a context change that is not an explicit rewind. Scenario 14 says moving alone needs no other action, which is unsafe if a Provider keeps the abandoned branch.
- Choice: OpenAI has stateless and stateful composition modes. The Runtime always supplies the complete authoritative view. The Provider shares a per-session cache across model bindings, applies middleware to the full request, then sends a suffix only if the exact input items and system instructions extend its last successful request plus raw output. Otherwise it starts an independent response chain. Moving, model changes, closing, erasure and explicit discard invalidate the cache. A fork has a new session identity and starts independently. Auxiliary summary requests use the same reconciliation and discard after recording the summary. Restart starts with full context, not a persisted continuation pointer. Tool definitions and instructions are sent on every request. No server tools, background generation, vendor context compaction or stored prompt templates are allowed.
- Swap test: yes. State must never supply context missing from the agent's view. Exact prefix comparison, cache representation and choice of OpenAI chaining API are internal, but discard identity, binding lifetime and auxiliary-inference isolation affect plugins. Moving must reconcile Provider context even when files are not rewound.

## M5-02: Remote erasure acknowledgement and uncertain requests

- Where: architecture.md, History and Surviving interruptions; contracts.md, Interface and Harness erasure and Provider discard; scenarios.md, 15; open-questions.md, Erasure scope.
- Missing: whether discarding state means only not using it or actually deleting remote copies, how erasure waits for network deletion, and how a restart finds remote IDs. A request can create a remote response before its ID reaches the agent.
- Choice: discard invalidates continuation immediately. Erasure is asynchronous and deletes every known response ID for each affected session before acknowledging success, including abandoned chains, summaries and IDs inventoried before a stream failed. A separate atomic Provider inventory holds IDs and uncertain-request markers, never prompts or keys, across restarts. IDs are saved before response-piece observers run. Failed deletion leaves a durable retry barrier; reopening or a subsequent request must finish cleanup first. The inventory also tracks the history's erasure IDs, closing the crash window between the local erasure commit and the separate Provider deletion-intent commit. Repeating erasure, even with no new local entries, retries cleanup. Local erasure is not rolled back on a network error. Already delivered output, unknown response IDs and OpenAI's service-side logs/retention are explicitly out of reach. Interrupted stateful requests still fail closed under the existing Runtime rule rather than being replayed. A definite rejection of an unavailable previous ID permits one full-context retry, not a general retry of unknown effects.
- Swap test: yes. A host must distinguish completed erasure from pending deletion and unreachable copies. The exact inventory format is internal. No build can promise removal of an unknown remote response or vendor backups through an API that cannot address them.

Each entry gives the location, uncertainty, choice, and swap test.

## M4-03: ACP coverage, host identity and reconnecting

- Where: architecture.md, Interface, Being driven by a host and Declared support; contracts.md, Interface and Harness; scenarios.md, Driven by a host.
- Missing: which ACP version and methods carry the host operations, how reconnecting identifies the actor, and how to expose operations ACP does not standardize.
- Choice: the official agent-client-protocol 5.3.0 SDK serves ACP v1 over stdio. Standard new/load/resume/list/close, prompts, cancellation and model/thinking selectors are implemented and declared. Each connection belongs to the launching OS user, not a self-reported clientInfo identity. The existing actor ID user is retained for that host's actions, declared as kind host and recorded on first prompt. This is not a multi-user authenticated service. Sessions have isolated in-process plugin compositions. The recorded canonical project must match load/resume cwd. Load replays gated branch messages and tool records; resume does not replay. Keyed prompts use _meta modular-agent-rs/inputKey; duplicate receipts survive a new process. Declared _modular/ extensions expose history after an entry, keyed steering/follow-up and withdrawal, draining, commands, jobs, questions/answers, direct tool calls, fork, position movement and erasure. Rewind is refused before changes. Forks are persisted and closed, then opened through resume. No hidden scheduler starts turns: prompts or explicit drain consume admitted work and job reports. Text-only prompts are declared. Client filesystem/terminal delegation, host system prompts, additional roots, legacy SSE MCP, ACP v2 and remote authentication are not offered.
- Swap test: yes for identity, declarations, replay, keys, refusals and extension semantics. The protocol and extension namespace are binding choices requiring adapters across builds. A host can use only the Interface; it does not need access to the Harness's Rust objects.

## M4-04: ACP interactions, concurrent dispatch and gated responses

- Where: architecture.md, Waiting for an answer and Who sees what; contracts.md, Input request and answer, Event and Interface and Harness.
- Missing: permission/elicitation mapping, absent-client support, asynchronous request ordering and whether non-streaming Interface responses also pass the output gate.
- Choice: approval offers only allow_once and reject_once. Only the explicit allow option authorizes a call. Text and choice requests use form elicitation with one validated answer field, only when the client advertises form support. Declines, errors, unsupported forms and cancelled permission requests fail closed through the existing request service. ACP does not collect secrets: form mode forbids them, and this build has no URL credential flow, so those requests are declined without sending a form. Late questions stay answerable through the declared answer/drain extensions. Child questions route to the same top connection, without leaking child message streams. SDK request callbacks immediately schedule connection-owned tasks, since awaiting a turn in its ordered callback deadlocks permission replies and cancel notifications. The official-client tests caught this, then proved the fix. Live events, replay and session RPC results all pass the gate; a flush ensures queued updates precede a prompt response. The record remains original. Closing cancels and joins active work and the event worker, and awaits session-owned MCP shutdown.
- Swap test: yes. Treating cancelled permission as allow, sending secrets in forms, bypassing the gate for RPC results or blocking replies would break hosts and guardrails. Task/queue implementation is internal.

## M4-05: Internal settings and executable configuration privacy

- Where: architecture.md, Configuration, Project trust and Sessions; contracts.md, Session and Declaration; open-questions.md, Plugin lifecycle and Configuration.
- Missing: separation of ordinary defaults from Harness-internal state and secret-bearing executable options, and what reopening does when its plugin composition differs.
- Choice: file defaults cannot set underscore-prefixed internal fields such as _parent or _authority. Only in-process agent features create those. Executable plugins/options are read from current global settings and currently trusted project settings on each composition, never copied from recorded history to launch a server. Reopening refreshes active plugin names and records a composition-name change. Session model/thinking and other ordinary settings stay recorded, rather than being reset from defaults. Host MCP env/HTTP headers exist only in the connection's memory, not session settings, history, model context, list output or command lines. Configured HTTP headers are supported, protocol headers cannot be overridden, and redirects are disabled. ACP executable paths must be absolute. Explicit trust affects new or reopened compositions, not a running one. Inline header/env authentication is supported, but there is no OAuth or credential-discovery UI.
- Swap test: yes. Allowing a project to forge internal parent/authority fields, relaunching untrusted recorded programs or recording host credentials changes security and host behavior. The options schema and path rules are binding choices. Current trust must always be checked before execution.

## M4-02: MCP adaptation, lifetimes and recovery readiness

- Where: architecture.md, Tool source, What plugins can do and Surviving interruptions; contracts.md, Tool definition, Tool result and Harness and tool source.
- Missing: MCP versions/transports, naming, annotation defaults, unknown content, connection ownership, source readiness during recovery and changing tool lists within a turn.
- Choice: the official rmcp 3.10.0 client owns stdio and Streamable HTTP, negotiating current 2026-07-28 with legacy fallback. Offline tests also exercise a 2025-11-25 stdio server. Names are mcp_SERVER__TOOL, with alphanumeric/hyphen server IDs and bounded vendor-safe tool names; invalid names and collisions are refused, not rewritten. Annotations map to read-only, safe-to-repeat, destructive and outside hints. Missing hints are conservative; parallel calls are off. The complete MCP definition/result, including non-text content and metadata, is retained in standard hint/result values. Settings servers connect for every session; host servers attach only to one session. Closing awaits SDK shutdown, which closes stdin, terminates if needed and reaps. Direct stdio servers also receive Linux parent-death SIGKILL. External HTTP servers are not owned or stopped. Startup rolls back partial connections. A Harness-owned session.prepare hook connects sources before interrupted Runtime work, rather than after it. Legacy list notifications refresh the cache, and each new turn refreshes tools through the SDK. A running turn keeps its captured definitions; new tools appear on the next turn. Calls have bounded timeouts and cancellation never claims an outside effect was undone. MCP sampling, elicitation and auth UI are not offered.
- Swap test: yes. Names, defaults, content retention, session scope and recovery readiness affect tools and hosts. Transport machinery is internal. The captured-per-turn tool set is an explicit limitation rather than a hidden change during replay.

## M4-01: Settings plugin catalog and project trust

- Where: architecture.md, Configuration, What plugins can do and Declared support; open-questions.md, Plugin lifecycle and Configuration.
- Missing: plugin package format, options precedence, trust identity and persistence, and whether plugins differ between projects in one host connection.
- Choice: settings name prelinked Rust plugins in an ordered `plugins` array of name/options objects. `plugin_settings` merges options for named plugins. Global declarations load first; trusted project declarations/options merge after them without moving an existing name. The catalog initially exposes literal guardrails and subagents, with MCP added in this milestone. Unknown names fail before a session starts. There is no native-library ABI or automatic package execution. The operator grants trust by recording canonical project paths in `trusted-projects.json` beside the global configuration, never in the project. Session defaults still merge before trust, but plugin configuration is excluded from session settings/history. A configured composition is fixed to a project; ACP uses a separate in-process composition per session and subagents inherit it. Reopening rechecks current trust.
- Swap test: yes for plugin names/options, merge ordering and trust behavior, since they affect execution. File locations and the prelinked catalog are binding choices. A different native plugin format needs an adapter, not changes to the frozen description.

## M3-08: Optional tool fields and named authority in model tools

- Where: contracts.md, Tool definition and Provider; architecture.md, Harness as standardizing boundary and Actors and authority.
- Missing: how a Provider adapts optional tool fields to a vendor's stricter schema, and how model-facing authority fields identify valid rights.
- Choice: OpenAI's adapter makes optional properties nullable in its strict vendor schema, removes optional nulls on the standard side, and retains the unmodified response in opaque data. The standard definitions are unchanged. The delegate tool lists valid authority rights as an enum, describes null as inheritance, and rejects unknown rights before creating work. Two initial live attempts did not write the file. The retained second attempt showed a prose authority value narrowing to no rights, so bash was correctly refused. The schema was clarified, an offline regression was added, and the third attempt passed.
- Swap test: vendor normalization is internal if the standard tool input stays equivalent. Named rights, default inheritance and rejecting invalid caps are observable plugin behavior. Prose must never be interpreted as a grant.

## M3-07: Authority follows work, branches and reports

- Where: architecture.md, Actors and authority, History, Waiting for an answer and Jobs; contracts.md, Actor, Tool calls outside a turn and Usage.
- Missing: how mixed-actor steering, later grants, copied requests, abandoned waits and job reports preserve narrowing.
- Choice: each admitted input captures an authority cap. A turn intersects every contributor's saved cap and current rights, including steering. Reports act as distinct job:ID actors, never as user commands or approvals, under the job's saved cap, current initiating actor and child's limits. Nested job usage is included without counting an earlier message again. Moving away cancels open calls and questions and returns queued input; moving with live jobs is refused until they are cancelled. Forking refuses unsettled work, and copied completed questions and answers are rebound to the new session before authority checks. Cancelling an idle suspended child settles its open calls. Erasure drops queued erased content but refuses erasing authority grants, because removing a revocation must not restore wider rights. UI calls require no Provider or model selection.
- Swap test: yes. Losing any contributor's cap or treating reports as user authority can permit an action another build refuses. Authority-record erasure refusal and unsettled-fork refusal are explicit restrictions rather than silent escalation. The internal cap representation is a binding choice.

## M3-04: Job ownership, reports and recovery

- Where: architecture.md, Jobs; contracts.md, Plugin and Harness: jobs.
- Missing: job-runner registration, report admission boundaries and recovery of reports not yet taken by a turn.
- Choice: a jobs plugin records starts and delegates execution and recovery to named runner capabilities. A runner declares whether it resumes; otherwise recovery reports unknown and stops its interrupted resources. Ending and admitting a report use one Harness history commit. Job-task and job-report inputs are keyed and restored after reopening, unlike ordinary user input that is returned. Waiting jobs do not also report. Cancellation is recorded and signals the runner, then waits for it to finish cleanup; turn cancellation does not signal jobs. Closing a session cancels and awaits its jobs. An Interface drains report input to start turns. Moving position with live jobs is refused until they are cancelled rather than silently abandoning work.
- Swap test: yes for report deduplication, recovery, cancellation and movement. Runner lookup, task scheduling and JSON snapshots are internal. A runner must cooperate with cancellation; a misbehaving trusted plugin can prevent closing.

## M3-05: Subagent sessions, variants and re-messaging

- Where: architecture.md, Working with other agents; scenarios.md, Handing a task to a subagent; open-questions.md, Plugin scope and Agents working together.
- Missing: child settings and plugins, depth, variant selection, question routing and concurrent messages.
- Choice: a child uses the same plugins and project, copied settings, only its task as input, and an immutable authority cap intersected with its parent's current authority. Default depth is three edges. The default subagents plugin is durable independently of the parent's Runtime; a transient replacement is also available. The shared Runtime plugin supplies both interruption policies for explicitly marked child sessions. Each message is a keyed job; a busy child refuses another message, and a lower-authority sender must start a narrower child instead of reusing a wider one. Questions carry the complete child-to-root route and may be answered by an authorized actor at any level. Finished children remain open for messages until parent close. Child initialization and parent job start are separate store commits; a crash in between can leave an unused child session, but cannot run the task before the parent job is recorded.
- Swap test: yes for inheritance, depth, busy-child handling, routing and independent durability. The unused-session crash window is an internal storage limitation, not an extra running job.

## M3-06: Terminal answers and background lifetime

- Where: contracts.md, Interface and Harness; architecture.md, Secrets, Jobs and Being driven by a host.
- Missing: terminal answer syntax, how answer input avoids ordinary history, and when print mode stops with background work.
- Choice: /questions, /answer ID VALUE, /jobs, /cancel-job ID and /tool JSON are Interface actions. Answers bypass ordinary input and command recording; only the accepted sanitized answer is recorded. Interactive Interfaces explicitly register user presence, including before durable reopening. Print/JSON prompt mode drains owned jobs and their reports before closing, so a background report can start the required parent turn in one process. Interactive reopening reads answers while recovery waits. EOF cancels questions that can no longer be answered, including child questions; quit cancels jobs before waiting for the drain. --credential-file accepts a path, never a credential value, and isolates offline Interface tests from the real store.
- Swap test: command spelling is a binding choice. Raw secret recording, answerer presence and stopping before owned jobs report would break the behavioral contract.

## M3-03: Deadlines, open calls, validation and UI calls

- Where: architecture.md, Waiting for an answer; scenarios.md, A question nobody answers in time; open-questions.md, Waiting for an answer and Tool calls outside a turn.
- Unclear: the scenario says a timed-out turn completes, while the architecture permits a limit outcome; the durable variant may keep waiting instead. UI call visibility is open.
- Choice: both Runtimes honor the asker's explicit deadline, end at a question limit with open calls, and save no tool result. Questions stay answerable without a deadline. Once all questions for the open calls have answers, the next Interface drain starts a new turn, reruns the checks and records late results once. Without a deadline, durable recovery reopens the wait in its original turn; transient recovery closes it as unanswerable. New input may run meanwhile: only the model view synthesizes a waiting placeholder. Current real results are paired with their original calls in the model view; UI-only results become explanatory user context. Validation uses the existing first-answer result hook and step budget. UI calls use the Runtime's same tool pipeline without inference.
- Swap test: yes for outcome, resumption, check replay, waiting views and UI visibility. The binding uses an Interface drain rather than a hidden turn scheduler, including for later job reports.

## M3-01: Authority grants, presence and delegation

- Where: architecture.md, Actors and authority; open-questions.md, Several actors.
- Missing: a grant operation, rights, revocation scope, and how an Interface is known to be present.
- Choice: named rights are intersected with immutable session caps and every ancestor's current authority. The initial user has all rights. An actor with grant authority may grant only its own rights. Grants and revocations apply across branches. Interfaces explicitly register answerer presence; an event sink alone is not an answerer. Approval refuses if none is authorized. Plugins remain trusted in-process code, not a security sandbox.
- Swap test: yes. Grant scope, revocation and presence determine whether outside effects are allowed. The Rust types and right spellings are binding choices.

## M3-02: Request keys, answers and credential writes

- Where: architecture.md, Waiting for an answer; contracts.md, Input request and answer and Credential store.
- Missing: key scope, concurrent answers, changed question text, and writable credential-store operations.
- Choice: keys are scoped to the current branch and bound to kind, text, options, credential name and call identity. Changed definitions fail rather than reuse approval. A request service serializes opening and answering. Reuse checks the answerer's current authority, including ancestors. Invalid answers cause a new recorded request. Named secret answers are written atomically to mode-0600 files in a mode-0700 answers directory beside the configured credential file; provider credentials cannot be replaced by questions. Without a writable store or name, no question is opened. Only the credential name crosses the request service boundary.
- Swap test: yes for key binding, revocation and secret routing. Credential storage layout is internal. A crash after writing a secret but before recording its name may ask again; no secret value is journaled.


## M2-01: Recovery checkpoints and plugin effects

- Where: architecture.md, Surviving interruptions; contracts.md, Harness and Runtime; open-questions.md, Transient and durable Runtimes and Parked: how.
- Missing: checkpoint boundaries, reconstruction of partly recorded model responses, and replay rules for hook handlers with outside effects.
- Choice: both Runtimes share a turn engine. The durable variant saves turn inputs, request intent, complete responses, started calls, completed-call checkpoints and step decisions in history. A response is authoritative for reconstructing missing call records. Completed calls are never dispatched again. Hook handlers may be invoked again after interruption and must not perform unkeyed outside effects; arbitrary transactional plugin operations are not introduced in this milestone. Interrupted requests to a stateful or tool-running Provider fail closed rather than being repeated.
- Swap test: checkpoint format is internal. Hook replay and refusal to repeat effectful inference are observable and need agreement for portable plugins. Exactly-once outside effects cannot follow merely from an append-only history.

## M2-02: Parallel execution versus durable result order

- Where: contracts.md, Tool definition; open-questions.md, Parallel tool calls; ACCEPTANCE.md, milestone 2 item 5.
- Missing: whether one exclusive tool serializes the whole round, and how completed later calls survive a crash while earlier calls are running.
- Choice: a round runs concurrently only if every offered call definition permits it. Otherwise the entire round is serial. Each completion is checkpointed immediately, but model-visible results are published in request order. Both Runtimes use this rule. Recovery reruns checks on calls it dispatches, never on already completed calls.
- Swap test: yes. A plugin relying on exclusive access or a host relying on ordered results would break with different rules. The invisible completion checkpoint is internal.

## M2-03: Strong local command containment

- Where: architecture.md, Working environment and Declared support; ACCEPTANCE.md, milestone 2 item 4.
- Missing: how to contain setsid descendants without privileged cgroups, and what cleanup after loss of the stopper means.
- Choice: Linux ptrace descendant tracing on an agent-owned thread, with kernel exit-kill on tracer death. Parent-death SIGKILL covers initial setup. Commands remain stopped until tracing is installed; new descendants are traced before running, regardless of process group. No supervisor service or second agent process is added. Durable PID/start-time records provide startup cleanup after interruption, before any recovered tool can run. Unsupported tracing fails the command closed. This is containment, not a hostile-code security sandbox.
- Swap test: mechanisms are internal, but the containment declaration and failure policy affect safe replay and hosts. Cleanup is eventual after SIGKILL, not simultaneous with the agent's last instruction.

## M2-04: Replay hints versus promises and saved definitions

- Where: contracts.md, Tool definition says hints are not promises; architecture.md, Surviving interruptions relies on tools declaring safe repetition.
- Unclear: whether a hint is sufficient to authorize automatic replay, and whether restarted turns use old or newly discovered definitions.
- Choice: safe_to_repeat is treated as the tool source's replay commitment, not inferred from read-only. Recovery also requires the working environment's containment promise. A turn saves its offered definitions, settings and system prompt. Model selection binds the saved model name through the normal selection plugin, and fails if unavailable. Missing or incompatible legacy checkpoints fail closed rather than inventing turn inputs. Changes to plugin code across a restart are not hot upgrades.
- Swap test: yes. Treating a casual hint as a replay promise can repeat unsafe effects. The description should distinguish advisory metadata from commitments used for crash safety. Checkpoint serialization and code-upgrade compatibility are implementation concerns.

## M1-01: In-process types and plugin installation

- Where: contracts.md, Information; ADR 0010; open-questions.md, Plugin lifecycle and Parked: how.
- Missing: Rust types, capability lookup, installation rollback, duplicate names and replacement conflicts.
- Choice: a shared agent-api crate, named typed capabilities, transactional registration, unique plugin/capability/command names. Explicit replacement removes every old registration. A replacement target must exist. Plugins are fixed while sessions run.
- Swap test: different internal registration machinery is harmless. Different public Rust types need an adapter, as ADR 0010 intentionally leaves wiring to builders. Silent duplicate resolution would break plugins, so this build refuses it.

## M1-02: Hook combination and ownership

- Where: contracts.md, Hook points; open-questions.md, How handlers combine.
- Missing: which fixed rule each standard point uses, ties among first/last requests, and errors outside gates.
- Choice: observe for lifecycle and response pieces; collect for before-turn contributions; transform for input, context, tool results, Provider requests and output; gate before tools and plugin loading; first-answer for request failure, after-step and result validation. Stable first/normal/last groups preserve load order. Only an issued owner token invokes a point. Gate errors refuse; other errors propagate.
- Swap test: yes, different combination rules or error behavior can change a plugin's effect. These rules need agreement for portable behavioral plugins.

## M1-03: Input timing, keys and model changes

- Where: open-questions.md, Input during a turn, Changing the model mid-turn and Keys for repeated input; contracts.md, Interface and Harness.
- Missing: admission boundaries, key lifetime and whether withdrawn keys can be reused.
- Choice: steering joins before the next request, after the current tool round. Follow-ups start separate turns. Keys are remembered for the lifetime of their stored receipt, across branches and restarts, including withdrawn or returned input and commands. Erasing that receipt also forgets its key. Concurrent input admission is serialized per session. A now input arriving while a turn runs waits, unless explicitly marked steering. Cancelling returns untaken input with gated content. Reopening returns untaken input rather than silently starting work. Model/thinking changes are refused during a turn and apply next turn.
- Swap test: yes. Hosts depend on admission timing and key scope, and plugins depend on when settings apply.

## M1-04: History format, writer locks and lazy sessions

- Where: contracts.md, History entry and Harness and history store; open-questions.md, What history records.
- Missing: file format, atomicity, lock ownership and what counts as a used session.
- Choice: atomic JSON snapshots with stable global entry IDs, parent links, settings, plugin names and input receipts. OS-owned writer leases last for the open session. A session is persisted only on its first non-observation entry, not when created or inspected. No full duplicate request body is stored; model responses retain opaque Provider data.
- Swap test: file format is internal to the history store. Persisted position, one writer, metadata and no empty session are observable promises. Byte-for-byte inference reconstruction is not promised.

## M1-05: Compaction policy and retries

- Where: ADR 0007; scenarios.md, 6; open-questions.md, Turn limits and What history records.
- Missing: size estimator, summary boundaries, inference failure policy and retry bounds.
- Choice: estimate tokens from UTF-8 byte length, reserve output space, normally keep the newest complete input/tool round and summarize older model-visible entries using bound model access. If the newest span alone is too large, summarize it too, without leaving native tool calls unpaired. Manual compaction may summarize the whole active view. Summary entries name every source. One context-overflow retry per step; summary failures fail the turn rather than dropping history. /compact may use auxiliary inference even though commands do not start a Runtime turn.
- Swap test: exact thresholds and summary wording are internal. Retry bounds, indivisible tool rounds, provenance and auxiliary command inference can affect plugins or hosts and should be stated.

## M1-06: Output buffering and privileged raw access

- Where: architecture.md, Who sees what; contracts.md, Content and Hook points; open-questions.md, Partial output.
- Missing: stream identity, flush behavior, privileged observation and how redaction changes structured output.
- Choice: recipient-specific output envelopes and explicit stream ends. Literal guardrails hold an entire selected stream, redact on flush, and recursively redact complete JSON string values. Plugins are trusted and may read raw history through the API; Interface recipients and model context use the gate. Live events are not retained as a second raw log.
- Swap test: yes. A guardrail needs stable stream boundaries and a declared hold/flush contract. Arbitrary secrets encoded or divided across structured fields are not detected by a literal guardrail.

## M1-09: Reading settings versus recording commands

- Where: contracts.md, Actor and History entry; ACCEPTANCE.md, milestone 1 History.
- Unclear: every command records its actor, but reading settings in a new unused session must leave nothing behind.
- Choice: observation-only command records live in memory until another action uses the session. Then the whole prefix is persisted. A session containing only command observations is not listed or saved.
- Swap test: yes. A host cannot expect read-only command records to survive an otherwise unused session closing. The empty-session acceptance requirement wins here.

## M1-10: Tool details and ordinary shell background children

- Where: contracts.md, Tool definition; architecture.md, Tool source and Working environment; examples/vanilla-pi.md.
- Missing: input field names, encoding, ambiguous edits, path restrictions, shell output limits and what happens to untracked background children.
- Choice: UTF-8 read/write/edit, exact unique edit matches, relative paths under the session project and absolute paths allowed. These are not sandboxed tools. Bash runs without profile files, with null stdin and streamed stdout/stderr. Exit status determines success. Ordinary untracked background children are killed and reaped after the shell exits, so inherited pipes cannot hang the call. Persistent named jobs are not introduced until milestone 3. No output truncation in milestone 1. Bash uses incremental UTF-8 decoding so split characters survive pipe reads; non-UTF-8 bytes use replacement characters.
- Swap test: tool inputs and path rules are plugin-facing and need adaptation across builds. Exact encoding and edit behavior are observable. The background cleanup policy must be declared; returning from bash does not imply a persistent job was created.

## M1-11: Content support and Provider limits

- Where: contracts.md, Content, Model access and Model request and response; open-questions.md, Content model.
- Missing: required media types, model limit discovery and vendor-specific continuation data.
- Choice: milestone 1 sends text and native tool calls/results. Reasoning and unknown content are retained as typed opaque JSON, including OpenAI output items for stateless continuation. The fixed OpenAI catalog advertises conservative local limits of 128000 context tokens and 8192 output tokens, with low/medium/high reasoning. These are local ceilings, not claims about the model's full advertised limits. Only gpt-6-luna can bind or pass middleware.
- Swap test: yes. Accepted input kinds, reasoning choices and limits are part of model access. Opaque vendor continuation data requires the matching Provider or an adapter, but is never discarded from the record.

## M1-12: Conservative erasure provenance

- Where: architecture.md, History and Who sees what; scenarios.md, 15; open-questions.md, Erasure scope.
- Missing: how to know whether generated text paraphrased an input, whether admission and consumption are separate copies, and whether materialized results count.
- Choice: every model response conservatively names every visible input it could have copied. Tool results name their calls. Failures name their context. Turn results and command observations name their source records. Settings name earlier materialized settings they copy. Summaries and fork copies name sources. A fork's erasure provenance is distinct from covering its own summary, so the summary does not accidentally hide itself. Erasing a consumed input also erases its admission copy. Erasure follows copies transitively, even if that erases more text than strictly needed. Materialized settings fall back to the newest surviving setting, or an empty object if their only recorded setting was erased. The fake Provider clears its controlled request recordings, pending raw events are dropped, and open session snapshots are refreshed. Already delivered output and snapshots handed to callers are reported out of reach.
- Swap test: yes. Provenance precision changes how much is erased. It must never leave a controlled copied value behind. This build favors over-erasure over retaining derived private data.

## M1-08: Diskless writer leases and erasure coordination

- Where: contracts.md, Harness and history store; architecture.md, History.
- Missing: empty-session lock cleanup, locking during erasure across forks, and cross-file crash atomicity.
- Choice: Linux abstract Unix socket leases keyed by store path and session ID. They leave no session artifact and the OS releases them on process exit. A short store-wide file lock serializes snapshots. Lease acquisition retries for at most 150 milliseconds because a concurrent fork can inherit a CLOEXEC socket until exec. A regression test holds exactly that window open. Erasure first acquires every affected foreign session lease and refuses before writing if one is held. Each changed snapshot is atomic; the whole multi-session erasure is not crash-atomic, and must be retried after a disk failure.
- Swap test: lease machinery is internal. Erasure refusal while another writer holds a copy is observable and avoids stale copies restoring erased content. Multi-session atomic erasure would be a stronger promise than this build makes.

## M1-07: Process containment staged by milestone

- Where: architecture.md, Working environment and Declared support; ACCEPTANCE.md milestones 1 and 2.
- Unclear: the architecture says nothing outlives the process, but milestone 2 specifically adds the SIGKILL/setsid proof.
- Choice: milestone 1 uses process groups, live pipe reads, cancellation and cleanup on normal completion, including background children in the group. It declares no guarantee after agent SIGKILL or a command escaping the group. Strong containment is left for milestone 2.
- Swap test: yes, but the description explicitly supplies this declaration and fallback: unknown outcomes are not automatically repeated.

## M1-13: Configuration locations and project discovery

- Where: architecture.md, Configuration, Project and System prompt; examples/vanilla-pi.md.
- Missing: setting filenames, precedence, starting defaults and which context files to discover.
- Choice: global settings are ~/.config/modular-agent-rs/settings.json, project settings are PROJECT/.modular-agent.json, and explicit new-session settings win over both. Objects merge recursively. Defaults are gpt-6-luna, low reasoning, 12 steps, 2048 output tokens and a 24000-token compaction threshold. Context reads only the project's root AGENTS.md, not parent directories. Reopening always uses the recorded project and settings. Data lives separately under ~/.local/state/modular-agent-rs.
- Swap test: filenames are intentionally builder-specific wiring. Precedence and discovery scope are observable and could change a plugin's prompt or a host's session defaults.

## M1-14: Terminal input, events and EOF

- Where: contracts.md, Interface and Harness and Event; examples/vanilla-pi.md, Interfaces; open-questions.md, Partial output.
- Missing: flags, line interaction, event encoding and whether EOF waits for queued input.
- Choice: line, print and JSON modes share the same Interface plugin. JSON is one typed event object per stdout line. Diagnostics go to stderr. Line input steers while active; /after queues; /cancel or Ctrl-C cancels; /quit closes. EOF drains accepted input. A worker settling just before another line arrives triggers another queue scan, rather than losing that input.
- Swap test: wire encoding is a binding choice under ADR 0010 and needs an adapter across builds. Losing accepted input at EOF would break a host, so draining is an explicit behavior.

## M1-15: Declarations and the first actor

- Where: architecture.md, Declared support and Actors and authority; contracts.md, Declaration; open-questions.md, Several actors.
- Missing: how plugin declarations combine and the initial actor's identity and authority.
- Choice: one implicit user actor, named user, with full authority in its session. Other input actors are refused. The declaration includes Runtime and working-environment support, defaults for absent features, owner-supplied plugin metadata and every hook point's owner and fixed rule. Plugin metadata merges in load order. The literal guardrail declares holding only when configured with literals. Several-actor authority policy is left for milestone 3.
- Swap test: actor identities and declaration truth affect hosts and plugins. The single-actor fallback is already allowed by the description. Declaration serialization remains a binding choice.

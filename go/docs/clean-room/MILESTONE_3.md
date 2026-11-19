# Milestone 3 acceptance evidence

Milestone 3 is complete. No acceptance item was skipped. Milestones 4 and 5 were not started.

## Run and test

```sh
mise exec -- go build -o bin/modular ./cmd/modular
mise exec -- go test -count=1 ./...
mise exec -- go test -race -count=1 ./...
mise exec -- go vet ./...
bin/modular --runtime durable --subagents durable --wait-jobs \
  --project /path/to/project --mode print --prompt 'Delegate a background file-writing task.'
```

Final suite: **79 top-level tests and 222 subtests, all passing**. That is 28 more top-level tests and 106 more subtests than milestone 2. Race checks, vet, build and `git diff --check` pass. The milestone 3 question, subagent, job and terminal cases were also repeated three times under the race detector.

All acceptance tests use the fake Provider. Anthropic protocol tests use a local HTTP server with dummy credentials. No test reads the experiment key or makes real inference requests. Subprocess helpers are killed by their exact process handles and waited for. Controlled bash supervisors are closed by the working environment. The new crash tests exercise fourteen SIGKILL/reopen cases, in addition to the existing milestone 2 crash suite.

## Acceptance items

1. **Recorded, keyed input requests.** `questions/TestRecordedKindsKeysAuthorityAndSecrets` covers approval, choice, free text, secret, key reuse and second-answer refusal with each Runtime. `TestQuestionSIGKILLReplay` kills a real process with a question open or an answer saved, then reopens with each Runtime: durable asks the open question again but reuses the saved answer; transient repairs the call and exposes the lost request as unanswerable. `TestReplayedAllowFromRevokedActorIsNotUsed` reopens a saved allow and revokes its actor before replay. `TestQuestionOnAbandonedBranchIsNotReused` proves branch scoping. Concurrent answer attempts accept exactly one answer.

2. **Authority.** The same question test gives a viewer a history view but refuses its answer and attempted authority grant. A grant-capable actor still cannot grant rights it lacks. `TestActorCommandsCannotBorrowOwnerAuthority` covers command identity. `subagents/TestChildCannotWidenAuthorityAndParentRevocationApplies` proves child ceilings and current parent revocation. Different actors cannot widen a running turn by steering it.

3. **Approval plugin.** `questions/TestApprovalPoliciesAndUICallAudit` exercises off, ask-unless-read-only, ask-always and never, including allow/refuse and a read-only bypass. `TestApprovalFailsClosedWithoutResponder` refuses a write with nobody connected. `TestLaterGateCannotChangeApprovedArgumentsOrUseRevokedAllow` proves final-argument binding and current authority checks. The plugin uses the standard Runtime-owned tool gate, not Runtime-specific code.

4. **ask_user.** `TestAskUserWaitsInTurnAndSecretDoesNotReachEventsOrModel` has the model request the tool, receives an answer and continues inside one turn. Other question cases cover choices, free text and deferred answers. `terminal/TestLineInterfaceAnswersSecretsWithoutSubmittingTheirValue` proves the terminal answering path.

5. **Questions outlasting turns.** `TestLateQuestionsEndWithoutResultsThenResumeTogether` times out two calls, proves no result was recorded, permits unrelated model input while they wait, then answers both and proves one new turn with one late result per original call. Model views describe waiting and late results without storing a stand-in. `TestLateUIQuestionResumesAndConcurrentAnswersCloseOnce` covers the same lifecycle from a UI call. Explicit close settles parked calls as cancelled.

6. **Secrets.** The above secret tests inspect raw history, events and fake model requests for the secret value; all see only the credential name. `TestSecretDestinationRefusedBeforeAskAndWriteErrorsDoNotLeak` proves preflight refusal and a failed store write leaving the question open without exposing the value in an error. `credentials/TestNamedSecretsPersistPrivatelyAndCannotReplaceExperimentKey` proves reopen, overwrite, private permissions and the reserved experiment credential. `subagents/TestNestedApprovalsAndSecretReachOnlyTopCredentialBoundary` proves two-level secret forwarding and approval routing.

7. **Jobs.** `jobs/TestProcessStopLeavesJobForItsOwnerAndKeyedStartIsOnce` proves recorded starts/ends, keyed deduplication, owner-controlled recovery and usage. `subagents/TestTurnCancelLeavesJobsButJobCancelAndSessionCloseStopThem` proves cancellation boundaries. `TestBackgroundReportStartsParentTurnAndChildGetsOnlyTask` proves a recorded report input starts a new parent turn, with job usage counted once. Closing a session ends its work; stopping a process leaves unfinished work for recovery.

8. **Subagents plugin on jobs.** The background test uses real offline bash to write a file, with no parent history in the child's fake request. `TestWaitedChildFollowupRemembersAndDoesNotReportTwice` proves waiting, remembered follow-ups and no duplicate report. `TestNestedQuestionsReachTopUserAndDepthLimit` proves two-level routing and depth enforcement. `TestSubagentSIGKILLRecovery` exercises both subagent variants with each Runtime, including a crash after completion but before report intake. Transient children report unknown; durable children continue to their real result; replayed reports do not start another turn. `TestDurableSubagentSurvivesRepeatedOrderlyProcessStops` proves repeated clean interruption with either Runtime. `TestErasureReachesWaitedJobCopiesAndNeverRestartsErasedWork` covers cross-session result provenance.

9. **Result checks.** `resultcheck/TestRejectedResultContinuesSameTurnAndRespectsStepLimit` loads a feature plugin that rejects a final result with a reason. The fake model sees the recorded reason and repairs its answer in the same turn. Persistent rejection stops at the normal step limit, with either Runtime.

10. **UI tool calls.** Approval-policy and final-gate tests use `api.API.CallTool`, with no model request. Each call is recorded with UI origin and its authenticated actor, plus one completed/refused result. `TestExternalSIGKILLQuestion` proves that interrupted model-free UI calls use the selected Runtime's recovery checks, without starting inference. UI calls and model calls share the same implementation of the before/body/after/result pipeline.

## Real run

[REAL_RUN_3.md](REAL_RUN_3.md) records one successful run, five Haiku 5.5 requests. A background child used bash to write `child-note.txt` with marker `m3-cobalt-73`. The parent's first turn had already ended. The job report started its second turn, which described the file, bash and marker. The repeat driver is `python3 scripts/milestone3-real.py bin/modular`; it is deliberately not an offline test.

## Gaps recorded

All entries give the source, missing detail, choice and swap test in `GAPS.md`:

- **G20:** actor identity, rights, grants, revocation and recursive ceilings.
- **G21:** keyed question shape, deadlines, answer replay, responder presence and approval policies.
- **G22:** open-call checkpoints, batch answers and keyed continuation turns.
- **G23:** credential writes, reserved destinations, errors and sanitized forwarding.
- **G24:** job keys, owner recovery, report delivery and usage accounting.
- **G25:** remembered children, depth, forwarding and mixed Runtime/subagent durability.
- **G26:** late model views and conservative navigation/fork/erasure boundaries.
- **G27:** stopping versus closing, shutdown ordering and cross-session copy provenance.
- **G28:** model-free UI execution/recovery, final approval validation and bounded result checks.

These all affect plugins or hosts under the swap test. Concrete Go signatures, file names and journal encoding remain binding choices. The frozen `docs/` snapshot was not changed.

## Declared limits, not skipped acceptance

Approval defaults to off. Interfaces authenticate actors; plugins are trusted in-process code. There are no tenant budgets or external identity service. Cross-actor steering, navigation through unfinished work and erasure during unfinished work are refused. Shell backgrounding by itself is not a managed job. The local working environment is Linux-only and not a filesystem sandbox. Arbitrary replayed hook effects still need plugin-owned idempotency. MCP, ACP, configured plugin trust/loading, full-screen UI and HTTP services remain for later assignments.

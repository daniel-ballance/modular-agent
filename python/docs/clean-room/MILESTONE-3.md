# Milestone 3: questions, jobs and subagents

**Complete. Stop here.** No acceptance item was skipped. Milestone 4 has not been
started. The frozen description was not changed and no helper subagents were used.

## What was built and how to run it

New independently installable plugins: `ma-questions`, `ma-approval`, `ma-jobs`,
`ma-subagents`, `ma-durable-subagents`. All use only the plugin API. The tool router
collects their definitions through its owned `tools.list` hook. The Harness owns
sessions and narrowing authority, not turn loops, inference or tool effects.

```sh
uv sync --python 3.13
uv run modular-agent --runtime durable --subagents durable --project /path/to/project
uv run --offline pytest -q --runtime transient
uv run --offline pytest -q --runtime durable
uv run ruff check .
uv run ruff format --check .
uv build --all-packages
```

The Runtime and subagent variants are independent choices. `delegate` takes a
task, background/wait choice and optional existing child session. A fresh child
gets only its task, project and settings, with authority narrowed by its parent.
The default depth cap is three. Waiting returns through the tool only; background
completion reports as input. Follow-ups create new jobs on the same child history.

Use `/answer ID VALUE` for questions, `/secret ID` for hidden credential-store
intake, `/jobs` to list jobs and `/job_cancel ID` to cancel one. Approval is a
feature plugin, default off. Session setting `approval` supports `ask unless
read-only`, `ask always`, `never ask, refuse`, and `off`.

Interfaces use checked role-bound APIs and bind authenticated actor identities.
`h.api()` is trusted Python embedding code. Secret values go directly from the
Interface to `credentials.answer`; the Runtime cannot access credentials.

## Acceptance evidence

Every item below has offline tests with fake Providers. Real shell commands and
SIGKILL fixtures do not use inference. Shared tests run with either Runtime.

| Item | Observable evidence |
|---|---|
| 1. Recorded keyed input requests | `test_questions.py`: four kinds, first-answer closure, keyed reuse and revoked answer authority. `test_milestone3_recovery.py`: actual SIGKILL with an open question and with an answer already committed. Durable replay reannounces only the unanswered question. |
| 2. Authority | `test_viewer_sees_question_but_cannot_answer_or_escalate`, `test_depth_limit_and_authority_never_widen`, and private Interface API tests. |
| 3. Approval plugin | Parameterized policy tests cover all four policies through checked UI calls. Model calls refuse without an answerer. Edge tests revoke a late allow and mutate already-approved arguments; neither writes a file. |
| 4. ask_user | Scripted model calls ask for text, choice, approval and named secrets, with exactly one tool result. |
| 5. Questions outlasting turns | Timeout leaves a call open without a stand-in result. Unrelated input sees a waiting view. The last answer starts a new turn and real late results arrive in request order. Parallel questions wait for every answer. |
| 6. Secrets | A canary is absent from history, events, model requests and traces, but present in the mode-0600 credential store. Missing names/stores and failed intake do not leak values. Two-parent forwarding propagates only the credential name. |
| 7. Jobs | Real offline child bash survives its starting turn; starts/ends and usage are recorded. Reports start turns, bypass commands and redeliver once after a committed-end interruption. Cancelling the parent leaves jobs running; cancelling a job or closing its session stops child bash. |
| 8. Subagents | Fresh-context isolation, waiting without duplicate reports, follow-up memory, depth and narrowed authority, two-parent questions, and SIGKILL for both variants. Transient loss closes the child's calls/proxies without resuming inference. Durable work continues under either Runtime. Parked child questions survive reopening and can be answered before the child opens. |
| 9. Result checks | A plugin returns a reason to retry, the next model step sees it, and both attempts belong to one turn. Step limits bound this loop. |
| 10. UI-started calls | Calls record Interface initiation and actor. Policies allow/refuse the same effects as model calls. Cancellation stops bash; the model is not called for the UI call. Private low-level operations cannot bypass the gate. |

Primary files: `tests/test_questions.py`, `tests/test_jobs_subagents.py`,
`tests/test_milestone3_recovery.py`, `tests/test_milestone3_edges.py`,
`tests/test_milestone3_audit.py`, `tests/test_milestone3_question_jobs.py`,
`tests/test_milestone3_live_driver.py`.

The audit also proves cross-session erasure: delegated tasks, child answers, job
reports and parent answers have copy references. Erasing an input or question
answer removes its controlled copies from SQLite and open sessions.

## Final tests and flake fixes

**144 tests pass per Runtime, no skips.** This retains the original 91 tests,
adds two deterministic flake regression cases, and adds 51 milestone 3 cases.
The final single-CPU stress run passed 30 full suites per Runtime: **8,640 passing
executions, zero failures**. Logs: `/tmp/ma-m3-release-verified/`.
Lint, formatting, diff checks and all 23 workspace source/wheel builds pass.

The milestone 2 review flake was reproduced under single-CPU stress. Cgroup
removal could precede the process's terminal state; cleanup now waits for both.
Later stress found a separate pre-existing test race: a created PID file could
still be empty when the test cancelled bash. A delayed-publication regression
reproduced it deterministically. Tests now wait for a complete PID line. No test
retries were added. `FLAKE-REVIEW.md` gives commands, failures and root causes.
A deterministic slow-cleanup audit also failed before fixing shutdown handler
ordering: suspension and close now quiesce the Runtime before environment cleanup,
so stopping the process cannot start another model step while commands stop.

No test or real-run command processes or command cgroups remain running.

## Real Haiku run

One attempt on 2026-11-17 UTC, five model requests total, all
`claude-haiku-5-5`, through the official Claude Agent SDK and the existing Claude
Code subscription login. No API key, native Claude tools or native Claude agents.

- Parent: `99e800e0c790469a8a14bed2532a776b`.
- Background job: `816c2a93df1c43cd92ae159ca0e0c7ac`.
- Child: `545dd73f07484ddfbed968f8acd87254`.
- The child's only tool was bash. It wrote `child-proof.txt` with `M3-CHILD-61742`.
- The report started the parent's second turn, whose answer was:

> The child used bash once to write `child-proof.txt` with the text marker `M3-CHILD-61742`.

The parent used delegate, not bash; the child did the write. Every call has one
result. Events, full histories, request accounting, the file and validated summary
are in `/tmp/modular-agent-py-m3-live/`. Later audits used no further inference.
The validator itself has offline positive and negative tests.

```sh
# Revalidate saved evidence without inference:
uv run python scripts/milestone3_live.py --verify-only \
  --output /tmp/modular-agent-py-m3-live
# Deliberately repeat with new inference and a new directory, only if needed:
uv run python scripts/milestone3_live.py --confirm-live --output /tmp/ma-m3-new
```

## Gaps logged during this milestone

Each entry in `GAPS.md` gives its source, missing detail, choice and swap test.

- G23: authority sets, enrollment, revocation and the trusted plugin boundary.
- G24: question keys, signatures, presence, reuse and finite timeout semantics.
- G25: deferred calls, late-result views, branch cancellation and replay.
- G26: direct secret intake, private storage and safe failures.
- G27: job ownership, report redelivery and process stop versus session close.
- G28: delegation schema, depth, follow-ups and independent durability variants.
- G29: forwarding links, credential-name propagation and question-proxy liveness.
- G30: pending-work forks, UI cancellation/recovery, budgets and embedding APIs.
- G31: unattended questions and Interface disconnection.

## Declared boundaries

No acceptance item was skipped. Authentication is the Interface's responsibility;
trusted in-process Python plugins are not sandboxed. Known token usage is checked
between steps, not during an unreported request. Arbitrary external hook effects
are not made exactly-once. Bash background descendants retain their original
lifetime semantics; an explicit subagent job is a separate recorded abstraction.
ACP, external MCP, configured plugin loading, project trust, full-screen UI and
the full multi-process binding belong to later milestones and were not started.

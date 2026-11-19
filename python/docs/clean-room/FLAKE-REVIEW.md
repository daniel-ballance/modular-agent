# Milestone 2 review flake

## Reproduction

Before milestone 3, 30 full offline runs per Runtime passed (5,460 executions).
Pinning the durable suite to one CPU reproduced the failure in 4 of 40 runs:
`test_watcher_and_agent_die_next_start_cleans_up`, with 90 other tests passing.
The isolated test failed in 4 of 30 runs. Logs: `/tmp/ma-m3-flake/`.

```sh
taskset -c 0 uv run --offline pytest -q --runtime durable \
  tests/test_containment.py::test_watcher_and_agent_die_next_start_cleans_up
```

## Cause and fix

Startup sent SIGKILL through `cgroup.kill` and treated successful `rmdir` as
proof that the contained processes had finished exiting. Instrumentation caught
a bash process still in kernel exit with `/proc` state R and zero address space,
even though its cgroup was already removed. No PID was reused and recovery had
not skipped the group. Single-CPU scheduling made that window easier to hit.

Cleanup now snapshots member PID/start-time identities before killing, waits for
those processes to reach a terminal state or disappear, and also waits for group
removal. The start times prevent PID reuse from extending the wait. This is a
completion barrier, not a retry of a failed test or a command. Both manifest and
cross-directory stale-group recovery use it. The normal watcher already reaps
its children before returning.

Source read: https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html
The kernel documents SIGKILL delivery for `cgroup.kill`, not a process-exit wait.

## Regression and verification

`test_cleanup_waits_for_process_exit_after_group_removal` models the exact
boundary deterministically. It failed before the fix and passes after it.
The original failing process test is unchanged. Temporary instrumentation was
removed. Thirty single-CPU full runs per Runtime then passed: 5,520 executions,
92 tests per suite, no failures or skips. No test retries were added.

No new description gap was needed: G20 and G21 already require complete cleanup.

## A second race found during milestone 3 stress

After the audited milestone 3 code reached 142 tests, a 30-runs-per-Runtime
single-CPU pass found one durable failure in
`test_bash_output_live_background_returns_and_cancel_kills_only_foreground`:
141 passed and the PID parse failed on an empty string. Log:
`/tmp/ma-m3-final-audited/durable-9.log`.

This was a test readiness bug, distinct from the kernel-exit barrier above.
Shell redirection creates the PID file before echo writes it. The test watched
only for existence, then cancelled the shell, occasionally killing echo between
open and write. A parameterized version inserts a 50 ms pause in that exact
window; it reproduced the same empty-PID failure deterministically before the
readiness fix. It passes after the fix.

The readiness predicate now requires a complete newline-terminated PID before
cancelling. Crash and new milestone 3 cancellation tests use the same predicate.
This waits for a defined publication boundary, not an arbitrary extra sleep or
retry. The delayed-publication parameter remains as a regression. The complete
suite then contained 143 tests per Runtime, and passed 30 full suites per Runtime.
A later shutdown-order audit added one regression: the final 144-test suite passed
30 single-CPU runs per Runtime, 8,640 passing executions, zero failures or skips.
Logs: `/tmp/ma-m3-release-verified/`. See PROGRESS.md for the complete handoff.

## Milestone 5: do not run whole suites concurrently

An initial four-way parallel release run passed three 210-test configurations
but failed the durable/process watcher-loss test before its explicit next startup.
That test intentionally kills both the working environment owner and its watcher,
then checks that command descendants are still alive before another environment
starts. Every new working environment scans the shared delegated cgroup subtree,
including those started by a different test suite with another history directory.

A controlled reproducer ran only that test while a second process called the real
`recover` every millisecond. It failed at exactly the same assertion in 1.46 seconds.
Removing only that competing cleaner gave eight consecutive passing isolated
runs. No plugin or containment change was needed: early cleanup by another agent
is the required G21 behaviour, not a missed cleanup or a bad watcher selection.
The process-placement test now selects the watcher under the journal's actual
environment-owner PID, not under the Harness PID.

The final release matrix must run its four suites sequentially. The failed
parallel log and deliberate reproducer are retained in `/tmp/ma-m5-release/`;
they are not reported as passes or erased by a retry. The throwaway cleaner was
stopped by its exact PID and removed. This is distinct from the two earlier bugs.

## Round three: one unclassified ACP shutdown timeout

The second shared-plugin release matrix passed 245 cases in each local Runtime,
then process/transient had 244 passes and one failure in
`test_bound_parked_question_uses_extensions_and_pending_update`. Its assertions
finished, but the ACP agent did not exit within the fixture's ten-second shutdown
deadline. The fixture killed and reaped its exact PID. No command groups or plugin
processes remained. Log: `/tmp/ma-plugin-r3/suite-acp-stop-failure.log`.

The case does not enable external plugins. Twelve isolated process/transient
executions passed, about 1.25 seconds each. A complete process/transient suite
with temporary metadata-only asyncio task-stack capture also passed, 245 cases
in 177.10 seconds. No failing stack was captured, so there is no demonstrated
cause and no timeout-specific code fix. This is not labelled a fixed flake.

After removing the instrumentation, the full process/transient and process/durable
runs passed 245 cases each in 177.34 and 179.75 seconds. The final local results
are 245 each in 68.11 and 73.82 seconds. No test-level retries or skips were added.
Diagnostic logs and task metadata remain in `/tmp/ma-plugin-r3/`; the temporary
sitecustomize probe was removed. A next investigation should capture the pending
parent and worker tasks before the fixture kills a timed-out ACP agent. Do not
attribute the failure to the new binding, to the old private binding, or to load
without a reproducible failing boundary.

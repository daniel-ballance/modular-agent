# Milestone 2: the swap test

Completed on 2026-11-17 UTC. No milestone 3 work was started.

## Built and how to run

`ma-durable` is a separate installable Runtime package. It provides the same
capability and hooks as `ma-runtime`. Only the chosen Runtime changes when it is
swapped. The existing Provider, tools, context, configuration, history, guardrail
and Interface work with either one.

```sh
uv sync --python 3.13
uv run --offline pytest -q --runtime transient
uv run --offline pytest -q --runtime durable
uv run ruff check .
uv run ruff format --check .
uv build --all-packages

uv run modular-agent --runtime durable --project /path/to/project -p "Do the work"
# Reopen and resume without giving the model another input:
printf '' | uv run modular-agent --runtime durable --session SESSION_ID --mode json
```

The default Runtime remains transient. Reopening there fails an interrupted turn
and settles its calls instead of carrying it on.

Local bash requires Linux cgroup v2 delegation, available on this machine without
sudo. The default subtree is under `user-UID.slice/user@UID.service`.
`MA_CGROUP_ROOT` can name another delegated subtree. Commands fail before starting
if containment is unavailable. File tools remain available. This is a lifetime
mechanism, not a security sandbox against hostile same-user programs.

## Offline acceptance evidence

**91 tests pass with the transient Runtime. The same 91 tests pass with the durable
Runtime, 182 passing executions total, no skips.** The original 58 tests remain in
the suite. Every test uses a fake Provider or a replaced SDK client, never inference.
Lint, formatting and all workspace source distributions and wheels also pass.

| Acceptance item | Evidence |
|---|---|
| 1. Durable Runtime replaces transient without other plugin changes | `test_runtime_is_only_plugin_changed_and_hooks_survive_replacement` retains the same other plugin objects, replaces Runtime through the plugin API, reopens the same session, checks the refreshed plugin list and runs it through the unchanged hooks. |
| 2. Same suite with either Runtime | Both full pytest commands above pass. The fixture, subprocess CLI tests and replaced-SDK tests choose the requested Runtime. Restart assertions select the declared transient or durable behaviour. |
| 3. Crash recovery and one result per call | `test_sigkill_at_committed_boundaries` actually kills an agent process at eight boundaries: turn start, model intent, committed response, call admission, safe read effect, unsafe bash effect, finished-tool receipt and step end. Calls and results pair exactly once. Transient turns fail; durable turns keep their identity and finish. Safe reads run again, never-started writes run, completed writes do not repeat, and interrupted bash gets an unknown result that the next model request sees. |
| 3. Conservative recovery edge cases | `tests/test_recovery_edges.py` checks old and current safety declarations, missing declarations, environment cleanup, later parallel completion receipts, preserved step limits, repeated recovery admission, gates run again and unknown native Provider effects refused rather than repeated. |
| 4. Command lifetime | `tests/test_containment.py` kills the agent during an active command and checks escaped descendants. Another test stops the watcher, kills both agent and watcher, proves the commands are still alive, then starts an agent with a different data directory and proves cleanup finishes. Background double-fork/setsid children, timeout cleanup, live-owner isolation and missing delegation are covered. Existing cancellation and normal-close tests still pass. |
| 5. Parallel calls really overlap, ordered results | `test_tool_overlap_ordering_and_mixed_step_exclusion` uses a barrier requiring two active calls together. The fast call finishes first, while model-visible results stay slow then fast. Entirely sequential and mixed-permission steps have a maximum of one active call. Parallel cancellation joins all calls and records one cancelled result each. |

The Runtime stores model response and full call list together, so a crash halfway
through individual call admission is repairable without another model request.
Hidden completion receipts preserve out-of-order tool finishes before ordered
results are published. Every copied journal payload participates in erasure.

No test or real-run command process or cgroup was left behind. No process was
killed by a name pattern. Cleanup tests kill only recorded PIDs; the live driver
also uses stable pidfd references for captured transport descendants.

## Real Haiku run

Only `claude-haiku-5-5`, through the official Claude Agent SDK and the existing
Claude Code login, was used. There was no API key or native Claude Code tool work.

Successful session: `de8c4d3ac0cd44f2a815b8bc697a3b96`.
Same turn before and after restart: `a05016e67da7450cbc5099e1a898cbdf`.
Logs and SQLite history: `/tmp/modular-agent-py-m2-live-verified/`.

1. At 03:15:49 UTC Haiku requested bash to write `M2-RECOVERED-5831` to
   `proof.txt`, print a marker and sleep for 90 seconds. Bash PID was 766520.
2. The driver executed `kill -9` against the recorded agent PID during that call.
   The agent returned -9. The driver's pidfd check proved the command stopped
   before it performed any optional transport cleanup.
3. A new CLI process opened that session with the durable Runtime, with stdin
   closed and no new prompt. At 03:15:51 the interrupted bash received one result:
   `outcome_unknown`, with this model-visible content:

   > Call did not finish. Its outcome is unknown. Check outside state before relying on it.

4. Haiku used `read` on `proof.txt`, then made another read-only check of
   `bash.pid`. Both completed. It did not call bash again.
5. At 03:15:54 the same turn completed. Its answer was:

   > `proof.txt` contains `M2-RECOVERED-5831`.
   >
   > The bash call's outcome is still unknown, though. That text was written at
   > the start of the command, before the `sleep 90`, so the file shows the command
   > got that far but not that it finished. `bash.pid` contains `766520`, which
   > shows the command did start. I didn't rerun the command.

There were four model requests in this successful demonstration. The call/result
statuses were `bash: outcome_unknown`, `read: completed`, `read: completed`.
There was exactly one turn start and one turn end across both processes.

### Driver corrections and request accounting

An initial attempt at 03:14 UTC reached bash but the demonstration driver found
that this Python build omits optional `os.pidfd_open` and
`signal.pidfd_send_signal` wrappers. Its finally block killed the agent, and
command/transport EOF cleanup left no processes behind. That attempt used one
model request and is retained under `/tmp/modular-agent-py-m2-live/`.

The driver now uses the machine's glibc pidfd functions, with an offline
regression and a platform preflight before inference. The successful second
attempt completed the real turn, but the driver's final checker initially
expected exactly one read. Haiku's extra read-only check made that checker too
strict. The checker was corrected and tested offline, then the saved logs were
validated without another model run. This older successful run has event logs
but predates the driver's separate process-observations JSON file.

Total for milestone 2: **five model requests, three CLI invocations, two sessions**.
Only one completed recovery demonstration was needed. Nothing was silently
retried against another model.

To repeat deliberately with a new output directory:

```sh
uv run python scripts/milestone2_live.py --confirm-live --output /tmp/ma-m2-new
```

To validate the existing evidence without inference:

```sh
uv run python scripts/milestone2_live.py --verify-only \
  --output /tmp/modular-agent-py-m2-live-verified
```

## Gaps logged

All entries include sources, the missing detail, the choice and the swap test.

- G17: recovery journal, call admission, hook replay and recovery scheduling.
- G18: replay authorization from safety hints and interrupted Provider requests.
- G19: parallel admission, ordered results and out-of-order completion receipts.
- G20: Linux containment prerequisites, escaped processes and watcher loss.
- G21: cleanup across data directories, stale ownership and PID reuse.
- G22: the active plugin composition when a session is reopened.

G06's milestone 1 limitations are superseded by G19 and G20. The frozen description
was not changed. No other implementation or its state directory was read.

## Skipped and boundaries

No milestone 2 acceptance item was skipped. Arbitrary external hook effects are
not made exactly-once; G17 records replay expectations. Unsupported cgroup
platforms get an explicit failure rather than a false crash-cleanup promise.
Questions, approvals, jobs, subagents, ACP, external MCP and plugin process
transport remain for later milestones. Stop here.

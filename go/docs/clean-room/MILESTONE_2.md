# Milestone 2 acceptance evidence

All five items are complete. All automated tests are offline and use the fake Provider wherever a model is involved. No milestone 3 work was started.

## Build and verify

```sh
mise exec -- go build -o bin/modular ./cmd/modular
mise exec -- go test -count=1 ./...
mise exec -- go test -race -count=1 ./...
mise exec -- go vet ./...
```

Final suite: 51 top-level tests and 116 subtests, all passing. Build, vet, race checks and `git diff --check` pass. Subprocess tests kill only controlled PIDs, wait for their children, and reap orphaned supervisors. No command processes remain after the suite.

## Acceptance map

| Item | Implementation and offline proof |
|---|---|
| 1. Durable Runtime replaces transient, without other plugin changes | `durable.Plugin()` implements the same `api.Runtime` and standard hooks using the shared `turnrun` protocol. `vanilla/swap_test.go`, `TestDurableReplacesOnlyRuntimeAndKeepsFeatureHandlers`, explicitly replaces the loaded transient plugin while preserving the existing context and feature handlers. It reads a file, answers through the unchanged plugins, and verifies `/support` declarations. |
| 2. Same tests with either Runtime | `internal/runtimetest` parameterizes 21 existing plugin-facing top-level tests. They exercise file tools, turn outcomes, call identity, cancellation, queued input, settings, commands, prompt, context compaction, overflow recovery, erasure, guarded output, terminal modes and executable restart. Four additional common suites cover intake recovery, navigation, parallel batches and actual SIGKILL recovery. Pure plugin/store/Provider tests still run unchanged. |
| 3. Crash recovery and exactly one result | `turnrun/recovery_test.go`, `TestRuntimeSIGKILLRecovery`, kills a real process at ten boundaries with each Runtime: turn start, step start, model commit, call-list commit, safe outside effect, unsafe outside effect, result commit, continuing checkpoint, final model commit and final checkpoint. The transient variant makes no new model request or outside effect, repairs requested calls and fails. The durable variant preserves the turn identity, runs never-started work, repeats the safe interrupted effect, does not repeat the unsafe one, keeps saved results, and continues. The next model request contains the explicit unknown-outcome warning. Counts, accumulated usage, result uniqueness and inert second reopen are checked. |
| 4. Commands cannot outlive agent | `local/crash_test.go`, `TestSIGKILLStopsForegroundEscapedAndBackgroundCommands`, uses a fake Provider and real bash commands. It SIGKILLs the agent with foreground and setsid descendants, including commands left in the background after their shell and turn finished. It also kills the supervisor itself and reopens its registry, and separately stops the supervisor, kills the agent, proves abandoned work is still present, and verifies that startup kills it before recovery. All controlled host PIDs are gone and reaped. Ordinary live-output, cancellation and background-return tests remain passing. |
| 5. Parallel calls really overlap, ordered results | `turnrun/parallel_test.go`, `TestParallelBatchesOverlapAndCommitInRequestOrder`, uses barriers rather than elapsed-time guesses. Both bodies must enter before either is released. The second finishes first, but cannot commit ahead of the first. Checks, after hooks and saved results keep request order. A mixed batch proves sequential fallback. Both Runtimes pass. |

`cmd/modular/crash_test.go` independently kills the compiled executable during live bash output, then starts a new executable with the durable Runtime, fake Provider and no prompt. It checks the same turn identity, a single unknown result, successful continuation and no repeated command effect.

## Additional recovery safety

`turnrun/declarations_test.go` proves that an interrupted call is not repeated if either safety declaration is absent, the working environment cannot guarantee cleanup, or the tool disappeared. Interrupted stateful and Provider-tool-running model requests fail without being resent. Receipt keys, input already taken, queued steering, steering taken after a saved response, and queued follow-ups survive reopen according to the declared Runtime behavior. The active plugin list reflects the new composition.

`turnrun/navigation_test.go` proves that moving or forking into a partial turn is refused before changes and cannot turn old effects into crash recovery. It also checks that panicking event observers cannot interrupt recorded execution.

## Real model run

See [REAL_RUN_2.md](REAL_RUN_2.md). At 2026-11-17 03:11 UTC, only Haiku 5.5 was used. The first agent was killed with SIGKILL after live output from a bash command that was sleeping before a file write. A new process reopened with `--runtime durable --session ID --mode json`, without new input. The unsafe call got unknown. Haiku inspected files and completed the same turn without rerunning it. One start, one end, three requests, three steps and three calls with one result each.

```sh
bin/modular --runtime durable --project /path/to/project --mode print --prompt 'Read README.md.'
bin/modular --runtime durable --session SESSION_ID --mode print
```

The explicit real-run driver is `python3 scripts/milestone2-real.py bin/modular`. It never reads the key itself and is not part of the test suite.

## Gaps logged

- G15: recovery boundaries, safety declarations and active plugin composition.
- G16: replayed hooks and plugin-owned idempotent outside operations.
- G17: all-parallel batches, mixed sequential fallback and ordered hooks/results.
- G18: Linux namespace command lifetime, registry cleanup and platform/PID/group limits.
- G19: intake/steering recovery and refusing partial-turn navigation.

Earlier G04, G07 and G08 now point to the relevant milestone 2 decisions. Frozen `docs/` was not changed. No other builds or `~/.modular-agent` were read.

## Skips and limits

No milestone 2 acceptance item or real run was skipped. Linux unprivileged user/PID namespaces are required for bash; there is no weaker cleanup fallback. Shell PIDs are namespace-local and supplementary groups are unavailable. Files remain local, not sandboxed. Hook-owned outside work must be idempotent and recorded by its plugin. Partial-turn moves/forks are explicitly refused. Questions, approvals, managed jobs, subagents and all later milestone work remain unstarted.

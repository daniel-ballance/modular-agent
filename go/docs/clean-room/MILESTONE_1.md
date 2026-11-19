# Milestone 1 acceptance evidence

Milestone 1 is complete. No acceptance item was skipped. Later milestones were not started. All acceptance tests use the scripted fake Provider. The real Anthropic adapter is tested separately against a local HTTP server, and the required real run is recorded in `REAL_RUN.md`.

## Offline proof

| Acceptance item | Public tests and evidence |
|---|---|
| 1. Plugins | `harness/plugins_test.go` covers new capabilities and hook points, all five rules, first/normal/last order, owner-only invocation, conflict refusal and deliberate replacement. `harness/audit_test.go` proves a later guard cannot be bypassed and other plugins' handlers survive replacement. `vanilla/plugins_test.go` exercises tool-input changes and failure handling through actual plugins. |
| 2. Providers | `transient/runtime_test.go` drives real turns with a scripted fake. `anthropic/provider_test.go` checks authentication, the restricted catalog, streamed responses and tool input, usage and failures without network access. `credentials/file_test.go` proves credentials are read on demand and refreshed, not cached. Runtime turn ports expose no credential store or model selection operation. |
| 3. Transient Runtime | `transient/runtime_test.go`, `input_test.go` and `identity_test.go` prove steps, exactly one result for every call, invalid tools, step limits, model failures, cancellation and reused Provider references. `vanilla/plugins_test.go` proves a post-tool hook failure still settles the rest of the batch. |
| 4. Tools and working environment | `local/local_test.go` checks project-relative files, output arriving before command exit, cancellation and background-shell return. `local/cleanup_test.go` verifies shutdown removes the tracked background PID. `transient/input_test.go` uses all four tools. The executable restart test opens from a different project and checks that the original project still supplies tools and history. |
| 5. History | `history/store_test.go` checks disk restart, idempotent saves, immutable records, lazy unused sessions, project filters, cross-process writer exclusion and erasure. `history/ownership_test.go` proves process death releases a writer lease. `harness/sessions_test.go` checks position moves, forks, restart and provenance. `commands/commands_test.go` shows that merely reading settings leaves no file. `cmd/modular/main_test.go` reopens the compiled executable in new processes. |
| 6. Context management | `contextview/context_test.go` covers automatic compaction, overflow retry, manual compaction, summary failure and intact originals. `audit_test.go` checks compacted forks and the single-retry bound. `steps_test.go` shows that earlier steps of one long turn can be summarized without breaking retained tool pairs. |
| 7. Prompt, model, thinking, settings, credentials | `commands/commands_test.go` proves global/project precedence, project instructions in the actual model request, settings-only sessions, slash model/thinking changes and no inference for those commands. Credential tests and Provider request tests cover the credential-store boundary. |
| 8. Input during a turn | `transient/input_test.go` checks steering, follow-ups, withdrawal, duplicate keys, cancellation returning both queues, and prior background work continuing after cancellation. `commands/commands_test.go` and `cmd/modular/main_test.go` prove keyed receipts survive restarts. Managed jobs belong to milestone 3; bare shell background work is the milestone 1 lifecycle stand-in. |
| 9. Output gate | `guardrail/guardrail_test.go` splits a secret across pieces, checks gated events, outcomes and history views, and verifies raw history is intact. `audit_test.go` covers streamed tool input and failed attempts. |
| 10. Erasure | `history/store_test.go` follows copies through summaries and forks. `harness/sessions_test.go` reloads affected open sessions. `harness/audit_test.go` verifies intake aliases and cached outcomes cannot retain erased content. |
| 11. Terminal Interface | `terminal/terminal_test.go` covers interactive lines, one-prompt print mode and JSON events. `cmd/modular/main_test.go` tests the built program across processes. |
| 12. Commands | The settings, model, thinking, history and manual compaction tests exercise plugin-registered commands. Unknown commands fail rather than reaching the model. Model-input keys do not silently apply to slash-command side effects. |

## Checks

```sh
mise exec -- go build -o bin/modular ./cmd/modular
mise exec -- go test -count=1 ./...
mise exec -- go test -race -count=1 ./...
mise exec -- go vet ./...
```

Final result: 42 top-level tests, plus 15 subtests, all passing. The race detector and vet also pass. Tests leave no command processes behind. No external Go dependencies are used.

The final audit added regression tests for gate short-circuiting, replacement handlers, erasure aliases and outcome caches, forked compaction references, retry bounds, streamed tool input, duplicate Provider IDs, tool-hook failures and cleanup. All found issues were fixed.

## Real run

Two processes, one session, three Haiku 5.5 requests total. Process 1 read a fixture and answered that the calibration word was cerulean and the telescope count 7. Process 2 reopened the session and answered cerulean and 14 without rereading. Both exited successfully. See `REAL_RUN.md` for exact commands and usage.

## Description gaps

All 14 gaps are in `GAPS.md`, each with sources, the missing detail, this build's choice and the swap test:

1. API shapes and wiring.
2. Capability conflicts, scope and replacement.
3. Hook rules and owner identity.
4. Position moves and forks, including plugin metadata.
5. Compaction policy and retry limits.
6. Steering timing, keys and cancellation.
7. Bare shell background work before managed jobs exist.
8. Settings timing, limits and malformed calls.
9. Erasure coordination, aliases, provenance and physical scope.
10. Prompt, configuration and command conventions.
11. Output holding, flush boundaries and recipient views.
12. Local call identities versus Provider references and opaque content.
13. Tool semantics and terminal input policies.
14. Commands bypassing agent turns versus auxiliary inference for `/compact`.

## Not included

Nothing from milestone 2 or later: durable resumption, hard-crash command cleanup, parallel calls, questions, approvals, managed jobs, subagents, ACP, MCP, configured plugins and HTTP services remain unbuilt. Rewind and several actors are declared unsupported. The local working environment is not a sandbox. Keyed slash commands are refused. These limits are explicit rather than silent fallbacks.

# Round two: shared bindings

Both assignments are complete. No real inference was needed or run. The frozen description, shared binding files and ACP kit source were not changed. No other build was read and no subagents were started.

## Results

- ACP kit: **43/43 checks** with transient and durable Runtimes, using the supplied official client kit unchanged.
- Go suite: **125 top-level tests and 323 subtests**, all passing both normally and with `-race`.
- Both executables build. `go vet ./...` and `git diff --check` pass.
- The suite includes the kit against a race-instrumented executable with both Runtimes. Node dependencies are a one-time prerequisite, not downloaded during tests.

```sh
mise exec -- go build -o bin/modular ./cmd/modular
mise exec -- go build -o bin/modular-service ./cmd/modular-service
(cd conformance/acp && npm ci)
node conformance/acp/run.mjs -- "$PWD/bin/modular" --mode acp
node conformance/acp/run.mjs -- "$PWD/bin/modular" --mode acp --runtime durable
mise exec -- go test -race -count=1 ./...
```

Evidence from this round is in `/tmp/modular-go-bindings-tests.jsonl`, `/tmp/modular-go-bindings-race.jsonl` and `/tmp/modular-go-acp-conformance-{transient,durable}.log`.

## ACP coverage

`acpinterface/` follows `modular-agent-acp/1`. Initialization and session responses carry the full declaration in the required metadata namespace. Model names, selectors, prompt keys/receipts/outcomes, stop reasons, permissions, tool updates, questions, cancellation and extension DTOs use the binding.

`cmd/modular/conformance_test.go` runs the kit and proves data-directory isolation, credential-free startup even with unusable gateway flags, and remote-history reopening with persistent keys. `conformancemodel/echo_test.go` covers echo/tool/result behavior, Unicode truncation, ignored old tool results and zero usage.

Additional ACP tests cover failed/output-limited/step-limited turns, handed-back input on cancellation and keyed retries, pending open calls, answers without forms and after a turn, unforgeable actor identity, next-turn approval/model/thinking changes, branch/all history, fork/move/erase/jobs, and output gating. Existing MCP, authority and crash/recovery tests remain in the suite.

See [HOSTS.md](HOSTS.md) for the exact agent launch, metadata, extensions and state layout. The process still serves one configured canonical project, declared as projectRoot; see gap B4.

## History coverage

`historyhttp/` follows `modular-agent-history/1`. Its service stores opaque JSON without interpreting private Go state or copy links. The Go adapter checkpoints mutable metadata separately from native entries and computes erasure closure itself.

| Binding requirement | Proof |
|---|---|
| Bearer auth, version, paths, bodies, errors/statuses | `TestHistoryBindingContract` |
| Session resend/project conflict, metadata, project filtering, newest-first, unused sessions, cursors | `TestHistoryBindingContract`, `TestSharedStorePersistenceAndErasure` |
| Same-owner lease resend, other-owner refusal, renew/release, expiry and restart fencing | `TestHistoryBindingContract`, `TestLeasesRetriesAndFencing` |
| Atomic batches, skipped duplicates, conflicting IDs, reordered keys, numeric equality, opaque fields | `TestHistoryBindingContract` |
| Lost committed answers resent without duplicate effects | `TestLeasesRetriesAndFencing`, `TestClientAgainstBindingPeer` |
| Client uses only shared paths/shapes, millisecond TTLs, stops writing after loss without reacquiring | `TestClientAgainstBindingPeer` |
| Lease expires while an upload arrives; no late writes | `TestLeaseIsCheckedAfterSlowRequestBody` |
| Erasure requires another owner's token, remains idempotent and scrubs disk; service does not follow copies | `TestHistoryBindingContract` |
| Agent follows copy closure and refuses affected foreign leases | `TestSharedStorePersistenceAndErasure` |
| Multi-process service/agent death and takeover with both Runtimes | existing `cmd/modular-service/process_test.go` tests |

See [SERVICES.md](SERVICES.md) for fixed-port service startup, token files and agent URL/token flags. Use a fresh service state folder: the old private service snapshot format is not migrated. This binding makes services interchangeable, not language-private session contents.

## Binding gaps

`GAPS.md`, under Bindings, records every choice and swap test:

- B1: mutable agent metadata over opaque append-only entries; private session encoding.
- B2: lazy creation when Acquire knows only an ID, not a project.
- B3: malformed requests, unknown erase IDs, numeric equality, replay after erasure, restart tokens and per-session erasure atomicity.
- B4: launch-scoped project trust and initialization/session declarations.
- B5: DATA_DIR precedence and project settings, echo-only credential-free startup and Unicode characters.
- B6: branch cursor scope, late questions, answer/limit types, unreachable effects and durable cancellation receipts.

No required operation was omitted. B4's one-project-per-process restriction is retained rather than weakening project trust. Cross-session erasure is preflighted but cannot be transactional through the specified per-session service API. These limits are explicit rather than hidden by the conformance result.

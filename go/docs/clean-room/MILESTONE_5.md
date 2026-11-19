# Milestone 5 acceptance evidence

All required parts-as-services items are complete. Every item has offline proof. The real run used only `claude-haiku-5-5` through Anthropic, with only the gateway reading the key. No subagents were started to implement this milestone, and no T3 settings were changed. The frozen description was not edited.

## What was built

- `historyhttp`: authenticated history service and normal history-capability plugin. Several agent processes share it. Renewable expiring leases, opaque fencing tokens, immutable synced snapshots and keyed acquisition/save retries.
- `environmenthttp`: authenticated sandbox service and normal working-environment plugin. Rooted file APIs and private per-agent Bubblewrap workers, with live command output, cancellation and lifetime-bound cleanup.
- `gateway`: authenticated Provider catalog/model-access service and plugin. Only gateway role installs the real Anthropic Provider and credential store. The agent gets no model credentials and has no credential-store capability.
- `agenthttp`: authenticated host Interface plugin, with sessions, input, answers, cancellation, support, settings, UI calls, commands, navigation, jobs, erasure and reconnectable gated record following.
- `cmd/modular-service`: one independently launched service role per process. `cmd/modular` keeps its terminal and ACP Interfaces, now requiring a gateway for real inference. Offline scripts still work.

`SERVICES.md` documents every HTTP API, its retry rules, credentials, launch commands and limits. Build with:

```sh
mise exec -- go build -o bin/modular-service ./cmd/modular-service
mise exec -- go build -o bin/modular ./cmd/modular
```

Launch four copies with `--role history`, `environment`, `gateway` and `agent`, as shown in `SERVICES.md`. Tokens come from private files, never from model keys or command-line credential bytes. The standalone listeners are loopback-only.

## Offline proof

| Binding item | Tests and observed behavior |
| --- | --- |
| Shared history and exclusive ownership | `historyhttp.TestLeasesRetriesAndFencing`, `TestSharedStorePersistenceAndErasure` and `cmd/modular-service.TestSeparateServicesOwnershipSIGKILLAndRecovery`. Two real agent processes hold distinct sessions at once; the second is refused for the first's session. Explicit release permits takeover. Killing the first permits takeover after bounded expiry. |
| Lost history answers are harmless | `TestLeasesRetriesAndFencing` serves each first keyed mutation into a response recorder, then drops the actual TCP answer after the work. Acquisition, saving and release retry successfully, without duplicate entries. `TestExpiredWireTokenCannotReviveOrOverwriteNewWriter` sends stale wire tokens after expiry, verifies refusal, and verifies that a delayed successful-save retry cannot roll back newer settings. |
| Rooted sandbox | `environmenthttp.TestSandboxPathsCommandsAndLifetime` checks normal file operations, outside absolute paths, traversal and outside symlinks. Shells cannot see an outside host file, outside symlink target or inherited environment. The folder is the only writable host storage; runtime binaries are read-only, and virtual filesystems/network are private. |
| Live commands and cleanup | The same test sees output before command completion, cancels a command with escaped descendants, and closes the agent lifetime connection after a returned background shell. Marker files stop growing. The executable process test sends agent SIGKILL during foreground and `setsid` loops, then separately kills the environment service during a UI command. Commands stop and lost effects receive unknown results. Existing local SIGKILL/supervisor-loss tests still pass. |
| Gateway owns credentials | `gateway.TestOnlyGatewayHasModelCredentials` uses a dummy-key local vendor server. Only the gateway-side Provider gets the dummy key. Agent capability lookup for credentials fails, and its history contains no key. Other gateway tests preserve streaming, state/tool declarations, errors, cancellation and unknown outcomes after lost answers, with exactly one vendor attempt. |
| HTTP agent host | `agenthttp.TestHTTPHostKeyedInputReplayAnswersAndCancel` drops an input answer after committing intake, then retries the same key and receives the original receipt. Questions are answered, turns cancel, and reconnect from an exclusive entry cursor includes every later record. `TestHTTPGateAndApprovalPresence` proves gated outcomes/live/replay records, fail-closed approval with no follower, a follower-approved UI call, and no inference for that call. Both run with each Runtime. |
| Services really separate | `cmd/modular-service.TestSeparateServicesOwnershipSIGKILLAndRecovery` builds and launches history, environment, fake gateway and two agent executables. It drives only HTTP, checks a sandbox file effect, transfers ownership, retries input across agents, kills an agent mid-call and reopens with each Runtime. Transient repair fails the interrupted turn; durable recovery continues it without repeating the unsafe command. |
| Authentication and transport | Wrong-token calls fail at each service/host boundary. `servicehttp.TestTransportRetriesOnlyDeclaredKeyedOperations` verifies no unkeyed automatic retry, stable keyed retry, refused redirects and refused non-loopback plaintext URLs. |

Final suite: **114 top-level tests and 296 subtests, all passing**, with ordinary and race checks. This adds 13 top-level tests and 6 subtests over milestone 4. Existing secret tests now explicitly install their dummy credential-store fixture; production agent composition no longer installs one. Assertions and secret-routing behavior are preserved.

```sh
mise exec -- go test -count=1 ./...
mise exec -- go test -race -count=1 ./...
mise exec -- go vet ./...
git diff --check
```

New in-process service tests were also repeated five times under the race detector. Evidence: `/tmp/modular-go-m5-tests.jsonl` and `/tmp/modular-go-m5-race.jsonl`. The executable tests build race-instrumented service binaries, use only fake inference, stop exact process handles and wait for them. No command/service processes remained after final checks.

## Real run

2026-11-17, 06:23 UTC. Four separate processes, one session, two short model requests and one remote `read` call. The HTTP host received:

> The marker is m5-jade-47, and twice its count is 34.

Both facts came from the sandbox file, not the prompt. Retrying the same input key returned the same receipt with `Duplicate=true`, without another turn or model request. Reconnecting from an entry cursor returned all seven later recorded entries in order. All four processes stopped cleanly. See `REAL_RUN_5.md` and `/tmp/modular-go-m5-real.rjaw9z0v`.

The explicit driver is `python3 scripts/milestone5-real.py`. It is never part of offline tests and never reads the Anthropic key.

## Gaps logged

- G32: remote history ownership, expiry/fencing, retry scope, erasure coordination and service authentication.
- G33: sandbox exposure, path/symlink rules, backgrounding, remote lifetime and namespace-correct `/proc`.
- G34: moving credentials with the Provider, model-access streaming, failure classification and unknown requests without transport retries.
- G35: HTTP host identity, record cursors, replay/live coverage, responder presence and acknowledgement retry scope.

Each entry names its description source, the missing point, the chosen behavior and the swap test. No milestone 5 acceptance item was skipped. Multi-tenant identity, resource quotas, arbitrary remote project mapping and production deployment hardening were not requested; their limits are declared. The only optional acceptance omission in the whole build is milestone 4's full-screen terminal UI.

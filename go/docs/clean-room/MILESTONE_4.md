# Milestone 4 acceptance evidence

Milestone 4 is complete. The optional full-screen terminal UI was skipped. Every required acceptance item is proven. Milestone 5 was not started.

## Build, run and test

```sh
mise exec -- go build -o bin/modular ./cmd/modular
mise exec -- go test -count=1 ./...
mise exec -- go test -race -count=1 ./...
mise exec -- go vet ./...

# Have an ACP client launch this command, with protocol traffic on stdio:
bin/modular --project /path/to/project --runtime durable --mode acp

# Explicitly enable that project's plugins and plugin options:
bin/modular --project /path/to/project --trust-project --mode acp
```

Final suite: **101 top-level tests and 290 subtests, all passing**. This adds 22 top-level tests and 68 subtests to milestone 3. All Runtime-facing milestone 4 cases use both Runtimes. Race checks, vet, build and `git diff --check` pass. The ACP and MCP protocol tests were also repeated ten times before the final additions and final full-suite checks.

Tests make no real inference requests and do not read the experiment key. They use the fake Provider, official SDK MCP servers on loopback HTTP or subprocess stdio, and the maintained ACP client library. Tests own, close and join their subprocesses. Local HTTP servers close after their MCP clients. JSON evidence is `/tmp/modular-go-m4-tests.jsonl` and `/tmp/modular-go-m4-race.jsonl`.

## Acceptance items

1. **ACP Interface.** `cmd/modular/TestExecutableACPClientLibraryAndReopen` launches the built executable through the ACP client library's stdio transport. It initializes, creates a session, changes approval, prompts the fake Provider, handles a permission request, receives tool and message updates, then starts a new process, loads history and continues from it. It runs with each Runtime.

   `acpinterface/TestACPLifecycleConfigReplayAndKeys` proves explicit declarations, model/thinking selectors, invalid value refusal, create/list/load/resume/close, load replay and no replay on resume, recorded host identity, keyed deduplication and reconnect follow from an entry cursor. It refuses unattached sessions, foreign project roots and unsupported extra roots. `TestACPModelChangesDuringGenerationApplyNextTurn` accepts model/thinking changes while generating, without changing the active turn's selection. `TestRecoveryKeepsRecordedModelAfterNextTurnConfiguration` proves the old selection survives interrupted-turn recovery while the next turn uses the new one.

   `TestACPPermissionsAndElicitation` covers explicit allow, refusal, cancellation, invalid permission IDs, free text and choice forms, and refusal to put secrets in forms. `TestACPUnsupportedElicitationDeclinesAndValidates` covers absent form support, decline, cancel, wrong types and choices. `TestACPCancelAndGate` and `TestACPCancelsOutstandingPermission` cover cancelling generation and outstanding reverse requests. `TestACPOutputGateCoversStreamReplayAndDuplicate` checks split-secret redaction across streamed output, full-record follow, load replay and duplicate outcomes while raw history stays intact. `TestACPHostInputSteeringAndWithdraw` proves the declared host extensions for steering, queued intake and withdrawal.

2. **MCP tools.** `mcptools/TestMCPTransportsAnnotationsResultsAndScope` uses actual subprocess stdio and Streamable HTTP with both JSON and SSE response framing. It checks read-only, destructive, idempotent and open-world hints, conservative defaults, structured results, non-text content, errors and private session scope. Session close removes its tools and terminates and joins its stdio server. `TestConfiguredMCPServersServeEverySession` loads a server from settings, drives its tool through the fake Provider, and proves that closing one session leaves the shared server available to another. `TestMCPListChangesAndCancellation` proves refreshed tool lists, live progress and cancellation. Failed attachments roll back without publishing partial tools; invalid names and closed sources cannot launch programs.

   `acpinterface/TestACPMCPClientServersAreSessionScoped` passes an HTTP server over ACP, drives its tool with the fake Provider, and proves another session cannot call it. `TestACPClientStdioServerSettings` does the same through ACP-provided stdio settings, including arguments and environment values. These run with each Runtime.

3. **Plugins from settings.** `configuration/TestConfiguredPluginsTrustAndOptions` loads named factories with options from global and project files, verifies deterministic merging, and invokes the installed command without inference. The default compiled catalog offers `guardrail` and `mcp`; Go compositions can register additional factories. Unknown factories, duplicate entries and malformed trusted options fail startup. `TestConfiguredPluginFailuresAndGuardrail` also proves a configured guardrail affects a fake model turn with each Runtime.

4. **Project trust.** The same trust matrix proves that global plugins load, project-only plugins and project overrides do not apply without explicit trust, and project model defaults still apply without trust. `TestUntrustedPluginDataIsNotDecoded` proves even malformed executable plugin data is ignored until trust is granted. A canonical project boundary rejects cross-project sessions before opening or creating them, preventing trusted registrations from leaking. Trust is an invocation flag, never inferred from repository files or granted over ACP.

5. **Optional full-screen terminal.** Skipped to keep the scope focused on the required host and protocol work. The existing line, print and JSON Interfaces remain available and their tests still pass. No required acceptance item was skipped.

## Real run

[REAL_RUN_4.md](REAL_RUN_4.md) records a successful ACP client-library run using two Haiku 5.5 requests. The client set ask-always, approved a read over ACP, received live tool and message updates, and got the correct file marker and doubled count. Resending the keyed prompt started no additional turn. The deliberate driver is `scripts/milestone4-real.go`.

## Gaps logged

Every entry gives the description source, missing detail, decision and swap test in `GAPS.md`:

- **G29:** configured plugin discovery, compiled factories, option merging, explicit project trust and fixed canonical process project scope.
- **G30:** MCP naming, annotation defaults, rich results, connection failure behavior, shared versus session ownership and process lifecycle.
- **G31:** stable ACP v1, local host identity, declarations, configuration boundaries, permission and elicitation translation, secret refusal, replay, keyed outcomes and host extensions.

All three affect hosts or plugins under the swap test. Concrete JSON fields, extension names and Go APIs are binding choices. Frozen `docs/` was not changed.

## Limits

One configured process serves one canonical project. Launch another process for another root. Plugins are trusted code with the agent's permissions, not sandboxed packages; the catalog does not download source or load Go shared objects. ACP does not collect secrets in forms, perform OAuth sign-in, use client-owned files or terminals, support client system prompts or extra roots, or implement draft ACP v2. Model/thinking changes take effect next turn; approval and limit changes require an idle turn. MCP sampling, remote elicitation, OAuth and legacy SSE transport are not offered. MCP tools stay serial because MCP has no standard parallel hint. All limits are declared or documented, not silent policy changes.

No history, working-environment, model-gateway or agent HTTP service from milestone 5 was started.

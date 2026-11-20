# modular: the Go SDK

This is the Go implementation of [SDK draft 0.1](../../docs/sdk/README.md). It wraps the Go build with the edition 4 draft extensions. Application and plugin code uses the `modular` package, not the base Harness or its API. The Go module path uses `OWNER` until the repository is published.

```go
agent := modulartest.Agent(t, modulartest.Script(`[{"text":"Hello."}]`))
session, err := agent.Session(t.Context())
if err != nil {
    t.Fatal(err)
}
turn, err := session.Prompt(t.Context(), "Say hello.")
if err != nil || turn.Text != "Hello." {
    t.Fatalf("turn: %+v; error: %v", turn, err)
}
```

Import `github.com/daniel-ballance/modular-agent/go/modular/modulartest` for tests and `github.com/daniel-ballance/modular-agent/go/modular` for applications. The only direct dependency newly used by the SDK is `github.com/google/jsonschema-go`, already in the base's module graph and named in the SDK specification. It generates and validates tool schemas.

## Official file and MCP tools

- `modular/files.Plugin(spill)` registers the six standard file and command tools. It uses `ToolContext.Environment`, which scopes file and command operations to the current call and works both in process and through the plugin binding.
- `modular/mcp.WithServers(servers, warn)` connects trusted MCP servers. A warning handler opts into skipping failed configured servers, while client-supplied ACP attachments remain scoped to their session.
- `NewSchemaTool` accepts an explicit JSON Schema object. `OnSessionPrepare` installs per-session resources before recovery. The in-process `OnTurnBefore` payload includes the canonical project and plugin-callable tool definitions; inspecting them does not grant authority.
- `Agent.Sessions` and `Agent.SessionInfo` read stored metadata without opening a session. Both are available on `HistoryStore` before composition. `Session.Busy` and `Session.WaitIdle` let a terminal distinguish active work from an idle session.
- `Agent.ServeACP` takes `ServeACPOptions` with `Compose`, `ProjectSettings`, and `ProjectMCP` to serve several canonical projects on one connection. `WithCompaction` controls automatic context compaction and `/compact`.
- `WithLateAnswersStartTurns` lets enabled tools leave a question open after a wait with `AskOptions{Then: "leaveOpen"}`. `WithJobReportsStartTurns` lets job reports start turns; otherwise the reports are parked.

The [Go `ma` README](../cmd/ma/README.md) shows these parts composed and tested as the standard configuration.

## Checks

From the repository root:

```sh
(cd conformance/acp && npm ci)
(cd go && mise exec -- go build ./... && mise exec -- go vet ./... && mise exec -- gofmt -l .)
(cd go && MODULAR_AGENT_SDK_REQUIRE=go mise exec -- go test -json -count=1 ./... > /tmp/modular-go-test.log 2>&1)
(cd go && MODULAR_AGENT_SDK_REQUIRE=go mise exec -- go test -race -json -count=1 ./modular/... > /tmp/modular-go-race.log 2>&1)

# Build peers for the cross-language runs.
(cd rust && mise exec -- cargo build -p sdk-scenarios --bin modular-agent-fixtures)
(cd go && mise exec -- go build -o .bin/modular-agent-fixtures ./modular/cmd/fixtures)
(cd typescript && npm ci && npm run build)
(cd python && uv sync --python 3.13)
(cd go && MODULAR_AGENT_SDK_REQUIRE=go mise exec -- go test -json -count=1 ./modular/scenarios -run '^TestShared$' > /tmp/modular-go-matrix.log 2>&1)
mkdir -p "$HOME/.cache/ma-std-tmp"
(cd rust && TMPDIR="$HOME/.cache/ma-std-tmp" MODULAR_AGENT_SDK_REQUIRE=go mise exec -- cargo test -p sdk-scenarios --test shared > /tmp/modular-rust-matrix.log 2>&1)
```

Commands in the base suite use Linux with unprivileged user, PID and mount namespaces. The SDK suites use scripted Providers or loopback servers only. The scenario runner builds its own fixture program and checks the registry for other built programs. Use `-v` to see the skipped placements and their build commands. Until the peer revisions merge, run the full and race suites with the peer fixture artifacts absent, then run the separate matrix checks with all four programs built. `MODULAR_AGENT_SDK_REQUIRE=go` makes Go mandatory; it does not filter out other built programs.

### What is checked

- **Go suite:** 31 packages pass (234 top-level tests and 447 subtests in the full run); 15 have no tests. Build and vet pass, and `gofmt -l .` emits no paths. The SDK race run passes 30 top-level tests and 60 subtests across two test packages.
- **Binding kits:** ACP 123/123 each for transient, durable and external durable (plus 121/121 each with split stdio plugins, for transient and durable); plugin 144/144. The SDK history kit passes 39/39 each over memory, files and an HTTP relay (normal runs, without restart mode). The SDK ACP test compares the published declaration to `Agent.Declaration()`.
- **Shared scenarios:** Go passes 22/22 in its own two placements. With all four programs built, Go passes 49/55: all 35 original combinations and 14 of the 20 new combinations. The six failures are `quay` and `pilot` missing in the three peer programs at the pinned baseline. The Rust runner passes 10/11 against Go, including all seven original scenarios. In `nested-call` it successfully runs Go’s `pilot` and `tide`, but its baseline `PromptResult` also lists the child result. Across all four served programs, Rust passes 37/44; its in-process suite passes six cases before stopping at the missing `pilot`. Both Go crash cases kill the agent’s process group, reap the direct child, and wait for remaining live group members before reopening.
- **Round 1 negative control:** changing the Go tide fixture's text to `High tide at Whitby is deliberately wrong.` failed `tool-call/process:go`, step 0, with the expected and actual result text. The fixture was restored and rebuilt.
- **Guide examples:** three offline tests from guides 01 and 02: scripted hello, iterating a text stream through `turnEnded`, and typed tide lookup. The process fixture program and the served scenario checks exercise guide 03's `Serve` and process-plugin path. Examples using the default real Provider endpoint are not run.
- **Placement and composition:** nine invalid compositions, default host isolation, identical tool refusal wording, rejection of an in-process-only tool at initialize, and file/command declarations for the local and memory environments.
- **Sessions and plugins:** cancellation hands a queued prompt back; structured results record refusal feedback, retry, and preserve JSON null; lagged streams return a replay cursor; invalid transformed tool values preserve the confirmed execution status and fail the turn. Settings/fork/reopen, item replacement, and a command plus four hook registrations are also tested.
- **Interfaces and Providers:** ACP prompts and reopening while recovery is still blocked, history HTTP reopen, three history service eligibility cases, unknown-model rejection before input admission, and ordinary Provider error settlement in both placements. Two loopback cases per official Provider cover streaming success and a rejected key.

## Built so far

| Milestone item | Go implementation |
|---|---|
| 1. Build an agent | Functional options, three durability modes, Provider catalog and model selection, default settings, approval, project and data directories. History override via `WithHistory`. Kept/durable require persistent history; default local recovery bookkeeping also requires `WithDataDir` in those modes. `WithEnvironment` overrides local. An explicit environment with `NeedsDataDir() bool` returning true also requires `WithDataDir`. Runtime override is not exposed. |
| 2. Sessions | `Session`, `OpenSession`, `Prompt`, `PromptStream`, `LastTurn`, `History`, `Send`, `Cancel`, `Settings`, `SetSetting`, `Fork`, `Commands`, `RunCommand`, `Close`. Keyed prompts are supported. `WithResult(schema)` accepts one validated JSON value (including null), and records feedback and retries invalid candidates; `Events(ctx, cursor)` replays gated committed entries after the cursor, then follows live events. A lagged reader gets `lost` with the last delivered entry ID (or null) in `Data["fromEntry"]`. |
| 3. Local actor | `user`, present for questions only while a handler is registered. An approval without one is refused. |
| 4. Tools | Struct-derived JSON Schema 2020-12, hints serialized inside `hints`, schema validation before dispatch and after result transforms, cancellation and refusal, `Ask`, `Progress`, and `Log`. Opt-in leave-open questions. Tool contexts expose a scoped working environment; secret questions and general history and emit callbacks are not yet supported. |
| 5. Errors | `*modular.Error` with a typed `Code`. Binding and context errors retain their known code; several untyped base errors have an operation-level fallback. |
| 6. Plugins | `Plugin` and `Registrar` for tools, Providers, commands, `tool.before`, `tool.after`, `turn.before`, `step.after`, `turn.end`. Configuration and item-level replacements are checked during composition. Other registrar roles and hook points are not exposed. |
| 7. Serve | Base plugin RPC server for registration, tools, ask, progress, hooks, commands, Providers, and shutdown. Flags for in-process-only tools, hooks and commands. An item discovered in setup gets a `not_supported` initialize reply with no registration. Served Provider credential lookup is not exposed through `ProviderContext` yet. |
| 8. Process plugins | Explicit launch specs require a plugin host and imply environment discovery; `WithPluginHost(false)` with listed process plugins is rejected. Startup failure is `invalid_composition`. |
| 9. Testing | Scripted Provider indexed by the final request, `modulartest.Agent` with a memory environment by default, `Answers` (`Handle` and `AssertDone`), six fixtures, and the shared runner with exact and substring expectations. `MemoryEnvironment`, `OverWire` (the real plugin binding over a pipe), and `Restart` (in-process simulated interruption, preserving the configured store). Real process and crash cleanup are covered by the shared scenarios, not by `Restart`. |
| 10. Guides | Offline examples and placement as listed above. |
| 11. Providers | Go `Provider` with model catalog and request functions. OpenAI Responses and Anthropic Messages, using `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`; both tested over loopback. Model errors are recorded. A cancelled served request emits no `provider.response`; served Providers lower unsupported reasoning levels. `outOfReach` descriptions are human-facing. |
| 12. Nested calls | `tc.Tools.List(ctx)` and `tc.Tools.Call(ctx, name, input)` work in both placements, through the Harness. The maximum depth is eight edges below a root call. The child has its own checks, commits, and settlement; it stays in history but out of the model context and `PromptResult.ToolResults()`. `modelTools` narrows the model offer without changing plugin access. ACP announces the parent; the plugin binding supports `host/tools/list`, `host/tools/call`, `env/list` and `host/env/list`. |
| 13. Declaration and ACP | `Declaration` and `ServeACP` publish the same SDK declaration, including the selected Runtime’s nested-call support, queued recovery policy, store erasure, and the environment’s containment and file confinement. Embedded reopen waits for recovery; ACP reopen does not. |
| 14. HTTP history | `ServeHistory` binds plaintext only on loopback. It serves `FileHistory`, `HTTPHistory` (as an authenticated relay) or `HistoryServiceFiles`; `MemoryHistory` requires `HistoryOptions.AllowVolatileForTests`. |

## Where the base and the specification differ

| Base | SDK treatment |
|---|---|
| Embedded actor was named `local-user`; the ACP connection authenticates its own actor. | Select `user` at harness construction for embedded sessions. Do not use an app-provided actor id to authenticate an ACP connection. |
| Native settings use `ask-unless-read-only` and `ask-always`. | Map `ask` and `all` through the shared setting keys. An absent option does not load approval. |
| Whole-plugin replacement and external item replacement were different paths. | Reuse the tentative item registration path in process. A `replaces` entry must be an item the plugin supplies, even if there was no collision. |
| Local file operations followed absolute paths and symlinks; the base command environment can declare `strong`. | The SDK uses local without file confinement by default, and reports the actual selected environment’s file and command declarations. |
| The legacy process host derives programs only from the environment. Its command binding sends an argument array. | Load SDK launch specs directly in order; only a plugin host reads the environment. The SDK host sends the binding's argument string, and the SDK server can still accept a legacy array. Both use the base RPC transport. |
| The base represents model failures as `error` returns and expects separate, older settings names and wire conversions. | The SDK records typed and ordinary Provider failures as failed assistant messages; ordinary failures use kind `other`. Portable adapters preserve the shared history and request forms. |
| The base re-runs queued admissions after a restart. | SDK opts into handing back recovered queued admissions; recovery of an already interrupted turn still follows the Runtime. |
| The base API does not consistently type errors, and does not offer cursor-based live event replay. | The SDK bounds both prompt streams and session subscriptions and returns a replay cursor on lag. |
| The HTTP history server and local `history` store have distinct storage layouts. | `ServeHistory` uses either the legacy service layout or the selected SDK store itself. The SDK-store adapter holds that store's writer lease for the duration of each HTTP writer lease. |

## Findings for the SDK specification

### Local environment declaration — `docs/sdk/concepts.md`, Defaults; `docs/sdk/api.md`, The declaration

**Resolved in round 2.** The original defaults prescribed `processGroup` by name, but the normative declaration is about the containment the chosen environment can guarantee. The Go local command supervisor can declare `strong`. Replace the working environment default with:

> Local, rooted at the project. It refuses file paths that resolve outside the project and declares the containment its command supervisor provides. Local does not mean sandboxed.

Replace the `commandContainment` value with:

> From the working environment. Declare `processGroup` for an environment that guarantees process-group containment only; do not infer containment from the environment's name.

### Explicit process specs with `pluginHost: false` — `docs/sdk/placement.md`, A plugin in another process

**Resolved in round 2 with the opposite choice.** The specification now rejects the combination. The original text gave both a per-agent override and an unconditional statement that providing processes makes the agent a host. Rust and Go load explicit programs but skip environment discovery when the app explicitly sets false. Replace the first two sentences of the third paragraph with:

> With no explicit `pluginHost` setting, providing `processPlugins` enables plugin-host discovery. `pluginHost: false` disables `MODULAR_AGENT_PLUGINS` discovery but does not suppress explicit `processPlugins`. An Interface that claims the plugin-host role must enable discovery.

### Shared shapes for tools — `docs/sdk/api.md`, Tools

**Resolved in round 2.** The original input/output paragraph named the wire keys but omits where hints go, which is easy to miss when converting the preceding flat list of SDK options. Add:

> In a serialized ToolDefinition, `readOnly`, `destructive`, `openWorld` and `safeToRepeat` are members of `hints`. `parallel` and `callers` are outside `hints`. This is true for definitions in history and Provider requests as well as the plugin binding.

**Proposed shared scenario:** run an `ask` agent with `tide` and no handler. Call `tide` and assert `completed` with the tide result, and no input request for approval. Assert that the four hint values in the recorded definition match the shared defaults plus `readOnly: true`. A second scenario could submit schema-invalid `tide` input and check `failed`, without requiring library-specific diagnostic text.

### Service history vs. local store implementations — `docs/sdk/placement.md`, Services

**Resolved in round 2.** The original draft said any history store could be served, but does not distinguish a store that supports the service's lease and list semantics from a local adapter without that shape. The first Go SDK pass could serve its service files but not a generic `api.Store`. Add implementation guidance:

> A service adapter must preserve the history binding's leases, append equality, filtering and erasure. It must not serve unrelated files when given an existing store. A build that cannot adapt a selected store must return `not_supported`, naming the store it cannot adapt.

### Process group exit and fixture argv — `docs/sdk/testing.md`, Finding the fixture programs and The fixture plugins

**Resolved in round 2.** A program serves one registration; the original table's preceding sentence said it takes names in the plural. A process runner also needs to distinguish exited zombies from surviving work. Replace the fixture program sentence with:

> The fixture program takes exactly one fixture name as its first argument and serves that plugin's registration.

Add after the process-group paragraph:

> Exited members still awaiting reaping are not running work. The runner must reap its direct child and verify that no live member of the group remains before reopening the session.

### Event replay cursor — `docs/sdk/api.md`, Events

**Resolved in round 2.** The original lag rule did not say whether the cursor was inclusive or how to represent the beginning. Replace the last paragraph with:

> A slow reader never blocks the agent. The SDK bounds each stream. If it falls behind, the stream ends with `lost` and exposes `fromEntry`, the id of the last committed entry delivered to that reader, or the beginning cursor if none was delivered. `events(fromEntry)` replays committed entries strictly after that id, then follows live events. Live deltas are not replayed.

### Simulated restart — `docs/sdk/testing.md`, The testing kit

**Resolved in round 2.** “Drops the agent without shutting it down” was ambiguous when a simulated process shares resources with its replacement. Replace the `restart(agent)` description with:

> Interrupts active work without writing a graceful turn outcome, releases the stopped agent's exclusive store leases, and builds a new agent over the same store and in-process plugin composition. It does not call application plugin stop callbacks. This simulates interruption; it does not prove that a real process or its descendants would stop. Shared crash scenarios kill a real process.

### Ephemeral scratch vs. an explicit data directory — `docs/sdk/api.md`, Building an agent; `docs/sdk/placement.md`, Durability

The new blanket rejection for a part with local recovery bookkeeping contradicts the explicit default in Concepts to use temporary scratch in `ephemeral`. Replace that condition in both sections with:

> A part that requires a local directory for recovery bookkeeping makes `dataDir` mandatory. The default local environment under `ephemeral` is an exception: its bookkeeping can be put in disposable scratch because the agent does not promise recovery across process lifetimes.

### Unknown models and ACP error codes — `docs/sdk/api.md`, Providers

ACP lists `invalid_request` for the JSON depth guard; configuration values outside the offered choices are invalid parameters. Replace the unknown-model sentence with:

> The embedded SDK and plugin Provider refuse an unknown model before admitting the request with `invalid_request`. ACP refuses an unknown model selection as `invalid_params` and does not admit input for an unoffered saved model. Each wire surface uses its binding’s error mapping.

### Invalid completed tool values — `docs/sdk/api.md`, Tools

The validation sentence omits when the check happens and what an invalid completed value means. The shared-data and settlement rules require checking the transformed result without misreporting confirmed effects. Replace the validation sentence with:

> The SDK validates input against `parameters` before the function runs; invalid input ends the call `failed` with a readable reason. After `tool.after`, the host requires and validates `value` when the result is `completed` and `returns` is set. On a missing or invalid value, commit a minimal safe result with the confirmed execution status, report the processing error separately and fail the enclosing operation without redispatch.

### Findings from guides 05 and 09

- **[API — Sessions and turns](../../docs/sdk/api.md#sessions-and-turns):** Add: “`lastTurn()` returns the latest settled turn as a PromptResult, or no value if none exists; it does not admit input. In Go, call `LastTurn(ctx)` and check the error and the possibly nil result.”
- **[API — The agent](../../docs/sdk/api.md#the-agent) and [Actors and rights](../../docs/sdk/api.md#actors-and-rights):** For the Go guide, replace the session-options and actor-selection instructions with: “Call `Agent.Session(ctx)` without options. Set new-session defaults with `WithSettings`. The embedded actor is `user`; the Go SDK does not expose `actors`, `tenant`, or actor-selection session methods. ACP authenticates its own actor.”
- **[API — The declaration](../../docs/sdk/api.md#the-declaration):** Go accepts an explicit persistent store with `Ephemeral` but does not declare `portableSessions` in that mode. In the guide, say: “Use `Kept` or `Durable` with a persistent store for portable sessions.”
- **[Placement — Services](../../docs/sdk/placement.md#services):** Use this Go spelling: “`modular.HTTPHistory(url, tokenFile)` creates the client store. `modular.ServeHistory(ctx, store, modular.HistoryOptions{Address: address, TokenFile: tokenFile})` runs the service until its context is cancelled; it does not return a listener address.”

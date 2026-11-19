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

Import `github.com/OWNER/modular-agent/go/modular/modulartest` for tests and `github.com/OWNER/modular-agent/go/modular` for applications. The only direct dependency newly used by the SDK is `github.com/google/jsonschema-go`, already in the base's module graph and named in the SDK specification. It generates and validates tool schemas.

## Checks

From the repository root:

```sh
(cd conformance/acp && npm ci)
(cd rust && mise exec -- cargo build -p sdk-scenarios --bin modular-agent-fixtures)
(cd go && mise exec -- go build -o .bin/modular-agent-fixtures ./modular/cmd/fixtures)
(cd typescript && npm ci && npm run build)
(cd go && mise exec -- go build ./... && mise exec -- go vet ./... && mise exec -- gofmt -l .)
(cd go && mise exec -- go test -json -count=1 ./... > /tmp/modular-go-test.log 2>&1)
(cd go && MODULAR_AGENT_SDK_REQUIRE=rust,typescript,go mise exec -- go test -race -count=1 ./modular/...)
mkdir -p "$HOME/.cache/ma-std-tmp"
(cd rust && TMPDIR="$HOME/.cache/ma-std-tmp" MODULAR_AGENT_SDK_REQUIRE=rust,typescript,go mise exec -- cargo test -p sdk-scenarios --test shared -- --nocapture)
(cd typescript && MODULAR_AGENT_SDK_REQUIRE=rust,typescript,go node --test packages/fixtures/dist/test/shared.test.js)
```

Commands in the base suite use Linux with unprivileged user, PID and mount namespaces. The SDK suites use scripted Providers or loopback servers only. The scenario runner builds its own fixture program and checks the registry for other built programs. Use `-v` to see the skipped placements and their build commands.

### What is checked

- **Go suite:** 31 packages pass; 15 have no tests. Build and vet pass, and `gofmt -l .` emits no paths. The SDK race run passes 23 top-level tests and 52 subtests in two packages.
- **Binding kits:** ACP 123/123 each for transient, durable and external durable (plus 121/121 each with split stdio plugins, for transient and durable); plugin 144/144. The SDK history kit passes 39/39 each over memory, files and an HTTP relay (normal runs, without restart mode). The SDK ACP test compares the published declaration to `Agent.Declaration()`.
- **Shared scenarios:** 84/84 across the Go, Rust and TypeScript runners (28 each): seven in-process combinations and seven against each of the three served fixture programs, per runner. Python is not required. Both crash cases kill the agent's entire process group and wait for it to exit before reopening.
- **Negative control:** changing the Go tide fixture's text to `High tide at Whitby is deliberately wrong.` failed `tool-call/process:go`, step 0, with the expected and actual result text. The fixture was restored and rebuilt.
- **Guide examples:** three offline tests from guides 01 and 02: scripted hello, iterating a text stream through `turnEnded`, and typed tide lookup. The process fixture program and the served scenario checks exercise guide 03's `Serve` and process-plugin path. Examples using the default real Provider endpoint are not run.
- **Placement and composition:** five invalid compositions, default host isolation, one refusal parity comparison, rejection of an in-process-only tool, and a symlink confinement check.
- **Sessions and plugins:** cancellation handing one queued prompt back, two hint/schema cases, settings/fork/reopen, item replacement preserving a sibling tool, and one command plus four hook registrations exercised in both placements.
- **Interfaces and Providers:** one prompt over a real ACP client and one reopen over the history HTTP binding. Two loopback cases per Provider (streaming success and a rejected key recorded as a failed assistant message).

## Built so far

| Milestone item | Go implementation |
|---|---|
| 1. Build an agent | Functional options, three durability modes, Provider catalog and model selection, default settings, approval, project and data directories. History override via `WithHistory`. `WithEnvironment` overrides the working environment. Runtime override is not exposed. |
| 2. Sessions | `Session`, `OpenSession`, `Prompt`, `PromptStream`, `LastTurn`, `History`, `Send`, `Cancel`, `Settings`, `SetSetting`, `Fork`, `Commands`, `RunCommand`, `Close`. Keyed prompts are supported. `WithResult(schema)` validates a final JSON value; `Events(ctx, cursor)` replays gated committed entries after the cursor, then follows live events. A lagged reader gets `lost` with the last delivered entry ID in `Data["fromEntry"]`. |
| 3. Local actor | `user`, present for questions only while a handler is registered. An approval without one is refused. |
| 4. Tools | Struct-derived JSON Schema 2020-12, separate hints, status and value mapping, cancellation and refusal, `Ask`, `Progress`, and `Log`. No leave-open or secret questions. Tool contexts do not yet expose the working environment or general history and emit callbacks. |
| 5. Errors | `*modular.Error` with a typed `Code`. Binding and context errors retain their known code; several untyped base errors have an operation-level fallback. |
| 6. Plugins | `Plugin` and `Registrar` for tools, Providers, commands, `tool.before`, `tool.after`, `turn.before`, `step.after`, `turn.end`. Configuration and item-level replacements are checked during composition. Other registrar roles and hook points are not exposed. |
| 7. Serve | Base plugin RPC server for registration, tools, ask, progress, hooks, commands, Providers, and shutdown. Flags for in-process-only tools, hooks and commands. Served Provider credential lookup is not exposed through `ProviderContext` yet. |
| 8. Process plugins | Explicit launch specs and host-only environment loading over the base RPC host. Startup failure is `invalid_composition`. |
| 9. Testing | Scripted Provider, `modulartest.Agent`, `Answers`, four fixtures, registry and shared runner. `MemoryEnvironment`, `OverWire` (the real plugin binding over a pipe), and `Restart` (in-process simulated interruption, preserving the configured store). Real process and crash cleanup are covered by the shared scenarios, not by `Restart`. |
| 10. Guides | Offline examples and placement as listed above. |
| 11. Providers | Go `Provider` with model catalog and request functions. OpenAI Responses and Anthropic Messages, using `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`; both tested over loopback. Model errors are recorded. A cancelled served request emits no `provider.response`; served Providers lower unsupported reasoning levels. `outOfReach` descriptions are human-facing. |
| 12. Nested calls | `tc.Tools.List(ctx)` and `tc.Tools.Call(ctx, name, input)` work in both placements, through the Harness. The maximum depth is eight edges below a root call. The child has its own checks, commits, and settlement; it stays out of the model context. `modelTools` narrows the model offer without changing plugin access. ACP announces the parent; the plugin binding supports `host/tools/list`, `host/tools/call`, `env/list` and `host/env/list`. |
| 13. Declaration and ACP | `Declaration` and `ServeACP` publish the same SDK declaration, including `nestedToolCalls`. |
| 14. HTTP history | `ServeHistory` serves `MemoryHistory`, `FileHistory`, `HTTPHistory` (as an authenticated relay) or `HistoryServiceFiles`. |

## Where the base and the specification differ

| Base | SDK treatment |
|---|---|
| Embedded actor was named `local-user`; the ACP connection authenticates its own actor. | Select `user` at harness construction for embedded sessions. Do not use an app-provided actor id to authenticate an ACP connection. |
| Native settings use `ask-unless-read-only` and `ask-always`. | Map `ask` and `all` through the shared setting keys. An absent option does not load approval. |
| Whole-plugin replacement and external item replacement were different paths. | Reuse the tentative item registration path in process. A `replaces` entry must be an item the plugin supplies, even if there was no collision. |
| Local file operations followed absolute paths and symlinks; the base command environment can declare `strong`. | SDK opts into `os.Root` for project files. Keep the environment's actual command containment instead of guessing a level from its name. |
| The legacy process host derives programs only from the environment. Its command binding sends an argument array. | Load SDK launch specs directly in order; only a plugin host reads the environment. The SDK host sends the binding's argument string, and the SDK server can still accept a legacy array. Both use the base RPC transport. |
| The base represents model failures as `error` returns and expects separate, older settings names and wire conversions. | The SDK turns typed `ModelError` values into a failed assistant response and uses the portable adapters for history and model requests. |
| The base re-runs queued admissions after a restart. | SDK opts into handing back recovered queued admissions; recovery of an already interrupted turn still follows the Runtime. |
| The base API does not consistently type errors, and does not offer cursor-based live event replay. | The SDK bounds both prompt streams and session subscriptions and returns a replay cursor on lag. |
| The HTTP history server and local `history` store have distinct storage layouts. | `ServeHistory` uses either the legacy service layout or the selected SDK store itself. The SDK-store adapter holds that store's writer lease for the duration of each HTTP writer lease. |

## Findings for the SDK specification

### Local environment declaration — `docs/sdk/concepts.md`, Defaults; `docs/sdk/api.md`, The declaration

The defaults prescribe `processGroup` by name, but the normative declaration is about the containment the chosen environment can guarantee. The Go local command supervisor can declare `strong`. Replace the working environment default with:

> Local, rooted at the project. It refuses file paths that resolve outside the project and declares the containment its command supervisor provides. Local does not mean sandboxed.

Replace the `commandContainment` value with:

> From the working environment. Declare `processGroup` for an environment that guarantees process-group containment only; do not infer containment from the environment's name.

### Explicit process specs with `pluginHost: false` — `docs/sdk/placement.md`, A plugin in another process

The text gives both a per-agent override and an unconditional statement that providing processes makes the agent a host. Rust and Go load explicit programs but skip environment discovery when the app explicitly sets false. Replace the first two sentences of the third paragraph with:

> With no explicit `pluginHost` setting, providing `processPlugins` enables plugin-host discovery. `pluginHost: false` disables `MODULAR_AGENT_PLUGINS` discovery but does not suppress explicit `processPlugins`. An Interface that claims the plugin-host role must enable discovery.

### Shared shapes for tools — `docs/sdk/api.md`, Tools

The input/output paragraph names the wire keys but omits where hints go, which is easy to miss when converting the preceding flat list of SDK options. Add:

> In a serialized ToolDefinition, `readOnly`, `destructive`, `openWorld` and `safeToRepeat` are members of `hints`. `parallel` and `callers` are outside `hints`. This is true for definitions in history and Provider requests as well as the plugin binding.

**Proposed shared scenario:** run an `ask` agent with `tide` and no handler. Call `tide` and assert `completed` with the tide result, and no input request for approval. Assert that the four hint values in the recorded definition match the shared defaults plus `readOnly: true`. A second scenario could submit schema-invalid `tide` input and check `failed`, without requiring library-specific diagnostic text.

### Service history vs. local store implementations — `docs/sdk/placement.md`, Services

The draft says any history store can be served, but does not distinguish a store that supports the service's lease and list semantics from a local adapter without that shape. The first Go SDK pass could serve its service files but not a generic `api.Store`. Add implementation guidance:

> A service adapter must preserve the history binding's leases, append equality, filtering and erasure. It must not serve unrelated files when given an existing store. A build that cannot adapt a selected store must return `not_supported`, naming the store it cannot adapt.

### Process group exit and fixture argv — `docs/sdk/testing.md`, Finding the fixture programs and The fixture plugins

A program serves one registration; the table's preceding sentence says it takes names in the plural. A process runner also needs to distinguish exited zombies from surviving work. Replace the fixture program sentence with:

> The fixture program takes exactly one fixture name as its first argument and serves that plugin's registration.

Add after the process-group paragraph:

> Exited members still awaiting reaping are not running work. The runner must reap its direct child and verify that no live member of the group remains before reopening the session.

### Event replay cursor — `docs/sdk/api.md`, Events

The lag rule does not say whether the cursor is inclusive or how to represent the beginning. Replace the last paragraph with:

> A slow reader never blocks the agent. The SDK bounds each stream. If it falls behind, the stream ends with `lost` and exposes `fromEntry`, the id of the last committed entry delivered to that reader, or the beginning cursor if none was delivered. `events(fromEntry)` replays committed entries strictly after that id, then follows live events. Live deltas are not replayed.

### Simulated restart — `docs/sdk/testing.md`, The testing kit

“Drops the agent without shutting it down” is ambiguous when a simulated process shares resources with its replacement. Replace the `restart(agent)` description with:

> Interrupts active work without writing a graceful turn outcome, releases the stopped agent's exclusive store leases, and builds a new agent over the same store and in-process plugin composition. It does not call application plugin stop callbacks. This simulates interruption; it does not prove that a real process or its descendants would stop. Shared crash scenarios kill a real process.

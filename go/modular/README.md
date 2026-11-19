# modular: the Go SDK

This is the Go implementation of [SDK draft 0.1](../../docs/sdk/README.md). It wraps the Go edition 3 build. Application and plugin code uses the `modular` package, not the base Harness or its API. The Go module path uses `OWNER` until the repository is published.

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
(cd go && mise exec -- go build ./... && mise exec -- go vet ./...)
(cd go && mise exec -- go test -count=1 ./... > /tmp/modular-go-test.log 2>&1)
(cd go && MODULAR_AGENT_SDK_REQUIRE=rust mise exec -- go test -count=1 -v ./modular/...)
(cd go && MODULAR_AGENT_SDK_REQUIRE=rust mise exec -- go test -race -count=1 ./modular/...)
mkdir -p "$HOME/.cache/ma-std-tmp"
(cd rust && TMPDIR="$HOME/.cache/ma-std-tmp" MODULAR_AGENT_SDK_REQUIRE=go mise exec -- cargo test -p sdk-scenarios --test shared -- --nocapture)
```

Commands in the base suite use Linux with unprivileged user, PID and mount namespaces. The SDK suites use scripted Providers or loopback servers only. The scenario runner builds its own fixture program and checks the registry for other built programs. Use `-v` to see the skipped placements and their build commands.

### What is checked

- **Shared scenarios:** 21 combinations in the Go runner: seven in process, seven served by Go, and seven served by Rust. The Rust runner also passes seven with the Go fixture program. Both crash cases kill the agent's process group, including the served fixtures. The Go runner watches count files or committed history, and waits for the group to exit before opening the session.
- **Negative control:** changing the Go tide fixture's text to `High tide at Whitby is deliberately wrong.` failed `tool-call/process:go`, step 0, with the expected and actual result text. The fixture was restored and rebuilt.
- **Guide examples:** three offline tests from guides 01 and 02: scripted hello, iterating a text stream through `turnEnded`, and typed tide lookup. The process fixture program and the served scenario checks exercise guide 03's `Serve` and process-plugin path. Examples using the default real Provider endpoint are not run.
- **Placement and composition:** five invalid compositions, default host isolation, one refusal parity comparison, rejection of an in-process-only tool, and a symlink confinement check.
- **Sessions and plugins:** cancellation handing one queued prompt back, two hint/schema cases, settings/fork/reopen, item replacement preserving a sibling tool, and one command plus four hook registrations exercised in both placements.
- **Interfaces and Providers:** one prompt over a real ACP client and one reopen over the history HTTP binding. Two loopback cases per Provider (streaming success and a rejected key recorded as a failed assistant message).

## Built so far

| Milestone item | Go implementation |
|---|---|
| 1. Build an agent | Functional options, three durability modes, Provider catalog and model selection, default settings, approval, project and data directories. History override via `WithHistory`. Runtime and environment overrides are not exposed. |
| 2. Sessions | `Session`, `OpenSession`, `Prompt`, `PromptStream`, `LastTurn`, `History`, `Send`, `Cancel`, `Settings`, `SetSetting`, `Fork`, `Commands`, `RunCommand`, `Close`. Keyed prompts are supported. No structured turn-result request option or general `Events` replay yet. |
| 3. Local actor | `user`, present for questions only while a handler is registered. An approval without one is refused. |
| 4. Tools | Struct-derived JSON Schema 2020-12, separate hints, status and value mapping, cancellation and refusal, `Ask`, `Progress`, and `Log`. No leave-open or secret questions. Tool contexts do not yet expose the working environment or general history and emit callbacks. |
| 5. Errors | `*modular.Error` with a typed `Code`. Binding and context errors retain their known code; several untyped base errors have an operation-level fallback. |
| 6. Plugins | `Plugin` and `Registrar` for tools, Providers, commands, `tool.before`, `tool.after`, `turn.before`, `step.after`, `turn.end`. Configuration and item-level replacements are checked during composition. Other registrar roles and hook points are not exposed. |
| 7. Serve | Base plugin RPC server for registration, tools, ask, progress, hooks, commands, Providers, and shutdown. Flags for in-process-only tools, hooks and commands. Served Provider credential lookup is not exposed through `ProviderContext` yet. |
| 8. Process plugins | Explicit launch specs and host-only environment loading over the base RPC host. Startup failure is `invalid_composition`. |
| 9. Testing | Scripted Provider, `modulartest.Agent`, `Answers`, four fixtures, registry and shared runner. The test helper uses a temporary project with the local environment; no memory environment, `overWire`, or `restart` helper yet. |
| 10. Guides | Offline examples and placement as listed above. |
| 11. Providers | Go `Provider` with model catalog and request functions. OpenAI Responses and Anthropic Messages, using `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`; both tested over loopback. Model errors are recorded. The edition 3 final model-dispatch and retry paths are not an edition 4 retry implementation. |
| 12. Nested calls | Not built. The Go base still needs edition 4 parent authority, child records, depth limits, settlement and recovery, including `host/tools/list` and `host/tools/call`. A direct UI tool call is not a safe substitute for that route. `nestedToolCalls` is false. |
| 13. Declaration and ACP | `Declaration` and `ServeACP`. ACP reuses the edition 3 base Interface and is tested with one real ACP client. The declaration of the embedded SDK and the base ACP declaration are not yet one source. |
| 14. HTTP history | `HTTPHistory` and `ServeHistory` using `HistoryServiceFiles` and the base server's own disk layout. The base server cannot serve an arbitrary SDK store. |

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
| The base API does not consistently type errors, and does not offer cursor-based live event replay. | SDK wraps errors at its boundary and bounds prompt streams; a lagged stream reports `lost`. |
| The HTTP history server and local `history` store have distinct storage layouts. | `HTTPHistory` connects to any compatible service. `ServeHistory` accepts the separate `HistoryServiceFiles` constructor, not `FileHistory` or `MemoryHistory`. |

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

The draft says any history store can be served, but does not distinguish a store that supports the service's lease and list semantics from a local adapter without that shape. The Go base can serve its service files but not a generic `api.Store`. Add implementation guidance:

> A service adapter must preserve the history binding's leases, append equality, filtering and erasure. It must not serve unrelated files when given an existing store. A build that cannot adapt a selected store must return `not_supported`, naming the store it cannot adapt.

### Process group exit and fixture argv — `docs/sdk/testing.md`, Finding the fixture programs and The fixture plugins

A program serves one registration; the table's preceding sentence says it takes names in the plural. A process runner also needs to distinguish exited zombies from surviving work. Replace the fixture program sentence with:

> The fixture program takes exactly one fixture name as its first argument and serves that plugin's registration.

Add after the process-group paragraph:

> Exited members still awaiting reaping are not running work. The runner must reap its direct child and verify that no live member of the group remains before reopening the session.

# modular: the Go SDK

This is the Go implementation of [SDK 0.1](../../docs/sdk/README.md). It wraps the edition 4 Go build. Application and plugin code uses the `modular` package, not the base Harness or its API.

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

Import `github.com/daniel-ballance/modular-agent/go/modular/modulartest` for tests and `github.com/daniel-ballance/modular-agent/go/modular` for applications. The SDK uses `github.com/google/jsonschema-go` for tool schemas and [Gorilla WebSocket v1.5.3](https://pkg.go.dev/github.com/gorilla/websocket@v1.5.3) for the network binding. The same plugin and ACP handlers serve stdio and WebSocket connections.

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
export TMPDIR="$HOME/.cache/ma-std-tmp"
mkdir -p "$TMPDIR"
npm ci --prefix conformance/tools
npm ci --prefix conformance/acp
# Build the four fixture programs per conformance/sdk/fixtures/*.json.
export MODULAR_AGENT_SDK_REQUIRE=all
# Before the other fixture programs have --listen, enable Go services only:
# export MODULAR_AGENT_SDK_SERVICE=go
(cd go && mise exec -- go build ./... && mise exec -- go vet ./... && test -z "$(mise exec -- gofmt -l .)")
(cd go && mise exec -- go test -json -count=1 ./... > "$TMPDIR/go-test.json" 2>&1)
(cd go && mise exec -- go test -race -json -count=1 ./modular/... ./cmd/ma/... > "$TMPDIR/go-race.json" 2>&1)
(cd go && mise exec -- go build -o .bin/ma ./cmd/ma)
node conformance/reference/run.mjs --agent go
(cd conformance/acp && MODULAR_AGENT_CONFORMANCE=1 node run.mjs --crash-checks --probe-checks --job-checks -- ../../go/.bin/ma --acp)
```

The base suites use Linux with unprivileged user, PID and mount namespaces. The scenario runner builds Go's fixture and discovers built peer programs. Build each peer with its [fixture registry](../../conformance/sdk/fixtures/) command. During the parallel rollout, only the `service:<peer>` runs that need a fixture depend on the peers' `--listen` changes; `MODULAR_AGENT_SDK_SERVICE=go` limits service placements without skipping any process placement.

### What is checked

- **Go build, vet and formatting:** pass. The full run passed 37 packages (283 top-level tests and 545 subtests); 15 packages had no tests. The SDK and `ma` race run passed seven packages (70 top-level tests and 158 subtests). Both require all peer process fixtures and select Go for the service placement. The WebSocket framing and plugin liveness tests also pass with the race detector.
- **Reference and bindings:** Go `ma` passed 17/17 reference checks and the ACP kit with crash, probe and job checks: **188/188 stdio, 193/193 direct WebSocket**. The Go conformance plugin passed **144/144 stdio, 151/151 direct WebSocket**, with both Runtime tiers. No bridge. The SDK history kit passes 39/39 each for memory, files and HTTP relay (without restart mode).
- **Shared scenarios:** 84/84 (14 each in `inProcess`, `service:go`, and `process:go`, `process:python`, `process:rust` and `process:typescript`) with all peer programs built and required. For service crash scenarios the runner kills and reaps the agent and each fixture's process group before starting fresh services and reopening. Transport tests cover self-signed TLS and rejection when not trusted, authentication, framing limits and close codes, liveness, a disconnected call's settlement, and token-selected ACP identity and project scope.
- **Questions and authority:** session handler override, open question listing, answers from the app, tenant and session ceilings, actor departure, and recording both submission identities. Secret tests force process exit after staging, after recording acceptance, and after activation. Recoveries discard unselected stages and finish selected answers. The SDK also checks private files, stale generations and idempotent activation; `ma` tests the same transactions in the `answers` section of `auth.json`.
- **Guides and Providers:** guides 01–09 have offline coverage. The developer Provider test changes its catalog, checks readiness, streams, transforms a request, observes its response and gets a host credential in both placements. The official Providers have loopback streaming and rejected-key tests.
- **Live Providers:** `TestLiveProviders` compiles and skips unless `MODULAR_AGENT_LIVE=1`. With opt-in it independently skips each Provider without its key. This run did not enable live checks.

## Built so far

| Area | Go implementation |
|---|---|
| Agent composition | Functional options; three durability modes; `WithRuntime` with `TransientRuntime()` and `DurableRuntime()`; history and environment overrides; Provider catalog and default model; settings and approval. Kept and durable need persistent history. The default local environment also needs `WithDataDir` in those modes. |
| Sessions | `Session(ctx, ...SessionOptions)`, `OpenSession`, `Sessions`, `SessionInfo`, `Prompt`, `PromptStream`, `LastTurn`, `Send`, `Cancel`, `Settings`, `SetSetting`, `Fork`, `Commands`, `RunCommand`, `WaitIdle` and `Close`. Keyed prompts and schema-checked JSON results (including null). Events replay gated committed entries and return a cursor on lag. |
| Actors and limits | `WithSeveralActors`, `WithSessionLimits`, `WithTenants`; settings, tenant and initial actors in `SessionOptions`; `Join`, `Leave`, `As` and `SetLimit`. The declaration reflects the options. The standard agent leaves all three off. |
| Questions and credentials | `WithOnQuestion`, session `OnQuestion`, `Questions` (open only), `Answer`, `Value` and tagged `Decline`. Without a handler, an approval is refused; another question waits while an eligible actor can answer it. `FileCredentials` stages and atomically activates or discards secrets. Only the stored name is returned. Leave-open calls are opt-in. |
| Tools | Struct-derived or explicit JSON Schema, dispatch and transformed-result validation, cancellation, refusal, ask, progress, log, raw history pages and custom events. Scoped environment and nested calls work in all three placements. A tool marked `InProcessOnly` can read named non-Provider credentials. Nesting is limited to eight edges below the root; nested results stay in history, outside the model context and `PromptResult.ToolResults()`. |
| Plugins and hooks | Static tools, Providers, commands, Runtimes and environments, with item-level replacement. `Registrar.On` exposes the standard binding hooks with shared payloads; typed helpers are available for common points. `OnSessionPrepare` is local; `OnSessionEnd` is also served. Setup-time placement failures return `not_supported`, without registering a partial plugin. |
| Providers | `Provider.Available`, `CatalogChanges.Changed()`, `ProviderContext.Credential()` and streamed pieces. Served Providers use `provider/models`, `provider/available`, `provider/request`, `provider/event`, the two `host/hook` callbacks and `host/credentials/read`. OpenAI Responses and Anthropic Messages by API key. Model failures settle the attempt; cancellation suppresses a late response callback. |
| Errors | `*modular.Error` with a typed `Code`. Binding and context errors retain known codes; some untyped base errors still need operation-level fallbacks. |
| Process and service plugins | `WithProcessPlugin` and `WithServicePlugin` load in that order after local plugins, then mixed `MODULAR_AGENT_PLUGINS` entries in array order. Both options imply plugin hosting; `WithPluginHost(false)` or a configured plugin that cannot start or register fails composition. |
| Testing | Scripted Provider, memory environment, `Answers`, `OverWire`, simulated `Restart` and seven shared fixture plugins. Shared scenarios check real process termination separately from the simulated restart. |
| ACP and history | ACP over stdio, supplied streams, or WebSocket, with multi-project composition, project settings and MCP. Embedded reopen waits for recovery; ACP reopen does not. `ServeHistory` serves file history, service files, or an authenticated HTTP relay; memory is test-only. |

### WebSocket services

- `modular.ServeService(ctx, plugin, modular.ServeOptions{Listen: "127.0.0.1:0", TokenFile: path})` returns a `Service` with `URL`, `Done()` and `Close()`. `Setup` runs per connection; put mutable instance state inside it or use `ServeServiceFactory` if the `Stop` closure also needs that state. A service environment must see the host's canonical project and allocate its own command ledger. Configuration paths such as the counter fixture's `path` are interpreted by the plugin, not remapped by the SDK.
- `modular.WithServicePlugin(modular.ServicePlugin{URL: svc.URL, TokenFile: path, Config: config})` dials the service using system TLS roots. Plain WebSocket dials and listeners are loopback-only. `TLSOptions{CertFile: cert, KeyFile: key}` enables WSS at the listener. Generate a bearer token with at least 128 bits of entropy and put it in an owner-only file. The operator can set `PingInterval` and `ControlDeadline` for an explicit service plugin.
- `agent.ServeACP(ctx, modular.ServeACPOptions{Listen: addr, Actors: entries})` blocks until stopped. `agent.ListenACP` returns the `Service` as soon as it listens. Each `ACPActor` supplies `TokenFile`, `Actor`, `Projects` and `Tenants`. Omit `Projects` to allow all projects supported by the composition; omit `Tenants` to allow only sessions without a tenant. Include `""` in an explicit tenant list to permit those sessions as well. The token is the only source of network connection identity; `MODULAR_AGENT_ACTOR` applies to stdio only.
- `ma --acp --listen ADDR --token-file FILE` serves the local ACP actor on loopback. `go/.bin/modular --serve-plugin --listen ADDR --token-file FILE` serves the conformance plugin and prints its bound URL. For the plugin kit, launch two more copies with `MODULAR_AGENT_PLUGIN_PARTS=runtime` and `durable-runtime`, and pass their URLs as `--runtime-url` and `--durable-runtime-url`.

### Remaining Go gaps

- The SDK does not yet expose all base roles: a developer tool source with change notification, a job owner and resumable job handles, and registrar History, Credential Store, Configuration and Interface roles. The bundled parts and the binding endpoints are not substitutes for those developer APIs.
- Standard binding hooks are registerable, but not every point has a typed helper and a scoped SDK hook context. In-process-only hook points and answers such as plugin-defined hooks, join/leave observers, and pending from a tool gate still need SDK adapters. The Go SDK also does not yet expose all command-context callbacks or the embedded move, erase and direct-call operations.

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

### WebSocket placement and startup

In [Building an agent](../../docs/sdk/api.md#building-an-agent), replace the `pluginHost` default and its description with:

> `false`, or `true` when `processPlugins` or `servicePlugins` is given. A plugin host reads `MODULAR_AGENT_PLUGINS` after both explicit lists. `pluginHost: false` contradicts either list; any failure to connect, initialize or register a configured service is `invalid_composition`.

In [Finding the fixture programs](../../docs/sdk/testing.md#finding-the-fixture-programs), replace “with three more arguments after the fixture's name” with “with four more arguments after the fixture's name”.

In [A plugin service](../../docs/bindings/websocket.md#a-plugin-service), clarify what `home` means to the service:

> `home` is a host-side name for state, not an instruction to open a path on the service. A stateful service maps authenticated hosts and their `home` names to separate allocations in a service-owned state directory. It must not write to a path chosen by a remote host merely because it was supplied as `home`.

In [Connection lifetime](../../docs/bindings/websocket.md#connection-lifetime), replace the liveness sentence with:

> A plugin service client MUST send `$/ping` when a connection with pending work has been silent for an operator-configured interval, by default 30 seconds, and treat no answer within the plugin binding's control deadline as loss. ACP does not define a JSON-RPC ping or a control deadline; ACP clients may use WebSocket ping/pong frames for liveness.

### Guide 08: ACP spelling and reopen factory — [API / The agent](../../docs/sdk/api.md#the-agent)

Replace the Go ACP options description with:

> `ServeACP(ctx, options ...ServeACPOptions)` accepts at most one options value. `Compose(ctx, project)` supplies a separate Agent bound to the canonical project. During reopen, `ACPReopeningSession(ctx)` returns the saved id. `ProjectSettings` returns new-session defaults; `ProjectMCP` returns trusted configured servers. `Input` and `Output` can replace stdin and stdout for the connection.

### Guides 04, 06 and 07 describe an earlier Go API

Replace the Go limitation in [Guide 04 / Answer from your UI](../../docs/sdk/guides/04-questions-and-approvals.md#ask-for-a-choice-and-answer-from-your-ui) with:

> Go can register an agent default with `WithOnQuestion` and a session override with `session.OnQuestion(ctx, handler)`. For a choice or text question, call `session.Questions(ctx)` and answer an open request with `session.Answer(ctx, id, modular.Value(text))` or `modular.Decline(reason)`. An approval still needs a present, eligible actor. The string `declined` is a text value, not a decline.

Replace the Go readiness and served-credentials limitations in [Guide 06](../../docs/sdk/guides/06-write-a-provider.md) with:

> Go consults an optional `Provider.Available` callback. Give the Provider a `*modular.CatalogChanges` and call its `Changed()` method after replacing the catalog. `ProviderContext.Credential()` reads the Provider's own credential from the agent's store in process or through `host/credentials/read` when served. Credential errors can still occur after admission.

Replace the Go hook placement sentence in [Guide 07](../../docs/sdk/guides/07-hooks.md#keep-local-hooks-local) with:

> Go's `OnSessionEnd` is servable. `OnSessionPrepare` stays in process, and `Registrar.On(point, handler, options...)` registers the standard binding hooks with their shared payload and answer shapes. Use `HookOrder` for explicit order.

### Duplicate credentials option — [API / Building an agent](../../docs/sdk/api.md#building-an-agent)

Replace the first credentials row below `environment` with:

> | `credentials` | a credential store | environment variables. A writable store (such as `fileCredentials(path)`) implements the [secret staging operations](../../docs/sdk/api.md#the-other-parts), so a `secret` question can be answered. |

Remove the duplicate credentials row below `tenants`.

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
- **[API — The agent](../../docs/sdk/api.md#the-agent) and [Actors and rights](../../docs/sdk/api.md#actors-and-rights):** Use this Go spelling: “Call `Agent.Session(ctx, modular.SessionOptions{Settings: settings, Tenant: tenant, Actors: actors})` to override session defaults. With the relevant creation options enabled, call `Join`, `Leave`, `As` and `SetLimit` on an embedded session. ACP authenticates its own actor.”
- **[API — The declaration](../../docs/sdk/api.md#the-declaration):** Go accepts an explicit persistent store with `Ephemeral` but does not declare `portableSessions` in that mode. In the guide, say: “Use `Kept` or `Durable` with a persistent store for portable sessions.”
- **[Placement — Services](../../docs/sdk/placement.md#services):** Use this Go spelling: “`modular.HTTPHistory(url, tokenFile)` creates the client store. `modular.ServeHistory(ctx, store, modular.HistoryOptions{Address: address, TokenFile: tokenFile})` runs the service until its context is cancelled; it does not return a listener address.”

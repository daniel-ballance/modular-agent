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
(cd go && mise exec -- go build ./... && mise exec -- go vet ./... && test -z "$(mise exec -- gofmt -l .)")
(cd go && mise exec -- go test -json -count=1 ./... > "$TMPDIR/go-test.json" 2>&1)
(cd go && mise exec -- go test -race -json -count=1 ./modular/... ./cmd/ma/... > "$TMPDIR/go-race.json" 2>&1)
(cd go && mkdir -p .bin && mise exec -- go build -o .bin/ma ./cmd/ma && mise exec -- go build -o .bin/modular ./cmd/modular)
node conformance/reference/run.mjs --agent go
ma="$PWD/go/.bin/ma"
(cd conformance/acp && MODULAR_AGENT_CONFORMANCE=1 node run.mjs --crash-checks --probe-checks --job-checks -- "$ma" --acp)
scripts/websocket-kits.sh go
```

The base suites use Linux with unprivileged user, PID and mount namespaces. The scenario runner builds Go's fixture and discovers built peer programs. Build each peer with its [fixture registry](../../conformance/sdk/fixtures/) command. `MODULAR_AGENT_SDK_REQUIRE=all` requires all four programs and runs the whole matrix.

### What is checked

- **Go build, vet and formatting:** pass. The full run passed 38 packages (306 top-level tests and 710 subtests); 16 packages had no tests. The SDK and `ma` race run passed seven packages (92 top-level tests and 323 subtests). Both runs included all 153 shared scenario placements. The Runtime tests include in-process recovery, as well as a real process-group `SIGKILL` with a developer-supplied Runtime served over stdio. The recovery test checks that the original turn resumes without duplicating its response or committed `step.after` decision. A separate test answers an open question after its turn and checks that the served Runtime continues the original call once in a linked turn.
- **Reference and bindings:** Go `ma` passed **18/18 reference checks** and the ACP kit with crash, probe and job checks: **188/188 stdio, 193/193 direct WebSocket**. The Go conformance plugin passed **146/146 stdio** and **153/153 direct WebSocket**; the WebSocket run included both Runtime tiers. The SDK history kit passed **39/39** each for memory, files, an authenticated HTTP relay and a custom persistent snapshot backend.
- **Shared scenarios:** **153/153** (17 in process, 17 each as a process and as a service for Go, Python, Rust and TypeScript), with `MODULAR_AGENT_SDK_REQUIRE=all`. The runner kills and reaps the agent and each fixture's process group before reopening after a crash.
- **Public SDK:** six interruption cases cover failed history commits and writer revocation through `Prompt`, `PromptStream` and ACP, with gated live events, cancellation, `lost` replies and recovery on reopen. Other public tests cover typed hook handlers, rejected out-of-scope transforms, typed session and turn events, custom working environments and Runtimes in process and over the wire, Configuration trust for ACP project MCP, and remote job resume after the host is killed. ACP token tests cover omitted and explicit no-tenant scope, named tenants, empty scopes, exact projects, composition bounds and the rights ceiling without rewriting a recorded grant.
- **Questions and authority:** session handler override, open question listing, answers from the app, tenant and session ceilings, actor departure, and recording both submission identities. Secret tests force process exit after staging, after recording acceptance, and after activation. Recoveries discard unselected stages and finish selected answers. The SDK also checks private files, stale generations and idempotent activation; `ma` tests the same transactions in the `answers` section of `auth.json`.
- **Guides and Providers:** guides 01–09 have offline coverage. The developer Provider test changes its catalog, checks readiness, streams, transforms a request, observes its response and gets a host credential in both placements. API-key Providers run 55 loopback cases covering the catalog mappings and fallbacks and verify that the shipped catalog is byte-identical to the specification.
- **Live Providers:** `TestLiveProviders` compiles and skips unless `MODULAR_AGENT_LIVE=1`. With opt-in it independently skips each Provider without its key. This run did not enable live checks.

## Built so far

| Area | Go implementation |
|---|---|
| Agent composition | Functional options; three durability modes; `WithRuntime` with `TransientRuntime()` and `DurableRuntime()`; history and environment overrides; Provider catalog and default model; settings and approval. Kept and durable need persistent history. The default local environment also needs `WithDataDir` in those modes. |
| Sessions | Creation, reopen, history, move and erase; keyed prompts accepting text or `Content`; proposals, release and withdrawal; direct tool calls and commands. `LastTurn` does not admit work or wait for a running turn. Events replay gated entries and return a cursor on lag; `TextEvent`, `EndEvent` and `TypedEvent[T]` expose standard event payloads. `TypedEvent[SessionInterruptedData]` reports `commitFailed` or `writerLost` live, never in history. Outstanding prompts fail with `lost`; close and reopen to recover. |
| Actors and limits | `WithSeveralActors`, `WithSessionLimits`, `WithTenants`; settings, tenant and initial actors in `SessionOptions`; `Join`, `Leave`, `As` and `SetLimit`. The declaration reflects the options. The standard agent leaves all three off. |
| Questions and credentials | `WithOnQuestion`, session `OnQuestion`, `Questions` (open only), `Answer`, `Value` and tagged `Decline`. Without a handler, an approval is refused; another question waits while an eligible actor can answer it. `FileCredentials` stages and atomically activates or discards secrets. Only the stored name is returned. Leave-open calls are opt-in. |
| Tools | Struct-derived or explicit JSON Schema, dispatch and transformed-result validation, cancellation, refusal, ask, progress, log, raw history pages and custom events. Scoped environment and nested calls work in all three placements. A tool marked `InProcessOnly` can read named non-Provider credentials. Nesting is limited to eight edges below the root; nested results stay in history, outside the model context and `PromptResult.ToolResults()`. |
| Plugins and hooks | Dynamic tool sources with `ToolChanges`, Providers, commands, Runtime and environment replacements via `NewRuntime` and `NewEnvironment`, and local history, credential store, configuration and Interface adapters. `NewRuntime` uses the binding checkpoint and scoped callbacks in both placements, including served recovery and continuation after a late answer. `Registrar.On` and typed helpers include join, leave, output and Provider pieces; `OnStepBeforeChange` can narrow the in-process Provider-tool allowance. Local plugins can define and invoke custom hooks. A tool gate can leave a question pending where the agent enables late answers. `HookContextFrom(ctx)` exposes scoped callbacks. |
| Commands and jobs | Commands have scoped history, environment, jobs and local questions. A served command gets its project through `host/session`. Model-using commands send auxiliary requests through the selected Provider, record both entries under the command step, and do not dispatch returned tools. Job owners register cancel and resume; job handles can report progress and commit their end beyond the starting call. |
| Providers | `Provider.Available`, `CatalogChanges.Changed()`, `ProviderContext.Credential()` and streamed pieces. Served Providers use `provider/models`, `provider/available`, `provider/request`, `provider/event`, the two `host/hook` callbacks and `host/credentials/read`. OpenAI Responses and Anthropic Messages by API key use the shared model table, with `WithModels` to enroll additional exact IDs. Unset reasoning keeps the vendor default. Model failures settle the attempt; cancellation suppresses a late response callback. |
| Errors | `*modular.Error` with a typed `Code`. Binding and context errors retain known codes; some untyped base errors still need operation-level fallbacks. |
| Process and service plugins | `WithProcessPlugin` and `WithServicePlugin` load in that order after local plugins, then mixed `MODULAR_AGENT_PLUGINS` entries in array order. Both options imply plugin hosting; `WithPluginHost(false)` or a configured plugin that cannot start or register fails composition. |
| Testing | Scripted Provider, memory environment, `Answers`, `OverWire`, simulated `Restart` and seven shared fixture plugins. Shared scenarios check real process termination separately from the simulated restart. |
| ACP and history | ACP over stdio, supplied streams, or WebSocket, with multi-project composition, project settings and MCP. Embedded reopen waits for recovery; ACP reopen does not. The selected composition’s `Configuration.Trusted` controls project MCP loading. `ServeHistory` serves files, a `ServiceHistoryBackend`, or an authenticated HTTP relay; memory is test-only. The custom adapter requires a persistent `HistoryOptions.StateDir` for lease fencing and a durable backend supporting atomic exact erasure. |

### WebSocket services

- `modular.ServeService(ctx, plugin, modular.ServeOptions{Listen: "127.0.0.1:0", TokenFile: path})` returns a `Service` with `URL`, `Done()` and `Close()`. `Setup` runs per connection; put mutable instance state inside it or use `ServeServiceFactory` if the `Stop` closure also needs that state. A service environment must see the host's canonical project and allocate its own command ledger. Configuration paths such as the counter fixture's `path` are interpreted by the plugin, not remapped by the SDK.
- `modular.WithServicePlugin(modular.ServicePlugin{URL: svc.URL, TokenFile: path, Config: config})` dials the service using system TLS roots. Plain WebSocket dials and listeners are loopback-only. `TLSOptions{CertFile: cert, KeyFile: key}` enables WSS at the listener. Generate a bearer token with at least 128 bits of entropy and put it in an owner-only file. The operator can set `PingInterval` and `ControlDeadline` for an explicit service plugin.
- `agent.ServeACP(ctx, modular.ServeACPOptions{Listen: addr, Actors: entries})` blocks until stopped. `agent.ListenACP` returns the `Service` as soon as it listens. Each `ACPActor` supplies `TokenFile`, `Actor`, `Projects` and `Tenants`. Omit `Projects` to allow all projects supported by the composition; omit `Tenants` to allow only sessions without a tenant. Include `""` in an explicit tenant list to permit those sessions as well. An empty list permits no tenants or projects in its scope. Network rights are capped without replacing recorded grants; `$/ping` works before and after initialization with a default five-second deadline. The token is the only source of network connection identity; `MODULAR_AGENT_ACTOR` applies to stdio only.
- `ma --acp --listen ADDR --token-file FILE` serves the local ACP actor on loopback. `go/.bin/modular --serve-plugin --listen ADDR --token-file FILE` serves the conformance plugin and prints its bound URL. For the plugin kit, launch two more copies with `MODULAR_AGENT_PLUGIN_PARTS=runtime` and `durable-runtime`, and pass their URLs as `--runtime-url` and `--durable-runtime-url`.

### Specification findings

- [Languages, Go](../../docs/sdk/languages.md#go) does not spell the nullable tenant scope for Go. Add: “In `ACPActor.Tenants`, a nil slice permits only sessions without a tenant, an empty non-nil slice permits none, and the empty string represents `null` in an explicit list.”
- [API, The other parts](../../docs/sdk/api.md#the-other-parts) describes the HTTP request vocabulary for a local history store but does not define its in-process transaction or lease shape. Add: “A local history adapter may expose `acquire` returning a writer lease with `load`, atomic `save` and `close`, plus store-level `list` and `erase`, if it preserves the same writer, commit, equality and erasure semantics. The HTTP adapter still implements the history binding.”
- [Languages, Go](../../docs/sdk/languages.md#go) describes only the blocking history listener. Replace “It runs until the context is cancelled and does not return a listener address.” with “`ServeHistory` runs until the context is cancelled. Use `ListenHistory` with the same options to obtain a `HistoryService` handle with `URL` and `Close()`.”

- [API, The other parts](../../docs/sdk/api.md#the-other-parts) does not specify how a snapshot store advertises HTTP lease and tombstone support. Add: “A service adapter for a snapshot store may require an explicit exact-erasure capability and private persistent state for restart lease exclusion. Its native and served records may share a namespace if both paths preserve the same leases and tombstones.”

- [ACP, Updates](../../docs/bindings/acp.md#updates) does not map session interruption to ACP. Add: “When session writing stops because a commit failed or writer access was lost or uncertain, send a live `_modular-agent/event` notification to every attached, authorized recipient after the output gate. Parameters are `{ kind: 'session.interrupted', session: Id, time: string, data: { reason: 'commitFailed' | 'writerLost' } }`. Send it without capability negotiation; clients that do not recognize the extension can ignore it. A waiting `session/prompt` fails with `lost` (`-32000`, `data.code: 'lost'`). Do not replay the notification.”
- [API, The other parts](../../docs/sdk/api.md#the-other-parts) does not define how local adapters report revocation when no store call is in progress. Add: “A history adapter whose writer access can be revoked MUST notify the host when revocation is detected, including when there is no pending write. Go exposes `WatchedHistoryLease` with `WriterLost` and `CheckWriter` for this purpose.”

### Remaining Go gaps

None.

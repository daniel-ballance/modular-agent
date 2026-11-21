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

## Findings for the SDK specification

- **[ACP service liveness](../../docs/research/sdk-findings.md#open-decisions).** Go proposes requiring JSON-RPC `$/ping` only for plugin service clients and using WebSocket ping/pong frames for ACP. The WebSocket binding currently does not make that distinction.
- **[Persistent history under `ephemeral`](../../docs/research/sdk-findings.md#open-decisions).** Go accepts an explicit persistent store in this mode but does not declare `portableSessions`. Decide whether to allow the override and what the declaration promises.

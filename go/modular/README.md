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
(cd go && ./scripts/build-monty.sh)
export MODULAR_AGENT_SDK_REQUIRE=all
(cd go && mise exec -- go build ./... && mise exec -- go vet ./... && test -z "$(mise exec -- gofmt -l .)")
(cd go && mise exec -- go test -json -count=1 ./... > "$TMPDIR/go-test.json" 2>&1)
(cd go && mise exec -- go test -race -json -count=1 ./modular/... ./cmd/ma/... > "$TMPDIR/go-race.json" 2>&1)
(cd go && ./scripts/build-monty.sh && mise exec -- go build -o .bin/ma ./cmd/ma && mise exec -- go build -o .bin/modular ./cmd/modular && mise exec -- go build -o .bin/modular-agent-fixtures ./modular/cmd/fixtures)
node conformance/reference/run.mjs --agent go
ma="$PWD/go/.bin/ma"
(cd conformance/acp && MODULAR_AGENT_CONFORMANCE=1 node run.mjs --crash-checks --probe-checks --job-checks -- "$ma" --acp)
scripts/websocket-kits.sh go
```

The base suites use Linux with unprivileged user, PID and mount namespaces. The scenario runner builds Go's fixture and discovers built peer programs. Build each peer with its [fixture registry](../../conformance/sdk/fixtures/) command. `MODULAR_AGENT_SDK_REQUIRE=all` requires all four programs and runs the whole matrix.

### What is checked

- **Go build, vet, and formatting:** pass. The Monty worker, `ma`, `modular`, and the shared-scenario fixture build from this checkout. The full Go suite passed 38 packages (17 had no tests); the SDK and `ma` race suite passed seven packages (seven had no tests).
- **Shared scenarios:** **153/153** with `MODULAR_AGENT_SDK_REQUIRE=all` (17 in process and 17 per process and service placement for each of the four SDKs).
- **Reference and bindings:** Go `ma` passed **23/23** reference checks. The ACP kit with crash, probe, and job checks passed **188/188** over stdio and **193/193** over WebSocket. The WebSocket plugin kit passed **153/153**. The standalone history service passed **42/42**, including a restart. The SDK history kit passed **39/39** on each of memory (test-only), file, relay, and custom persistent snapshot backends.
- **ADR 0030:** the ACP isolation and capacity profiles passed **43/43** on stdio and **45/45** on WebSocket. Public SDK tests check a race for the last no-tenant intake slot, withdrawal at saturation, a restart with two parked proposals above a lowered ceiling, and a bounded failed response with usage and no dispatched calls (built-in, custom local, and served Runtimes). They also cover two authenticated history services with unrelated stores, lease handoff and pending erasure across a native history restart, and rejection of a served environment's foreign project before setup. The ADR 0030 shared HTTP erasure profile was not run; the raw HTTP client does not provide a pending registry.
- **Public SDK:** six interruption cases cover failed history commits and writer revocation through `Prompt`, `PromptStream` and ACP, with gated live events, cancellation, `lost` replies and recovery on reopen. An idle-session test revokes a lease without a subsequent write. Image progress from a served job and tool reaches the event follower through their own output gate over stdio and WebSocket. Other checks cover nested callbacks during Runtime model streaming and environment output, and catalog refreshes and emitted events on the same connection. Additional tests check proposal settlement conflicts, lazy custom-store creation and paging, and SDK Provider declarations in both placements. Other public tests cover typed hook handlers, rejected out-of-scope transforms, typed session and turn events, custom working environments and Runtimes in process and over the wire, Configuration trust for ACP project MCP, and remote job resume after the host is killed. ACP token tests cover omitted and explicit no-tenant scope, named tenants, empty scopes, exact projects, composition bounds and the rights ceiling without rewriting a recorded grant.
- **Provisional sessions:** the public SDK checks file history, an HTTP client against a history service, and a custom store registered through the Registrar, each with an in-process and a served Runtime. Before this fix, file history created a lock and the custom store was acquired at session creation; the HTTP client already deferred PUT. An unused session leaves no session records or leases after close or process-group `SIGKILL`. Native file history initializes an empty pending-erasure registry for the store, not for each session. A refused input leaves nothing either. The first admitted input commits the original setup and its receipt together. A fork commits its copied prefix and fresh setup in one batch and does not recover copied turns as live work. `ma --acp` tests check `session/new` and `session/close` against file and HTTP history.
- **Questions and authority:** session handler override, open question listing, answers from the app, tenant and session ceilings, actor departure, and recording both submission identities. Secret tests force process exit after staging, after recording acceptance, and after activation. Recoveries discard unselected stages and finish selected answers. The SDK also checks private files, stale generations and idempotent activation; `ma` tests the same transactions in the `answers` section of `auth.json`.
- **Guides and Providers:** guides 01–09 have offline coverage. The developer Provider test changes its catalog, checks readiness, streams, transforms a request, observes its response and gets a host credential in both placements. API-key Providers run 55 loopback cases covering the catalog mappings and fallbacks and verify that the shipped catalog is byte-identical to the specification.
- **Live Providers:** `TestLiveProviders` compiles and skips unless `MODULAR_AGENT_LIVE=1`. With opt-in it independently skips each Provider without its key. This run did not enable live checks.

## Built so far

| Area | Go implementation |
|---|---|
| Agent composition | Functional options; three durability modes; `WithRuntime` with `TransientRuntime()` and `DurableRuntime()`; history and environment overrides; Provider catalog and default model; settings and approval. Kept and durable need persistent history. The default local environment also needs `WithDataDir` in those modes. |
| Sessions | Creation, reopen, history, move and erase; keyed prompts accepting text or `Content`; proposals, release (including decline) and withdrawal; repeated settlement returns `conflict`. Also supports direct tool calls and commands. `LastTurn` does not admit work or wait for a running turn. Events replay gated entries and return a cursor on lag; `TextEvent`, `EndEvent` and `TypedEvent[T]` expose standard event payloads. `TypedEvent[SessionInterruptedData]` reports `commitFailed` or `writerLost` live, never in history. Writer loss is reported even while idle. Outstanding prompts fail with `lost`; close and reopen to recover. |
| Actors and limits | `WithSeveralActors`, `WithSessionLimits`, `WithTenants`; settings, tenant and initial actors in `SessionOptions`; `Join`, `Leave`, `As` and `SetLimit`. The declaration reflects the options. `WithCapacityLimits` sets count and byte bounds for the session, tenant, and agent; `Agent.CapacityLimits()` returns operator limits, not current use. Project factories share their parent's accounting. The standard configuration leaves several actors and session rights limits off; a policy with named tenant scopes enables those tenants. |
| Questions and credentials | `WithOnQuestion`, session `OnQuestion`, `Questions` (open only), `Answer`, `Value` and tagged `Decline`. Without a handler, an approval is refused; another question waits while an eligible actor can answer it. `FileCredentials` stages and atomically activates or discards secrets. Only the stored name is returned. Leave-open calls are opt-in. |
| Tools | Struct-derived or explicit JSON Schema, dispatch and transformed-result validation, cancellation, refusal, ask, progress, log, raw history pages and custom events. `toolOutput` carries a text chunk and optional original `Content`, including images. Job progress also preserves its content. Scoped environment and nested calls work in all three placements. A tool marked `InProcessOnly` can read named non-Provider credentials. Nesting is limited to eight edges below the root; nested results stay in history, outside the model context and `PromptResult.ToolResults()`. |
| Plugins and hooks | Dynamic tool sources with `ToolChanges`, Providers, commands, Runtime and environment replacements via `NewRuntime` and `NewEnvironment`, and local history, credential store, configuration and Interface adapters. `NewRuntime` uses the binding checkpoint and scoped callbacks in both placements, including served recovery and continuation after a late answer. `Registrar.On` and typed helpers include join, leave, output and Provider pieces; `OnStepBeforeChange` can narrow the in-process Provider-tool allowance. Local plugins can define and invoke custom hooks. A tool gate can leave a question pending where the agent enables late answers. `HookContextFrom(ctx)` exposes scoped callbacks. |
| Commands and jobs | Commands have scoped history, environment, jobs and local questions. A served command gets its project through `host/session`. Model-using commands send auxiliary requests through the selected Provider, record both entries under the command step, and do not dispatch returned tools. Job owners register cancel and resume; job handles can report progress and commit their end beyond the starting call. |
| Providers | `Provider.Available`, `CatalogChanges.Changed()`, `ProviderContext.Credential()` and streamed pieces. A Provider may keep state and implement `DiscardState`. The declaration always reports `runsToolsAtProvider: false` and `liveSessions: false`. Served Providers use `provider/models`, `provider/available`, `provider/request`, `provider/event`, the two `host/hook` callbacks and `host/credentials/read`. OpenAI Responses and Anthropic Messages by API key use the shared model table, with `WithModels` to enroll additional exact IDs. Unset reasoning keeps the vendor default. Model failures settle the attempt; cancellation suppresses a late response callback. |
| Errors | `*modular.Error` with a typed `Code`. Binding and context errors retain known codes; some untyped base errors still need operation-level fallbacks. |
| Process and service plugins | `WithProcessPlugin` and `WithServicePlugin` load in that order after local plugins, then mixed `MODULAR_AGENT_PLUGINS` entries in array order. Both options imply plugin hosting; `WithPluginHost(false)` or a configured plugin that cannot start or register fails composition. |
| Testing | Scripted Provider, memory environment, `Answers`, `OverWire`, simulated `Restart` and seven shared fixture plugins. Shared scenarios check real process termination separately from the simulated restart. |
| ACP and history | ACP over stdio, supplied streams, or WebSocket, with operator project and tenant scope, rights ceilings, and optional representation. Multi-project composition checks saved scope before the factory receives metadata. Native file history keeps pending-erasure marks beside its session files; memory shares marks among agents holding the same store. `HTTPHistory` does not declare erasure. Embedded reopen waits for recovery; ACP reopen does not. The selected composition’s `Configuration.Trusted` controls project MCP loading. `NewPagedHistoryStore` gives local custom stores the binding's `Create`, cursor/limit `Read` and `List`, declared lease TTL, and lease, append and erase operations. `HistoryGrant.WriterLost` can signal revocation immediately. `ServeHistory` serves files, a `ServiceHistoryBackend`, or an authenticated HTTP relay; memory is test-only. The custom snapshot service adapter requires a persistent `HistoryOptions.StateDir` for lease fencing and a durable backend supporting atomic exact erasure. |

### WebSocket services

- `modular.ServeService(ctx, plugin, modular.ServeOptions{Listen: "127.0.0.1:0", TokenFile: path})` returns a `Service` with `URL`, `Done()` and `Close()`. `Setup` runs per connection; put mutable instance state inside it or use `ServeServiceFactory` if the `Stop` closure also needs that state. A service environment requires `ServeOptions.Projects`, a list of operator-approved canonical projects, and checks requested file paths under the initialized project. Keep stateful services on separate listeners with separate credentials and trusted state directories. Use separate process and filesystem confinement where a plugin or shell could reach another scope. Configuration paths such as the counter fixture's `path` are interpreted by trusted plugin code, not remapped by the SDK.
- `modular.WithServicePlugin(modular.ServicePlugin{URL: svc.URL, TokenFile: path, Config: config})` dials the service using system TLS roots. Plain WebSocket dials and listeners are loopback-only. `TLSOptions{CertFile: cert, KeyFile: key}` enables WSS at the listener. Generate a bearer token with at least 128 bits of entropy and put it in an owner-only file. The operator can set `PingInterval` and `ControlDeadline` for an explicit service plugin.
- `agent.ServeACP(ctx, modular.ServeACPOptions{Listen: addr, Actors: entries})` blocks until stopped. `agent.ListenACP` returns the `Service` as soon as it listens. Each `ACPActor` supplies `TokenFile`, `Actor`, `Projects`, `Tenants`, and optional `Represents`. For stdio use `ServeACPOptions.Projects`, `Tenants`, `Rights`, and `Represents`; `StdioActor` sets the complete operator principal instead of reading the launcher environment. Omit `Projects` to allow all projects supported by the composition; omit `Tenants` to allow only sessions without a tenant. Include `""` in an explicit tenant list to permit those sessions as well. An empty list permits no tenants or projects in its scope. Network rights are capped without replacing recorded grants; `$/ping` works before and after initialization with a default five-second deadline. The token is the only source of network connection identity; `MODULAR_AGENT_ACTOR` applies to stdio only.
- `ma --policy FILE` selects an operator file instead of the default `policy.json`. It sets `stdio`, WebSocket `actors`, and `limits` in all modes. `ma --acp --listen ADDR --token-file FILE` remains the local loopback shorthand; omit `--token-file` when the policy supplies `actors`. `ma --declaration` shows the effective limits without principals or credentials. `go/.bin/modular --serve-plugin --listen ADDR --token-file FILE` serves the conformance plugin and prints its bound URL. For the plugin kit, launch two more copies with `MODULAR_AGENT_PLUGIN_PARTS=runtime` and `durable-runtime`, and pass their URLs as `--runtime-url` and `--durable-runtime-url`.

### Remaining ADR 0030 work

- The count ledger and logical history quota do not bound every output buffer, open connection, or open session. The byte charge does not cover all metadata and sidecar writes or prove a physical disk reservation. Question, turn, tool, and recovery settlement can still exhaust their write space for large payloads. Several direct action and callback races, including blocked transports and grant changes between final check and dispatch, still need barriers and coverage.
- The native registry prevents a stale fork from publishing and verifies completed tombstones under its lease. It does not finish an interrupted turn or job with pending content before tombstoning, autonomously retry every pending session after restart, or persist retryable Provider discard failures. It does not fence restored backups; the operator must do that. Portable HTTP erasure needs shared coordinator provisioning and lease-fenced integration before it can be offered.
- The current SDK checks are not the entire ADR 0030 race and fault matrix. In particular they do not cover history write reply loss for pending erasure or separate stateful plugin hosts with colliding retained keys.

### Specification findings

- [Reference declaration](../../docs/reference/standard-configuration.md#declaration): move `tenants` out of the fixed-false row and add: “`tenants` is false by default. If an operator policy lists named tenants, `ma` enables those tenant buckets and applies each connection’s explicit reach; an omitted tenant list still permits only unassigned sessions.”
- [Resource reservations](../../docs/contracts.md#resource-reservations): after the sentence requiring durable write space, add: “The quota counts retained encoded records and outstanding write obligations. For a backend that stages an atomic replacement, the operator MUST provide the additional physical space for that replacement; this does not enlarge the logical quota.”
- [SDK erasure declaration](../../docs/sdk/api.md#the-declaration): add: “An HTTP history client without a provisioned pending registry MUST declare `erasure: false` even if the raw service has an erase operation. A deployment that supplies an external registry MUST configure every participating reader and writer to check it and fence restores against it.”


- [Languages, Go](../../docs/sdk/languages.md#go) does not spell the nullable tenant scope for Go. Add: “In `ACPActor.Tenants`, a nil slice permits only sessions without a tenant, an empty non-nil slice permits none, and the empty string represents `null` in an explicit list.”
- [Languages, Go](../../docs/sdk/languages.md#go) describes only the blocking history listener. Replace “It runs until the context is cancelled and does not return a listener address.” with “`ServeHistory` runs until the context is cancelled. Use `ListenHistory` with the same options to obtain a `HistoryService` handle with `URL` and `Close()`.”

- [API, The other parts](../../docs/sdk/api.md#the-other-parts) does not specify how a snapshot store advertises HTTP lease and tombstone support. Add: “A service adapter for a snapshot store may require an explicit exact-erasure capability and private persistent state for restart lease exclusion. Its native and served records may share a namespace if both paths preserve the same leases and tombstones.”

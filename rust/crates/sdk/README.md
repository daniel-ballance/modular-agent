# modular-agent: the Rust SDK

The Rust SDK for the revised [SDK specification 0.1](../../../docs/sdk/README.md). It wraps the Rust base, including the edition 4 draft's nested calls, plugin binding `/1`, shared data `/1`, and the base ACP Interface. It does not expose the Harness.

```rust
use modular_agent::testing::test_agent;
use serde_json::json;

let agent = test_agent()
    .script(json!([{ "text": "Hello." }]))
    .build()
    .await?;
let result = agent.session().await?.prompt("Say hello.").await?;
assert_eq!(result.text, "Hello.");
agent.close().await?;
```

`Agent::builder()` puts together a real agent. `openai()` uses the Responses API and `OPENAI_API_KEY`; `anthropic()` uses the Messages API and `ANTHROPIC_API_KEY`. Both are stateless. Their checked-in model catalogs are not fetched from a service. `with_test_endpoint` accepts only loopback HTTP and uses a dummy key, never an environment key. The OpenAI adapter reuses the base's request construction and response normalization; the subscription-only `provider-responses` adapter is not suitable for an API key. The SDK reuses the workspace's `reqwest` and the plugin host's `base64` release. The base uses `jsonschema` to validate Draft 2020-12 rather than mistaking Rust deserialization for schema validation. Its file and network schema retrieval features are disabled, and the validator explicitly refuses external resource retrieval.

## What is checked

From `rust/`:

```sh
export TMPDIR="$HOME/.cache/ma-std-tmp"; mkdir -p "$TMPDIR"
(cd ../conformance/acp && npm ci)
(cd ../conformance/tools && npm ci)
MODULAR_AGENT_SDK_REQUIRE=all mise exec -- cargo test --workspace --no-fail-fast -- --test-threads=1 > "$TMPDIR/rust-workspace.log" 2>&1
mise exec -- cargo fmt --all -- --check
mise exec -- cargo clippy --workspace --all-targets -- -D warnings
```

- **Workspace:** 333 passed, 1 failed, 0 ignored, including doctests. The only failing test is `services_from_other_sdks`: the Go, Python and TypeScript fixtures in this checkout predate `--listen`. Formatting, workspace Clippy with `-D warnings`, and the `ma` build passed.
- **History HTTP:** The shared history kit passed 39/39 checks normally and 42/42 with `--restart-ttl` against the filesystem-backed SDK example. The restart checks verify committed data survival and old lease exclusion after the TTL decreases from 6,000 ms to 1,000 ms.
- **Gap coverage:** Seven baseline SDK regression tests cover validation, structured results, events, restart and typed session errors. Two new tests cover actor options, rights intersections and fork identity. Two secret tests check slot generations, discard and process loss after staging, selection and activation. The Provider tests exercise readiness, catalog changes, credential lookup and admitted failure. A real stdio test additionally exercises request transformation and response observation.
- **Shared scenarios:** 84/84 across `inProcess`, `process:rust`, `process:go`, `process:python`, `process:typescript` and `service:rust` with all four fixture programs built and `MODULAR_AGENT_SDK_REQUIRE=all`. The Rust runner also attempts the other three service placements: 2/14 pass in each because they need no fixture plugins; the other 12 in each are expected to fail until those SDKs supply `--listen`. Crash steps kill and reap the agent's group and each fixture service's group before starting fresh services for reopen.
- **Revised composition:** Seven tests cover history and command-bookkeeping requirements, erasure and history-service eligibility, unknown models, `step.after` refusal in both placements, answer queue verification, opaque Provider data and explicit built-in parts.
- **Placement:** 1 test checks process startup failure, environment opt-in, the `pluginHost` contradiction, and a real served tool result. 7 SDK milestone tests cover session operations, declaration values, hooks and commands, progress, nested calls and stale contexts, refusal to serve in-process-only items, and the memory environment. The relevant tests run both in process and through the real plugin host over an in-memory duplex.
- **Guides:** 12 offline tests across guides 01–09 and one crate doctest. The guide 03 and guide 06 process tests load the Rust fixture program over real stdio.
- **Providers:** Three loopback HTTP tests cover Responses streaming, Messages streaming and admitted credential failures. `tests/live.rs` compiles and returns before checking keys unless `MODULAR_AGENT_LIVE=1`; each Provider also checks that its own key is present. No live requests were run.
- **ACP and reference:** `ma` passed 17/17 reference checks, 188/188 on ACP stdio and 193/193 directly on ACP WebSocket, both with crash, probe and job checks. The SDK tests also verify two simultaneous tokens select independent principals and enforce project scope.
- **Plugin binding:** The Rust conformance plugin passed 146/146 on stdio and 153/153 directly on WebSocket, including both Runtime tiers. No bridge was used. SDK/transport tests cover refused registration, unreachable services, losing a pending tool call, the 64 MiB limit, normal close, and WSS with a generated self-signed certificate (rejected when untrusted).

To repeat the Rust runner matrix (build each peer using its fixture registry entry first):

```sh
mise exec -- cargo build -p sdk-scenarios --bin modular-agent-fixtures
MODULAR_AGENT_SDK_REQUIRE=all mise exec -- cargo test -p sdk-scenarios --test shared -- --nocapture
```

Run the shared history kit from `rust/` with a fresh disposable store and a free port:

```sh
mise exec -- cargo build -p modular-agent --example history_service
umask 077
scratch=$(mktemp -d)
openssl rand -hex 16 > "$scratch/token"
node ../conformance/history/run.mjs http://127.0.0.1:39071 "$scratch/token" \
  --restart-ttl -- "$PWD/target/debug/examples/history_service" \
  127.0.0.1:39071 "$scratch/token" "$scratch/store"
rm -rf "$scratch"
```

## WebSocket placement

- `serve_websocket(plugin, ServeOptions { listen, token_file, tls })` returns a `WebSocketServer` with `url` and async `close()`. Port zero binds an available port. `serve(plugin)` retains stdio.
- `Agent::builder().service_plugin(ServicePlugin::new(url, token_file).config(config))` loads a service after explicit process plugins. A plugin host accepts service and process entries in `MODULAR_AGENT_PLUGINS`. Startup failure is `invalid_composition`. Set `MODULAR_AGENT_PLUGIN_IDLE_MS` to change the 30-second JSON-RPC ping interval for silent connections with pending calls.
- `agent.serve_acp_websocket(AcpOptions { compose }, AcpServiceOptions { listen, actors, tls })` returns the same server handle. Each `AcpActor` binds its token file to a configured actor, tenant scope and canonical project roots. `None` leaves a scope unrestricted; in an explicit tenant list a `None` entry allows a session without a tenant. Token selection does not consult `MODULAR_AGENT_ACTOR`.
- Use trusted loopback for plain `ws:`. `TlsOptions { cert_file, key_file }` enables `wss:` using a PEM certificate chain and private key; the plugin client verifies the server against the system trust store. Generate tokens with at least 128 bits of randomness and keep their files owner-readable only. The transport uses [Tokio Tungstenite 0.30's upgrade callback](https://docs.rs/tokio-tungstenite/0.30.0/tokio_tungstenite/fn.accept_hdr_async_with_config.html) and [message and frame limits](https://docs.rs/tungstenite/0.30.0/tungstenite/protocol/struct.WebSocketConfig.html). Deployments need no Node bridge.

## Built so far

| Milestone | State |
|---|---|
| 1. Compose an agent | Project, durability, history, Runtime and environment selection, Providers, tools, plugins, process plugins, WebSocket service plugins, models, settings, approval, credentials and question handlers. The built-in constructors include `transient_runtime`, `durable_runtime`, `local_environment`, `environment_credentials` and `file_credentials`. Custom Runtime, environment and history implementations are not yet exposed through SDK traits. |
| 2. Sessions and turns | Create, open and recover, prompt and stream, send, cancel, settings, fork, move or rewind, gated history, wait for idle, commands, erasure where supported and close. Text input and keys, `PromptOptions` for structured results, and `events(from_entry)` for replay and live delivery. The input API still takes text; generic Content input and typed event variants remain gaps. |
| 3. Actors and questions | `several_actors`, `session_limits` and `tenants` opt in. `session_with` supplies initial actors and tenant. `r#as`, `join`, `leave`, proposals and `set_limit` use effective rights; the opt-ins remain false in `ma`. `questions` lists open questions, `answer` answers them by ID, and `on_question` overrides the agent handler. With no eligible answerer, approval refuses. The SDK and `ma` use durable staging for secret answers; only the stored name leaves the store. |
| 4. Tools | Typed input and hints, result/decline/cancel handling, approval/choice/text questions, context progress/log, working environment operations and nested calls. Input is checked against JSON Schema before deserialization and execution. `.output::<T>()` or `.output_schema(schema)` publishes `returns`; `ToolOutput::value` emits structured output. Validation runs after `tool.after`. `PromptResult::tool_results` lists only model calls; nested calls stay in history. A tool can return Content (`Vec<Value>`) directly. Several advanced context callbacks remain unavailable. |
| 5. Errors | Stable SDK codes; typed base causes map writer conflicts, missing sessions, conflicting work and missing rights without matching error text. Other untyped failures can still map to `internal`. |
| 6–8. Plugins, serving, hosting | Named plugins, setup/config, item replacement, per-point hook methods and plain commands in both placements. Output gate and other in-process-only hook variants are not exposed; `define_hook` registers a point but does not yet expose calling or subscribing to it. `serve` rejects flagged and defined items, including those registered in `setup`. Developer Providers register in process or over the plugin binding on stdio or WebSocket. `step.after` refusal fails a turn and `tool.after` sends a full wire transform. Other generic part registrations are not yet exposed. |
| 9. Testing | Scripted Provider indexed by the final request, test agent, `testing::answers` with `Answers::assert_done`, memory environment, `TestAgentBuilder::over_wire` and the shared runner with all seven fixture plugins in-process, on stdio and on WebSocket. `restart(agent)` stops tracked work without settlement and rebuilds an in-process test agent on the same store. It does not stop work detached from a plugin call; the shared runner still uses real process kills. The runner supports `as`, `send`, `answer`, `wait` and the `crashWhen.count` and `crashWhen.record` triggers. |
| 10. Guides | Offline examples checked, with substitutions listed below. |
| 11. Providers | Developer `Provider` trait and two API-key Providers, checked offline. `CatalogNotifier::changed()` invalidates the local catalog view and `available()` gates dispatch. Serving supports catalog/readiness queries, streamed pieces, both host hooks and scoped credential reads. Unknown models are refused before Provider admission; other admitted errors become failed attempts. The request and assistant message wrap shared JSON and retain unknown fields; not all shared data is a typed Rust struct yet. |
| 12. Nested calls | In process and served. The core permits four levels, counting the outer call, and runs every nested call through its own gates. |
| 13. Declaration and ACP | Declaration from the installed parts and host policy. `serve_acp(AcpOptions::default())` serves the Agent's configured project on stdio; `serve_acp_websocket` authenticates independent ACP connections by bearer token. An `AcpComposition` can compose Agents by canonical project and saved session, provide project settings and attach MCP servers. ACP installs recovery before returning, but does not wait for the recovered turn to finish. Call `serve_acp` before opening embedded sessions, on an agent built with `plugin_host(true)`. |
| 14. HTTP history | `http_history(url, token_file)` wraps the base client. `serve_history(store, ServeHistoryOptions::new(address, token_file))` serves a dedicated durable snapshot store on trusted loopback. The filesystem store implements this capability; in-memory history and the HTTP client do not. Native TLS, retention and transparent migration of an existing native store are not implemented. |

## Where the base and the specification differ

| Base behavior | SDK handling |
|---|---|
| The base's native settings include `step_limit`, `thinking`, and its own approval names. It refuses setting changes during a turn. | Use the portable names at the SDK boundary. `set_setting` returns `busy` during a turn and the declaration says `refused`. |
| The base can record some failures before a turn has a normal input record. | The fallback settlement records the admission ID so a prompt does not mistake that failure for a hand-back. |
| The Linux local environment declares cleanup through `SIGKILL` and supports saved points. | Report `strong` containment and `rewinding: true`, not the example values for a process-group-only environment. `confinesFiles` remains false: paths can lead outside the project. |
| Memory history does not support erasure or portable persistence. | Declare both false. |
| The native file lock has no expiry to report. | Map its typed writer conflict to `busy`, and the HTTP history client's bounded reopen failure to `held` with `retryAfterMs`. |
| The base ACP Interface usually owns one Harness per ACP session. | The adapter shares the SDK's existing composition. Closing an ACP session does not shut down that composition. |
| The base history API exposes snapshots and separate live notifications. | `events()` subscribes before taking its replay snapshot, gates replayed rows, and deduplicates overlapping entry events. `history().await` also projects each row through the output gate for the selected actor. Live events are still collected by the shared SDK sink, not a separate output gate stream for every represented actor. |

## Findings for the SDK specification

- **[API / Building an agent](../../../docs/sdk/api.md#building-an-agent), plugin host default.** Replace the `pluginHost` default with: “False, or true when any `processPlugins` or `servicePlugins` are given. A plugin host reads `MODULAR_AGENT_PLUGINS` after the explicit process and service entries. Explicit false is incompatible with either list being nonempty.”
- **[Testing / Finding the fixture programs](../../../docs/sdk/testing.md#finding-the-fixture-programs), argument count.** Replace “three more arguments after the fixture's name” with “four more arguments after the fixture's name”.
- **[Placement / The whole agent](../../../docs/sdk/placement.md#the-whole-agent), omitted scopes and handle.** Add: “Omitted `tenants` and `projects` apply no additional restrictions. An explicit empty list grants no access in that scope. An explicit tenant list permits no-tenant sessions only if it contains null. Project roots are canonicalized before matching, and include their descendants. Once listening, `serveAcp` returns the server's URL and close operation, as plugin `serve` does.”
- **[WebSocket / Connection lifetime](../../../docs/bindings/websocket.md#connection-lifetime), ACP control message.** After the liveness rule add: “For ACP over WebSocket, `$/ping` takes `{}` and returns `{}` even before `initialize`. Its default deadline is five seconds. It does not change ACP initialization or session state.” The ACP binding itself does not define a ping or control deadline.
- **[Placement / Services](../../../docs/sdk/placement.md#services), Rust spelling.** Add: “Rust retains the stdio forms `serve(plugin)` and `agent.serve_acp(options)`. Use `serve_websocket(plugin, ServeOptions { listen, token_file, tls })` and `agent.serve_acp_websocket(options, AcpServiceOptions { listen, actors, tls })` for the two WebSocket servers.”

- **[API / Building an agent](../../../docs/sdk/api.md#building-an-agent), credentials.** Replace the first `credentials` row with: “`credentials` | a credential store | environment variables. A writable store (such as `fileCredentials(path)`) implements the secret staging operations so a `secret` question can be answered.” Remove the duplicate row after `tenants`.
- **[API / Questions](../../../docs/sdk/api.md#questions), staging and replies.** After the sentence about secret values, add: “A successful secret reply returns the stored credential name to the asker only after the accepted stage is activated and the terminal answer is committed. A staged value without a committed selection is not an answer.”
- **[API / Providers](../../../docs/sdk/api.md#providers), catalog notifications.** Replace the `models()` row with: “Returns the full current catalog. In process, a Provider can call `changed()` to tell subscribers to read it again. The plugin binding has no Provider-catalog change notification; a host re-reads `provider/models` and `provider/available` before preparing a step.” The Rust synchronous `Agent::models()` still shows the initial catalog for served Providers; newly advertised IDs are not selectable until the plugin reloads.

- **[API / The declaration](../../../docs/sdk/api.md#the-declaration) (resolved in the revision):** The original table assumed next-turn settings, erasure in memory, and a single local environment design. The queued-policy ownership refinement is below. Replace the three rows with: “`settingsDuringTurn`: `nextTurn` if settings changes are recorded during a turn and deferred; otherwise `refused`.” “`erasure`: true only if the selected history store can erase.” “`commandContainment`: the selected environment's declared containment; a local environment can declare `processGroup` or `strong`.” Add: “`queuedJobReportsAfterRestart` comes from the Runtime's recovery policy; if omitted, clients use `queuedInputAfterRestart`.”
- **[API / Building an agent](../../../docs/sdk/api.md#building-an-agent) (resolved in the revision):** The error paragraph requires `dataDir` even when the durability page permits an explicit persistent store. Replace “a missing `dataDir`” with “a missing `dataDir` when the chosen durability or a configured part needs it and no explicit persistent history store supplies it.”
- **[API / Sessions and turns](../../../docs/sdk/api.md#sessions-and-turns) and [ACP / Sessions](../../../docs/bindings/acp.md#sessions) (resolved in the revision):** Embedded open waits for recovery, but ACP open must not wait. Replace the SDK row with: “`openSession(id)` installs recovery before admitting fresh work. The embedded SDK may wait for recovery; ACP MUST return once recovery is installed and allow reads, answers and cancellation immediately.” The Rust base now installs recovery before returning an ACP open result and drives it separately.
- **[API / Providers](../../../docs/sdk/api.md#providers) (resolved in the revision):** The base model port has no post-admission RPC error channel: a raised developer error reaches the Runtime as a failed attempt. Add: “Reject an unknown model before admitting a Provider request. After admission, a Provider that returns an error without a ModelError records a failed AssistantMessage with kind `other`; it does not turn a settled model attempt into an input error.”
- **[Testing / The testing kit](../../../docs/sdk/testing.md#the-testing-kit) (resolved in the revision):** A question handler error is specified to decline, so just raising on an extra question cannot fail a test. Replace the `answers` row with: “Answers in order; an unexpected question declines and is observable as a test failure on a separate verification handle. The handler's error must not escape the agent's question boundary.” The Rust helper exposes `Answers::assert_done`.
- **[Guide 01 / Stream the answer](../../../docs/sdk/guides/01-first-agent.md#stream-the-answer) (resolved in the revision):** The Rust workspace depends on `futures-util`. Replace `use futures::StreamExt;` with `use futures_util::StreamExt;` in the offline example.
- **[Guide 03 / Serve the plugin and Load it into an agent](../../../docs/sdk/guides/03-tool-in-another-process.md) (resolved in the revision):** The Rust load example assumes Python installed under `/srv` and a live model. Add: “For an offline Rust test, build `modular-agent-fixtures` and use `.process_plugin(ProcessPlugin::new([env!(\"CARGO_BIN_EXE_modular-agent-fixtures\"), \"tide\"]))` in its integration test, with `testing::scripted_provider` and `.model(\"scripted/script\")`. The fixture program calls `modular_agent::serve(plugin).await`.”

- **[Placement / Services](../../../docs/sdk/placement.md#services) (resolved in the revision):** Replace “serves any history store as the history service” with “serves a history store that durably commits the history service's opaque records and can enforce lease exclusion; unsupported stores are refused at startup.” In-memory history cannot meet the binding's restart guarantee without separate persistent storage. A native snapshot client is not necessarily an atomic opaque-record backend.
- **[API / Events](../../../docs/sdk/api.md#events) (resolved in the revision):** Replace the lag sentence with “On lag, the stream ends with `lost` and `data.fromEntry`, the ID of the last delivered history entry or null if none. Pass that cursor to `events(fromEntry)` to replay kept entries strictly after it, then resume live delivery. Live deltas and other live-only events cannot be recovered.”
- **[API / Sessions and turns](../../../docs/sdk/api.md#sessions-and-turns) (resolved in the revision):** Replace the structured result sentence with “`options.result` is a JSON Schema 2020-12 schema. On successful completion `value` contains the accepted JSON value, including JSON null when allowed. The SDK may obtain the candidate by asking the model for a final JSON value as text; missing or invalid candidates are fed back through the normal `turn.result` refusal and retry rules.”
- **[Testing / The testing kit](../../../docs/sdk/testing.md#the-testing-kit) (resolved in the revision):** Replace the `restart` row with “Rebuilds an in-process test agent over the same store and registrations, dropping tracked work without shutdown or settlement. Reopen the sessions on the returned agent. Detached work and external processes are outside this simulation; use a real process kill to test them.”

- **[API / The agent](../../../docs/sdk/api.md#the-agent), ACP options.** Replace the Rust ACP options description with: “`serve_acp(AcpOptions { compose })` takes an optional `Arc<dyn AcpComposition>`. The trait supplies composition by canonical project and optional saved session id, shared history, operator trust handling and new-session settings. Its `project_mcp(session, project, servers)` attaches ACP client-supplied servers; put trusted project-configured sources in the composed Agent. Composed Agents must enable plugin hosting and supply `data_dir`. With no factory, the server accepts only the built Agent's project and refuses nonempty client MCP specs.”
### Guides 04, 06 and 07

- **[Guide 04 / Ask for a choice](../../../docs/sdk/guides/04-questions-and-approvals.md#ask-for-a-choice-and-answer-from-your-ui):** Replace the Rust limitation with: “The session handler overrides the agent handler. Use `session.questions()?` to read the waiting question, `session.answer(&id, answer).await?` for the click, and a pending handler future if the handler is only showing the question. The SDK drops that future when the question settles.”
- **[API / Hooks](../../../docs/sdk/api.md#hooks): Rust spelling and observer failures.** For the Rust examples use: “Register with `on_<point>` for the default order or `on_<point>_with(Order::First, handler)` (or `Order::Last`) for explicit order. Return `Gate::Refuse(reason)` from `on_step_after` to end the turn; the Rust SDK does not have an `end(reason)` constructor. A `turn.end` observer error is reported and leaves the original outcome unchanged.”

### New findings in round 2

- **[API / The declaration](../../../docs/sdk/api.md#the-declaration):** [The plugin binding](../../../docs/bindings/plugin.md#the-host-asks-the-runtime) has no Runtime registration keys for queued inputs or job reports. Rust's Harness installs their recovery and runs queued job reports while handing back ordinary input. Replace the two rows with: “`queuedInputAfterRestart`: the policy the agent implements for queued input on reopen. `queuedJobReportsAfterRestart`: the policy the agent implements for queued job reports on reopen; omit when it equals `queuedInputAfterRestart`.”
- **[API / The declaration](../../../docs/sdk/api.md#the-declaration):** The fixed `waitingThroughRestart: false` contradicts the SDK's use of the installed Runtime's capabilities. [ACP](../../../docs/bindings/acp.md#questions) defines this as asking an interrupted in-turn question again, not retaining a pending wire request. Replace the row with: “`waitingThroughRestart`: true only when the chosen durable Runtime and host support re-asking an interrupted in-turn question on recovery; otherwise false.”
- **[API / Building an agent](../../../docs/sdk/api.md#building-an-agent):** The `dataDir` row and error paragraph would also reject the [default ephemeral agent](../../../docs/sdk/concepts.md#defaults), which uses agent-owned scratch for its local environment. Replace the row default with: “None. Required by parts whose local bookkeeping must survive restart; the default ephemeral local environment may keep temporary command bookkeeping in an agent-owned scratch directory.” Replace “a part that keeps local recovery bookkeeping (such as the local working environment) with no `dataDir`” with “a part that needs local recovery bookkeeping to survive restart (such as the local working environment under `kept` or `durable`) with no `dataDir`.”
- **[Placement / Services](../../../docs/sdk/placement.md#services):** The normative [history service](../../../docs/bindings/history-http.md#writing-one-writer-at-a-time) requires restart durability. Replace “The memory store can be served only for tests, where losing everything on restart is acceptable; a build that does not offer that says so.” with “A volatile memory store cannot be served as a conforming history service. A test-only in-memory peer may simulate the wire but does not conform to the history service binding.” Rust refuses memory and client-only stores, including for tests.

### Findings from guides 05 and 09

- **[API / Sessions and turns](../../../docs/sdk/api.md#sessions-and-turns):** Add: “`lastTurn()` returns the latest settled turn as a PromptResult, or no value if none exists; it does not admit input. In Rust, `Session::last_turn()` is synchronous and returns `Result<Option<PromptResult>>`.”
- **[API / The agent](../../../docs/sdk/api.md#the-agent) and [Actors and rights](../../../docs/sdk/api.md#actors-and-rights):** For the Rust guide, use: “Call `Agent::session_with(SessionOptions { settings, tenant, actors })` for per-session options. The embedded actor is `user`; enable `several_actors` to join additional principals and use `session.r#as(actor_id)?` to act for one. ACP authenticates its own actor.”
- **[Placement / Services](../../../docs/sdk/placement.md#services):** Add for Rust: “`serve_history(file_history(dir)?, options)` keeps separate opaque service records, not a live export of native sessions. Use a separate service process or schedule the server on a separate task on a multi-thread Tokio runtime: the SDK HTTP client makes blocking store calls.”

**Remaining implementation gaps.** The Rust SDK still lacks several generic part and job interfaces, dynamic tool-source serving, custom hook subscription and invocation, the public `output` handler, and some context and in-process hook variants. These are not requests to relax the specification. The live suite has not been run against model services; the Anthropic adapter does not advertise a reasoning setting, so that check does not run for it until the adapter gains one.

**Proposed shared scenarios.** The revision added `nested-call` (resolved for the two recorded results and one model call in `PromptResult`). It could also assert `parentCallId` and that the nested result is not model-visible. Add `queued-cancel`: park an input `after` a held call, cancel, then retry its key; verify it returns `handedBack` without another turn. `send` now exists; this still needs cancellation and admission-key expectations.

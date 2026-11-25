# modular-agent: the Rust SDK

The Rust SDK for the [SDK specification](../../../docs/sdk/README.md). It wraps the Rust base, including edition 4's nested calls, plugin binding `/1`, shared data `/1`, and the base ACP Interface. It does not expose the Harness.

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

`Agent::builder()` puts together a real agent. `openai()` uses the Responses API and `OPENAI_API_KEY`; `anthropic()` uses the Messages API and `ANTHROPIC_API_KEY`. Both are stateless. Their checked-in model catalogs are not fetched from a service. `with_test_endpoint` accepts only loopback HTTP and uses a dummy key, never an environment key. The OpenAI adapter reuses the base's request construction and response normalization; the subscription Responses adapter is not suitable for an API key. The SDK reuses the workspace's `reqwest` and the plugin host's `base64` release. The base uses `jsonschema` to validate Draft 2020-12 rather than mistaking Rust deserialization for schema validation. Its file and network schema retrieval features are disabled, and the validator explicitly refuses external resource retrieval.

## Subscription Providers

```rust
use modular_agent::{
    Agent, ChatGptOptions, ClaudeOptions, GrokOptions, chatgpt, claude, grok, subscription_logins,
};

let logins = subscription_logins("/path/to/auth.json");
let builder = Agent::builder()
    .provider(chatgpt(ChatGptOptions::new(logins.clone()))?)
    .provider(grok(GrokOptions::new(logins.clone()))?);
// Optional: load the Claude Provider as a process plugin.
let builder = builder.claude_provider(claude(ClaudeOptions::default())?);
```

Use `sign_in("grok", &logins, options).await` and
`sign_out("grok", &logins).await`. Use `"chatgpt"` for a ChatGPT sign-in.
`SignInOptions` has `device`, `client_identity`, `on_step`, `on_notice`
and `paste`, a Tokio unbounded receiver of pasted lines. Grok ignores
`device` and `paste` and reports `SignInStep::DeviceCode` then `Waiting`,
never `OpenAndPaste`. The SDK never opens a browser.

`ChatGptOptions::models` and `GrokOptions::models` enroll exact model ids
with limits and input types. Both Providers use the shipped shared
catalog and refresh under the same login file lock. `client_identity`
defaults to `modular-agent` and accepts 1–64 ASCII letters, digits, periods,
underscores or hyphens. Grok sends it as the device form's `referrer`,
not on model requests.

Claude needs Node.js 22 or newer and Claude Code. Set
`ClaudeOptions::program` to the TypeScript program, or set
`MODULAR_AGENT_CLAUDE_SIDECAR`. The install location is
`~/.local/share/modular-agent/sidecars/claude/dist/src/main.js`.
`ClaudeProvider::available().await` checks for a Claude plan sign-in;
`unavailable_reason().await` explains a refusal. The Rust SDK does not read
Claude credentials, pass them to the program, or sign in.

## What is checked

For ADR 0035, 488 workspace tests, formatting, Clippy and separate builds of `ma` and `agent-base` passed. The AG-UI kit passed 48/48; named plugin callers passed 29/29. The reference checks passed 28/28. Stdio ACP passed 190/190; WebSocket ACP passed 195/195, the plugin kit 153/153 and separate-listener isolation 14/14. Both scripted demos passed. No model service was contacted.

The [covered approval tests](tests/covered_approvals.rs) check live calls at two nesting depths and waiting calls reopened with and without coverage in the original view. They check denial, a read-only parent, another gate's refusal, a change to `never` before dispatch, and a fresh allow after process loss. The covered approval round passed 484 workspace tests and 28 reference checks.

The waiting approval tests exercise the public SDK with a scripted model and an observable counter. They check the default live policy, invalid compositions, route-bound polling, expiry before and after an allow, revocation, changed input and registration, erasure and fork refusal. A served Runtime and an in-process Runtime run the dispatch cases. Separate processes reopen kept and durable sessions after the origin turn, the decision, and the first effect.

The shared runner implements `poll`, `decide`, `clock`, `barrier`, `change` and `stop`. It keeps the actual history batches, clock and counter across writer loss. The 28 ADR 0034 fixtures passed in process, on stdio and on WebSocket with the Rust tools (84 cases). The AG-UI fixture also checks a presence stream opened on return and a race against an ACP answer on the same writer. The shared telemetry adapter records active work at the parked checkpoint and flushes ended spans before releasing the decision.

For the waiting approval round, 476 workspace tests passed. Formatting, Clippy, the separate `ma` and `agent-base` builds, and both demos passed. `ma` passed 27/27 reference and 190/190 stdio ACP checks. The WebSocket kits passed 153/153 plugin, 14/14 listener-isolation and 195/195 ACP checks. AG-UI passed the 26 existing cases plus the eight waiting cases from the parallel conformance branch. The in-process telemetry kit passed 16/16 cases, including all four waiting scenarios with and without export.

The Interface tool tests use the public SDK with a scripted Provider. They cover approval denial, exact advertisements and output gates, disconnect and a new connection, an early or expired report, revoked rights, racing reports, cancellation, erasure, and a handoff recovered after `SIGKILL`. They check that a Runtime served by another process receives an empty `calls` list and still sees the checked result in its next request. They also check the two tool spans and the declaration of an agent without the option. These are Rust SDK tests, not a shared scenario: the current scenario format has no authenticated executor route, handoff or report action.

The earlier Interface tool round passed 449 workspace tests, including 11 Interface tool tests. Formatting, Clippy, and separate `ma` and `agent-base` builds passed. That `ma` passed all 27 reference checks in that round. The stdio ACP kit passed 188/188 with crash, probe and job checks. The direct WebSocket kits passed 153/153 for plugins, 14/14 for listener isolation and 193/193 for ACP. The project-notes demo passed its scripted and crash-and-reopen runs.

The telemetry tests use the OpenTelemetry in-memory exporter, a failing exporter and a scripted Provider. They check admission, turn, step and call parentage, the absence of fixture payloads, the no-SDK path, private recovery checkpoints and fork exclusion. A plugin carrier test checks both directions with and without agreement and ignores unscoped callback context. This run passed 434 workspace tests, formatting and Clippy. The separate `ma` and base builds and the locked history demo build passed. The WebSocket kit passed 153/153 for the plugin, 14/14 for listener isolation and 193/193 for ACP. The shared telemetry check also kills the agent group with SIGKILL at the counter barrier and reopens the same store. It observes the resume checkpoint before the next Provider dispatch and checks that the counter effect is not repeated. The in-memory tests still cover fork exclusion. Wire tests check the current trace context on each MCP catalog page and tool call. A retry gets a new step under the turn and settles under that step.

From `rust/`:

```sh
(cd ../conformance/acp && npm ci)
(cd ../conformance/tools && npm ci)
MODULAR_AGENT_SDK_REQUIRE=all mise exec -- cargo test --workspace --no-fail-fast -- --test-threads=1
mise exec -- cargo fmt --all -- --check
mise exec -- cargo clippy --workspace --all-targets -- -D warnings
```

- **Linux:** 425 workspace tests passed, 0 failed, 0 ignored, including doctests and five opt-in live checks that returned without making requests. Formatting, Clippy with `-D warnings`, the separate `ma` and base builds, and the locked history demo build passed. The `ma` reference checks passed 24/24 and the stdio ACP kit passed 188/188 with crash, probe and job checks enabled. An earlier WebSocket run passed 153/153 for the plugin, 14/14 for separate-listener isolation and 193/193 for ACP.
- **Apple silicon, macOS 27.2:** The locked builds of `ma`, the base agent, the SDK fixtures and the `history_service` example passed. The workspace had 401 passed, 0 failed and 2 ignored, including doctests. The ignored tests need Linux `/proc` or check cleanup of processes that escape their group. Other Linux-only tests are excluded at compile time. The `ma` reference checks passed 23/23 and the stdio ACP kit passed 188/188 with crash, probe and job checks enabled. The base plugin kit passed 145/145; it omits the strong-containment `setsid` check. The HTTP history client uses `CLOCK_MONOTONIC`, which advances during suspension on macOS, so it does not require a lease margin there.
- The workspace runs used the Rust fixtures; other languages' fixtures were not built for these runs. The five opt-in live checks compile and return before checking credentials unless `MODULAR_AGENT_LIVE=1`. The subscription checks also require `MODULAR_AGENT_LIVE_LOGINS`. The Grok check sends one short prompt and defaults to `grok-4.7` unless `MODULAR_AGENT_LIVE_GROK_MODEL` is set.
- **ADR 0030 checks:** ACP isolation passed 15/15 on `ma` and 17/17 on the base agent over stdio, and 17/17 and 20/20 over WebSocket. Capacity passed 28/28 on each over stdio. The seed turns now take their input in order; only the admissions for the last slot race. Erasure passed 18/18 on each against Rust HTTP history. The plugin listener passed 7/7 isolation checks. History passed 42/42 with isolation and 42/42 with restart and a changed lease TTL. The Harness tests charge held output at all three scopes and keep ordinary writes out of control headroom. These checks do not prove physical write reservation or a cutoff at every external handoff.
- **History HTTP:** The shared history kit passed 39/39 normally and 42/42 with `--restart-ttl` against the SDK example using the portable store path. It verified committed data survival and old lease exclusion after the TTL decreased from 6,000 ms to 1,000 ms.
- **Public API regressions:** Four job tests cover keyed starts, scoped callbacks, in-process and served cancellation, in-process resume, and served resume after a real `SIGKILL`. They also verify that unconfirmed cleanup revokes callbacks and bars resume. Two interruption tests cover both reasons, live delivery to SDK and ACP followers, `lost` on waiting SDK prompts, streams and ACP prompts, and recovery without a recorded interruption. One timed-ask test runs embedded and served tools and checks automatic late continuation. One custom Runtime test checks both placements; another uses two process exits to test the resume checkpoint and late continuation. A native Runtime test exits before and after the pending commit. Three portable history tests cover opaque fenced appends, metadata creation and cursor/limit forwarding, and live writer loss while idle, on both push revocation and failed renewal. Two binding-part tests cover an environment and image progress in both placements, and the Provider declaration ceiling. The public actor test covers proposal listing, release and decline receipts, withdrawal, and conflicts on repeat settlement. Two typed-payload tests cover step snapshots, model usage, tool and turn events, and unknown fields.
- **Provisional setup:** Rust wrote file history early when a new session enrolled an actor or changed a setting. HTTP and portable custom history also published before admission when a setting followed a tenant or actor setup record. Six public SDK cases cover native and served Runtimes with file, HTTP and Registrar stores. They check close and a real process kill without input, a refused input, original setup order and timestamps at first admission, and one initial batch for the copied prefix and fresh fork setup. A `ma` stdio ACP test checks `session/new`, a configuration change, close and first prompt against file history.
- **Same-connection callbacks:** Rust did not reproduce Go's job-progress deadlock: it spawned job progress off the reader. Those tasks could instead deliver the second update before the first. The Runtime report handler, in contrast, could await its own output gate on the reader. The bounded notification worker now preserves arrival order without delaying unrelated replies or callbacks. Public SDK tests cover two image-bearing job updates through the owner's own output gate to an `events()` follower over stdio and WebSocket. They also cover held tool and environment output, a same-peer Runtime model request and streamed Provider events, a Runtime report with a nested history callback, catalog refresh before the triggering tool returns, and ordered custom events through the emitting plugin's gate.
- **Shared scenarios:** 153/153 with `MODULAR_AGENT_SDK_REQUIRE=all`: 17 each in process and with each of Rust, Go, Python and TypeScript over stdio and WebSocket. The history-service fixture binds a loopback port before returning its URL. Crash cleanup ignores both `ENOENT` and `ESRCH` when a process exits during the `/proc` scan. An additional committed-record crash check passed.
- **Revised composition:** Seven tests cover history and command-bookkeeping requirements, erasure and history-service eligibility, unknown models, `step.after` refusal in both placements, answer queue verification, opaque Provider data and explicit built-in parts.
- **Placement:** 1 test checks process startup failure, environment opt-in, the `pluginHost` contradiction, and a real served tool result. 7 SDK milestone tests cover session operations, declaration values, hooks and commands, progress, nested calls and stale contexts, refusal to serve in-process-only items, and the memory environment. The relevant tests run both in process and through the real plugin host over an in-memory duplex.
- **Guides:** 12 offline tests across guides 01–09 and one crate doctest. The guide 03 and guide 06 process tests load the Rust fixture program over real stdio.
- **Providers:** API-key checks cover the vendored table, request mapping, budget caps, streaming, and admitted failures. The subscription checks verify the shared table byte for byte, both ChatGPT OAuth flows, Grok's device form and polling outcomes, locked refresh, `invalid_grant`, file permissions, model mapping and client identity. The Grok tests check the five-second backoff with a paused clock, HTTPS verification addresses, the output cap and replay of encrypted reasoning. Requests and refresh failures are checked in process and over the plugin binding. A fake Claude program checks process registration, streamed pieces, tools, catalog updates and refusal of API-key use. No live request was made.
- **ACP and reference before ADR 0030:** `ma` passed 18/18 reference checks, 188/188 on ACP stdio and 193/193 directly on ACP WebSocket, both with crash, probe and job checks. SDK tests cover per-token principals, project scope, JSON-RPC ping before and after initialize and a watch-only token reopening an actor's broader recorded grant without changing it.
- **Plugin binding:** 146/146 on stdio and 153/153 directly on WebSocket, including both Runtime tiers. No bridge was used. SDK/transport tests cover per-connection setup and stop, refused registration, unreachable services, losing a pending tool call, the 64 MiB limit, normal close, and WSS with a generated self-signed certificate (rejected when untrusted).

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

- `serve_websocket(plugin, ServeOptions { listen, token_file, tls, projects })` returns a `WebSocketServer` with `url` and async `close()`. Port zero binds an available port. `serve_websocket_factory` makes a fresh plugin per authenticated connection; setup receives that connection's configuration. One token identifies one host trust scope. To distinguish callers on one listener, use the named factory below. An SDK network working environment requires a factory and an exact permitted canonical project at initialization. Host-provided `home` is not a grant to open a path, and this check does not confine files or commands on its own. `serve(plugin)` retains stdio.
- `Agent::builder().service_plugin(ServicePlugin::new(url, token_file).config(config))` loads a service after explicit process plugins. A plugin host accepts service and process entries in `MODULAR_AGENT_PLUGINS`. Startup failure is `invalid_composition`. Set `MODULAR_AGENT_PLUGIN_IDLE_MS` to change the 30-second JSON-RPC ping interval for silent connections with pending calls.
- `agent.serve_acp_websocket(AcpOptions { compose, ..Default::default() }, AcpServiceOptions { listen, actors, tls })` returns the same server handle. Omitted tenants allow only tenantless sessions; `Some(vec![None])` explicitly grants tenantless access. An explicit project list matches exact canonical paths; omitting it uses the serving composition's scope. An empty list grants nothing. A token caps the connection's rights without rewriting the actor's recorded rights. Each token may name additional represented actors. On stdio, supply `projects`, `tenants`, `rights` and `represents` in `AcpOptions`; they are not ACP parameters.
- Use trusted loopback for plain `ws:`. `TlsOptions { cert_file, key_file }` enables `wss:` using a PEM certificate chain and private key; the plugin client verifies the server against the system trust store. Generate tokens with at least 128 bits of randomness and keep their files owner-readable only. The transport uses [Tokio Tungstenite 0.30's upgrade callback](https://docs.rs/tokio-tungstenite/0.30.0/tokio_tungstenite/fn.accept_hdr_async_with_config.html) and [message and frame limits](https://docs.rs/tungstenite/0.30.0/tungstenite/protocol/struct.WebSocketConfig.html). Deployments need no Node bridge.

### Named plugin callers

Pass `serve_websocket_named` a factory and `NamedServeOptions`. Make one `PluginCaller::new(caller_id, token_file)` per credential. Set its `projects` to the exact roots this caller's environment can serve. The factory gets an `AuthenticatedCaller` with only `caller_id`. Use it to select retained state before processing setup or tool input. The SDK makes a fresh instance on every successful upgrade, even for two sockets using the same token. It adds nothing to plugin messages.

An empty table, an empty or duplicate ID, an unsafe or unreadable token file, equal token values, or both a table and `token_file` fail with `invalid_composition` before listening. Missing or wrong credentials get HTTP 401 before the factory runs. A caller ID is neither a session actor nor a grant. Use separate confined processes if the plugin cannot isolate its callers.

### Serving AG-UI

Enable the `agui` Cargo feature. It is enabled in `ma`; applications that only embed the SDK need not build the HTTP adapter.

```rust
use modular_agent::{AcpActor, AguiActor, AguiOptions};

let server = agent.serve_agui(AguiOptions {
    listen: "127.0.0.1:0".into(),
    actors: vec![AguiActor::new("editor", AcpActor::local(token_file))],
    ..Default::default()
}).await?;
println!("{}", server.url); // HTTP origin
// While the app is serving, requests go to /agui/v1.
server.close().await;
```

Set `acp: true` on an agent built with `plugin_host(true)` for WebSocket upgrades on the same socket. Set `tls` to serve HTTPS. Set `client_ca_file` as well to require a client certificate; the bearer token is still required. `tenant` selects the creation tenant. `origins` adds allowed browser origins. Network trace parents are ignored unless `AguiActor::trust_trace_context` is set. `trace_state_keys` selects allowed vendor keys.

The client ID is not a credential. It selects the history view and executor route. The agent checks the token's actor, project, tenant and current rights. Open the optional presence stream before a run to answer a question while its turn is still running. Closing the listener detaches streams, not the admitted work. Reconnect by reading the thread snapshot. Send its ordered messages, followed by the new input or reports. The history cursor is optional.

Approval interrupts include `metadata["modular-agent.approvalCall"]: { name, input }` in `RUN_FINISHED` and in the thread snapshot's `waiting.questions`. It is the call shown to this approver, not the model's draft. If the output gate changes or blocks the approval view, the client gets no interrupt. Use the call for display and the interrupt ID to answer.

Call `GET /agui/v1/threads?limit=100` to list kept threads in this project and tenant. Each row has only `threadId`, `updatedAt` and `waiting`. The summary counts questions this client can answer and open calls on its executor route. `turn` is `running`, `interrupted` or `none`; a finished turn can still have an open question or call. Listing does not open the session, join an actor or establish presence. Pass `next` back as `after` on the same client. If the server returns HTTP 400 `invalid_request` for an expired cursor, list again without it. The SDK's ACP `session/list` also returns `_meta["modular-agent"].waiting`. ACP is not an executor route.

For closures, take `waitCursor` from the HTTP thread snapshot. Send it as `after` to `GET /agui/v1/threads/{threadId}/wait-closures`. Each SSE item is one committed closure with a new cursor. Save that cursor after processing the item. A reader that falls behind disconnects. A missing cursor is HTTP 400; an expired, foreign or invalidated cursor is HTTP 409. Get a fresh snapshot to reset the view. The feed does not deliver an interrupt, report tool output or keep an approval route present.

On kept history the snapshot also offers `runReceipts: 1`. Send `runId` as one query value to `GET /agui/v1/threads/{threadId}/run-receipt`. `terminal` describes this exchange's released terminal group, not client receipt. `work` describes its admission or linked turn, not the latest turn. These reads require current membership and `watch`. They do not open a writer or trigger recovery. A 404 is not permission to resubmit. Use a new run ID for the remaining decisions after a partly accepted batch.

Rust reserves the terminal marker under `agui-receipts/` in the deployment state directory. Keep that directory with the history deployment, including when history is served over HTTP. A custom kept store without an explicit `data_dir` uses `$XDG_STATE_HOME/modular-agent/rust` (default `~/.local/state/modular-agent/rust`). A portable session or a fork alone is not a receipt index.

Use `Agent::session_summary(id, &viewer)` to read kept work for one authenticated viewer. Both listings use the same read of each committed record. The Harness checks recorded or prospective rights without joining. The store's optional `HistoryStore::confirms_writer` operation supplies read-only evidence of a live writer; Linux file history checks its kernel lease socket. For a trusted local application, `Agent::sessions` exposes `SessionInfo.unfinished_turn` without taking a lease. `Agent::open_interrupted_session(id, &local_options)` checks the local operator's scope and `watch` under the writer lease before starting ordinary recovery. It returns `None` if the turn already ended.

`AguiState` names the document plugin and supplies its current revision and snapshot. Only that plugin's state events update the projection. `raw_events` maps an emitting plugin and event name to a configured foreign source. The actor's output gate still applies. For final AG-UI frames the gate's recipient is the nonsecret client ID, so two clients of one actor can have different views.

Run `conformance/agui/rust.sh` from the repository root for the offline kit. Ordinary conversations use `ma`; the remaining cases use the SDK fixture. It includes wait-closure and run-receipt cases. The Rust crash test also kills the adapter between transport release and recording.

## Built so far

For covered approvals, set `AgentBuilder::approval_covers_nested(true)` and install the gate with `.approval(Approval::Ask)` or another policy. The option defaults to false. Only this combination declares `approvalCoversNested: true`. Show the entire `Question::call` and whether `Question::covers_nested` is true. An allow on a marked top-level request answers the approval check of its nested calls in that dispatch, at any depth. It does not grant rights or bypass any other gate. A parent that did not ask covers nothing.

Each covered nested start records `toolStarted.data.approvalCoveredBy: { toolCallId, requestId }` for the top-level call and its request. A repeated parent needs a new allow. A waiting parent can use its original allow for its first dispatch on continuation; turning on coverage after it asked does not change the original view.

For approvals that wait, set `AgentBuilder::max_approval_wait_ms(u64)`, install the gate with `.approval(Approval::All)` (or another policy), and use kept or durable history. The maximum must be a positive shared Duration. Both built-in Runtimes support this; a served Runtime needs the path for continuing with an empty call list. An incompatible composition returns `Code::InvalidComposition`. Check `agent.declaration()?["approvalsOutlastTurns"]` for support. The maximum is not a session default or a project setting.

Opt in with `session.set_setting("approvalWait", json!("untilDeadline"))?` or set the same field in `SessionOptions::settings`. The default is `"live"`. A parked call appears in `PromptResult::open_tool_calls`, without a tool result. It does not keep `wait_idle` busy. On return, use `session.questions_present().await?` on the answering actor's handle. Check `Question::call`, `approval_wait` and `deadline`. Answer on that handle with `session.answer(&id, Answer::Allow).await?` or a tagged decline. `questions()` does not establish delivery. Closing an idle kept session preserves its wait, not its presence or delivery.

ACP keeps permission RPCs live-only. On a later connection, poll `_modular-agent/requests` before sending `_modular-agent/answer`. An AG-UI client opens presence, gets the thread snapshot, and submits `resume` on that presence route. Neither route turns the inbox item into a tool call. `ma` enables it only when the operator configures approval and a wait maximum.

For Interface-run tools, pass `InterfaceToolSource { source_id, actor_id, route_id, result_timeout_ms, tools }` entries to `AgentBuilder::interface_tools`. `tools` holds shared tool definitions with `callers: ["model"]`. No local tool handler runs. The agent declares `interfaceTools: true` only when configured with these sources and a compatible Runtime. Custom Runtimes opt in with `RuntimeSupport::interface_tools`.

After authenticating the actual actor and checking its project and tenant scope, a trusted app calls `Session::connect_interface_tools(route_id, actor_id, rights)`. Call `advertise` with the available subset of exact definitions and `next_call().await` to take a live executable request. `release(call_id).await` takes a specific staged ticket once; a call ID from history is not a ticket. Do not execute from history. After the originating turn ends, call `report_tool_result(report).await` on the same route, from the original connection or a new one. It returns `Accepted`, `AlreadySettled` or `Refused { reason }`, without dispatch. A valid report before turn end is refused with `Some("notReady")`. Dropping the connection clears its advertisements but does not close the session or settle its calls. ACP projects only the declaration. AG-UI uses the same connection and defers release until the end of the originating turn.

Use `Ask::link(question, uri)` for a link question. Pass an absolute URI separately from the prompt. The interrupt carries the gated URI in `metadata["modular-agent.link"]`. Its answer acknowledges the link, not a sign-in.

The `ma --agui` options are in the [standard configuration](../../../docs/reference/standard-configuration.md#the-program).

The Harness declares `telemetry: 1`, whether export is installed or not. Set `Agent::builder().agent_name("my-agent")` to supply a stable, non-sensitive GenAI agent name. Register the application's tracer and meter providers with `opentelemetry::global` before building the agent. The SDK uses the OpenTelemetry API only; the application owns sampling, export and shutdown. Durable turns save their span context and use it as the parent and a link when they resume. Forks and public history do not carry that context. The SDK sends no baggage or vendor state. ACP trusts the stdio launcher unless `AcpOptions::trust_trace_context` is `Some(false)`. A network peer is outside that scope unless its `AcpActor::trust_trace_context` is true. Work on a configured plugin connection can carry the trusted operation context. A callback stays in the trace of its parent work.

| Milestone | State |
|---|---|
| 1. Compose an agent | Project, data directory and disposable scratch, durability, built-in parts and explicit plugins, ordered process and service plugins, models, settings, approval, credentials and question handlers. `Registrar::runtime` accepts a `RuntimePart` with scoped, binding-shaped callbacks in process or served. `Registrar::history_store` accepts `History::from_portable` for metadata creation, lease-fenced opaque appends and paged reads and listings, or a native snapshot store. The Registrar also accepts custom environments, credentials, configuration and Interfaces. An explicit persistent store, including one installed by a plugin, requires `kept` or `durable`. |
| 2. Sessions and turns | Create, open and recover, prompt and stream, send, cancel, settings, fork, move or rewind, gated history, wait for idle, async actor-gated `last_turn`, erasure where supported and close. `prompt`, `prompt_stream` and `send` accept text or shared Content. Standard events expose typed payloads without losing wire fields. A commit failure or lost lease interrupts the open writer, cancels turn work, notifies followers live, and settles waiting prompts with `lost`. The HTTP client monitors renewal independently of writes, and a portable store may also signal revocation as soon as it detects it. |
| 3. Actors and questions | `several_actors`, `session_limits` and `tenants` opt in. `session_with` supplies initial actors and tenant. `r#as`, `join`, `leave`, `proposals`, `release`, `withdraw`, and `set_limit` use effective rights; the opt-ins remain false in `ma`. `release` returns an `InputReceipt`, including `handedBack` when declined, and a second settlement returns `conflict`. `questions` lists open questions, `answer` answers them by ID, and `on_question` overrides the agent handler. A timed non-approval `ask_with` can suspend a call (`Error::is_left_open()`); an accepted late answer runs the same call from the top with its answers reused. With no eligible answerer, approval refuses. The SDK and `ma` use durable staging for secret answers; only the stored name leaves the store. |
| 4. Tools | Typed input and hints, result/decline/cancel handling, approval/choice/text questions, context progress/log, working environment operations and nested calls. `progress` carries text or Content and `toolOutput` exposes both the text chunk and the reported Content, in process and served. Input is checked against JSON Schema before deserialization and execution. `.output::<T>()` or `.output_schema(schema)` publishes `returns`; `ToolOutput::value` emits structured output. Validation runs after `tool.after`. `PromptResult::tool_results` lists only model calls; nested calls stay in history. A tool can return Content (`Vec<Value>`) directly. Tool and command contexts can read paged raw history, emit custom events and start jobs owned by their plugin. |
| 5. Errors | Stable SDK codes; typed base causes map writer conflicts, missing sessions, conflicting work and missing rights without matching error text. Other untyped failures can still map to `internal`. |
| 6–8. Plugins, serving, hosting | Setup/config, reverse-order stop, item replacement, typed core hook registrations, actor lifecycle and Provider-piece observers, output transformations in process and served, and definition/subscription/invocation of custom hook points. Dynamic sources can announce changes over the binding. Commands can ask a question or make metered auxiliary model requests in process. An input hook can run a command instead of admitting a turn. A local tool gate can leave a question pending for a later answer. Job owners register cancellation and opt into resume. A user's `session.start` hook can list and resume its plugin's unfinished jobs; without that hook the SDK invokes the owner automatically. Cleanup that cannot be confirmed is recorded and fences the old execution. `Registrar::environment_part` accepts a binding-shaped `EnvironmentPart` in either placement, with byte reads/writes, optional listing and points, exec output and session cleanup. Native environments remain available through `Registrar::environment`. `on_step_before_change` can narrow a local Provider's tool allowance. With a binding-shaped Runtime, the host keeps that allowance alongside the prepared request without sending it on the wire. `serve` refuses in-process-only registrations and rejects in-process-only hook answers at call time. |
| 9. Testing | Scripted Provider indexed by the final request, test agent, `testing::answers` with `Answers::assert_done`, memory environment, `TestAgentBuilder::over_wire` and the shared runner with all seven fixture plugins in-process, on stdio and on WebSocket. `restart(agent)` stops tracked work without settlement and rebuilds an in-process test agent on the same store. It does not stop work detached from a plugin call; the shared runner still uses real process kills. The runner supports `expectCreateError`, explicit file or service history, `as`, `send`, `answer`, `wait` and the `crashWhen.count` and `crashWhen.record` triggers. |
| 10. Guides | Offline examples checked in `tests/guides.rs` and `tests/guide*.rs`. The live example in guide 01 imports `modular_agent_openai`, which the workspace does not ship yet ([#73](https://github.com/daniel-ballance/modular-agent/issues/73)). |
| 11. Providers | Developer `Provider` trait, table-driven OpenAI and Anthropic API-key Providers, ChatGPT and Grok subscription Providers with a shared login file, and Claude over the process binding. Unlisted models can be enrolled with `model_with_input` and have no reasoning controls. `CatalogNotifier::changed()` invalidates the local catalog view and `available()` gates dispatch. Serving supports catalog/readiness queries, streamed pieces, both host hooks and scoped credential reads. Unknown models are refused before Provider admission; other admitted errors become failed attempts. The request and assistant message wrap shared JSON and retain unknown fields; not all shared data is a typed Rust struct yet. |
| 12. Nested calls | In process and served. The core permits four levels, counting the outer call, and runs every nested call through its own gates. |
| 13. Declaration and ACP | Declaration from the installed parts and host policy; `runsToolsAtProvider` and `liveSessions` are false for the SDK 0.1 Provider port. `serve_acp(AcpOptions::default())` serves the Agent's configured project on stdio; `serve_acp_websocket` authenticates independent ACP connections by bearer token. An `AcpComposition` can compose Agents by canonical project and saved session, use a configuration's project trust and settings, and attach MCP servers. A composed ephemeral Agent keeps its scratch until the ACP session closes. Connections on one `serve_acp_websocket` listener reuse an open session's writer, each after its own scope checks. On the fixed-project service, an authorized open of that session from another listener on the same Agent gets `busy` after its scope checks; the first writer stays. A composed Agent or a writer in another process is refused by the history lease instead (`held`). ACP installs recovery before returning, but does not wait for the recovered turn to finish. Call `serve_acp` before opening embedded sessions, on an agent built with `plugin_host(true)`. |
| 14. HTTP history | `http_history(url, token_file)` wraps the base client. `serve_history(store, ServeHistoryOptions::new(address, token_file))` accepts a dedicated native snapshot store or an eligible persistent `PortableHistoryStore` on trusted loopback. `ServeHistoryOptions::lease_ttl` is a `Duration` declared by the service as `ttlMs`. It defaults to 15 seconds and must be a whole number of milliseconds, at least 1 ms. The SDK rejects invalid durations with `invalid_params`. A portable store owns lease enforcement, restart exclusion, atomic commits and tombstones, and opts in through `supports_history_service`. Its TTL must match `lease_ttl`; pass the same duration to `portable_file_history` when using that opaque filesystem store. An ineligible store is refused by name. `listen_history` returns the bound URL and close handle. In-memory history and the HTTP client cannot be served. Native TLS, retention and transparent migration of an existing native store are not implemented. |

| ADR 0030. Resource limits | `AgentBuilder::resource_limits` sets counts. `AgentBuilder::byte_limits` opts into logical JSON byte accounting for retained history, pending input, settlement and held output at session, tenant and agent scope. ACP project compositions share the serving pool. `ma` uses both sets of limits from its operator policy. `resourceReservations` still reports counts only. Logical byte accounting does not allocate physical store space. |
| ADR 0030. Pending erasure | Native file history puts the registry beside its snapshots. The snapshot-backed HTTP service declares [`pendingErasure: 1`](../../../docs/bindings/history-http.md#pending-erasure-registry-profile-pendingerasure-1). It stores the plans in the durable control record and orders publication, completion and guarded appends under the same lock. The old Rust routes and declaration are removed. On upgrade the service migrates existing private marks, keeping their bookkeeping IDs and completion flags. The client requires the profile to declare erasure, checks the registry before handoff and completes pending copies under the destination lease. Raw readers still bypass the Harness. Back up the registry and records together and verify restore freshness independently. |

## Remaining

Tracked in #38.

- Commands receive exec output in their result, not as a standard `toolOutput`: the command has no tool call ID. A separate event shape would be needed to report that progress to followers.
- `ModelRequest` and `AssistantMessage` still wrap shared JSON rather than representing all standardized fields as Rust structs. ACP trust lookup remains opt-in for composition factories; a fixed-project Agent has already loaded its plugins.

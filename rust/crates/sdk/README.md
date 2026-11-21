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

- **Workspace:** 365 passed, 0 failed, 0 ignored, including doctests. Formatting and workspace Clippy with `-D warnings` passed. The two live test functions compiled and returned before checking credentials.
- **History HTTP (previous Rust revision):** The shared history kit passed 39/39 checks normally and 42/42 with `--restart-ttl` against the filesystem-backed SDK example. The restart checks verify committed data survival and old lease exclusion after the TTL decreases from 6,000 ms to 1,000 ms.
- **Public API regressions:** Four job tests cover keyed starts, scoped callbacks, in-process and served cancellation, in-process resume, and served resume after a real `SIGKILL`. They also verify that unconfirmed cleanup revokes callbacks and bars resume. Two interruption tests cover both reasons, live delivery to SDK and ACP followers, `lost` on waiting SDK prompts, streams and ACP prompts, and recovery without a recorded interruption. One timed-ask test runs embedded and served tools and checks automatic late continuation. Two portable-part tests exercise a custom Runtime in both placements and opaque history appends with writer fencing. Two typed-payload tests cover step snapshots, model usage, tool and turn events, and unknown fields.
- **Shared scenarios:** 153/153 with `MODULAR_AGENT_SDK_REQUIRE=all`: 17 each in process and with each of Rust, Go, Python and TypeScript over stdio and WebSocket. The history-service fixture binds a loopback port before returning its URL. An additional committed-record crash check passed.
- **Revised composition:** Seven tests cover history and command-bookkeeping requirements, erasure and history-service eligibility, unknown models, `step.after` refusal in both placements, answer queue verification, opaque Provider data and explicit built-in parts.
- **Placement:** 1 test checks process startup failure, environment opt-in, the `pluginHost` contradiction, and a real served tool result. 7 SDK milestone tests cover session operations, declaration values, hooks and commands, progress, nested calls and stale contexts, refusal to serve in-process-only items, and the memory environment. The relevant tests run both in process and through the real plugin host over an in-memory duplex.
- **Guides:** 12 offline tests across guides 01–09 and one crate doctest. The guide 03 and guide 06 process tests load the Rust fixture program over real stdio.
- **Providers:** Six offline tests verify the vendored table byte for byte, every request mapping, fallback and budget capping, streaming, and admitted credential failures. The live cases compile and return before looking for credentials unless `MODULAR_AGENT_LIVE=1`. They were not run live.
- **ACP and reference:** `ma` passed 18/18 reference checks, 188/188 on ACP stdio and 193/193 directly on ACP WebSocket, both with crash, probe and job checks. SDK tests cover per-token principals, project scope, JSON-RPC ping before and after initialize and a watch-only token reopening an actor's broader recorded grant without changing it.
- **Plugin binding:** 153/153 directly on WebSocket, including both Runtime tiers. No bridge was used. SDK/transport tests cover per-connection setup and stop, refused registration, unreachable services, losing a pending tool call, the 64 MiB limit, normal close, and WSS with a generated self-signed certificate (rejected when untrusted).

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

- `serve_websocket(plugin, ServeOptions { listen, token_file, tls })` returns a `WebSocketServer` with `url` and async `close()`. Port zero binds an available port. `serve_websocket_factory` makes a fresh plugin per authenticated connection; setup receives that connection's configuration. `serve(plugin)` retains stdio.
- `Agent::builder().service_plugin(ServicePlugin::new(url, token_file).config(config))` loads a service after explicit process plugins. A plugin host accepts service and process entries in `MODULAR_AGENT_PLUGINS`. Startup failure is `invalid_composition`. Set `MODULAR_AGENT_PLUGIN_IDLE_MS` to change the 30-second JSON-RPC ping interval for silent connections with pending calls.
- `agent.serve_acp_websocket(AcpOptions { compose }, AcpServiceOptions { listen, actors, tls })` returns the same server handle. Omitted tenants allow only tenantless sessions; `Some(vec![None])` explicitly grants tenantless access. An explicit project list matches exact canonical paths; omitting it uses the serving composition's scope. An empty list grants nothing. A token caps the connection's rights without rewriting the actor's recorded rights.
- Use trusted loopback for plain `ws:`. `TlsOptions { cert_file, key_file }` enables `wss:` using a PEM certificate chain and private key; the plugin client verifies the server against the system trust store. Generate tokens with at least 128 bits of randomness and keep their files owner-readable only. The transport uses [Tokio Tungstenite 0.30's upgrade callback](https://docs.rs/tokio-tungstenite/0.30.0/tokio_tungstenite/fn.accept_hdr_async_with_config.html) and [message and frame limits](https://docs.rs/tungstenite/0.30.0/tungstenite/protocol/struct.WebSocketConfig.html). Deployments need no Node bridge.

## Built so far

| Milestone | State |
|---|---|
| 1. Compose an agent | Project, data directory and disposable scratch, durability, built-in parts and explicit plugins, ordered process and service plugins, models, settings, approval, credentials and question handlers. `Registrar::runtime` accepts a `RuntimePart` with scoped, binding-shaped callbacks in process or served. `Registrar::history_store` accepts `History::from_portable` for opaque, lease-fenced appends, or a native snapshot store. The Registrar also accepts custom environments, credentials, configuration and Interfaces. An explicit persistent store, including one installed by a plugin, requires `kept` or `durable`. |
| 2. Sessions and turns | Create, open and recover, prompt and stream, send, cancel, settings, fork, move or rewind, gated history, wait for idle, async actor-gated `last_turn`, erasure where supported and close. `prompt`, `prompt_stream` and `send` accept text or shared Content. Standard events expose typed payloads without losing wire fields. A commit failure or lost lease interrupts the open writer, cancels turn work, notifies followers live, and settles waiting prompts with `lost`. |
| 3. Actors and questions | `several_actors`, `session_limits` and `tenants` opt in. `session_with` supplies initial actors and tenant. `r#as`, `join`, `leave`, proposal listing, release and withdrawal, and `set_limit` use effective rights; the opt-ins remain false in `ma`. `questions` lists open questions, `answer` answers them by ID, and `on_question` overrides the agent handler. A timed non-approval `ask_with` can suspend a call (`Error::is_left_open()`); an accepted late answer runs the same call from the top with its answers reused. With no eligible answerer, approval refuses. The SDK and `ma` use durable staging for secret answers; only the stored name leaves the store. |
| 4. Tools | Typed input and hints, result/decline/cancel handling, approval/choice/text questions, context progress/log, working environment operations and nested calls. Input is checked against JSON Schema before deserialization and execution. `.output::<T>()` or `.output_schema(schema)` publishes `returns`; `ToolOutput::value` emits structured output. Validation runs after `tool.after`. `PromptResult::tool_results` lists only model calls; nested calls stay in history. A tool can return Content (`Vec<Value>`) directly. Tool and command contexts can read paged raw history, emit custom events and start jobs owned by their plugin. |
| 5. Errors | Stable SDK codes; typed base causes map writer conflicts, missing sessions, conflicting work and missing rights without matching error text. Other untyped failures can still map to `internal`. |
| 6–8. Plugins, serving, hosting | Setup/config, reverse-order stop, item replacement, typed core hook registrations, actor lifecycle and Provider-piece observers, local output transformations and definition/subscription/invocation of custom hook points. Dynamic sources can announce changes over the binding. Commands can ask a question or make metered auxiliary model requests in process. An input hook can run a command instead of admitting a turn. A local tool gate can leave a question pending for a later answer. Job owners register cancellation and opt into resume. A user's `session.start` hook can list and resume its plugin's unfinished jobs; without that hook the SDK invokes the owner automatically. Cleanup that cannot be confirmed is recorded and fences the old execution. Custom native working environments can be served over the plugin binding. `serve` refuses in-process-only registrations and rejects in-process-only hook answers at call time. |
| 9. Testing | Scripted Provider indexed by the final request, test agent, `testing::answers` with `Answers::assert_done`, memory environment, `TestAgentBuilder::over_wire` and the shared runner with all seven fixture plugins in-process, on stdio and on WebSocket. `restart(agent)` stops tracked work without settlement and rebuilds an in-process test agent on the same store. It does not stop work detached from a plugin call; the shared runner still uses real process kills. The runner supports `expectCreateError`, explicit file or service history, `as`, `send`, `answer`, `wait` and the `crashWhen.count` and `crashWhen.record` triggers. |
| 10. Guides | Offline examples checked, with substitutions listed below. |
| 11. Providers | Developer `Provider` trait and table-driven OpenAI and Anthropic API-key Providers. Unlisted models can be enrolled with `model_with_input` and have no reasoning controls. `CatalogNotifier::changed()` invalidates the local catalog view and `available()` gates dispatch. Serving supports catalog/readiness queries, streamed pieces, both host hooks and scoped credential reads. Unknown models are refused before Provider admission; other admitted errors become failed attempts. The request and assistant message wrap shared JSON and retain unknown fields; not all shared data is a typed Rust struct yet. |
| 12. Nested calls | In process and served. The core permits four levels, counting the outer call, and runs every nested call through its own gates. |
| 13. Declaration and ACP | Declaration from the installed parts and host policy. `serve_acp(AcpOptions::default())` serves the Agent's configured project on stdio; `serve_acp_websocket` authenticates independent ACP connections by bearer token. An `AcpComposition` can compose Agents by canonical project and saved session, use a configuration's project trust and settings, and attach MCP servers. A composed ephemeral Agent keeps its scratch until the ACP session closes. The fixed-project service reserves a session for one connection and refuses a competing writer without detaching the first. ACP installs recovery before returning, but does not wait for the recovered turn to finish. Call `serve_acp` before opening embedded sessions, on an agent built with `plugin_host(true)`. |
| 14. HTTP history | `http_history(url, token_file)` wraps the base client. `serve_history(store, ServeHistoryOptions::new(address, token_file))` serves a dedicated durable snapshot store on trusted loopback. `listen_history` returns the listener address and close handle after binding. The filesystem store implements this capability; in-memory history and the HTTP client do not. Native TLS, retention and transparent migration of an existing native store are not implemented. |

## Findings for the SDK specification

- **[Guide 01, Rust import](../../../docs/sdk/guides/01-first-agent.md#ask-a-question):** Replace `use modular_agent::{Agent, Result};` and `use modular_agent_openai::openai;` with `use modular_agent::{Agent, Result, openai};`. The workspace ships the API-key constructor in the core crate.
- **[Guide 06, Rust projections](../../../docs/sdk/guides/06-write-a-provider.md#test-a-scripted-request):** Replace `let history = session.history()?;` with `let history = session.history().await?;` and `let turn = session.last_turn()?.expect("prompt settled");` with `let turn = session.last_turn().await?.expect("prompt settled");`. The projections can await an output hook.
- **[Guide 07, typed Rust hooks](../../../docs/sdk/guides/07-hooks.md#register-the-hooks):** Replace `call.call["name"] == "preview_tide" && call.result["status"] == "completed"` with `call.call.name == "preview_tide" && call.result.status == ToolStatus::Completed`, `call.result["content"][0]["text"]` with `call.result.content[0]["text"]`, and `turn.outcome["kind"].as_str().unwrap_or_default().into()` with `turn.outcome.kind().into()`.
- **[Languages, Rust history service](../../../docs/sdk/languages.md#rust):** Add: “To start the same service in a task or test, `listen_history(file_history(dir)?, options).await` returns a bound listener with `url` and async `close()`. An address with port zero selects a free port.”

- **[Guide 08, Rust ACP composition](../../../docs/sdk/guides/08-drive-an-agent-over-acp.md#choose-the-project):** Replace “Composed agents must enable plugin hosting and supply a `data_dir`.” with “Composed agents must enable plugin hosting. `data_dir` is required only by the selected durability and parts, as in `createAgent`; an ephemeral composed agent owns its scratch until the session closes.”
- **[Languages, Rust projections](../../../docs/sdk/languages.md#rust):** Add “`session.last_turn().await?` reads the most recent settled turn through the receiving actor's output gate. It does not wait for a running turn.”
- **[API, portable history adapter](../../../docs/sdk/api.md#the-other-parts):** Replace the history store operations cell with “`create`, `acquire`, `renew`, `release`, `append`, `read`, `list`, `erase`. `create(metadata)` is the binding's idempotent metadata PUT; defer it to first admitted input, or to fork publication.” The method list currently omits metadata creation even though the other operations need it.
- **[API, fixed-project ACP](../../../docs/sdk/api.md#the-agent):** After the first sentence of the composition paragraph add “Connections may write different sessions concurrently. A second writer for an already open session is subject to the history writer rule; a refusal must not change the first connection's state.”
- **[API, configuration and ACP](../../../docs/sdk/api.md#the-agent):** Replace “Project settings supply defaults for new sessions, not replacements on reopen.” with “Before invoking a factory that loads project-selected parts, consult the operator's configuration source for project trust. `trusted(project)` reads that decision; ACP's trust operation, where offered, changes it under operator authority. Project settings supply defaults for new sessions, not replacements on reopen.”

## Remaining

- Custom Runtime resume and continuation share the host bridge but do not have SDK-specific crash tests. Native Runtime recovery still lacks complete handling and crash coverage for a pending disposition committed before `turnEnd`. Add to [Testing](../../../docs/sdk/testing.md#adding-a-scenario): “Check two crash points for a timed `leaveOpen`: after the wait expires but before `toolPending`, and after `toolPending` but before `turnEnd`. The first must not redispatch; the second must remain open for a later answer.”
- The filesystem history service still uses its separate namespace. `serve_history` does not accept an arbitrary `PortableHistoryStore`: the current HTTP server expects durable snapshots for its own lease state. Add to [Placement](../../../docs/sdk/placement.md#services): “A store declares whether it can be served. The opaque append port alone does not supply the durable lease state or restart exclusion needed to serve the store.” The working-environment server also still adapts the native trait rather than exposing a binding-shaped implementation trait.
- Standard event variants and the main hook payloads are typed, with raw JSON for open extension payloads and parts such as model requests and assistant messages. Some projections and specialized contexts are not complete: tool progress renders text rather than arbitrary Content, the SDK does not expose a Provider-tool allowance on `step.before`, and the remote Provider and command context cannot expose identities the binding omits. Replace the first [Contexts](../../../docs/sdk/api.md#contexts) row with “`sessionId`, `actorId` and work ids, where the call carries them | all | only the ids in that method's binding envelope. A served Provider request carries `sessionId` but no actor or step id; `command/run` carries the session and actor ids but no step id.” To preserve non-text progress, add to [Output events](../../../docs/bindings/data.md#output-events): “`toolOutput` may also include `content: Content`; `chunk` is its text projection.”
- Custom ACP trust lookup is opt-in on the composition factory. It is checked before invoking a configured factory; it cannot authorize code already loaded into a fixed-project Agent. Live model checks were intentionally not run.

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

## Findings for the SDK specification

- **[ACP token scope](../../../docs/research/sdk-findings.md#open-decisions).** Rust treats omitted `tenants` and `projects` as no additional restriction and includes descendants of canonical project roots. The SDKs differ on these defaults and on project matching.
- **[ACP control message](../../../docs/research/sdk-findings.md#open-decisions).** Rust proposes documenting `$/ping` with `{}` in and out, including before `initialize`, and a five-second default control deadline. The WebSocket binding's liveness rule needs a decision about ACP clients.
- **[API-key reasoning levels](../../../docs/research/sdk-api-key-reasoning.md).** The OpenAI adapter and Anthropic adapter do not offer the same range of settings as the other SDKs. Decide the shared per-model mapping before changing the adapters.

**Remaining implementation gaps.** The Rust SDK still lacks several generic part and job interfaces, dynamic tool-source serving, custom hook subscription and invocation, the public `output` handler, and some context and in-process hook variants. These are not requests to relax the specification. The live suite has not been run against model services; the Anthropic adapter does not advertise a reasoning setting, so that check does not run for it until the adapter gains one.

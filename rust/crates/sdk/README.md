# modular-agent: the Rust SDK

The Rust SDK for [SDK specification 0.1](../../../docs/sdk/README.md). It wraps the Rust base, including the edition 4 draft's nested calls, plugin binding `/1`, shared data `/1`, and the base ACP Interface. It does not expose the Harness.

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
mise exec -- cargo test --workspace --no-fail-fast -- --test-threads=1
mise exec -- cargo fmt --all -- --check
mise exec -- cargo clippy --workspace --all-targets -- -D warnings
```

- **Workspace:** 290 tests passed, including doctests and the base's ACP and plugin kit tests; none failed or were ignored. Formatting and Clippy passed.
- **History HTTP:** The shared history kit passed 39/39 checks normally and 42/42 with `--restart-ttl` against the filesystem-backed SDK example. The restart checks verify committed data survival and old lease exclusion after the TTL decreases from 6,000 ms to 1,000 ms.
- **Gap coverage:** 7 SDK tests cover input validation and checked tool returns in both placements, structured prompts (feedback retries and JSON null), event replay and reader lag, in-process restart during an unsettled call, and typed missing/held session errors. 1 additional test loads a Provider over real stdio and checks request transformation, response observation, streaming and the final result.
- **Shared scenarios:** 7 in process and 7 with the Rust fixture program. The two crash cases kill the agent's process group and reopen from disk. A deliberately wrong `tide` program made `tool-call (process:rust) step 0` report the expected and actual text while `inProcess` passed. The original program was restored and rerun. Only `rust.json` was present in this checkout; there were no cross-language placements to run in either direction.
- **Placement:** 1 test checks process startup failure, environment opt-in, and result wording parity. 6 SDK milestone tests cover session operations, declaration values, hooks and commands, progress, nested calls and stale contexts, refusal to serve in-process-only items, and the memory environment. The relevant tests run both in process and through the real plugin host over an in-memory duplex.
- **Guides:** 5 tests across guides 01–03 (4 in `sdk/tests/guides.rs`, 1 in `sdk-scenarios/tests/guide03.rs`). The guide 03 test loads the Rust fixture's `tide` tool over stdio. 1 crate doctest compiles.
- **Providers:** 3 tests against loopback HTTP: Responses streaming, Messages streaming, and admitted credential failures for both.
- **ACP:** 1 integration test sends two sessions and two prompts on a real stdio ACP connection, closing the first session before the second. The workspace suite also runs the base's conformance kits.

To repeat the Rust fixture placement, or to require another SDK's program once registered and built:

```sh
mise exec -- cargo build -p sdk-scenarios --bin modular-agent-fixtures
MODULAR_AGENT_SDK_REQUIRE=rust mise exec -- cargo test -p sdk-scenarios --test shared -- --nocapture
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

## Built so far

| Milestone | State |
|---|---|
| 1. Compose an agent | Project, durability, history override, Providers, tools, plugins, process plugins, model, settings, approval, question handler. No hidden `base_plugin` escape hatch. Other part constructors and generic overrides are not yet exposed. |
| 2. Sessions and turns | Create, open and recover, prompt and stream, last turn, history, send, cancel, read/change settings, fork, commands and close. Text input and keys, typed `PromptOptions` for structured results, and `events(from_entry)` for recorded-entry replay followed by live events. A lagged stream ends with `lost` and `data.fromEntry`. No SDK erasure API yet; not all live event types have dedicated Rust variants. |
| 3. Local actor | `user` is present for questions only with an app handler. No handler means immediate refusal of approval. |
| 4. Tools | Typed input and hints, result/decline/cancel handling, approval/choice/text questions, context progress/log, working environment operations and nested calls. Input is checked against JSON Schema before deserialization and execution. `.output::<T>()` or `.output_schema(schema)` publishes `returns`; `ToolOutput::value` emits structured output. Validation runs after `tool.after`. Generic Content results and some context members are not yet exposed. |
| 5. Errors | Stable SDK codes; typed base causes map writer conflicts, missing sessions, conflicting work and missing rights without matching error text. Other untyped failures can still map to `internal`. |
| 6–8. Plugins, serving, hosting | Named plugins, setup/config, item replacement, per-point hook methods and plain commands in both placements. Output gate and other in-process-only hook variants are not exposed; `define_hook` registers a point but does not yet expose calling or subscribing to it. `serve` rejects flagged and defined items, including those registered in `setup`. Developer Providers register in process or over stdio. Other generic part registrations are not yet exposed. |
| 9. Testing | Scripted Provider, test agent, answer queue, memory environment, `TestAgentBuilder::over_wire`, fixture program and unchanged scenario runner. `restart(agent)` stops tracked work without settlement and rebuilds an in-process test agent on the same store. It does not stop work detached from a plugin call; the shared runner still uses real process kills. |
| 10. Guides | Offline examples checked, with substitutions listed below. |
| 11. Providers | Developer `Provider` trait and two API-key Providers, checked offline. The request and assistant message wrap shared JSON and retain unknown fields; not all shared data is a typed Rust struct yet. |
| 12. Nested calls | In process and served. The core permits four levels, counting the outer call, and runs every nested call through its own gates. |
| 13. Declaration and ACP | Declaration from the installed parts; SDK agent serves one configured project through the base ACP Interface. Call `serve_acp()` before opening embedded sessions, on an agent built with `plugin_host(true)`. |
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
| The base history API exposes snapshots and separate live notifications. | `events()` subscribes before taking its replay snapshot, gates replayed rows, and deduplicates overlapping entry events. `history()` still projects the raw record; it is not the actor's gated view. |

## Findings for the SDK specification

- **[API / The declaration](../../../docs/sdk/api.md#the-declaration):** The table assumes next-turn settings, erasure in memory, and a single local environment design. Replace the three rows with: “`settingsDuringTurn`: `nextTurn` if settings changes are recorded during a turn and deferred; otherwise `refused`.” “`erasure`: true only if the selected history store can erase.” “`commandContainment`: the selected environment's declared containment; a local environment can declare `processGroup` or `strong`.” Add: “`queuedJobReportsAfterRestart` comes from the Runtime's recovery policy; if omitted, clients use `queuedInputAfterRestart`.”
- **[API / Building an agent](../../../docs/sdk/api.md#building-an-agent):** The error paragraph requires `dataDir` even when the durability page permits an explicit persistent store. Replace “a missing `dataDir`” with “a missing `dataDir` when the chosen durability or a configured part needs it and no explicit persistent history store supplies it.”
- **[API / Sessions and turns](../../../docs/sdk/api.md#sessions-and-turns) and [ACP / Sessions](../../../docs/bindings/acp.md#sessions):** Embedded open waits for recovery, but ACP open must not wait. Replace the SDK row with: “`openSession(id)` installs recovery before admitting fresh work. The embedded SDK may wait for recovery; ACP MUST return once recovery is installed and allow reads, answers and cancellation immediately.” This SDK's embedded `open_session` waits; the inherited Rust ACP recovery path also waits. Nonblocking ACP recovery needs a separate base change.
- **[API / Providers](../../../docs/sdk/api.md#providers):** The base model port has no post-admission RPC error channel: a raised developer error reaches the Runtime as a failed attempt. Add: “Reject an unknown model before admitting a Provider request. After admission, a Provider that returns an error without a ModelError records a failed AssistantMessage with kind `other`; it does not turn a settled model attempt into an input error.”
- **[Testing / The testing kit](../../../docs/sdk/testing.md#the-testing-kit):** A question handler error is specified to decline, so just raising on an extra question cannot fail a test. Replace the `answers` row with: “Answers in order; an unexpected question declines and is observable as a test failure on a separate verification handle. The handler's error must not escape the agent's question boundary.” The current Rust helper declines extras without a verification handle.
- **[Guide 01 / Stream the answer](../../../docs/sdk/guides/01-first-agent.md#stream-the-answer):** The Rust workspace depends on `futures-util`. Replace `use futures::StreamExt;` with `use futures_util::StreamExt;` in the offline example.
- **[Guide 03 / Serve the plugin and Load it into an agent](../../../docs/sdk/guides/03-tool-in-another-process.md):** The Rust load example assumes Python installed under `/srv` and a live model. Add: “For an offline Rust test, build `modular-agent-fixtures` and use `.process_plugin(ProcessPlugin::new([env!(\"CARGO_BIN_EXE_modular-agent-fixtures\"), \"tide\"]))` in its integration test, with `testing::scripted_provider` and `.model(\"scripted/script\")`. The fixture program calls `modular_agent::serve(plugin).await`.”

- **[Placement / Services](../../../docs/sdk/placement.md#services):** Replace “serves any history store as the history service” with “serves a history store that durably commits the history service's opaque records and can enforce lease exclusion; unsupported stores are refused at startup.” In-memory history cannot meet the binding's restart guarantee without separate persistent storage. A native snapshot client is not necessarily an atomic opaque-record backend.
- **[API / Events](../../../docs/sdk/api.md#events):** Replace the lag sentence with “On lag, the stream ends with `lost` and `data.fromEntry`, the ID of the last delivered history entry or null if none. Pass that cursor to `events(fromEntry)` to replay kept entries strictly after it, then resume live delivery. Live deltas and other live-only events cannot be recovered.”
- **[API / Sessions and turns](../../../docs/sdk/api.md#sessions-and-turns):** Replace the structured result sentence with “`options.result` is a JSON Schema 2020-12 schema. On successful completion `value` contains the accepted JSON value, including JSON null when allowed. The SDK may obtain the candidate by asking the model for a final JSON value as text; missing or invalid candidates are fed back through the normal `turn.result` refusal and retry rules.”
- **[Testing / The testing kit](../../../docs/sdk/testing.md#the-testing-kit):** Replace the `restart` row with “Rebuilds an in-process test agent over the same store and registrations, dropping tracked work without shutdown or settlement. Reopen the sessions on the returned agent. Detached work and external processes are outside this simulation; use a real process kill to test them.”

**Proposed shared scenarios.** Add `nested-call`: an outer fixture lists and calls a child; verify both results, parent attribution, and that the child result is not model-visible. Run the same fixture in process and served. Add `queued-cancel`: park an input `after` a held call, cancel, then retry its key; verify it returns `handedBack` without another turn. This needs `send`, `cancel`, and admission-key steps in the shared scenario format.

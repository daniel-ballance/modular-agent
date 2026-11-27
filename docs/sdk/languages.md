# Languages

How each language expresses the [API](api.md). The rule is the same throughout: the concepts, operations, fields and error codes are the same in every SDK, and each is written the way a developer in that language expects. An SDK MUST NOT rename an operation, add a concept or drop one to suit its language. Where a language has no direct way to express something, this page says what to do instead.

## At a glance

| | Rust | TypeScript |
|---|---|---|
| Operations and fields | `snake_case` | `camelCase` |
| Types | `UpperCamelCase` | `UpperCamelCase` |
| `createAgent(options)` | `Agent::builder()…build().await` | `createAgent({ … })` |
| Asynchronous work | `async` on Tokio | `Promise` |
| Streams | `impl Stream<Item = Result<Event>>` | `AsyncIterable<Event>` |
| Cancellation | `CancellationToken` | `AbortSignal` |
| Errors | `Result<T, modular_agent::Error>` | thrown `AgentError` |
| Error code | `error.code()`, an enum | `error.code`, a string union |
| `lastTurn()` | `session.last_turn().await`: `Result<Option<PromptResult>>` | `session.lastTurn(): Promise<PromptResult \| undefined>` |
| Last activity from `sessions()` and `sessionInfo(id)` | `SessionInfo.last_active` (`u64`), `0` for no last activity | `SessionListEntry.updated` and `SessionInfo.updated` (`number`), `0` for no last activity |
| Optional arguments | builder methods | an options object |
| Closed sets of values | enums with an `Unknown(String)` variant where shared data keeps unknown values | string unions |
| Tool input | a type deriving `Deserialize` and `JsonSchema` | a [Standard Schema](https://standardschema.dev) or JSON Schema |

## Configuration and prompts

| Input | Rust | TypeScript |
|---|---|---|
| File-backed Configuration | `AgentBuilder::configuration(FilesConfiguration::new(global))`, where `global` is the operator settings file | No `createAgent` option. Load settings in the app and pass `settings`, or install a Configuration with a plugin. |
| Local credential store | `AgentBuilder::credentials(store: impl CredentialStore)` | `createAgent({ credentials })`, with `credentials?: CredentialStore` |
| Deployment tenants | `AgentBuilder::tenants(tenants: serde_json::Value)` | `createAgent({ tenants })`, with `tenants?: Record<string, { rights: Right[]; tokens?: number }>` |
| Product system prompt | `AgentBuilder::default_prompt(false)` omits the SDK’s default prompt plugin; supply a `turn.before` contribution with `on_turn_before` | No equivalent switch or SDK default prompt plugin; supply a `turn.before` contribution with `registrar.on("turn.before", …)`. |

In Rust, `FilesConfiguration` uses the `trusted-projects.json` ledger next to `global`. `trusted(&Path)` checks the canonical project path; `trust(&Path)` grants trust and is for explicit operator actions. `settings(&Path)` layers project defaults from `.modular-agent.json` even without a trust grant; reading them does not authorize launches. Keep the operator files outside the project. `Registrar::configuration(source: impl Configuration)` can instead install a Configuration whose `settings(&Path)` supplies defaults. For an ACP composition that gates projects on a Configuration, expose it separately through `AcpComposition::configuration`.

In TypeScript, `registrar.configuration(source: ProjectConfiguration | Configuration)` accepts either a `ProjectConfiguration` with `trusted(project)` and `settings(project)` (each can return a promise), or the lower-level `Configuration` part. The registrar calls `settings(project)` on a `ProjectConfiguration` only when `trusted(project)` succeeds with `true`; a lower-level `Configuration` owns its own policy. The SDK does not create a project trust ledger for either form.

To replace the SDK’s Configuration or credential store through an in-process registrar, list `configuration` or `credentials`, respectively, in `replaces`. Use `credential_store(store: impl CredentialStore)` in Rust and `credentialStore(store: CredentialStore)` in TypeScript.

## Credential store operations

| | Rust | TypeScript |
|---|---|---|
| SDK file store | `modular_agent::file_credentials(path) -> impl CredentialStore` | `fileCredentials(path: string): CredentialStore` from `@modular-agent/core` |
| Direct named write on the SDK file store | `store.write(name: &str, value: &str) -> Result<()>` | `await store.modify(name, async () => value)` with a string value; `await store.delete(name)` removes the active value. |
| Staging operations | `stage(receipt, value)`, `lookup_staged(&request)`, `activate(&request)`, `discard(&request)`, plus `writable()` returning `true` (or overriding `accepts(name)` to accept the secret name, since `writable()` defaults to `false`) | `stage(submission, value)`, `lookupStaged(scope)`, `activate(scope)`, `discard(scope)`, returning promises (presence of the four methods enables secret staging) |

Both SDK file stores implement direct writes and staged transactions. So do Rust’s base `credentials_file::FileCredentials` (direct write: `agent_api::CredentialStore::put`) and the `AuthFile` used by Rust `ma` (`CredentialStore::write` or `AuthFile::put_answer`). TypeScript’s `ma` uses `AuthFile.credentials()` with `modify` and `delete`. The separate TypeScript `@modular-agent/credentials-file` package also supports staging and direct modification through `FileCredentialStore`; its `fileCredentials({ path })` returns a base plugin, not the SDK store returned by the core helper.

## Input receipts

For an ordinary `send` with a key, Rust uses `session.send_with(input, timing, Some(key))`; TypeScript uses `session.send(input, timing, { key })`. Rust's `InputReceipt` has `input_id: String`, `taken: String`, and the booleans `duplicate` and `erased`. TypeScript uses `inputId: string` and `taken` as a string union; an ordinary first receipt omits `duplicate`, a retry sets `duplicate: true`, and neither receipt has `erased`. Cancellation hand-back leaves those receipts non-erased in both SDKs. See [Sessions and turns](api.md#sessions-and-turns).

## OpenTelemetry

Each Modular Agent SDK depends on the OpenTelemetry API only. The app chooses and installs the OpenTelemetry SDK and exporter. Register the app's tracer provider before creating the agent. If the app uses a meter provider, register it the same way.

| Language | API dependency | How the app installs tracing |
|---|---|---|
| Rust | `opentelemetry` crate, not `opentelemetry_sdk` | Set the SDK tracer provider through `opentelemetry::global`. |
| TypeScript | `@opentelemetry/api` | Register the SDK tracer provider and an async context manager with the API. |

See [Tracing](api.md#tracing) for the common rules and the [research note](../research/opentelemetry-genai.md#language-apis-and-export) for the upstream versions checked.

## Schemas

A tool's input and output are written as types or schema objects, never as hand-written JSON Schema unless the developer chooses to. Each SDK turns them into JSON Schema 2020-12 using only the standard vocabulary and within-document references ([Tools](../bindings/data.md#tools)):

- **Rust:** `schemars` from a type that also derives `serde::Deserialize`.
- **TypeScript:** any validator implementing Standard Schema with a JSON Schema export, such as Zod or Valibot; or a JSON Schema object with its TypeScript type inferred.

The SDK checks input against the schema before calling the tool, so the tool receives a typed value.

## Scoped command execution

These are the tool and Command context APIs, not the result of calling the standard `exec` tool.

| SDK | Call and timeout | Successful SDK return |
|---|---|---|
| Rust | `environment.exec(command, timeout).await`; `timeout: Option<Duration>` (`std::time::Duration`) | `CommandOutput { exit_code: Option<i64>, output: String, timed_out: bool, status: ToolStatus }` |
| TypeScript | `await environment.exec(command, { timeout })`; optional `timeout` in milliseconds | `{ exitCode: number \| null, output: string, timedOut: boolean }` |

Rust takes `status` from the working environment in process. For a served call that returns a result, Rust derives `Completed` from exit code zero with `timed_out == false` and `Failed` otherwise. The served reply does not carry a separate cancellation status. TypeScript exposes no command `status` field in either placement. Neither SDK exposes a signal name or number; when there is no numeric exit code, Rust returns `None` and TypeScript returns `null`. These shapes describe returned results, not SDK errors.

Omit the timeout (`None` in Rust) to request no deadline. For served calls, the binding uses positive whole milliseconds. Rust converts a supplied duration to whole milliseconds, with a minimum of one; TypeScript callers must pass a positive safe integer if supplying a timeout over the binding.

## Declaration choices

| Capability | Rust | TypeScript |
|---|---|---|
| Questions that outlast their turns | No builder switch. The SDK installs its questions plugin by default; it declares `questionsOutlastTurns` and `lateAnswersStartTurns` as true. | `createAgent({ questionsOutlastTurns: true })` enables both declarations. They default to false. |
| Changing settings during a turn | No builder switch. The SDK declares `settingsDuringTurn: "refused"`; a `Session::set_setting` change during a running turn returns `Code::Busy`. | `createAgent` defaults to `settingsDuringTurn: "nextTurn"`. Set `settingsDuringTurn: "refused"` for `session.setSetting` to raise `busy` during a running turn. |

## History restore witness

- Rust: Set `FileHistoryOptions { restore_witness: Some(path.into()) }` in `file_history_with_options(dir, options)` for native snapshots or `portable_file_history_with_options(dir, lease_ttl, max_sessions, options)` for opaque records. Pass either configured store to `listen_history` or `serve_history` for the built-in HTTP snapshot service. For the portable store, match the service’s lease TTL to the store’s. The `history_service` example configures the portable store with `--restore-witness PATH` after `STORE_DIR`. The witness records the registry and snapshot digests, including snapshots carrying stored authority changes.
- TypeScript: `fileHistory(dir, { restoreWitness: path })`. Pass it to `serveHistory` for the built-in HTTP SQLite service. `historyService({ dir, restoreWitness: path, ... })` also accepts it. The witness tracks the database that commits history, stored authority changes and HTTP erasure plans together. Direct file history additionally uses `path + ".registry"` to witness the separate pending-erasure registry. `pendingErasureDir` controls where that registry lives.

Provision the witness with a new store. Use a unique path in an existing private directory outside the history and registry backup/rollback domain. Keep the witness current and configured across restarts; do not restore it from a history backup. Stop writers and the service before backup or restore, and run only one live store per witness. Both SDKs reject older or mismatched restores, including rollback across a deletion, pending erasure publication or stored authority revocation. They also reject a missing or unreadable configured witness. A crash or failed write between the witness update and the local commit can leave the store unavailable; recover only with state verified to match the witness, never by resetting it. Without a witness the SDK cannot detect a matching rollback. Custom stores and external authority sources must provide their own freshness proof.

## Rust

- Use `agent.session_summary(id, &viewer)?` to read kept work without opening the session. An inaccessible or missing session returns `None`.
- The core crate is `modular-agent`, imported as `modular_agent`. It requires Tokio.
- A tool is built with `Tool::new(name, description).run(|input: T, cx| async move { … })`. Hints are builder methods: `.read_only()`, `.safe_to_repeat()`.
- A plugin is built with `Plugin::new(name)` and chained registrations: `.tool(tool)`, `.on_tool_before(handler)`, `.replaces(item)`, `.config(settings)`, and `.setup(|r| …)` for items that depend on settings. For singleton parts such as history, see [Replacing a part](api.md#replacing-a-part).
- For `turn.before`, `on_turn_before` returns a `TurnAddition`. Its `sources: Option<Vec<String>>` distinguishes `None` from `Some(vec![])`.
- Each hook point is its own typed method, `on_tool_before` rather than `on("tool.before", …)`, with `on_<point>_with(Order::First, handler)` or `Order::Last` for explicit order. A gate answers `Gate::Allow` or `Gate::Refuse(reason)`; `Gate::Refuse` is also the `step.after` end decision.
- A plugin program awaits `modular_agent::serve(plugin)` for stdio. For a single-token WebSocket listener use `serve_websocket(plugin, ServeOptions { listen, token_file, tls, projects })` or `serve_websocket_factory(factory, options)`. For named callers use `serve_websocket_named(|caller: AuthenticatedCaller| make_plugin(caller.caller_id), NamedServeOptions { listen, callers, ..Default::default() }).await?`. Each `PluginCaller::new(caller_id, token_file)` can set its own `projects`. The factory gets the authenticated ID on each new connection, not the token.
- With the `agui` feature, `agent.serve_agui(AguiOptions { listen, actors, ..Default::default() }).await?` serves the host reads. Use the thread snapshot's `waitCursor` with `wait-closures?after=…` and, when it offers `runReceipts: 1`, `run-receipt?runId=…`. These are authenticated HTTP reads, not methods on an answerable `Session`.
- For ACP use `agent.serve_acp(options)` on stdio or `agent.serve_acp_websocket(options, AcpServiceOptions { listen, actors, tls })`; see [ACP project options](#acp-project-options).
- Use `session.r#as(actor_id)?` to act for a joined actor.
- `serve_history(file_history(dir)?, options)` keeps service records separate from native session files; it does not export existing native sessions. Create options with `ServeHistoryOptions::new(address, token_file)`. Set `options.lease_ttl` to a `Duration` to override the 15-second writer lease. The duration must be at least 1 ms and a whole number of milliseconds; the service declares it as `ttlMs`. To start the same service in a task or test, `listen_history(file_history(dir)?, options).await` returns a bound listener with `url` and async `close()`. An address with port zero selects a free port.
- Public errors are `modular_agent::Error`, not `anyhow::Error`. Plugin code can return any error that converts into it.
- An operation with options has a plain form and a `_with` form: `session()` and `session_with(SessionOptions { … })`.
- A tool refuses with `return Err(cx.refuse("reason"))`: the call ends `refused`, where any other error ends it `failed`.
- Streams are the boxed `EventStream`, so `StreamExt::next` works on them without pinning. An unboxed `impl Stream` made the guide's own loop fail to compile.
- Data types own their data and implement `Serialize`, `Deserialize`, `Clone` and `Debug`.
- Minimum Rust version: the one pinned in `rust/mise.toml`. Edition 2024.
- Subscription Providers: `chatgpt(ChatGptOptions::new(subscription_logins(path)))` and `grok(GrokOptions::new(subscription_logins(path)))`, given to `AgentBuilder::provider`. `sign_in` and `sign_out` are async and take `"chatgpt"` or `"grok"`. `SignInOptions::paste` is an optional Tokio receiver of pasted lines, ignored for Grok. `AgentBuilder::claude_provider(claude(ClaudeOptions::default())?)` starts the Claude program as a process plugin; it needs Node.js 22 or later.
- Interface-run tools: `AgentBuilder::interface_tools` registers them. A binding attaches an executor with `Session::connect_interface_tools(route_id, actor_id, rights)`, takes calls with `next_call().await` and reports with `report_tool_result(report).await`.
- Approvals that wait: set the operator bound with `AgentBuilder::max_approval_wait_ms(u64)`; a session opts in through `SessionOptions::settings` or `Session::set_setting("approvalWait", json!("untilDeadline"))`. `Session::questions_present().await?` is an answerable delivery on that handle; `Session::questions()` is a listing, not a delivery.
- Covered approvals: `.approval_covers_nested(true)` with `.approval(Approval::Ask)`, default false. The approval view carries `coversNested`; each covered start records `approvalCoveredBy`.

## TypeScript

- Use `await agent.sessionSummary(id, viewer)` to read kept work without opening the session. An inaccessible or missing session returns `undefined`.
- The core package is `@modular-agent/core`, an ES module with its own type declarations. It runs on Node.js 22 or later.
- A tool is `tool({ name, description, input, run })`. Hints are fields: `readOnly: true`.
- A plugin is an object: `{ name, replaces?, setup(registrar), stop? }`, or `definePlugin({ name, tools, hooks, … })` for the common case. For singleton parts such as history, see [Replacing a part](api.md#replacing-a-part).
- `run` may return a value or a Promise. Streams are async iterables, used with `for await`. A tool refuses by calling `cx.refuse(reason)`, which throws and does not return.
- Standard Schema validators must expose the Standard JSON Schema input export, for example Zod 4. For plain JSON Schema assigned to a variable, use `as const` so its keywords keep their literal types for inference.
- For `turn.before`, return `{ add: { system?, context?, sources? } }`. Omit `sources` or leave it `undefined` for the default attribution; `sources: []` is an explicit empty list.
- `registrar.on("tool.before", handler)` infers the payload and answer from the point. A gate can return `"allow"` or `{ refuse: reason }`.
- A service can take `serve(() => makePlugin(), options)` for fresh plugin state per connection. `serveHistory(fileHistory(dir), { address, tokenFile, leaseTtl? })` resolves to `{ url, close }`; tests can ask for port `0` and await `close()` when done. `leaseTtl` is a whole number of milliseconds, at least 1, and defaults to 15,000.
- Use `defineProvider` to get `changed()`. `agent.refreshModels()` explicitly refreshes served catalogs.
- Without an explicit stdio `actor`, the ACP actor ID comes from `actorId`, then `MODULAR_AGENT_ACTOR`, then `acp-user`. See [ACP project options](#acp-project-options).
- One Agent can serve several `serveAcp({ listen, actors })` listeners. Start them before opening embedded sessions, and give every one the same `projectMcp`. The [ACP session rules](../bindings/acp.md#sessions) govern writer reuse and refusals across listeners. On the fixed project, another listener may open the session after the first listener releases its writer claim, including after a successful `session/close`. A composed Agent is refused by the history lease instead (`held`). Closing any listener's handle closes the Agent.
- No default exports.
- Subscription Providers come from `@modular-agent/subscription` (`subscriptionLogins(path)`, `chatgpt({ logins, … })`, `grok({ logins, … })`, `signIn(provider, logins, options)` and `signOut(provider, logins)`, with `provider` `"chatgpt"` or `"grok"`) and `@modular-agent/claude` (`claude(options)`, in process on Anthropic's Agent SDK). The Claude package also has the program the Rust SDK starts.
- Approvals that wait: set `maxApprovalWaitMs` in `createAgent`; a session opts in with `approvalWait: "untilDeadline"` at creation or through `session.setSetting`. `session.questions({ present: true })` is an answerable delivery on that handle; a plain listing is not.
- Covered approvals: `createAgent({ approval: "ask", approvalCoversNested: true })`, default false. The approval view carries `coversNested`; each covered start records `approvalCoveredBy`.
- For named plugin callers, use `await serve(({ callerId }) => makePluginFor(callerId), { listen, callers })`. Add `tls` for a TLS listener. Each operator entry is `{ callerId, tokenFile }`. The listener authenticates before calling the factory. Neither the token nor a caller claim goes in a plugin message.
- `await agent.serveAgui({ listen, actors })` serves both host reads. From the thread snapshot, pass `waitCursor` as the `after` query value on `wait-closures`. When `runReceipts === 1`, pass the original `runId` as one query value on `run-receipt`. Use authenticated HTTP; neither read needs a presence stream.

## ACP project options

These are the language mappings for [ACP project composition](api.md#acp-project-composition).

### Rust ACP

Set `AcpOptions.compose` to `Some(factory)`, where `factory` is an `Arc<dyn AcpComposition>`, on stdio or WebSocket. Enable `plugin_host(true)` on the serving and composed Agents. Build the returned Agent for the requested canonical project.

| `AcpComposition` method | Use |
|---|---|
| `compose(project: &Path, reopening: Option<&str>)` | Async. Receives `None` for a new session or the saved session ID for a reopen. Use `history()?.session_info(id)` to inspect saved settings before building the Agent. |
| `history()` | Returns the `History` used by ACP for lookup and listing. Use the same underlying history for the Agents that write and reopen those sessions. |
| `configuration()` | Optional. When supplied, the adapter calls `trusted(project)` before composing and refuses the build if it returns false. To allow untrusted projects without their launch config, leave this gate unset and check trust when selecting executable parts or project MCP sources. Rust `ma` does this for project MCP when building its Agent. |
| `project_settings(project)` | New-session settings. By default it reads `configuration().settings(project)` if provided, or returns an empty object. |
| `project_mcp(session, project, servers)` | Async attachment callback for **client-supplied** specifications. Its default refuses a nonempty list, as does a fixed-project Agent. Install a configured MCP source in `compose` instead. The SDK has no `hostMcpServers` option; a composition that supports client attachment must enforce the operator’s host MCP policy in its attachment path. |

### TypeScript ACP

Pass these options to `agent.serveAcp` on stdio or alongside `listen` and `actors` on WebSocket. Use `createAgent({ history })` on the serving Agent for the index, and use the same underlying history for the composed Agents. For the default file history, they can instead use the same `dataDir`.

| Serve option | Use |
|---|---|
| `compose(project, saved?)` | Returns a `Promise<Agent>`. Receives the canonical project and, on reopen, a `SessionInfo` with the saved settings. Return an Agent for that project; use a fresh Agent if it is not the serving Agent itself. The SDK can reuse a selected Agent, so do not rely on `compose` as a per-request trust check. |
| `projectSettings(project)` | Returns new-session settings, synchronously or asynchronously. It can be used without `compose`. |
| `projectMcp(project)` | Returns a `Record<string, McpServerConfig>` synchronously or asynchronously. It supplies configured MCP servers, not client attachments, and can be used without `compose`. The application checks operator trust before returning project-defined servers; TypeScript `ma` checks its external ledger here. |
| `hostMcpServers` | Controls whether the binding accepts client MCP specifications, independently of `projectMcp`. Defaults to `true` on stdio and `false` on WebSocket, for either a fixed-project or composed Agent. |

## Packages

| | Rust | TypeScript |
|---|---|---|
| Core | crate `modular-agent` | `@modular-agent/core` |
| Official plugin `<name>` | crate `modular-agent-<name>` | `@modular-agent/<name>` |
| Testing kit | module `modular_agent::testing` | `@modular-agent/core/testing` |
| Fixture program | binary `modular-agent-fixtures` | `bin` of `@modular-agent/fixtures` |

The packages are not published to registries; build them from the repository (see the top-level README).

Official plugin names are the same in every language: `openai`, `anthropic`, `files`, `mcp`, `acp`, `approval`, `questions`, `compaction`, `model-selection`, `subagents`, `guardrails`, `history-http`.

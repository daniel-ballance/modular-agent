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

## Rust

- Use `agent.session_summary(id, &viewer)?` to read kept work without opening the session. An inaccessible or missing session returns `None`.
- The core crate is `modular-agent`, imported as `modular_agent`. It requires Tokio.
- A tool is built with `Tool::new(name, description).run(|input: T, cx| async move { … })`. Hints are builder methods: `.read_only()`, `.safe_to_repeat()`.
- A plugin is built with `Plugin::new(name)` and chained registrations: `.tool(tool)`, `.on_tool_before(handler)`, `.replaces(item)`, `.config(settings)`, and `.setup(|r| …)` for items that depend on settings. `AgentBuilder::configuration` installs a settings file and project trust ledger as the Configuration. A plugin that registers a history store, credential store or Configuration lists `history`, `credentials` or `configuration` in `replaces`.
- Each hook point is its own typed method, `on_tool_before` rather than `on("tool.before", …)`, with `on_<point>_with(Order::First, handler)` or `Order::Last` for explicit order. A gate answers `Gate::Allow` or `Gate::Refuse(reason)`; `Gate::Refuse` is also the `step.after` end decision.
- A plugin program awaits `modular_agent::serve(plugin)` for stdio. For a single-token WebSocket listener use `serve_websocket(plugin, ServeOptions { listen, token_file, tls, projects })` or `serve_websocket_factory(factory, options)`. For named callers use `serve_websocket_named(|caller: AuthenticatedCaller| make_plugin(caller.caller_id), NamedServeOptions { listen, callers, ..Default::default() }).await?`. Each `PluginCaller::new(caller_id, token_file)` can set its own `projects`. The factory gets the authenticated ID on each new connection, not the token.
- With the `agui` feature, `agent.serve_agui(AguiOptions { listen, actors, ..Default::default() }).await?` serves the host reads. Use the thread snapshot's `waitCursor` with `wait-closures?after=…` and, when it offers `runReceipts: 1`, `run-receipt?runId=…`. These are authenticated HTTP reads, not methods on an answerable `Session`.
- For ACP use `agent.serve_acp(AcpOptions { compose })` on stdio, or `agent.serve_acp_websocket(options, AcpServiceOptions { listen, actors, tls })`. `compose` is an optional `Arc<dyn AcpComposition>`; the trait takes a canonical project and optional saved session id, supplies history, optional configuration (for reading trust and settings) and new-session settings, and attaches client-supplied MCP servers through `project_mcp(session, project, servers)`.
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
- A plugin is an object: `{ name, replaces?, setup(registrar), stop? }`, or `definePlugin({ name, tools, hooks, … })` for the common case. `createAgent` has no Configuration option; the SDK installs the default. A plugin that registers a history store, credential store or Configuration lists `history`, `credentials` or `configuration` in `replaces`.
- `run` may return a value or a Promise. Streams are async iterables, used with `for await`. A tool refuses by calling `cx.refuse(reason)`, which throws and does not return.
- Standard Schema validators must expose the Standard JSON Schema input export, for example Zod 4. For plain JSON Schema assigned to a variable, use `as const` so its keywords keep their literal types for inference.
- `registrar.on("tool.before", handler)` infers the payload and answer from the point. A gate can return `"allow"` or `{ refuse: reason }`.
- A service can take `serve(() => makePlugin(), options)` for fresh plugin state per connection. `serveHistory(fileHistory(dir), { address, tokenFile, leaseTtl? })` resolves to `{ url, close }`; tests can ask for port `0` and await `close()` when done. `leaseTtl` is a whole number of milliseconds, at least 1, and defaults to 15,000.
- Use `defineProvider` to get `changed()`. `agent.refreshModels()` explicitly refreshes served catalogs.
- ACP's `compose(project, saved?)` takes an optional `SessionInfo`. `projectSettings(project)` and `projectMcp(project)` may be async. Without an explicit stdio `actor`, the actor ID comes from `actorId`, then `MODULAR_AGENT_ACTOR`, then `acp-user`.
- No default exports.
- Subscription Providers come from `@modular-agent/subscription` (`subscriptionLogins(path)`, `chatgpt({ logins, … })`, `grok({ logins, … })`, `signIn(provider, logins, options)` and `signOut(provider, logins)`, with `provider` `"chatgpt"` or `"grok"`) and `@modular-agent/claude` (`claude(options)`, in process on Anthropic's Agent SDK). The Claude package also has the program the Rust SDK starts.
- Approvals that wait: set `maxApprovalWaitMs` in `createAgent`; a session opts in with `approvalWait: "untilDeadline"` at creation or through `session.setSetting`. `session.questions({ present: true })` is an answerable delivery on that handle; a plain listing is not.
- Covered approvals: `createAgent({ approval: "ask", approvalCoversNested: true })`, default false. The approval view carries `coversNested`; each covered start records `approvalCoveredBy`.
- For named plugin callers, use `await serve(({ callerId }) => makePluginFor(callerId), { listen, callers })`. Add `tls` for a TLS listener. Each operator entry is `{ callerId, tokenFile }`. The listener authenticates before calling the factory. Neither the token nor a caller claim goes in a plugin message.
- `await agent.serveAgui({ listen, actors })` serves both host reads. From the thread snapshot, pass `waitCursor` as the `after` query value on `wait-closures`. When `runReceipts === 1`, pass the original `runId` as one query value on `run-receipt`. Use authenticated HTTP; neither read needs a presence stream.

## Packages

| | Rust | TypeScript |
|---|---|---|
| Core | crate `modular-agent` | `@modular-agent/core` |
| Official plugin `<name>` | crate `modular-agent-<name>` | `@modular-agent/<name>` |
| Testing kit | module `modular_agent::testing` | `@modular-agent/core/testing` |
| Fixture program | binary `modular-agent-fixtures` | `bin` of `@modular-agent/fixtures` |

The packages are not published to registries; build them from the repository (see the top-level README).

Official plugin names are the same in every language: `openai`, `anthropic`, `files`, `mcp`, `acp`, `approval`, `questions`, `compaction`, `model-selection`, `subagents`, `guardrails`, `history-http`.

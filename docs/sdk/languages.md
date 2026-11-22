# Languages

How each language expresses the [API](api.md). The rule is the same throughout: the concepts, operations, fields and error codes are the same in every SDK, and each is written the way a developer in that language expects. An SDK MUST NOT rename an operation, add a concept or drop one to suit its language. Where a language has no direct way to express something, this page says what to do instead.

## At a glance

| | Rust | TypeScript | Go | Python |
|---|---|---|---|---|
| Operations and fields | `snake_case` | `camelCase` | `UpperCamelCase` (exported) | `snake_case` |
| Types | `UpperCamelCase` | `UpperCamelCase` | `UpperCamelCase` | `UpperCamelCase` |
| `createAgent(options)` | `Agent::builder()…build().await` | `createAgent({ … })` | `modular.New(ctx, opts…)` | `await create_agent(…)` |
| Asynchronous work | `async` on Tokio | `Promise` | blocking calls taking `context.Context` | `async` on asyncio |
| Streams | `impl Stream<Item = Result<Event>>` | `AsyncIterable<Event>` | `iter.Seq2[Event, error]` | `AsyncIterator[Event]` |
| Cancellation | `CancellationToken` | `AbortSignal` | `context.Context` | task cancellation, plus `context.cancelled` |
| Errors | `Result<T, modular_agent::Error>` | thrown `AgentError` | returned `*modular.Error` | raised `AgentError` |
| Error code | `error.code()`, an enum | `error.code`, a string union | `err.Code`, typed string constants | `error.code`, a `StrEnum` |
| `lastTurn()` | `session.last_turn(): Result<Option<PromptResult>>` | `session.lastTurn(): Promise<PromptResult \| undefined>` | `session.LastTurn(ctx): (*PromptResult, error)` | `await session.last_turn()`; `None` if absent |
| Optional arguments | builder methods | an options object | functional options (`WithX`) | keyword arguments |
| Closed sets of values | enums with an `Unknown(String)` variant where shared data keeps unknown values | string unions | typed string constants | `StrEnum` |
| Tool input | a type deriving `Deserialize` and `JsonSchema` | a [Standard Schema](https://standardschema.dev) or JSON Schema | a struct with `json` tags | type hints or a Pydantic model |

## Schemas

A tool's input and output are written as types or schema objects, never as hand-written JSON Schema unless the developer chooses to. Each SDK turns them into JSON Schema 2020-12 using only the standard vocabulary and within-document references ([Tools](../bindings/data.md#tools)):

- **Rust:** `schemars` from a type that also derives `serde::Deserialize`.
- **TypeScript:** any validator implementing Standard Schema with a JSON Schema export, such as Zod or Valibot; or a JSON Schema object with its TypeScript type inferred.
- **Go:** `github.com/google/jsonschema-go` from a struct; field descriptions from `jsonschema` tags.
- **Python:** Pydantic from a model or from a function's type hints; field descriptions from the docstring or `Field`.

The SDK checks input against the schema before calling the tool, so the tool receives a typed value.

## Rust

- The core crate is `modular-agent`, imported as `modular_agent`. It requires Tokio.
- A tool is built with `Tool::new(name, description).run(|input: T, cx| async move { … })`. Hints are builder methods: `.read_only()`, `.safe_to_repeat()`.
- A plugin is built with `Plugin::new(name)` and chained registrations: `.tool(tool)`, `.on_tool_before(handler)`, `.replaces(item)`, `.config(settings)`, and `.setup(|r| …)` for items that depend on settings.
- Each hook point is its own typed method, `on_tool_before` rather than `on("tool.before", …)`, with `on_<point>_with(Order::First, handler)` or `Order::Last` for explicit order. A gate answers `Gate::Allow` or `Gate::Refuse(reason)`; `Gate::Refuse` is also the `step.after` end decision.
- A plugin program awaits `modular_agent::serve(plugin)` for stdio. To listen on a WebSocket, call `serve_websocket(plugin, ServeOptions { listen, token_file, tls })`.
- For ACP use `agent.serve_acp(AcpOptions { compose })` on stdio, or `agent.serve_acp_websocket(options, AcpServiceOptions { listen, actors, tls })`. `compose` is an optional `Arc<dyn AcpComposition>`; the trait takes a canonical project and optional saved session id, supplies history, trust and new-session settings, and attaches client-supplied MCP servers through `project_mcp(session, project, servers)`.
- Use `session.r#as(actor_id)?` to act for a joined actor.
- `serve_history(file_history(dir)?, options)` keeps service records separate from native session files; it does not export existing native sessions.
- Public errors are `modular_agent::Error`, not `anyhow::Error`. Plugin code can return any error that converts into it.
- An operation with options has a plain form and a `_with` form: `session()` and `session_with(SessionOptions { … })`.
- A tool refuses with `return Err(cx.refuse("reason"))`: the call ends `refused`, where any other error ends it `failed`.
- Streams are the boxed `EventStream`, so `StreamExt::next` works on them without pinning. An unboxed `impl Stream` made the guide's own loop fail to compile.
- Data types own their data and implement `Serialize`, `Deserialize`, `Clone` and `Debug`.
- Minimum Rust version: the one pinned in `rust/mise.toml`. Edition 2024.
- Subscription Providers: `chatgpt(ChatGptOptions::new(subscription_logins(path)))` and `grok(GrokOptions::new(subscription_logins(path)))`, given to `AgentBuilder::provider`. `sign_in` and `sign_out` are async and take `"chatgpt"` or `"grok"`. `SignInOptions::paste` is an optional Tokio receiver of pasted lines, ignored for Grok. `AgentBuilder::claude_provider(claude(ClaudeOptions::default())?)` starts the Claude program as a process plugin; it needs Node.js 22 or later.

## TypeScript

- The core package is `@modular-agent/core`, an ES module with its own type declarations. It runs on Node.js 22 or later.
- A tool is `tool({ name, description, input, run })`. Hints are fields: `readOnly: true`.
- A plugin is an object: `{ name, replaces?, setup(registrar), stop? }`, or `definePlugin({ name, tools, hooks, … })` for the common case.
- `run` may return a value or a Promise. Streams are async iterables, used with `for await`. A tool refuses by calling `cx.refuse(reason)`, which throws and does not return.
- Standard Schema validators must expose the Standard JSON Schema input export, for example Zod 4. For plain JSON Schema assigned to a variable, use `as const` so its keywords keep their literal types for inference.
- `registrar.on("tool.before", handler)` infers the payload and answer from the point. A gate can return `"allow"` or `{ refuse: reason }`.
- A service can take `serve(() => makePlugin(), options)` for fresh plugin state per connection. `serveHistory(fileHistory(dir), { address, tokenFile })` resolves to `{ url, close }`; tests can ask for port `0` and await `close()` when done.
- Use `defineProvider` to get `changed()`. `agent.refreshModels()` explicitly refreshes served catalogs.
- ACP's `compose(project, saved?)` takes an optional `SessionInfo`. `projectSettings(project)` and `projectMcp(project)` may be async. The stdio actor id comes from `actorId`, then `MODULAR_AGENT_ACTOR`, then `acp-user`.
- No default exports.
- Subscription Providers come from `@modular-agent/subscription` (`subscriptionLogins(path)`, `chatgpt({ logins, … })`, `grok({ logins, … })`, `signIn(provider, logins, options)` and `signOut(provider, logins)`, with `provider` `"chatgpt"` or `"grok"`) and `@modular-agent/claude` (`claude(options)`, in process on Anthropic's Agent SDK). The Claude package also has the program the Rust and Go SDKs start.

## Go

- The module is `github.com/daniel-ballance/modular-agent/go` until the repository is published; import `github.com/daniel-ballance/modular-agent/go/modular` and construct an agent with `modular.New(ctx, …)`.
- Every operation that can wait takes a `context.Context` first. Cancellation is the context's.
- A tool is `modular.NewTool(name, description, func(ctx context.Context, in T, tc *modular.ToolContext) (Out, error), opts…)`, with type parameters for input and output.
- A plugin is a `modular.Plugin` value with `Name`, `Replaces` and `Setup func(*modular.Registrar) error`.
- Streams are `iter.Seq2[Event, error]`, used with `range`.
- Use `agent.Session(ctx, modular.SessionOptions{Settings: settings, Tenant: tenant, Actors: actors})` for per-session options.
- `ServeACP(ctx, options ...ServeACPOptions)` accepts at most one options value; `Input` and `Output` can replace stdin and stdout. `Compose(ctx, project)` gets the saved id on reopen through `modular.ACPReopeningSession(ctx)`. `ProjectSettings` supplies new-session defaults and `ProjectMCP` supplies trusted server configs. Use `ListenACP(ctx, options)` for the WebSocket listener handle.
- Use `modular.HTTPHistory(url, tokenFile)` for the client store and `modular.ServeHistory(ctx, store, modular.HistoryOptions{Address: address, TokenFile: tokenFile})` for the service. It runs until the context is cancelled and does not return a listener address.
- Set `Provider.CatalogChanges` to a `*modular.CatalogChanges` and call `Changed()` after updating the catalog. Register hooks with `Registrar.On(point, handler, options...)` or the typed methods; use `HookOrder` for explicit order.
- Errors are values. `errors.As(err, &modularErr)` gives the code.
- Minimum Go version: the one pinned in `go/mise.toml`.
- Subscription Providers are in package `subscription`: `SubscriptionLogins(path)`, `SignIn`, `SignOut`, `ChatGPT`, `Grok` and `Claude`. `Grok(subscription.GrokOptions{Logins: logins})` returns a Provider; `SignIn(ctx, "grok", logins, options)` runs its device sign-in. `Claude` starts the TypeScript Claude program as a process plugin; it needs Node.js 22 or later.

## Python

- The distribution is `modular-agent`, imported as `modular_agent`. Official plugins are extras: `modular-agent[openai]`.
- Attributes and keyword arguments are `snake_case`. A dictionary that is shared wire data, such as a raw history entry, a hook payload or a Provider request, keeps the shared field names; passing or returning it never renames its keys.
- Durations are seconds, as `float`, the Python convention; the SDK converts them to the binding's integer milliseconds.
- The API is `async`. `modular_agent.run(coro)` runs a coroutine for scripts that are not already async.
- `create_agent(…)` can be awaited, or used with `async with`, which closes the agent at the end of the block. `serve(plugin)` is an ordinary function for stdio. For WebSocket use `await serve(plugin_or_factory, listen=..., token_file=...)`; the factory returns a fresh plugin per connection. Set `service_ping_interval` and `service_control_timeout` in `create_agent` to configure plugin-service liveness in seconds.
- Use `await agent.session(settings=..., actors=..., tenant=...)` for per-session options and `session.as_actor(actor_id)` for `session.as(actorId)` (`as` is reserved).
- ACP's async `compose(project)` and optional `compose_reopen(project, id)` take a canonical `Path`; `project_settings` and `project_mcp` are synchronous callbacks.
- In the history service process, call `serve_history(file_history(directory), address=(host, port), token_file=path)`. The client uses `http_history(url, token_file)`.
- Inherit `ProviderCatalog` to call `changed()`. A hook handler registered with `r.on(point, handler, order='normal')` receives a payload dictionary with the binding's keys and a `HookContext`; a handler that does not need the context may take only the payload. Return `{'change': {'input': new_input}}` to rewrite `tool.before`, `{'change': {'content': content}}` to rewrite `tool.after`, `{'add': {'system': text}}` to contribute a prompt, or `{'end': reason}` to end at `step.after`.
- A tool is an `async` function with the `@tool` decorator. The docstring's summary is the description and its `Args:` entries describe the fields; type hints are the input schema; hints are decorator arguments: `@tool(read_only=True)`.
- A plugin is a `Plugin(name, tools=[…], hooks={…})` or a subclass overriding `setup`.
- Every public function and type is fully type-annotated and passes a strict type checker.
- Minimum Python version: the one pinned in `python/mise.toml`.
- Subscription Providers: `subscription_logins(path)`, `await sign_in(provider, logins, …)` and `await sign_out(provider, logins)`, where `provider` is `"chatgpt"` or `"grok"`. Construct the Providers with `modular_agent.chatgpt.chatgpt(logins=…)` or `modular_agent.grok.grok(logins=…)`, and `modular_agent.claude.claude(…)` on Anthropic's Python Agent SDK.

## Packages

| | Rust | TypeScript | Go | Python |
|---|---|---|---|---|
| Core | crate `modular-agent` | `@modular-agent/core` | package `modular` | `modular-agent` |
| Official plugin `<name>` | crate `modular-agent-<name>` | `@modular-agent/<name>` | package `modular/<name>` | module `modular_agent.<name>`, extra `[<name>]` |
| Testing kit | module `modular_agent::testing` | `@modular-agent/core/testing` | package `modular/modulartest` | module `modular_agent.testing` |
| Fixture program | binary `modular-agent-fixtures` | `bin` of `@modular-agent/fixtures` | command `modular/cmd/fixtures` | `python -m modular_agent.fixtures` |

The packages are not published to registries; build them from the repository (see the top-level README). The Go module path is `github.com/daniel-ballance/modular-agent/go`.

Official plugin names are the same in every language: `openai`, `anthropic`, `files`, `mcp`, `acp`, `approval`, `questions`, `compaction`, `model-selection`, `subagents`, `guardrails`, `history-http`.

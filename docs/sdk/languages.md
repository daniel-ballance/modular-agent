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
- Plugins implement the `Plugin` trait, or are built with `Plugin::new(name)` and chained registrations.
- Public errors are `modular_agent::Error`, not `anyhow::Error`. Plugin code can return any error that converts into it.
- An operation with options has a plain form and a `_with` form: `session()` and `session_with(SessionOptions { … })`.
- A tool refuses with `return Err(cx.refuse("reason"))`: the call ends `refused`, where any other error ends it `failed`.
- Streams are the boxed `EventStream`, so `StreamExt::next` works on them without pinning. An unboxed `impl Stream` made the guide's own loop fail to compile.
- Data types own their data and implement `Serialize`, `Deserialize`, `Clone` and `Debug`.
- Minimum Rust version: the one pinned in `rust/mise.toml`. Edition 2024.

## TypeScript

- The core package is `@modular-agent/core`, an ES module with its own type declarations. It runs on Node.js 22 or later.
- A tool is `tool({ name, description, input, run })`. Hints are fields: `readOnly: true`.
- A plugin is an object: `{ name, replaces?, setup(registrar), stop? }`, or `definePlugin({ name, tools, hooks, … })` for the common case.
- `run` may return a value or a Promise. Streams are async iterables, used with `for await`.
- No default exports.

## Go

- The module is the repository's `go/` directory; the core package is `modular`, so an agent is `modular.New(ctx, …)`.
- Every operation that can wait takes a `context.Context` first. Cancellation is the context's.
- A tool is `modular.NewTool(name, description, func(ctx context.Context, in T, tc *modular.ToolContext) (Out, error), opts…)`, with type parameters for input and output.
- A plugin is a `modular.Plugin` value with `Name`, `Replaces` and `Setup func(*modular.Registrar) error`.
- Streams are `iter.Seq2[Event, error]`, used with `range`.
- Errors are values. `errors.As(err, &modularErr)` gives the code.
- Minimum Go version: the one pinned in `go/mise.toml`.

## Python

- The distribution is `modular-agent`, imported as `modular_agent`. Official plugins are extras: `modular-agent[openai]`.
- The API is `async`. `modular_agent.run(coro)` runs a coroutine for scripts that are not already async.
- `create_agent(…)` can be awaited, or used with `async with`, which closes the agent at the end of the block. `serve(plugin)` is an ordinary function that runs until the agent closes the connection.
- A tool is an `async` function with the `@tool` decorator. The docstring's summary is the description and its `Args:` entries describe the fields; type hints are the input schema; hints are decorator arguments: `@tool(read_only=True)`.
- A plugin is a `Plugin(name, tools=[…], hooks={…})` or a subclass overriding `setup`.
- Every public function and type is fully type-annotated and passes a strict type checker.
- Minimum Python version: the one pinned in `python/mise.toml`.

## Packages

| | Rust | TypeScript | Go | Python |
|---|---|---|---|---|
| Core | crate `modular-agent` | `@modular-agent/core` | package `modular` | `modular-agent` |
| Official plugin `<name>` | crate `modular-agent-<name>` | `@modular-agent/<name>` | package `modular/<name>` | module `modular_agent.<name>`, extra `[<name>]` |
| Testing kit | module `modular_agent::testing` | `@modular-agent/core/testing` | package `modular/modulartest` | module `modular_agent.testing` |
| Fixture program | binary `modular-agent-fixtures` | `bin` of `@modular-agent/fixtures` | command `modular/cmd/fixtures` | `python -m modular_agent.fixtures` |

These names are provisional until the first release reserves them on each registry. The Go module path depends on where the repository is published.

Official plugin names are the same in every language: `openai`, `anthropic`, `files`, `mcp`, `acp`, `approval`, `questions`, `compaction`, `model-selection`, `subagents`, `guardrails`, `history-http`.

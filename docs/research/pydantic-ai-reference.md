# Pydantic AI and its ecosystem as a reference

These notes come from the Pydantic AI repository, read on 2026-11-16 at commit `c7586d7` on `main` (latest release tag `v2.68.0`). Only `docs/` and the package sources were checked out, to `~/Code/_ref/pydantic-ai`. They were read, not run. Pages used, all under `docs/`:
- `extensibility.md`, `capabilities/overview.md`, `capabilities/custom.md`, `capabilities/on-demand.md`, `capabilities/handle-deferred-tool-calls.md` and `hooks.md`
- `harness/index.md` (Pydantic AI Harness)
- `deferred-tools.md`, `toolsets.md` (headings), `agent.md` (runs, graph iteration, instructions), `persistence.md`, `durable_execution/overview.md`, `interfaces.md`, `workspace.md` and `agent-spec.md`
- `comparisons/vs-pi.md`

Upstream: <https://github.com/pydantic/pydantic-ai>, documentation at <https://ai.pydantic.dev>. MIT licensed.

## The ecosystem

- **Pydantic AI:** the agent framework, a Python library. Its core is deliberately "a light harness": the typed agent loop, any model, your own tools, and structured output.
- **Pydantic AI Harness:** the official library of capabilities (90+). Complete agents such as `Coder` and `Researcher` are themselves combinations of capabilities that can be taken apart.
- **Pydantic Graph:** the general state-machine library the agent loop runs on.
- **Pydantic Evals:** evaluation. **Logfire:** observability, built on OpenTelemetry.
- `fasta2a`, a separate package, serves an agent over A2A.

## Shape

- **There is no Harness/Runtime split as we draw it.** An `Agent` is a definition (model, instructions, tools, capabilities). An agent **run** executes the loop. The application around it owns everything else: storing conversations, choosing an interface, and choosing durability.
- **The loop is a graph** of three node types: `UserPromptNode`, `ModelRequestNode` and `CallToolsNode`. A caller can step through it one node at a time (`agent.iter()`, `next()`).
- **History belongs to the caller.** A run returns a `Conversation` (messages, usage, ID, and pending deferred calls), and the next run takes it back as input. "Runs vs. conversations": one conversation can span many runs.
- **Interfaces are separate from the agent.** The same agent runs from code, a terminal, a web chat, AG-UI or Vercel AI streams, ACP for editors (experimental, in the Harness), A2A, realtime voice, and GitHub Agentic Workflows.
- **Agent specs** define an agent declaratively in YAML or JSON: its model, instructions, settings and a list of capabilities.

## Vocabulary

| Pydantic AI | Ours |
|---|---|
| model request plus the tool calls it makes (one `ModelRequestNode` and one `CallToolsNode`) | step |
| agent run | turn |
| conversation | session (but the application stores it, not the agent) |
| `Agent` | roughly the Harness configuration plus a Runtime |
| **capability** | **plugin** |
| toolset | tool source |
| `Model` / provider | Provider |
| hook | hook handler |
| deferred tool call | a tool call waiting on the person or on outside work |

**Name clash:** Pydantic AI's "capability" is our **plugin**, not our **capability**. Our capability (a named role a plugin fills, DeepSeek Harness's "seam") has no single equivalent: Pydantic AI has typed interfaces such as `Model`, `AbstractToolset` and the workspace instead.

## Capabilities (our plugins)

- **A capability bundles any mix of** tools (toolsets or provider-native tools), lifecycle hooks, instructions, model settings, and model selection. It is "the primary extension point". A simple one needs no subclass: `Capability(...)` bundles instructions and tools declaratively.
- **Core versus Harness has a mechanical rule, not a maturity rule.** Core ships the capabilities that need model or framework support: provider-native tools, provider APIs such as server-side compaction, deep loop integration such as tool search, and fundamentals such as thinking, MCP and web search. Everything else (files, shell, sandboxes, skills, memory, subagents, planning, guardrails, model-agnostic compaction) is in the Harness, "so capabilities can iterate at the speed the field moves while Pydantic AI itself stays lean."
- **Composition follows middleware rules,** as in Django and Starlette. When several capabilities are combined:
  - configuration merges: instructions concatenate, model settings merge with later ones winning, and toolsets combine
  - `before_*` hooks fire in capability order, `after_*` in reverse, and `wrap_*` nests with the first capability outermost
  - a capability can declare where it must sit, regardless of list order: `position` (outermost or innermost), `wraps`, `wrapped_by`, and `requires` (fail if a capability it needs is missing). The combined list is sorted topologically.
- **Capabilities can be loaded by the model on demand.** With `defer_loading=True` a capability collapses to a one-line catalog entry, and its instructions and tools stay hidden until the model loads it. Agent Skills work this way, and it is "progressive disclosure" for whole bundles of tools.
- **Capabilities publish typed events** in their own namespace (for example `workspace.file_read`), and other capabilities react with `@on_event`. Listeners run in capability order. An event class can declare immediate dispatch, which makes it a decision: the emitter waits until every listener has run, so a listener can veto the action. Their example is a capability that stops writes into `.git`.
- **One capability, two implementations:** web search, web fetch, image generation and MCP run on the provider's side when the model supports it, and fall back to a local implementation otherwise.
- **Capabilities can be written by the agent itself:** "Capability Creation" lets an agent write, check and save new capabilities during a run, for a later run to load.

## Hooks

- **Every stage has the same lifecycle:** `wrap_*` enter, then `before_*`, then the operation (with `on_*_error` if it fails), then `after_*`, then `wrap_*` exit. A wrap hook that does not call its handler skips everything inside it.
- **The stages:** the run, each graph node, each model request, tool argument validation, tool execution, output validation and processing, tool preparation (filtering or changing tool definitions for each step), deferred tool calls, and the event stream.
- **Error hooks:** re-raise to let the error through, raise a different error to transform it, return a value to recover.
- Hooks can be filtered by tool, can have timeouts, and can trigger a retry (`ModelRetry`) or a tool failure (`ToolFailed`).

## Tools and toolsets

- A **toolset** is a tool source. Toolsets compose through wrappers: combine, filter, prefix names, rename, change definitions for each step, require approval, defer loading, add metadata, and change how calls run.
- **The workspace is a typed environment** that tools use through `ctx.workspace`: run commands, read and write files. It can be the local directory or a cloud or local sandbox (more than a dozen in the Harness). "Harness capabilities never pick one for you": a run that needs a workspace fails at its start if none is attached.

## Waiting for the person

A **deferred tool call** is one that cannot finish within the run as it stands: it needs approval, or its result comes from outside (a frontend, a worker, a person). Each pending call says what it waits for: `approval`, `question` or `external`. There are three ways to resolve one:
1. **Answer in place.** A `HandleDeferredToolCalls` capability's handler returns results for some or all pending calls, and the run carries on. Handlers form a chain, and each handles what the previous ones left.
2. **Wait with a resume token.** The handler passes a token to whoever will answer (a Slack button, an email link, an admin page), and the run waits until the token is resolved. In a durable run the engine records the wait and the answer, so the wait survives restarts.
3. **End the run.** Its output is `DeferredToolRequests`. The caller collects answers and starts a new run with the conversation plus `DeferredToolResults`.

The three combine: a handler can resolve some calls and let the rest end the run. Pydantic AI Harness's `AskUser` raises a deferred call of kind `question`, and the application supplies the answerer.

## History, persistence and durability

Pydantic AI separates four things that are often blurred:

| Need | Answer |
|---|---|
| Keep a conversation and continue it later | store the `Conversation` (core, in your own database), or a `ConversationStore` |
| A record of what each run did, with snapshots to continue or fork from | `StepPersistence` (Harness): a snapshot at each settled tool-call boundary |
| Remember across conversations | `Memory` (Harness) |
| Survive the process dying partway through a step | durable execution |

- **"Durability is not storage."** A durable engine keeps one run alive through a crash. It records each model request and tool call, replays the finished ones, and retries the one in progress. Saving, resuming and forking runs need no engine.
- **Nine engines,** each wrapping the same agent definition: Temporal, DBOS, Prefect, Restate, AWS Lambda, Absurd, pgtask, Azure Durable Task and Airflow. There is also a builder for others. A capability marks its own outside work as **durable operations**, under a stable ID, so engines can record and replay it.
- **Instructions that change mid-conversation can be appended** instead of rewritten, so the prompt cache survives. Appended instructions are rebuilt from saved history.

## Ideas worth taking

1. **Three ways to resolve a waiting call:** answer in place, wait on a resume token, or end the run. The middle one is the piece our open question [Waiting for the user](../contracts.md#questions) proposal lacks: an answer that arrives later can resume the *same* turn, provided something durable holds it.
2. **Kinds of waiting** (`approval`, `question`, `external`) on one mechanism, instead of separate approval and question systems.
3. **Middleware composition with declared ordering** (`position`, `wraps`, `wrapped_by`, `requires`) answers part of open questions [How handlers combine](../contracts.md#hook-execution) and [Plugin lifecycle](../open-questions.md#plugin-lifecycle): how handlers combine, and how a plugin says where it must sit and what it needs.
4. **"Durability is not storage"** separates our open questions [What history records](../open-questions.md#what-history-records) and [Transient and durable Runtimes](../open-questions.md#transient-and-durable-runtimes). A transient and a durable Runtime can share one agent definition if every outside effect is a recordable operation: model requests, tool calls, and operations that plugins declare.
5. **The core versus Harness rule:** core holds only what needs deep integration with the loop or the model, and everything else ships separately. That is a concrete test for open question [What the Harness keeps](../contracts.md#plugins-and-capabilities).
6. **Plugins the model loads on demand.** A plugin's tools and instructions can stay hidden until the model asks for them, as Agent Skills do. This bears on open question [Plugin scope](../open-questions.md#plugin-scope).
7. **Namespaced plugin events, including decision events a listener can veto**, as a way for plugins to build on each other (open question [Plugins building on plugins](../contracts.md#plugins-and-capabilities)).
8. **The workspace as a typed environment** that tools reach through one handle, with many swappable backends (open question [Working environment](../contracts.md#harness-and-working-environment)).

## Cautions

- **Pydantic AI's comparison page is marketing.** Its Pi column, last checked 2026-09-26, lists Pi's interfaces as "CLI" only, although Pi also has print, JSON and RPC modes and an SDK.
- **It is a library, not a product.** The application around the agent owns conversation storage, interfaces and deployment, so it says less than Pi or DeepSeek Harness about how those parts fit together.
- Its "capability" means our "plugin". Read its docs with that in mind.

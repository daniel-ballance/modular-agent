# DeepSeek Harness as a second reference

These notes come from DeepSeek Harness (`dsh`) version `0.2.2-rc.3`, a developer preview. The repository was read on 2026-11-16 at commit `39163dd` (2026-11-13), cloned to `~/Code/_ref/deepseek-harness` and read, not run. Sources inside that clone:
- `README.md`, `docs/architecture.md`, `docs/glossary.md`, `docs/cordis-primer.md`, `docs/agent-lifecycle.md` and `docs/tool-execution-pipeline.md`
- `docs/subsystems/tools.md`, `approval.md`, `user-questions.md`, `core.md`, `session.md` and `subagent.md`
- the READMEs of `packages/core/agent-loop`, `packages/llm/llm-pi-ai`, `packages/sdk/protocol` and `packages/acp/acp`
- the decision note `.agents/notes/implemented/architecture/2026-07-05-reconstructable-requests.md`

Upstream: <https://github.com/deepseek-ai/deepseek-harness>. It is MIT licensed.

## Shape

- **Everything is a plugin.** It is built on Cordis, a plugin framework: plugins contribute services (`ctx.tools`, `ctx.llm`, `ctx.sessions`, …), typed events and reversible registrations to one shared context. The agent loop is itself a plugin (`ctx.agentLoop` implements the `Agent` interface), so it can be replaced from configuration.
- **There is no Runtime/Harness split and no process boundary between them.** Every seam is an in-process TypeScript service. Its wire protocols sit only at the edges: an SDK JSON-RPC server, an ACP server, and the Web UI.
- **A seam has three roles:** a Service Definition (the interface), one or more Service Providers, and Consumers. Example: `dsh-shell` defines the shell seam, `dsh-bash-local` and `dsh-bash-sandbox` provide it, and `dsh-tool-bash` consumes it. Pointing the filesystem and subprocess providers at a remote sandbox moves Bash, the terminal and LSP with them.
- **Composition is configuration.** A profile stacks bundles of plugin config rows (`web`, `headless`, `sdk`, `acp`), and each layer can patch any row by id.

## Vocabulary

Its loop vocabulary matches ours exactly:

| DeepSeek Harness | Ours |
|---|---|
| step (one model request plus the tools it calls) | step |
| turn (zero or more steps, "one drain of admitted input") | turn |
| session | session |
| round (an outer policy loop around a turn, such as a goal round) | no equivalent |
| exchange (turns from one human input until the next, including turns woken by notices) | no equivalent |
| plugin | plugin |
| seam (a capability with its definition, providers and consumers) | capability |
| human command | command |
| `ctx.agentLoop` (the default driver) | Runtime |
| the plugin tree around it | Harness |
| `ctx.llm` adapter | Provider |
| Web UI, SDK client, ACP client | Interfaces |

## How handlers combine

Each event declares one dispatch mode as part of its public contract, documented with an `@mode` tag and checked against dispatch sites:

| Mode | Awaited | Order | Returns a value |
|---|---|---|---|
| `emit` | no | registration order | no |
| `waterfall` | no | registration order | yes |
| `parallel` | yes | all at once | no |
| `serial` | yes | registration order | yes |
| `bail` | no | until one bails | yes |

A `waterfall` is around-middleware. Each listener gets `next()`: calling it delegates, and returning without calling it short-circuits. A policy listener that owns the decision returns its answer, and a listener that only annotates must call `next()`. The loop's interception points (`agent/pre-step`, `agent/request`, `llm/stream`, and the three `tools/*` events) are waterfalls. `agent/turn-stopping` is `serial`.

Compare Pi's six combination patterns, in the [Pi reference](pi-reference.md#layer-2-pi-coding-agent-the-harness).

## The turn

From `docs/architecture.md` and `docs/agent-lifecycle.md`:

1. `turn/start`. Claim pending next-step input plus one queued message from the inbox.
2. Snapshot the session's model selection. Resolve this step's tool set and assemble the prompt.
3. `agent/pre-step` (waterfall): accept, rewrite or reject the claimed messages. A rejection, or an empty first batch, closes the turn with no step.
4. `step/start`. `agent/request` adjusts call controls but cannot change the provider, model or effort. `prepareCall()` binds the adapter.
5. Log the system prompt, the entered user messages, and a `request/header` when one is owed. Derive the model history from the log and freeze the request.
6. Stream the model call through the `llm/stream` waterfall, then commit `assistant/message`. A failed attempt is committed as `assistant/attempt` instead, and `agent/request-error` may ask for a retry within the same step.
7. Run the tool batch (see [Tools](#tools)), then `step/end`.
8. If the tools are owed another request, or new next-step input has arrived, start the next step. On a natural stop with an empty inbox, `agent/turn-stopping` runs as a final checkpoint.
9. `turn/end`.

**Input during a turn.** One inbox feeds the loop. `followup()`, `steer()` and `inject()` are presets of one `send` method. Steering joins the nearest step. Injected context waits until something else wakes the agent. Every claimed batch passes through `agent/pre-step`, so all three use the same hook point.

## Tools

The loop hands the whole raw batch of tool calls to a service. It does not call tools itself.

- **Tool set per step.** Before each step the loop calls `ctx.tools.resolve()` with the model selection it captured. The returned `ResolvedToolSet` decides both what the model is told it can call and what may run, including calls nested inside code mode. A tool can carry a `when` condition. The set is disposed of once the step's batch settles.
- **The executor is a seam.** `ctx.tools.execute({ calls, signal, agent, toolSet, log, maxParallelToolCalls })` delegates to the nearest `ToolExecutor`. The executor owns argument parsing, scheduling, concurrency, cancellation, and logging the calls and their results. It returns one result per call, in the order the model gave them. There are two executors: native, and PTC, a code mode in which the model writes a `run_code` program whose sub-calls go through the same pipeline.
- **The pipeline for each call:**
  1. `tool/call` is logged before anything runs.
  2. `tools/pre-execute` (waterfall: hooks, permission, sandbox) returns allow, deny or ask. Ask goes to `ctx.approval`.
  3. **Monotonic guards** run after that waterfall. They can deny or abstain, never allow, so a later plugin cannot reopen a gate that owner policy closed.
  4. `tools/execute` (waterfall around the call: timeout, retry, metrics).
  5. The tool body runs. Filesystem writes pass `fs/write-intent` or `fs/edit-intent`.
  6. `tools/post-execute` (waterfall) can accept, block, replace the result, or add context.
  7. `tools/result` (notification) sees the final, frozen result. `tool/result` is logged.
- **Tools declare their output.** A `ToolDefinition` has a mandatory `output` schema. The body returns a JSON value checked against that schema, and a separate `render()` turns it into model-facing content. Presentation hooks (`presentCall`, `presentResult`) are kept off the model-facing schema.
- **Crash repair.** When a step fails, the loop records an error result for every unanswered tool call. A call that was logged but has no result gets `TOOL_OUTCOME_UNKNOWN`. A call that never started gets `TOOL_NOT_STARTED`. The history stays paired, and operations whose outcome is uncertain are not retried automatically.

## Waiting for the user

Like Pi, it waits in place by default. It adds a way to turn a wait into an "ended, then resumed" exchange, and it keeps the state needed for that in the session log.

- **Approval** (`ctx.approval.request`) has a closed set of outcomes: `allowed-once`, `rejected`, `cancelled` and `unavailable`. Only `allowed-once` grants, and only for that one action. A missing, throwing or misbehaving answerer becomes `unavailable`, so the gate fails closed.
  - Answerers form a waterfall (`approval/request`), and a UI can answer only for the agents it owns.
  - The request carries the tool name and a `callId`, not the arguments, so the UI attaches the prompt to the tool call it has already shown.
  - Each request logs an `approval/asked` and `approval/decided` pair for audit. Neither enters the model's transcript.
  - A per-session policy, `ask` or `never`, is a logged event. `never` rejects everything without asking anyone, for CI and unattended runs.
  - It is valid only inside an open turn.
- **Questions** (`ctx.userQuestions.ask`) take a batch of questions. Each has a caller-chosen `id` that comes back with its answer, optional choices, and multi-select. An optional `intent` (`plan-review` or `approval`) changes only how it is presented, never the answer format.
- **Timed questions** are the hybrid:
  1. The tool waits in place for a fixed window.
  2. If the user answers in time, the answer is the tool result.
  3. Otherwise the tool returns `{ pending: true, callId }`. The turn carries on, and the question stays answerable with no deadline.
  4. A late answer is queued as a user message (source `user-question-reply`). It wakes the agent and is handled in a new turn.
  5. Which questions are still open is a projection of the log, not wait state held in memory, so it survives a restart. After a restart the Host resumes the agent, and a late reply starts a new turn.
  6. While a client is attached it holds a claim on the wait, which pauses the deadline. Closing the panel sends nothing.
- **Over the SDK wire** these become server-to-client JSON-RPC requests (`approval/request`, `user-question/ask`), which the client opts into at `initialize`. Cancellation discards late responses. Losing the transport fails pending decisions closed.

## Session log and reconstruction

- **Event-sourced sessions.** The session is an append-only log of typed events. The model's history is derived from it by a pure function applied per event. Live UI updates arrive on a separate, non-durable stream (`agent/assistant-stream`).
- **"Model-visible ⟺ durably referenced."** Anyone holding the log, the content-addressed attachments it references, and the pinned code version can rebuild every model request byte for byte. A `request/header` event records a full snapshot of the call config and the exact tool schemas the model saw. It is written at the start, on resume, and whenever something changes. A system-prompt change is logged as a history event, not a header change.
- **Prefix caching is a consequence, not something managed.** Because the log is append-only and the history is a pure function of it, each request extends the previous one unless the header changed, so provider prefix caches keep hitting. They test this: an end-to-end test checks that cache-read tokens are positive after the first request.
- They rejected letting a hook change the model per call, because it would silently drop the cache and leave no record. Model selection is per-conversation state that is logged. A hook may propose a change, and the log records it.

## Providers

- `ctx.llm` is the adapter seam. The loop calls `prepareCall()` to bind an adapter for a step, then streams through it.
- Credentials are looked up per request through a separate credentials seam (`apiKeyEnv` names a reference, not a secret), so changing settings takes effect on the next request without a restart.
- One of its adapters, `dsh-llm-pi-ai`, routes through Pi's `pi-ai` provider library.

## Wire protocols and subagents

- **SDK protocol:** JSON-RPC 2.0, one message per line.
  - Client to server: `initialize`, `session/prompt` (returns a durable enqueue receipt, not the answer), `session/query`, `session/resume`, `session/wait`, `shutdown`.
  - Server to client: requests for approval and questions, plus notifications `session.event` (the durable events), `session.status` (`running`/`idle`) and `subagent.started`/`subagent.finished`.
- **ACP** ([Agent Client Protocol](https://agentclientprotocol.com)) server for automation: create or resume sessions, choose the model, attach MCP servers, prompt, cancel and receive updates. It deliberately leaves out UI-specific features. The repository's own client for it, `dsh-subagent-acp`, is used to run subagents out of process.
- **Subagents** use one activation API with several backends: a local child agent, or an external execution such as a turn delegated to another product. Backends declare capability flags (`agentOptions`, `agentPreset`, `outputSchema`, `depthLimit`) that are checked before starting. A result is delivered either to the parent's model or only to the caller.

## Ideas worth taking

1. **The timed hybrid for suspended turns.** Wait in place for a window, then turn the wait into a pending tool result and a later user message. This joins the two models in open question [Waiting for the user](../contracts.md#questions), and it survives restarts because what is still open comes from the log.
2. **Closed, fail-closed approval outcomes**, with a per-session `never` policy for unattended runs, and approvals that refer to the tool call by `callId` instead of copying its arguments.
3. **"Model-visible means logged"** as a rule, with a request header that records the model, call config and tool schemas. This bears on open questions [Changing the model mid-turn](../open-questions.md#changing-the-model-mid-turn) and [What history records](../open-questions.md#what-history-records) ([open questions](../open-questions.md)).
4. **`TOOL_OUTCOME_UNKNOWN` versus `TOOL_NOT_STARTED`** as the crash-repair vocabulary for durable Runtimes (open question [Transient and durable Runtimes](../open-questions.md#transient-and-durable-runtimes)).
5. **A dispatch mode declared per hook point** (`emit`, `waterfall`, `parallel`, `serial`, `bail`), as an alternative to Pi's six patterns (open question [How handlers combine](../contracts.md#hook-execution)). Monotonic guards that can deny or abstain but never allow are worth a mode of their own.
6. **A tool set resolved once per step**, used both for what the model is told and for what may run, and a batch-level tool request instead of one request per call (open questions [Parallel tool calls](../open-questions.md#parallel-tool-calls) and [Direct tool access](../open-questions.md#direct-tool-access)).
7. **The inbox model:** follow-up, steer and inject as presets of one operation, all passing through one pre-step hook point (open question [Input during a turn](../open-questions.md#input-during-a-turn)).
8. **ACP**, which it serves for automation and uses for out-of-process subagents. It is now in the [protocol landscape](protocol-landscape-2026-11.md#acp-agent-client-protocol), and bears on how the agent looks from outside and on agents called as tools (open questions [The agent from outside](../open-questions.md#the-agent-from-outside) and [Agents working together](../open-questions.md#agents-working-together)).

## Cautions

- It is a developer preview (`0.2.2-rc.3`), and its README warns of breaking changes.
- The documentation is extremely dense, and the system is large: more than 50 package groups. Much of that complexity comes from being a full product (desktop, web, office documents, teams), not from the agent design.
- Every seam is an in-process service. It shows how to divide the work, but it does not show what a Harness ↔ Runtime wire protocol looks like. Pi's RPC mode and its SDK protocol are the only wire prior art in either project.
- Nothing in these notes was tested by running it. "People have said great things about it" comes from the user; the third-party reviews found in search were not read.

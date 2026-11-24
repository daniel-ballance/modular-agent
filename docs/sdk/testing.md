# Testing

Each SDK ships a testing kit for developers, and runs a shared set of scenarios against itself and the other SDKs. Both work offline, with no real model and no credentials.

## Planned AG-UI kit

The [AG-UI kit](../../conformance/agui/README.md) uses a scripted Provider, a controlled clock and store, and disposable tokens. It needs no real model or external tools. It targets these checks:

- Discovery, explicit AG-UI version, request and event limits, SSE framing, lifecycle validation and coexistence with ACP WebSocket on one listener. Check TLS, actor and client scope, tenant and project filters, and no setup on an unauthorized request.
- Initial prompt, one turn per run, stable message IDs, message snapshots, duplicate input keys, mismatched copies, history with and without a cursor, stale cursors, branch moves and erasure. Reconnect must not replay live chunks or execute work.
- Question answer, decline and expiry; approval with a present route that received unchanged arguments; no approval on another client, changed view, missing answer or lost presence. Resuming a waiting turn must not start a duplicate turn.
- Exact registered offers, final authority and approval before handoff, written `toolStarted` and checkpoint, and no executable draft or replay. Check result acceptance and `tool.after`, report races with timeout, changed authority and erasure, and refusal of a foreign actor or route. A second connection on the same route can submit once.
- Crash before handoff, after handoff, after result commitment and during continuation. Check no redispatch, one continuation with no new input, restored deadlines, correct `outcomeUnknown` and erased-report refusal. Include mixed tool and question waits.
- State snapshot, delta base and resnapshot after withholding. Check recipient gating on state, errors, native output, extensions and replay. No keys or opaque Provider data appear. Strip unknown input fields without granting anything; reject malformed known values.
- Trusted per-request trace context, no baggage or content, pending execution and later settlement spans, and trace continuity from the authoritative turn checkpoint rather than a reconnect's headers.

## Planned checks for approvals that wait

[ADR 0034](../adr/0034-approvals-that-wait.md) is accepted; implementations follow in 0.3.0. The following are test plans, not scenarios that pass today. Use a scripted model and the `bump` counter. Observe its file as well as the committed records: an open question alone does not show that the tool never ran.

| Proposed shared scenario | What to observe |
|---|---|
| Opt-in and default | Keep `approval-without-handler` passing unchanged. Even on a capable agent, `approvalWait: "live"` refuses with no eligible route. The two ordinary late-question declarations alone cannot enable waiting approval. Reject an opt-in without support and an invalid maximum. In an opted-in session `off`, `never` and a trusted read-only call under `ask` still do not open an approval. |
| Allow after turn end | With `approval: "all"`, an eligible member but no handler or connection present, prompt for one `bump`. Expect the bound request and gate pending record, one completed origin with that call open, count zero and no `toolStarted`. Finish the prompt and `waitIdle`. Poll as present, check the exact call and deadline, then allow. Expect one linked continuation, one start with the original call/step IDs under the new turn, one result and count one. No new `inputAccepted` or `input`. Answering again cannot add work. |
| Decline and expiry | Decline gives `refused`. Use a short requested timeout and one above the maximum; verify the absolute deadline in both cases. Advance to the deadline before answering: expect one `timeLimit` closure, `notStarted`, no start and count zero. Hold continuation dispatch, allow just before the deadline and advance to it before release: keep the actor answer, but get the same unstarted result. |
| Recheck at handoff | Change the registered source, definition, or final input from a `tool.before` transform in separate runs. Gate the display for one recipient. Revoke the work actor's `tools`, then in another run the approver's `approve`, **after** allow and before handoff. Expect no effect and no substitute question; the stale call is `refused`. As a control, an approver with `watch` and `approve` but no `tools` may approve a worker's otherwise authorized call. |
| Reopen | Stop after the completed origin and separately after the committed answer. Reopen both `kept` and `durable` sessions. With an open question, recover the same request, call and deadline but require a fresh view. With an allow, recheck its recorded proof; do not need a second answer or presence. Kill after the counter effect but before its result: no second effect on reopen, `outcomeUnknown` if unconfirmed. |

The shared format would need setup for the maximum and declared capabilities, authenticated polling on a session handle, a controlled clock, and barriers at answer commit and dispatch. Add assertions for absent records, exact counts, IDs, associations, `openToolCalls` and deadlines; the existing ordered `records` assertion alone cannot prove these cases. Run applicable tool placements in all four SDKs. Use commit barriers, not sleeps or retries.

The binding kits own checks the single-session scenario runner cannot make: [ACP](../../conformance/acp/README.md#waiting-approval-checks) for polling, actor races and portable reopen; [AG-UI](../../conformance/agui/README.md#waiting-approval-checks) for presence routes, snapshots and mixed waits; [telemetry](../../conformance/telemetry/README.md#planned-checks-for-adr-0034) for spans. No real Provider or credentials are needed.

## The testing kit

Every SDK ships these in a `testing` module:

| Item | What it does |
|---|---|
| `scriptedProvider(script)` | A Provider with id `scripted` and one model, `scripted/script`, that answers from a [script](#the-model-script). |
| `memoryEnvironment(files?)` | A working environment that keeps files in memory. `exec` runs commands registered with `onExec(name, handler)` and raises `not_supported` for others. It declares `containment: "none"`. |
| `testAgent(options)` | `createAgent` with the scripted Provider and its model, a memory environment and `ephemeral` durability, unless the options say otherwise. |
| `answers(list)` | A question handler that answers in order from a list. Each item is `"allow"`, `"decline"` or `{ "value": answer }`. A question beyond the list is declined, because a handler's error is a decline, and is also recorded: the helper's check (`assertDone` or the language's equivalent) fails the test if any question went unexpected or any answer went unused. |
| `overWire(plugin)` | The same plugin, served over the plugin binding through an in-memory pipe in the same process. A test can run any servable plugin both ways and compare. |
| `restart(agent)` | Interrupts the agent's work without writing a graceful outcome or calling plugins' stop, releases its writer leases, and builds a new agent over the same store and in-process plugins. Reopen the sessions on the new agent. It simulates an interruption in one process; it does not show that a real process or its descendants would stop. The shared crash scenarios kill a real process for that. |

A developer tests a tool by building a `testAgent` with the tool and a script that calls it, sending a prompt and checking the PromptResult and the recorded ToolResult. The [guides](guides/README.md) show it.

### The model script

A script is a list of responses. Each response is an object:

| Field | Meaning |
|---|---|
| `text` | the answer's text |
| `reasoning` | readable reasoning |
| `toolCalls` | `[{ name, input }]`, requested in order |
| `error` | `{ kind, message }`: the attempt fails with this ModelError |
| `usage` | Usage to report; zero if absent |

For each request, the scripted Provider counts the assistant messages in `request.messages`, the final request actually sent, so attempts left out of the context and responses removed by compaction do not count, and answers with the response at that index. The script is therefore stateless: a request repeated after a crash gets the same answer as the first time, and a turn that carries on after a restart picks up where it left off. A request past the end of the script fails with kind `other` and the message `script exhausted`.

The same format is used by the shared scenarios, so a developer's script and a scenario's are interchangeable.

## The shared scenarios

The scenarios are JSON files in [`conformance/sdk/scenarios/`](../../conformance/sdk/scenarios/). Each describes an agent, a model script and steps, and what must be true after each step. Every SDK has a runner for them.

### Running them

The runner runs each scenario in every applicable placement of the fixture plugins:

- `inProcess`: the fixtures in the agent's process;
- `process:<sdk>`: the fixtures served by an SDK's fixture program, for each of the four.
- `service:<sdk>`: the fixtures served by the same program as services on a WebSocket ([Services](placement.md#services)), for each of the four.

So a Rust agent runs every scenario with fixtures in process, then served from Rust, TypeScript, Go and Python, first as programs, then as services. Every result MUST be the same. A scenario that uses an in-process-only feature lists `"placements": ["inProcess"]`.

For each run of a scenario in each placement, the runner creates a fresh, empty directory outside the agent's reach and supplies two things from it:

- the agent's `dataDir`, which survives a crash and is reused on reopen;
- the `counter` fixture's config `path`, an absolute path to its count file. A missing file counts as zero.

### Finding the fixture programs

Each SDK lists its fixture program in `conformance/sdk/fixtures/<sdk>.json`:

```json
{
  "sdk": "rust",
  "build": "cd rust && mise exec -- cargo build -p sdk-scenarios --bin modular-agent-fixtures",
  "command": ["{repo}/rust/target/debug/modular-agent-fixtures"]
}
```

`command` is the argument vector that starts the program; the runner appends the fixture's name and passes the counter's `path` in the plugin's config. `{repo}` stands for the repository's absolute root. A program whose `{repo}` paths do not exist has not been built: the runner skips that placement and says how to build it, unless `MODULAR_AGENT_SDK_REQUIRE` names that SDK or is `all`, in which case it fails. The program starts with the plugin binding's minimal environment, so `command` uses an absolute path wherever `PATH` alone would not find the program or its dependencies. Each runner uses its own SDK's freshly built program for its own placement.

For `service:<sdk>`, the runner writes a random token to a file readable only by its user, in the run's directory, and starts the program with four more arguments after the fixture's name: `--listen 127.0.0.1:0 --token-file FILE`. The program serves the fixture with `serve(plugin, { listen, tokenFile })` and, once it accepts connections, writes one line to stdout, the server's `url`. It serves until it is killed. The runner names the service in `servicePlugins`, `{ url, tokenFile, config }`, with the same config it would pass a process plugin. It starts one service per fixture for each start of the agent, each in its own process group, and stops them when the run ends.

Steps that crash the agent run it as a separate process, in its own process group. A crash sends `SIGKILL` to the whole group, so served fixture plugins die with the agent, and the runner reaps its direct child and waits until no member of the group can still run before it reopens. A zombie awaiting reaping counts as exited. Recovery then has nothing left running that could race it ([Working environment](../contracts.md#the-working-environment)). In `service:<sdk>`, a crash also sends `SIGKILL` to each service's group; the runner waits the same way, then starts fresh services before it reopens.

### The fixture plugins

Every SDK implements these identically and serves them from a fixture program, `fixtures`, that takes exactly one fixture name as its first argument and serves that plugin. They are servable.

| Plugin | Registers | Behavior |
|---|---|---|
| `tide` | tool `tide`, input `{ harbour: string }`, read-only | Returns `High tide at <harbour> is 14:02.` |
| `counter` | tool `bump`, input `{ hold?: boolean, note?: string }`, not safe to repeat | Adds one to a count kept in the file named by its config `path`, then returns the new count as text. With `hold: true` it then waits until cancelled, so a crash lands after its effect. |
| `confirm` | tool `confirm`, input `{ question: string }` | Asks a `choice` question with options `yes` and `no` and returns the answer. |
| `gate` | hook `tool.before` | Refuses any call whose input, as JSON text, contains `forbidden`, with the reason `the gate refused it`. |
| `quay` | tool `moor`, input `{ harbour: string }` | Refuses with the reason `the quay is closed`, through the tool context's `refuse`. |
| `note` | tool `note`, input `{ question: string }` | Asks a `text` question. Returns `value: ` followed by the answer, or `declined` if the question was declined. |
| `pilot` | tool `pilot`, input `{ harbour: string }`; needs `tide` loaded too | Calls `tide` with the same harbour as a [nested call](../contracts.md#nested-calls), then returns `Pilot: ` followed by the nested result's text. |

### The format

```json
{
  "scenario": "tool-call",
  "about": "A model calls a tool and answers with its result.",
  "rules": ["contracts.md#tool-dispatch"],
  "agent": { "durability": "ephemeral", "plugins": ["tide"] },
  "model": [
    { "toolCalls": [{ "name": "tide", "input": { "harbour": "Whitby" } }] },
    { "text": "High tide is at 14:02." }
  ],
  "steps": [
    { "prompt": "When is high tide at Whitby?",
      "expect": { "outcome": "completed", "text": "High tide is at 14:02.",
                  "toolResults": [{ "name": "tide", "status": "completed", "text": "High tide at Whitby is 14:02." }] } }
  ]
}
```

| Field | Meaning |
|---|---|
| `scenario` | a unique name, the file's name without `.json` |
| `about` | one sentence for people |
| `rules` | the rules it checks, as links relative to `docs/` |
| `agent` | `durability`, `plugins` (fixture names, in load order), `approval`, `answers` (for the [`answers` handler](#the-testing-kit), or absent for no handler), `settings`, `severalActors`, and `actors`: actors to join to the session after it is created, each `{ id, kind, rights }`. Optional `history` selects an explicit fixture store: `file` or `service`, as described below. |
| `model` | the [model script](#the-model-script) |
| `placements` | optional; the placements it applies to, all by default |
| `steps` | in order |
| `expectCreateError` | optional `{ code, messageContains }`. With this expectation, `steps` is empty and the runner checks `createAgent` instead of opening a session. |

For `agent.history: "file"`, the runner passes `fileHistory(dir)` explicitly. For `agent.history: "service"`, it starts a [history service](placement.md#services) over a file store and passes `httpHistory(url, tokenFile)` explicitly. Use a fresh store directory separate from `dataDir` in either case. The service fixture is independent of the placement of plugin fixtures. Set up the fixture before calling `createAgent`; a fixture setup error does not satisfy `expectCreateError`. The runner MUST check the error code and the required substring in the message. Success fails the expectation.

A step is one of:

| Step | Does |
|---|---|
| `{ "prompt": text }` | `session.prompt(text)` and waits for the outcome |
| `{ "prompt": text, "crashWhen": { "record": kind } }` | sends the prompt and kills the agent's process once a record of that kind is committed |
| `{ "prompt": text, "crashWhen": { "count": n } }` | sends the prompt and kills the agent's process once the `counter` fixture's count reaches `n`, so the crash lands after the effect |
| `{ "prompt": text, "as": actorId }` | `session.as(actorId).prompt(text)` |
| `{ "send": text, "timing": timing }` | `session.send(text, timing)`, without waiting for a turn; `timing` is `now` if absent |
| `{ "answer": answer }` | waits up to 10 seconds until exactly one question is open in `session.questions()`, then answers it with `session.answer`; `answer` takes the forms the `answers` list does |
| `{ "wait": true }` | `session.waitIdle()`; expectations then apply to the session's last turn |
| `{ "reopen": true }` | starts the agent again over the same data and reopens the session; waits until it is idle |

and can have `expect`:

| Expectation | Holds when |
|---|---|
| `outcome` | the last turn's outcome kind matches |
| `text` | the last turn's result text is exactly this |
| `toolResults` | the last turn's tool results, in order, have these `name` and `status`, `text` if given (exact), and `contains` if given (a substring, for diagnostics an SDK may word in its own way) |
| `records` | these record kinds appear in the session's history in this order, not necessarily adjacent |
| `count` | the `counter` fixture's count is this number |
| `error` | the step itself raised this error code |

The runner MUST report each failed expectation with the scenario, placement, step and both values. It MUST NOT retry a failed scenario.

## Shared telemetry check

The planned [`conformance/telemetry/` check](../../conformance/telemetry/README.md) reuses the [shared scenarios](#the-shared-scenarios) without replacing their outcome or history assertions. It needs no live Provider or collector.

The harness runs a receiver on a fresh loopback port outside the agent and plugin process groups. It accepts [OTLP/HTTP](https://opentelemetry.io/docs/specs/otlp/#otlphttp) at `/v1/traces` in both encodings, protobuf and JSON, and returns a successful OTLP response. Each SDK's scenario runner and each participating fixture program install their language's OpenTelemetry SDK with an always-on sampler and the language's official OTLP/HTTP span exporter, using `http/protobuf`, pointed at that receiver. Every language's official exporter supports protobuf, and it is the encoding `ma` and common backends such as Arize Phoenix use; Go's exporter has no JSON encoding. Pass the endpoint explicitly to children. Do not use production credentials or endpoints. Force a flush on normal exit and wait for the acknowledged exports before comparing spans. Do not require a flush from a killed process.

Run these cases for each host SDK:

| Scenario | Placements and assertions |
|---|---|
| `first-turn` | `inProcess`. Check one invocation, one step, one scripted inference attempt and the history commits that the host observes. Check `telemetry: 1` in both agent and session declarations, with and without an OpenTelemetry SDK. Without it the turn still completes and no spans reach the receiver. |
| `tool-call` | `inProcess` and `process:<sdk>` for every other SDK. With both handshake members present, the plugin client span is under the tool execution; the fixture's server span has the same trace ID and the client span ID as parent. Check the injected context in the request. Repeat with the fixture omitting acceptance, then with the host omitting the offer. Observe both directions of the wire: no work request or notification has `params.traceContext` in either case, and no response has it in any case. Work still settles. |
| `nested-call` | `inProcess` and the same cross-language process pairs. In process, the child tool span is a direct child of the parent tool span. In the cross-language run, observe the scoped `host/tools/call` callback under the parent tool's trace and check the nested call's parent call ID. Repeat the two handshake omissions here to exercise a callback as well. |
| `gate-refusal`, `question-answered` | `inProcess`. A pre-dispatch refusal produces a disposition event and no execution span. An answered question has open and close events with the matching ID, kind and disposition, without the question or answer body. |
| `durable-crash`, `kept-crash` | `inProcess`. Use the scenario's counter barrier and kill the agent group with `SIGKILL` (`kill -9`). Save the committed initial context and turn ID outside that group before killing it. After restart over the same data, the durable run has an invocation with the same trace and turn IDs, a fresh span ID, `modular_agent.turn.resumed=true`, and both a parent and a link to the saved segment. Do not require the old invocation span to have been exported. Observe the new checkpoint before resumed effects. In the kept run there is no resumed invocation; neither run repeats the counter effect. |

For each case, compare against the [profile's span and event mapping](../telemetry.md#spans-and-events). Match operations by the fixture's session, turn, step and call IDs, not export order. Check names, kinds, parentage, required attributes and their values, and one observation per actual operation. Inspect every exported name, resource attribute, span attribute, status, event and link for forbidden fields or fixture content. Use distinct sentinels in prompts, model output, tool payloads, question and answer bodies, diagnostics and test secrets. None may appear, even as substrings. Check the raw wire for absent fields rather than inferring their absence from missing spans. No baggage crosses the wire. Check that version 1 writes no disclosure markers.

## Live checks

Everything above runs offline. Each SDK also has a small set of live checks against real model services, skipped unless `MODULAR_AGENT_LIVE=1`. Each check is skipped, not failed, when its key is absent.

| Variable | Used for |
|---|---|
| `OPENAI_API_KEY`, and `MODULAR_AGENT_LIVE_OPENAI_MODEL` (default `gpt-6-luna`) | the `openai` Provider |
| `ANTHROPIC_API_KEY`, and `MODULAR_AGENT_LIVE_ANTHROPIC_MODEL` (default `claude-haiku-5-5`) | the `anthropic` Provider |
| `MODULAR_AGENT_LIVE_LOGINS`, a [login file](subscription-providers.md#logins), and `MODULAR_AGENT_LIVE_CHATGPT_MODEL` (default `gpt-6.1-sol`) and `MODULAR_AGENT_LIVE_GROK_MODEL` (default `grok-4.7`) | the `chatgpt` and `grok` Providers, each skipped without its login |
| `MODULAR_AGENT_LIVE_CLAUDE_MODEL` (default `claude-haiku-5-5`) | the `claude` Provider, skipped without a Claude Code plan sign-in |

For each subscription Provider with a sign-in, the checks send one short prompt and expect non-empty text, and never sign in. For each API-key Provider with a key, the checks run: one prompt that must come back `completed` with non-empty text; streamed `text` events that join to that text; one turn in which the model calls a `tide` tool and answers with its result; and a reasoning setting the model lists. They spend a few cents at most. Run them by hand before a release, never in a loop.

## Adding a scenario

A scenario belongs in the shared set when it checks behavior every SDK must share: a rule in the specification, a default in [Concepts](concepts.md#defaults), or a promise in [Placement](placement.md). Add the scenario first; each SDK then makes it pass. A scenario that needs a new step or expectation adds it here first.

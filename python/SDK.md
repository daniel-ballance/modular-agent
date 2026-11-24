# modular-agent: the Python SDK

Applications import `modular_agent`; they do not need to import the Harness or its plugins. This SDK targets [SDK 0.1](../docs/sdk/README.md) and edition 4. The `modular-agent` console script and `python -m modular_agent` still run the base CLI; `ma` runs the standard configuration.

```python
from modular_agent import run
from modular_agent.testing import test_agent


async def main() -> None:
    async with test_agent(script=[{"text": "Hello."}]) as agent:
        session = await agent.session()
        print((await session.prompt("Say hello.")).text)


run(main())
```

## Run the checks

Set `TMPDIR=$HOME/.cache/ma-std-tmp` and create that directory first. From the repository root:

```sh
(cd conformance/acp && npm ci)
(cd conformance/tools && npm ci)
(cd conformance/telemetry && npm ci)
(cd python && uv sync --python 3.13)
(cd python && uv run --offline pytest -q --runtime transient)
(cd python && uv run --offline pytest -q --runtime durable)
(cd python && uv run --offline pytest -q --runtime transient --binding process)
(cd python && uv run --offline pytest -q --runtime durable --binding process)
(cd python && uv run --offline ruff check . && uv run --offline ruff format --check . && uv run --offline mypy)
node conformance/reference/run.mjs --agent python
MODULAR_AGENT_CONFORMANCE=1 node conformance/acp/run.mjs --crash-checks --probe-checks --job-checks -- "$PWD/python/.venv/bin/ma" --acp
node conformance/plugin/run.mjs -- "$PWD/python/.venv/bin/modular-agent-plugin"
scripts/websocket-kits.sh python
```

Build each fixture using its command in [`conformance/sdk/fixtures/`](../conformance/sdk/fixtures/). Then run `(cd python && MODULAR_AGENT_SDK_REQUIRE=all uv run --offline python -m modular_agent._scenarios)`. Omit `MODULAR_AGENT_SDK_REQUIRE` to skip unbuilt programs. Pass individual scenario paths to run a subset.

To run the [ACP kit over WebSocket](../conformance/acp/README.md#over-websocket), create an owner-only token file with a cryptographically random token (e.g. `(umask 077; openssl rand -hex 32 > "$TOKEN_FILE")`) and use a free loopback port:

```sh
MODULAR_AGENT_CONFORMANCE=1 node conformance/acp/run.mjs \
  --connect ws://127.0.0.1:39211/ --token-file "$TOKEN_FILE" \
  --service-command "$PWD/python/.venv/bin/ma --acp --listen \"\$MODULAR_AGENT_CONFORMANCE_URL\" --token-file \"\$MODULAR_AGENT_CONFORMANCE_TOKEN_FILE\"" \
  --crash-checks --probe-checks --job-checks
```

For the [plugin kit](../conformance/plugin/README.md#over-websocket), run three copies of `python/.venv/bin/modular-agent-plugin --listen 127.0.0.1:0 --token-file "$TOKEN_FILE"`: one with the default parts, one with `MODULAR_AGENT_PLUGIN_PARTS=runtime`, and one with `MODULAR_AGENT_PLUGIN_PARTS=durable-runtime`. Pass their printed URLs as `--connect`, `--runtime-url` and `--durable-runtime-url` respectively, with the same `--token-file`. Neither kit needs a bridge.

The five [live checks](../docs/sdk/testing.md#live-checks) in `tests/test_sdk_live.py` skip by default. With `MODULAR_AGENT_LIVE=1`, the API-key checks also require their Provider's key. The subscription checks require `MODULAR_AGENT_LIVE_LOGINS` and skip without the relevant login. They make one short request each and never sign in. Use `MODULAR_AGENT_LIVE_CHATGPT_MODEL`, `MODULAR_AGENT_LIVE_GROK_MODEL` or `MODULAR_AGENT_LIVE_CLAUDE_MODEL` to choose a different model. The offline suite does not use real credentials.

## What is checked

- **Shared scenarios:** 405/405 with `MODULAR_AGENT_SDK_REQUIRE=all`: 45 in process, and the same 45 with each of the four SDKs' fixture programs on stdio and over WebSocket.
- **Pytest:** 823 passed and five live checks skipped in each of four configurations: transient and durable Runtimes, with local and process bindings.
- **Covered approvals:** 11 public SDK cases check the request view, each nested start, refusal by policy or another gate, exact input, restart and continuation with or without a marked parent view.
- **Waiting approvals:** 61 public SDK cases cover the composition, rights, polling handles, deadlines, erasure, fork/move refusal and recovery. SIGKILL tests stop the writer after the origin ends, after the answer commits and after the counter increments. They use both Runtime tiers in process and served. The ADR 0034 runner adds `poll`, `decide`, `clock`, `barrier`, `change` and `stop`. With the shared fixtures, the 28 new scenarios passed in all nine placements (252/252; 405/405 including the 17 existing scenarios). The in-process telemetry check passed 16/16, including the four waits with export on and off. The eight waiting AG-UI cases passed against the real fixture listener.
- **Interface tools:** 35 public SDK cases cover in-process and served Runtimes. They check approvals, exact gated handoff, reconnect, competing reports, expiry, cancellation, erasure, trace links and SIGKILL recovery before and after the origin ends. No shared scenario was added: its format has no authenticated Interface connection or result-report operation.
- **Reference `ma`:** 28/28 on Linux. `approval-covers-script` checks that a refused script writes neither file and an allowed script writes both. It also checks a new writer can finish the script after a waiting decision.
- **Telemetry:** eight offline SDK cases check span parentage and IDs, inference metrics, private sentinels, a job-linked report, both handshake omissions, exporter failure, and operation without the OpenTelemetry SDK. The crash fixture kills two durable segments and checks that the third span has the last saved parent and link. Fork copies have no trace checkpoint or turn trace field.
- **Subscriptions:** Offline checks cover the shared catalog and login file, both ChatGPT sign-in flows, and Grok's device flow, including slow-down, denial, expiry and refusal of non-HTTPS verification addresses. Both Responses Providers are checked in process and over the plugin binding for request shape, encrypted reasoning replay and refused refresh. The Grok checks force two refreshers to contend for the login lock. Claude fixtures exercise account readiness, thinking settings, streaming and host tool dispatch.
- **ACP kit against `ma`:** 190/190 on Linux stdio with crash, probe and job checks. With `--approval off` (feature loaded), 193/193 including the live coverage check and waiting-declaration checks. With a 60-second maximum, 118/118 public, crash and job checks, including the covered continuation. Adding the Runtime probes to the maximum-bound run gave 165/169: those four probes register Runtimes without the required continuation support, so composition refuses them. The separate `--waiting-approval-only` group passed its two declaration checks but not its 42 managed-fixture checks. Plain `ma` does not supply that kit's private clock, control listener or offline test principals. The WebSocket run passed 195/195. Separate-listener plugin isolation passed 14/14. The named-caller fixture passed 29/29. The base build takes the opt-in policy with `modular-agent --acp` in conformance mode, without changing the legacy `--mode acp` composition.
- **Plugin kit:** 146/146 on stdio and 153/153 over WebSocket, with both Runtime tiers.
- **Discovery and recovery:** 48/48 AG-UI cases, including replay and live wait closures, masked receipts, the covered interrupt and nested dispatch after restart. The public Python tests cover page cursors, per-connection counts, revocation during delivery, a held writer, and durable and transient recovery after SIGKILL.
- **Demos:** ops desk passed all six scripted cases. Project notes passed both the scripted case and crash and reopen; each produced one file, one completed turn and two tool results.
- **History kit:** 42/42 with restart and 42/42 with `--isolation-checks`, using two `serve_history(file_history(...))` services with different stores and tokens.
- **Session publication:** six SDK cases cover file, HTTP and Registrar history with in-process and served Runtimes. Unused sessions leave no records on close or process loss. The first admission flushes setup in order, and forks publish the copied prefix and fresh setup together. A separate ACP case checks that `session/new` and close do not create an HTTP history record.
- **Session interruption:** seven public API cases cover failed appends and revoked leases. Embedded `prompt`, embedded `prompt_stream` and WebSocket ACP each settle with `lost`; a follower sees the live interruption and reopening recovers from the kept journal. A custom store's revocation notice interrupts an idle session before any renewal or write.
- **Plugin connection callbacks:** on stdio and WebSocket, two image-bearing job progress updates reach the originating plugin’s output gate and the SDK event follower in order, before job end. The old Python host let job end overtake progress and could stall when a notification handler delegated a same-peer RPC to a child task. The peer now drains notifications in order without holding unrelated replies or callbacks. Tests also cover same-peer tool and environment streams, Provider pieces, Runtime callbacks and reports, catalog refresh, custom events and diagnostics.
- **SDK API regressions:** four follower cases preserve image progress through local and served tools and Runtimes. Three proposal cases check conflicts after release, decline and withdrawal. A history port case checks metadata and both page cursors; two Provider cases check the declaration in both placements.
- **Command lifetime:** the WebSocket plugin kit checks disconnect cleanup. A regression also kills the agent's entire process group while a background descendant is still running; the separate lifetime watcher must survive the group kill and stop it on pipe EOF. On macOS the managed group is the cleanup scope. Crash recovery does not treat that scope as proof that a started call is safe to repeat.
- **HTTP history leases:** Linux uses `CLOCK_BOOTTIME`. macOS uses `clock_gettime(CLOCK_MONOTONIC)`, which advances during sleep according to Apple's `clock_gettime(3)`. Platforms without a sleep-aware clock require `MODULAR_AGENT_HISTORY_LEASE_MARGIN_MS`.
- **Secret crash recovery:** three actual SIGKILL cutoffs: after staging, after committing the selection, and after activation. A separate test checks idempotence and generations.
- **ADR 0030 SDK tests:** seven cases cover held-fork erasure handoff, concurrent refusal at each input scope, duplicate and hand-back at saturation, reservation rebuild, and capacity outcomes for a refused model attempt and a refused call list. Policy and SDK smoke checks passed 61 cases. Two more public cases cover malformed stdio options and configured network representation. Ruff lint and format and strict mypy passed. The targeted regressions also cover port-zero listeners over file and custom stores, a stale HTTP store restore, and oversized tool results.

## Built so far

| Area | State |
|---|---|
| Composition | Awaitable or async context manager; local, memory and file/HTTP-backed parts, three durability modes, explicit `transient_runtime()` and `durable_runtime()`, Provider and tool options, local, stdio and WebSocket plugins. `local_environment(root)` uses `root` as the project when none is given; if both are given they must match. |
| Telemetry | The Harness declares `telemetry: 1` even if export is off. It records metadata through `opentelemetry-api` only. Register the app's tracer and meter providers before `create_agent`; the app chooses sampling and owns exporter shutdown. Use the fixed `agent_name` option for `gen_ai.agent.name`. Plugin propagation requires agreement. Durable turns checkpoint span context and resume in the same trace. |
| Session and turn | Create, reopen, prompt and steer with shared Content, stream, gated last turn and history, send, cancel, settings, move, fork, erase and close. Direct calls use the Runtime's gates. Structured turn results are checked with feedback and retry. `events(from_entry)` replays kept entries, then follows typed live events, with `lost` and the last delivered entry cursor on lag. `SessionInterruptedEvent` is live only; a failed commit or lost writer fences dispatch and fails waiting prompts with `lost`. |
| Authority | `several_actors`, `session_limits` and `tenants` opt in. Embedded actor and proposal operations use current effective rights. Stdio ACP accepts operator `actor`, `rights`, `projects`, `tenants` and `represents`; network scope and representation are set per token. A checked scope cannot enlarge the composition's reach. `ma` reads one policy file in all modes. |
| Reservations | `create_agent(resource_reservations={scope: {name: count}})` sets bounds. Scopes are `session`, `tenant` and `agent`. Fields are `inputs`, `calls`, `jobs`, `bufferedBytes`, `storageBytes` and `controlBytes`. Omitted fields have finite defaults. `agent.reservation_limits()` returns configuration only. Count ceilings are in the declaration. Project compositions share the listener's reservations. |
| Pending erasure | Native SQLite history publishes a content-free registry in the same database as its records. A held copy stays pending and a writer reconciles it under its lock. HTTP history discovers `pendingErasure: 1` in `GET /v1`. Without that version it declares `erasure: false`. Use separate service instances, credentials and backing directories for raw history scopes. |
| Questions | `on_question` can override the agent-wide handler. `questions()` lists only open questions and reports per-recipient `answerable`; `answer` submits by ID. Without a handler an untimed non-approval can wait for an eligible offline actor, while a live approval still needs a present eligible answerer. A text `declined` and a tagged decline are distinct. `late_answers_start_turns=True` enables a timed non-approval to leave a call open. |
| Covered approvals | `create_agent(approval="ask", approval_covers_nested=True)`. See [Covered approvals](#covered-approvals). |
| Waiting approvals | `create_agent(max_approval_wait=..., late_answers_start_turns=True, approval=...)` on kept or durable history. `approvalsOutlastTurns` declares support; sessions remain live-only by default. See [Approvals that wait](#approvals-that-wait). |
| Secrets | `environment_credentials()` is read-only. `file_credentials(path)` provides durable `stage`, `lookup_staged`, `activate` and `discard`. `ma` passes a `SubscriptionLogins` so secret answers and sign-ins share the same `auth.json` and lock. Recovery discards unselected staging and completes a committed selection before resuming work. |
| Tools | Input from type hints, one Pydantic model, or `Tool.from_schema`; exact hints, structured results, cancellation, refusal, questions, progress, log, history pages, environment and nested calls. Typed `toolOutput` events expose the text `chunk` and optional original `content`, including images. Nesting is four levels including the outer call. The public wire Runtime placement does not declare nesting. |
| Interface tools | `create_agent(interface_tools=[{"source_id": ..., "actor_id": ..., "route_id": ..., "result_timeout_ms": ..., "tools": [...]}])` registers model-only definitions. An authenticated Interface can advertise availability, receive one checked handoff, and report a result for a later turn. Both shipped Runtimes support the feature, including on the plugin binding. The AG-UI listener uses deferred release for these calls. |
| Plugins and parts | Register tools, changing tool sources, Providers, commands, hooks, working environments, Runtimes and job owners, in process or served. Custom configuration, credential stores, Interfaces and plugin-defined hooks run in process. `Registrar.on` provides typed payloads and answers for core points; `HookContext` supports raw history, cancellation and custom events. Actor joins/leaves and Provider pieces are local hooks. A flagged local `tool.before` gate can leave a call pending even when the Runtime is served. |
| Jobs | Registered owners start keyed work through `context.jobs.start()`. Job handles report progress and settlement. Owner cancellation and reopen/resume are checked in both placements. A missing committed end on cancellation records `jobCleanupUnconfirmed`; the execution cannot report or resume. |
| Providers and commands | Providers may declare kept state; `runsToolsAtProvider` and `liveSessions` are always false. Embedded catalog invalidation with `ProviderCatalog.changed()`; polling over the binding without a private notification. In-process commands can ask questions or request models under their own recorded step without starting a turn. A served command uses `host/session` for its project, even when the session was saved in a different project. Tools and Providers can read named credentials in process. API-key Providers use the shared, byte-checked model table; explicitly enrolled unlisted ids send no reasoning controls. |
| Subscription Providers | `modular_agent.chatgpt.chatgpt(logins=..., models=..., client_identity=...)` and `modular_agent.grok.grok(logins=..., models=..., client_identity=...)` use the same login file. `modular_agent.claude.claude(models=...)` uses the Python Claude Agent SDK and accepts only a Claude Code plan sign-in. |
| Testing and guides | Scripted Provider, memory environment, `test_agent`, `answers(...).assert_done()`, `over_wire` and `restart`. Seven shared fixture plugins, a fixture program and a runner. Offline tests cover guides 01–09. `restart` interrupts tracked work without graceful plugin stops; it does not simulate detached work or child-process cleanup. |
| WebSocket transport | `await serve(plugin, listen=ADDR, token_file=path, tls=...)` starts a plugin service. `create_agent(service_plugins=[{"url": url, "token_file": path, "config": {...}}])` loads it after process plugins and before entries from `MODULAR_AGENT_PLUGINS`. That variable uses wire casing (`tokenFile`). `await agent.serve_acp(listen=ADDR, actors=[...], tls=...)` serves independent, authenticated ACP connections. `ma --acp --listen ADDR --token-file FILE` is the loopback service for the local user. |
| History | `history_store(port)` registers a custom `HistoryPort`; pass the same persistent port to `serve_history` to serve it over HTTP. Stores with an independent revocation signal can implement `async wait_writer_lost(session_id, lease)`, returning when that lease is lost; the agent cancels the wait when closing the lease. `http_history(url, token_file)` selects the client. `serve_history(file_history(directory), address=(host, port), token_file=path, lease_ttl=15.0)` serves an opaque-record SQLite database; it does not import existing native history. `lease_ttl` is the writer lease in seconds, declared as `ttlMs`. It defaults to 15 seconds and must be a whole number of milliseconds, at least one. A fixed port blocks. Port `0` returns a listener with its bound `url` and synchronous `close()`. A custom store supplies its own `ttl_ms`; keep it open until the listener closes. Its callbacks run on the service thread. `sqlite_history_port(directory)` is a context manager over that same service store, for implementing or wrapping opaque records and leases. Memory and client-backed stores are ineligible. Plain HTTP is numeric loopback only. |

A custom `RuntimePort` declares its id and support, implements `run_turn`, `resume_turn` and `continue_open_calls`, and registers with `r.runtime(port)` in a plugin that lists `replaces=["runtime"]`. `RuntimeContext` exposes the binding's checked callbacks, including the model request and output pieces, record and steering, and raw history. A custom `HistoryPort` receives opaque shared dictionaries. It owns atomic batch equality, durable acknowledgement, expiry, paged reads and tombstone projection. Raise `HistoryError("held", message, {"retryAfterMs": n})` for a held lease, or the appropriate binding refusal for other unchanged requests. A port is caller-owned; keep it open while the agent or service uses it.

The six standard file tools come from `modular_agent.files.file_tools(output_directory)`. `modular_agent.mcp.mcp(servers)` connects stdio or Streamable HTTP tool servers. Register these in `plugins`. Local paths are not confined. At command dispatch, the default local environment requires delegated cgroup v2; `local_process_groups=True` opts in to a weaker fallback.

`agent.sessions(project=...)` and `agent.session_info(id)` inspect saved sessions without acquiring writer leases. `agent.serve_acp(compose=..., compose_reopen=..., project_settings=..., project_mcp=...)` can select compositions by canonical project and saved session ID. Compositions that reopen sessions share the serving Agent's persistent history, and the MCP resolver must check project trust before returning configured programs.

Use `await agent.session_summary(id, actor="user", route_id=...)` to inspect committed work. It returns `None` for a missing, provisional, ephemeral or inaccessible session. Otherwise it returns `id`, `project`, `updatedAt` and `waiting`. The caller supplies authenticated identity and any narrower rights; an Interface can also supply its in-turn question IDs and exact approval views. Reading a summary does not start recovery, take the writer lease or register presence. The AG-UI and ACP listings use this public operation.

For an opt-in service restart, pass `resume_open={"report": callback}` to `serve_agui` or `serve_acp`. It checks the serving project before accepting clients. The callback receives the session ID and either `"resumed"` or `"skipped"`. Supply the local operator's `actor`, `projects` and `tenants` to narrow the scan. A held writer is skipped, not waited out. With ACP project composition, the next client can attach to the writer that resumed the session.

Both WebSocket servers return a listener with `url` (the bound address including the port chosen for `:0`) and async `close()`. Plain `ws:` is loopback-only. To serve `wss:`, pass `tls={"cert_file": ..., "key_file": ...}`. The SDK client verifies the certificate and hostname against the default TLS trust store (which supports `SSL_CERT_FILE` for a private CA). Tokens stay in owner-only files. Choose tokens with at least 128 random bits. Set `service_ping_interval` and `service_control_timeout` on the host to tune the default 30-second silent-work interval and 5-second control deadline, respectively.

A plugin value gets a new registration and copy per connection. If the plugin carries state in function closures or holds noncopyable resources, pass a zero-argument factory to `serve` so each connection gets fresh state. ACP's `actors` entries are `{"token_file": path, "actor": {"id": ..., "kind": ..., "rights": [...]}, "tenants": [...], "projects": [...]}`. Tenant scope defaults to no tenant; include `None` to allow it alongside named tenants. An explicit project list contains canonical project roots; omitting it allows the projects the serving composition admits. Tokens for the same actor id must agree on kind, but can impose different rights ceilings on the same recorded grants. An authorized second connection can attach to an open session's existing writer without sharing the first connection's ACP handshake or leaving the session suspended on its disconnect.

### Named plugin callers

Use the factory context, not setup or tool input, to select storage. For a working environment, `projects={caller_id: [root, ...]}` restricts each caller to its canonical project roots. A caller ID grants no session rights. Use separate services if the plugin cannot isolate its resources.

#### Exact text for the Python section of docs/sdk/languages.md

- For named plugin callers, use `await serve(factory, listen=address, callers=[{"caller_id": "desk", "token_file": path}])`. The synchronous factory takes a `CallerContext` with `context["caller_id"]` and returns a fresh `Plugin`. `PluginCaller` is the operator entry type. With `token_file=path` instead, an existing zero-argument factory or plugin value still works.
- The listener returned by `await agent.serve_agui(...)` serves the host reads over HTTP. In the thread snapshot use `waitCursor` for `GET /agui/v1/threads/{threadId}/wait-closures?after=...`. When `runReceipts` is `1`, use `GET /agui/v1/threads/{threadId}/run-receipt?runId=...`. Encode each query value separately. Neither read delivers an answer handle or dispatches a tool.

## Serve AG-UI

```python
listener = await agent.serve_agui(
    listen="127.0.0.1:0",
    actors=[
        {
            "token_file": token_path,
            "client_id": "editor",
            "actor": {"id": "alice", "kind": "user", "rights": ["input", "watch", "tools"]},
        }
    ],
    acp=True,
)
# listener.url is an HTTP origin. The authenticated discovery path is /agui/v1.
await listener.close()
```

The listener uses the agent's project and the operator's optional `tenant`. Each actor entry can restrict `projects` and `tenants`. Token rotation may keep a client ID only for the same actor and scope. A different client ID cannot report a pending call. For HTTPS set `tls={"cert_file": ..., "key_file": ...}`. Add `client_ca_file` to require a trusted client certificate as well as the bearer. `origins` lists additional allowed browser origins. Trace parents are accepted only for entries with `trace_trusted=True`. The optional `trace_state_keys` lists the trusted HTTP vendor keys. No baggage is accepted.

List kept threads with `GET /agui/v1/threads?limit=100`. The response contains `threads`, newest change first. Each has `threadId`, an ISO 8601 `updatedAt`, and `waiting` with counts for this client (`questions`, `toolCalls`) and a turn state (`none`, `running`, or `interrupted`). No messages or handoff arguments appear. Pass `next` as `after` to read another page. An unknown or expired page cursor is HTTP 400 `invalid_request`; start the list again. A page cursor is not a history cursor. ACP puts the same summary in each listed session's `_meta["modular-agent"].waiting`; ACP is not an executor route.

Send the latest committed messages with the new suffix. `MA-History-Cursor` is optional. On conflict, replace the local conversation with the authenticated thread snapshot, including its new message IDs. The optional presence stream allows an in-turn question to be answered on the same live route. It does not carry calls. Execute only after the terminal event, never from the snapshot.

Follow wait closures from the snapshot's `waitCursor`, not its message cursor. Each SSE item contains a new cursor, a request or call ID and its committed reason. A settled call also gives its status. Save the cursor after processing the item. On HTTP 409 take a new snapshot. The feed does not mark presence.

A run receipt on kept history separates the released terminal class from the disposition of the linked work. For example, an interrupt exchange may have `{"terminal":"interrupt","work":"completed"}` after another client answers. A crash before the terminal marker commits leaves `terminal` as `unknown`. Neither field proves receipt by the client. The deployment stores the marker apart from portable history and removes it with its sources.

For shared state, set `state_plugin` to the emitting plugin's name and provide its async `state_snapshot(session_id)` reader. The reader returns `{revisionId, snapshot}` or `None` when no current snapshot can be supplied. The adapter requests it at run start and when a patch loses its base. Without a reader the plugin must publish a current snapshot before any delta. To allow explicitly foreign events, set `raw_sources={plugin_name: source}`. The plugin emits `modular-agent.agui.raw` with the foreign event as its payload.

The [managed kit](../conformance/agui/README.md) runs history, encoding and the official client's ordinary conversation against the actual `ma` executable. The scripted SDK fixture supplies the operator gate, controlled clock and process kill boundaries.

## Covered approvals

Pass `approval_covers_nested=True` to `create_agent` with an approval policy. The option belongs to the operator, not to a session or a tool. The default is false. The declaration includes `approvalCoversNested: true` only when both the option and the approval plugin are present.

Show `q.call` and `q.question` to the approver. When `q.covers_nested` is true, an explicit allow for the displayed top-level call also answers approval for the nested calls it makes in that dispatch, at any depth. Each child's `toolStarted.data.approvalCoveredBy` gives the top-level `toolCallId` and the `requestId` of its allow. A parent that passed without a question has no allow to pass on. A view without the marker covers nothing, even if the next writer enables the option. A new dispatch needs a new allow. Rights, other gates, input validation, nesting depth and the final dispatch check still apply to each call.

## Approvals that wait

Set `max_approval_wait` in seconds, for example `30.0`. It must be a whole number of milliseconds, at least one. It is an operator option, not a session setting. It requires an approval plugin, portable history and `late_answers_start_turns=True`. Both shipped Runtimes can continue even when every open call has already settled. A served Runtime must support that empty-call path. Exclude older writers from shared history before enabling the option.

Opt a session in with `await agent.session(settings={"approvalWait": "untilDeadline"})` or `await session.set_setting("approvalWait", "untilDeadline")`. An unstarted top-level server tool can now appear in `result.open_tool_calls`; this is not a tool result. The process may close and release the writer. Other calls keep live-only approval.

On return, keep the actor handle on which you poll:

```python
reviewer = session.as_actor("reviewer")
for q in await reviewer.questions(present=True):
    if q.approval_wait == "untilDeadline" and q.answerable:
        # Show q.question, q.tool_call_id, q.call, q.covers_nested and q.deadline.
        decision = await show_approval(q)
        await reviewer.answer(q.id, "allow" if decision else "decline")
```

`q.deadline` is a UTC ISO 8601 string, as for other timed Python questions. The recorded `deadlineAt` stays in integer milliseconds. An unchanged view delivered to one handle does not qualify another, even for the same actor. Acceptance means the decision committed, not that the tool ran. The continuation checks the bound input, registration, rights, policy and deadline again. For ACP poll `requests` and answer on the same connection. For AG-UI open presence, fetch the thread snapshot, then resume on that presence route. Python `ma` enables this feature only with a configured approval policy and an operator maximum.

## Interface-run tools

Register definitions in shared ToolDefinition form (`parameters`, `callers: ["model"]`), without handlers. Use a finite positive integer timeout in milliseconds. After authenticating the peer, trusted adapter code calls `agent.connect_interface_tools(actor_id=..., route_id=..., on_handoff=...)`. It can supply `rights` to cap the connection and `tenants` to allow named tenants; the default is the agent's project with no tenant. The actor still needs recorded `watch` and `tools` rights.

With `defer=True`, the callback runs only on a successful `await connection.release(session.id, call_id)`. Release checks the live handle, originating turn, scope, rights, gate, deadline, erasure and writer. Reopening a session does not create another delivery.

Call `connection.advertise(session.id, definitions)` with the exact subset this connection can execute. Use an empty list to withdraw it. The synchronous `on_handoff` callback receives `session_id`, `call_id`, `name`, `input` and the absolute `deadline`. It must not block. Calling `connection.close()` clears presence without settling an open call. A new authenticated connection on the same route can report without advertising or registering a callback.

After the originating turn ends, call `await connection.report_tool_result(session.id, report)`, with shared fields `callId`, `status` (`completed` or `failed`), `content` and optional `value`. It returns a dictionary with `status` set to `accepted`, `alreadySettled` or `refused`. A valid report before turn end returns `{"status": "refused", "reason": "notReady"}`. It can be retried; an expired call cannot. Results supply context to a continuation, not a new user message. Do not execute a call from a history entry or an event replay. ACP does not expose the executor connection or the report method.

## Subscription sign-in

Call `subscription_logins(path)` from `modular_agent` and pass the result to `chatgpt(logins=...)` or `grok(logins=...)`. Add the Provider to `create_agent(providers=[...])`, or register it with `r.provider(provider)` in a served plugin. Both constructors take `models` to enroll unlisted ids with no inferred reasoning controls. A `modular_agent.grok.GrokModelInfo` entry can supply an explicit `effort` mapping, as used for existing `ma` catalog overrides.

Use `await sign_in("chatgpt", logins, on_step=show, paste=read_line, device=False, client_identity="modular-agent")` and `await sign_out("chatgpt", logins)`. `show` receives a `SignInStep` with `kind` (`openAndPaste`, `deviceCode` or `waiting`), `url` and, as applicable, `code` or an explanatory `message`. `read_line` is an optional async callback returning a line or `None` at end of input. Use `await sign_in("grok", logins, on_step=show, client_identity="modular-agent")` and `await sign_out("grok", logins)` for Grok. Grok ignores `device` and `paste` and reports `deviceCode` followed by `waiting`. The SDK never opens a browser. The file is mode 0600, is atomically replaced under a sibling `.lock`, and retains the other top-level members.

Call `await claude_provider.available()` before displaying account-specific models. If it returns false, `claude_provider.unavailable_reason` explains why. Claude has no SDK sign-in. The Provider checks the account before sending a prompt, using Anthropic's [Python Agent SDK](https://github.com/anthropics/claude-agent-sdk-python). It maps `budgetTokens` in the shared table to `budget_tokens` in the Python options.

## Trace trust and spec findings

The launcher of a stdio ACP host is trusted for per-request trace context unless `serve_acp(trace_trusted=False)` disables it. Set `trace_trusted=True` in an embedded network ACP `actors` entry only for a peer allowed to share trace IDs. Network principals are not trace-trusted by default. Configured history and plugin destinations get context per request. The SDK does not accept or send baggage. AG-UI can accept allowlisted vendor state on a trusted work POST.

### ADR 0035 spec finding

In [Run receipts](../docs/bindings/agui.md#run-receipts), replace “If freshness cannot be established, refuse with 503 `unavailable`.” with: “If an erasure intent covers a source of the receipt, return 404 `not_found`, including while deletion is pending. If the current erasure state cannot be checked, refuse with 503 `unavailable`.”

### ADR 0033 spec findings

- The [SDK API](../docs/sdk/api.md#the-agent) now defines a session-bound executor handle. Python's existing handle is scoped to the configured project and actor; its `advertise`, `release` and `report_tool_result` take the session ID explicitly. For a language note:

  > | `connection.reportToolResult(sessionId, report)` | `accepted`, `alreadySettled` or `refused`. The connection is bound to an independently authenticated actor and operator-configured Interface route. The report uses the [shared shape](../docs/bindings/data.md#interface-handoff-records). This operation never dispatches a tool. |

- For [Serving AG-UI](../docs/sdk/placement.md#serving-ag-ui), replace “The app advertises the exact definitions it can run.” with:

  > The binding attaches an executor connection using the authenticated actor, the operator-configured route, and the connection scope. The connection replaces its per-session availability with an exact subset of the registered definitions. The Harness sends executable requests only through that connection, after committing the handoff. Closing the connection clears its availability without settling any call. Another independently authenticated connection on the same route can report a result without advertising availability.

- The [connection rules](../docs/contracts.md#authority) say: “The Harness MUST refuse unless operator policy admits that principal for this session's project and tenant, `joinOnOpen` is enabled and the session supports another member if needed.” The Python network policy has no `joinOnOpen` option. The listener refuses unrecorded actors; a trusted Interface must grant them membership first. The kit fixture uses that grant operation.
- The [binding](../docs/bindings/agui.md#shared-state) says: “The adapter starts each run with the plugin's current snapshot if the plugin is present.” For [placement](../docs/sdk/placement.md#serving-ag-ui), add: “To expose state, select its emitting plugin and supply its current snapshot reader. The reader takes a session ID and returns the plugin's revision and snapshot, or no snapshot. Do not use a client's input state as that snapshot.”

## Plugin traffic for one tool turn

Run `cd python && uv run --offline python scripts/plugin_traffic.py > traffic.jsonl`.
Each row gives bytes toward and away from the host and frame counts by plugin and method.
Replies count toward the request that caused them. The timer covers the ACP prompt handler,
two offline model steps and one successful file read. It excludes setup, process startup and
shutdown. Each already-published SQLite branch has the stated number of entries. After the
setup records, every tenth entry has model-visible text; the others have 128 bytes of hidden
note data. No CPU quota was set. Times are individual measurements, not thresholds.

The base ACP kit in `9fefe95e` used `--process-plugins all` for `--binding process`.
Its workers use a **private Python protocol**, not the public plugin binding. Here
**public** uses three Python stdio plugins: Runtime, Provider and tool source.
**Local** uses in-process parts and the same Provider directive. No ACP client transport
is counted. In the private placement a small worker request enters the ACP handler.

| Prior entries | Private bytes, before → after | Private ms | Public bytes, before → after | Public ms | Local ms |
|---:|---:|---:|---:|---:|---:|
| 10 | 1,648,345 → 479,658 | 85 → 67 | 76,812 → 54,574 | 40 → 35 | 45 → 38 |
| 100 | 3,592,193 → 512,943 | 116 → 73 | 90,234 → 65,206 | 55 → 43 | 64 → 46 |
| 1,000 | 23,041,023 → 847,098 | 432 → 155 | 225,246 → 172,318 | 222 → 122 | 257 → 122 |

The private frame count went from 982 to 974 at each size. Public stayed at 68. Local had no
plugin frames. These are not measurements of the original kit's mixed-content session.

**Private workers.** At 1,000 entries, Runtime `entries` calls accounted for 8.87 MB,
history `keep` for 7.70 MB, and Context branch reads for 1.73 MB. The environment, prompt
and approval plugins fetched entries just to read the project or settings. The Harness now
selects from the committed branch or kept history before copying, depending on the operation.
For example, an input waiter gets its own outcome; tool settlement still checks for a result
in a later turn. A store commit carries metadata and the batch, not the entire prior session.
The Context plugin reads visible entries, call dispositions and the current turn's feedback
barriers, not two copies of the raw branch. None of these private operations is a
`modular-agent-plugin/1` requirement. Recording an exact repeatable model request and
delivering gated history events still move real data.

**Public binding.** In the two-step, 1,000-entry turn:

| Method (both directions) | Bytes before → after | What [the binding](../docs/bindings/plugin.md) requires |
|---|---:|---|
| `runtime/runTurn` | 992 → 893 | One Turn with model, support and settings, not a transcript. |
| `host/runtime/prepareStep` | 42,499 → 31,407 | Allocated step ID and usage; full prepared ModelRequest in the reply. |
| `host/runtime/model` | 42,781 → 31,689 | Step ID and full authorized ModelRequest; assistant message in the reply. |
| `provider/request` | 41,897 → 31,857 | Provider and model identity and full ModelRequest. |
| `host/hook` for `provider.request` | 82,644 → 62,564 | The original payload out and the full transformed payload back, even without handlers. The host commits before granting permission to infer. |
| `host/hook` for `provider.response` | 1,130 → 1,130 | Raw message and scope, not the request or history. |

Native message data, duplicate tool schemas and session settings bulked up every copy.
The host now projects the model view instead of copying native records into it. Message
source IDs still track erasure and opaque reasoning. The five transfers of the model
request per step remain. A catalog/readiness check is not a new registration; neither
initialize nor a registration appeared during the turn. The read tool got its scoped call.
No plugin asked for raw history on this fresh turn. On recovery, the Runtime reads the
committed checkpoint by turn ID through `host/history`. The current binding pages the
branch (or all kept entries), not just that turn. A peer cannot substitute a truncated
page or a cached history after a move or erasure.

### Proposed binding text (not implemented)

For a negotiated extension to [Runtime callbacks](../docs/bindings/plugin.md#runtime-callbacks)
and [Provider requests](../docs/bindings/plugin.md#the-host-asks-a-provider):

> The host MAY offer `requestRefs: 1` at initialization. A plugin MAY accept by returning
> `requestRefs: 1` in its registration. Without agreement the existing method schemas apply.
> With agreement a Runtime MAY send `byStep: true` in `host/runtime/prepareStep`. After
> normal preparation the host MUST then reply `{ prepared: true }` and retain the exact
> prepared ModelRequest for that parent and step. In `host/runtime/model` the Runtime
> MAY omit `request` for that preparation only. The host MUST use that request and apply
> the same single-attempt, phase, limit and authority checks as for a literal request.
> On `model.failed` the Runtime MAY omit `payload.request` for that attempt; the host MUST
> supply the retained request to the hook chain. This option does not authorize a retry
> or a recovery replay. Retained requests expire with the live parent; an unknown or
> ineligible reference is `invalid_request`.

> With agreement a Provider MAY omit `payload.request` on its one `provider.request`
> callback. Omission means the exact request of the named live `provider/request` parent
> on this connection. The host MUST perform the same transform, commit and final dispatch
> checks. If the effective request is unchanged by JSON value, it MAY reply
> `{ unchanged: true }` to this abbreviated callback; otherwise it MUST return the full
> transformed payload. Only the successful reply authorizes inference. The response
> callback, cancellation and loss rules do not change.

For [paging history](../docs/bindings/plugin.md#paging-history):

> The host MAY offer `historySelect: 1` at initialization. A plugin MAY accept by returning
> the same member. Only with agreement, `host/history` MAY carry `turnId: Id` or
> `toolCallId: Id`, but not both. The host MUST select the branch or kept view as before,
> then filter by that association, then apply `after` and `limit`. A cursor outside the
> selected view is `invalid_request`. Page size, order, erasure freshness, trace projection
> and authority rules remain unchanged. A turn filter does not prove a call has no later
> settlement. A reader needing that proof MUST also check by call ID across kept history.

## Remaining Python implementation gaps

The older base build's private `MA_PLUGIN_PROCESSES` placement does not install OpenTelemetry in its worker processes. The shared telemetry check does not exercise it: `create_agent` passes an empty internal worker list to the Harness, and `process:<sdk>` uses the SDK's explicit plugin binding. The SDK's public hosted Runtime placement records the invocation in the host and uses the plugin binding for propagation.

Provider-owned tool dispatch, live sessions and late answers are outside the SDK 0.1 Provider port ([API, Providers](../docs/sdk/api.md#providers)).

ADR 0030 is not complete. Represented actors can send attributed input and explicit answers. Permission requests and forms select a present, eligible actor and recheck that route before sending and accepting a reply. Final authority checks on every callback, child and job relay are not independently covered. Trusted plugin code and external resources still need operator confinement. The reservation ledger accounts for saved records and unfinished work, and bounds tool receipts and job results. It does not prove settlement space for every auxiliary attempt, cleanup failure or stalled recipient. An affected session refuses new effects and stale effect results, but an already active call or job can keep erasure pending. The implementation does not settle all affected in-flight work or track and verify all external deletions.

### ADR 0030 kit results

| Option | `ma` passed/run | Base passed/run |
|---|---:|---:|
| ACP isolation, stdio | 15/15 | 16/17 |
| ACP isolation, WebSocket | 17/17 | 18/19 |
| ACP capacity, stdio | 18/20 | 18/20 |
| ACP erasure, stdio with a `pendingErasure: 1` history service | 18/18 | Not rerun on the profile |
| History isolation (shared SDK service, not per agent) | 3/3 isolation, 42/42 overall | 3/3 isolation, 42/42 overall |
| Plugin multi-credential isolation | Not run | Not run |

A diagnostic run with the two fixture corrections below passed 43/43 combined stdio isolation and capacity checks for `ma` and 45/45 for the base. The table uses the unchanged kit.

The plugin opt-in needs several credentials with distinct project grants on one listener. Python uses the separate-listener deployment selected by ADR 0030. The default WebSocket kit covers independent connections with one credential but does not test distinct grants.

For coordinated HTTP erasure, use `http_history(url, token_file)` or set `MODULAR_AGENT_HISTORY_URL` and `MODULAR_AGENT_HISTORY_TOKEN_FILE` for `ma`. The built-in `serve_history(file_history(...))` advertises the [pending-erasure registry profile](../docs/bindings/history-http.md#pending-erasure-registry-profile-pendingerasure-1). A custom `HistoryPort` served by the base HTTP adapter does not advertise it. Participating agents do not open the service's database. The private coordination arguments and environment variables were removed. A store with recorded private intents refuses coordinated mutations and registry reads instead of dropping those marks; finish and export it using the old deployment before switching stores.

The service keeps marks and revisions with its records. Keep raw writers outside the coordinated scope. Before serving restored history, verify its freshness against an authority that was not restored with it. `serve_history(..., witness=path)` can keep a separate local witness. Do not restore the witness from a history backup. The service advances it before database commit; a mismatch refuses access and requires operator recovery. Without a witness the operator must supply another independent freshness check.

The history kit passed 42/42 base and restart checks and 18/18 profile checks, including publication, refusal and takeover by separate wire clients. The ACP erasure check ran against the Python service without shared filesystem state.

## Specification findings

- **SDK API, Questions.** After the `call` row, insert: “| `coversNested` | True when an explicit allow for this top-level call also answers the approval check for its nested calls in this dispatch. Omission means false. |”
- **AG-UI, Questions.** After the sentence beginning “For approvals include”, insert: “For an approval marked `coversNested: true`, the message MUST say the allow covers the call's nested calls and the interrupt MUST include `metadata[\"modular-agent.coversNested\"]: true`. Otherwise omit the key.”

- **SDK, The agent.** Add to the session reopening options: “A composition can name former Provider ids and their current ids for saved model settings. When reopening a session, record the current model ref before recovery; do not rewrite earlier entries.” Python passes this map as `create_agent(model_aliases=...)`.
- **SDK API, The agent.** The stdio options describe how to constrain a configured principal but give no way to select that principal, which `ma` policy requires. Replace the first sentence starting “On stdio, `serveAcp` accepts” with: “On stdio, `serveAcp` accepts an operator-supplied `actor` with `id`, `kind` and `rights`, and optional `projects`, `tenants`, `rights` and `represents` lists. When both the actor and a rights list are supplied, intersect the two rights lists. Without an actor, use the local principal as defined in the ACP binding.”
- **ACP capacity fixture.** Both tenant and agent fixtures race two initial admissions for one pending slot, but need both initial prompts to start a turn before racing the admissions they measure. Replace the simultaneous initial starts with: “Start each initial prompt in sequence. Wait for its committed input consumption and open question before starting the next prompt. Then race the two new input keys for the last pending slot.”
- **ACP isolation fixture, configured representation.** The fixture closes a session without admitting any input. The binding says unused sessions leave no records, so the second launcher cannot reopen this session. Before capturing `before`, insert: “Prompt the session as the configured principal and wait for the committed turn to finish. Then capture the history used for the no-admission assertion.”
- **Plugin isolation fixture.** The single-listener test does not cover the accepted separate-listener deployment. Add: “For a separate-listener deployment, give the kit two URLs, each with its own token, project grant and state directory. Cross credentials must fail upgrade. Check one same-credential pair on each listener and check that neither listener can read or restore the other's project or retained state.”

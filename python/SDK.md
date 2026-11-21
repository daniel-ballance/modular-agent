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

The two [live checks](../docs/sdk/testing.md#live-checks) in `tests/test_sdk_live.py` are skipped by default and skip separately if their Provider's environment key is absent. Run them by hand before a release with `MODULAR_AGENT_LIVE=1`. The offline suite does not need real credentials.

## What is checked

- **Shared scenarios:** 153/153 with `MODULAR_AGENT_SDK_REQUIRE=all` on the ADR 0030 branch: all 17 in process, all 17 with each SDK's fixture programs on stdio, and all 17 with each SDK's fixtures over WebSocket.
- **Reference `ma`:** 23/23 on the policy implementation. The stderr regression checks a dispatched `codemode` call, not `tool(null)`.
- **ACP kit against `ma`:** 188/188 on stdio and 193/193 over WebSocket with crash, probe and job checks. The opt-in ADR 0030 run against history HTTP passed 15/27 at the first policy checkpoint. A later stdio isolation-only run passed 13/15. Those runs do not establish shared erasure support.
- **Plugin kit:** 146/146 on stdio and 153/153 over WebSocket, with both Runtime tiers.
- **History kit:** 42/42 against `serve_history(file_history(...))` with restart. An earlier run also passed 42/42 through a custom `HistoryPort` with a shorter TTL after restart.
- **Session publication:** six SDK cases cover file, HTTP and Registrar history with in-process and served Runtimes. Unused sessions leave no records on close or process loss. The first admission flushes setup in order, and forks publish the copied prefix and fresh setup together. A separate ACP case checks that `session/new` and close do not create an HTTP history record.
- **Session interruption:** seven public API cases cover failed appends and revoked leases. Embedded `prompt`, embedded `prompt_stream` and WebSocket ACP each settle with `lost`; a follower sees the live interruption and reopening recovers from the kept journal. A custom store's revocation notice interrupts an idle session before any renewal or write.
- **Plugin connection callbacks:** on stdio and WebSocket, two image-bearing job progress updates reach the originating plugin’s output gate and the SDK event follower in order, before job end. The old Python host let job end overtake progress and could stall when a notification handler delegated a same-peer RPC to a child task. The peer now drains notifications in order without holding unrelated replies or callbacks. Tests also cover same-peer tool and environment streams, Provider pieces, Runtime callbacks and reports, catalog refresh, custom events and diagnostics.
- **SDK API regressions:** four follower cases preserve image progress through local and served tools and Runtimes. Three proposal cases check conflicts after release, decline and withdrawal. A history port case checks metadata and both page cursors; two Provider cases check the declaration in both placements.
- **Command lifetime:** the WebSocket plugin kit checks disconnect cleanup. A regression also kills the agent's entire process group while a background descendant is still running; the separate lifetime watcher must survive the group kill and stop it on pipe EOF.
- **Secret crash recovery:** three actual SIGKILL cutoffs: after staging, after committing the selection, and after activation. A separate test checks idempotence and generations.
- **ADR 0030 SDK tests:** seven cases cover held-fork erasure handoff, concurrent refusal at each input scope, duplicate and hand-back at saturation, reservation rebuild, and capacity outcomes for a refused model attempt and a refused call list. Policy and SDK smoke checks passed 61 cases. Two more public cases cover malformed stdio options and configured network representation. Ruff lint and format and strict mypy passed. The four-configuration pytest matrix was not clean during development; the targeted regressions passed after fixes. The earlier, pre-ADR four-configuration matrix passed 518 in each placement, with two live checks skipped.

## Built so far

| Area | State |
|---|---|
| Composition | Awaitable or async context manager; local, memory and file/HTTP-backed parts, three durability modes, explicit `transient_runtime()` and `durable_runtime()`, Provider and tool options, local, stdio and WebSocket plugins. `local_environment(root)` uses `root` as the project when none is given; if both are given they must match. |
| Session and turn | Create, reopen, prompt and steer with shared Content, stream, gated last turn and history, send, cancel, settings, move, fork, erase and close. Direct calls use the Runtime's gates. Structured turn results are checked with feedback and retry. `events(from_entry)` replays kept entries, then follows typed live events, with `lost` and the last delivered entry cursor on lag. `SessionInterruptedEvent` is live only; a failed commit or lost writer fences dispatch and fails waiting prompts with `lost`. |
| Authority | `several_actors`, `session_limits` and `tenants` opt in. Embedded actor and proposal operations use current effective rights. Stdio ACP accepts operator `actor`, `rights`, `projects`, `tenants` and `represents`; network scope and representation are set per token. A checked scope cannot enlarge the composition's reach. `ma` reads one policy file in all modes. |
| Reservations | `create_agent(resource_reservations={scope: {name: count}})` sets bounds. Scopes are `session`, `tenant` and `agent`. Fields are `inputs`, `calls`, `jobs`, `bufferedBytes`, `storageBytes` and `controlBytes`. Omitted fields have finite defaults. `agent.reservation_limits()` returns configuration only. Count ceilings are in the declaration. Project compositions share the listener's reservations. |
| Pending erasure | Native SQLite history publishes a content-free registry in the same database as its records. A held copy stays pending, and a writer reconciles it under its lock. Raw HTTP history does not declare coordinated erasure. Use separate service instances, credentials and backing directories for raw history scopes. |
| Questions | `on_question` can override the agent-wide handler. `questions()` lists only open questions and reports per-recipient `answerable`; `answer` submits by ID. Without a handler an untimed non-approval can wait for an eligible offline actor, while an approval still needs a present eligible answerer. A text `declined` and a tagged decline are distinct. `late_answers_start_turns=True` enables a timed non-approval to leave a call open. |
| Secrets | `environment_credentials()` is read-only. `file_credentials(path)` provides durable `stage`, `lookup_staged`, `activate` and `discard`; `ma` uses it for `auth.json` and keeps active values under `answers`. Recovery discards unselected staging and completes a committed selection before resuming work. |
| Tools | Input from type hints, one Pydantic model, or `Tool.from_schema`; exact hints, structured results, cancellation, refusal, questions, progress, log, history pages, environment and nested calls. Typed `toolOutput` events expose the text `chunk` and optional original `content`, including images. Nesting is four levels including the outer call. The public wire Runtime placement does not declare nesting. |
| Plugins and parts | Register tools, changing tool sources, Providers, commands, hooks, working environments, Runtimes and job owners, in process or served. Custom configuration, credential stores, Interfaces and plugin-defined hooks run in process. `Registrar.on` provides typed payloads and answers for core points; `HookContext` supports raw history, cancellation and custom events. Actor joins/leaves and Provider pieces are local hooks. A flagged local `tool.before` gate can leave a call pending even when the Runtime is served. |
| Jobs | Registered owners start keyed work through `context.jobs.start()`. Job handles report progress and settlement. Owner cancellation and reopen/resume are checked in both placements. A missing committed end on cancellation records `jobCleanupUnconfirmed`; the execution cannot report or resume. |
| Providers and commands | Providers may declare kept state; `runsToolsAtProvider` and `liveSessions` are always false. Embedded catalog invalidation with `ProviderCatalog.changed()`; polling over the binding without a private notification. In-process commands can ask questions or request models under their own recorded step without starting a turn. A served command uses `host/session` for its project, even when the session was saved in a different project. Tools and Providers can read named credentials in process. API-key Providers use the shared, byte-checked model table; explicitly enrolled unlisted ids send no reasoning controls. |
| Testing and guides | Scripted Provider, memory environment, `test_agent`, `answers(...).assert_done()`, `over_wire` and `restart`. Seven shared fixture plugins, a fixture program and a runner. Offline tests cover guides 01–09. `restart` interrupts tracked work without graceful plugin stops; it does not simulate detached work or child-process cleanup. |
| WebSocket transport | `await serve(plugin, listen=ADDR, token_file=path, tls=...)` starts a plugin service. `create_agent(service_plugins=[{"url": url, "token_file": path, "config": {...}}])` loads it after process plugins and before entries from `MODULAR_AGENT_PLUGINS`. That variable uses wire casing (`tokenFile`). `await agent.serve_acp(listen=ADDR, actors=[...], tls=...)` serves independent, authenticated ACP connections. `ma --acp --listen ADDR --token-file FILE` is the loopback service for the local user. |
| History | `history_store(port)` registers a custom `HistoryPort`; pass the same persistent port to `serve_history` to serve it over HTTP. Stores with an independent revocation signal can implement `async wait_writer_lost(session_id, lease)`, returning when that lease is lost; the agent cancels the wait when closing the lease. `http_history(url, token_file)` selects the client. `serve_history(file_history(directory), address=(host, port), token_file=path)` blocks and serves an opaque-record SQLite database; it does not import existing native history. `sqlite_history_port(directory)` is a context manager over that same service store, for implementing or wrapping opaque records and leases. Memory and client-backed stores are ineligible. Plain HTTP is numeric loopback only. |

A custom `RuntimePort` declares its id and support, implements `run_turn`, `resume_turn` and `continue_open_calls`, and registers with `r.runtime(port)` in a plugin that lists `replaces=["runtime"]`. `RuntimeContext` exposes the binding's checked callbacks, including the model request and output pieces, record and steering, and raw history. A custom `HistoryPort` receives opaque shared dictionaries. It owns atomic batch equality, durable acknowledgement, expiry, paged reads and tombstone projection. Raise `HistoryError("held", message, {"retryAfterMs": n})` for a held lease, or the appropriate binding refusal for other unchanged requests. A port is caller-owned; keep it open while the agent or service uses it.

The six standard file tools come from `modular_agent.files.file_tools(output_directory)`. `modular_agent.mcp.mcp(servers)` connects stdio or Streamable HTTP tool servers. Register these in `plugins`. Local paths are not confined. At command dispatch, the default local environment requires delegated cgroup v2; `local_process_groups=True` opts in to a weaker fallback.

`agent.sessions(project=...)` and `agent.session_info(id)` inspect saved sessions without acquiring writer leases. `agent.serve_acp(compose=..., compose_reopen=..., project_settings=..., project_mcp=...)` can select compositions by canonical project and saved session ID. Compositions that reopen sessions share the serving Agent's persistent history, and the MCP resolver must check project trust before returning configured programs.

Both WebSocket servers return a listener with `url` (the bound address including the port chosen for `:0`) and async `close()`. Plain `ws:` is loopback-only. To serve `wss:`, pass `tls={"cert_file": ..., "key_file": ...}`. The SDK client verifies the certificate and hostname against the default TLS trust store (which supports `SSL_CERT_FILE` for a private CA). Tokens stay in owner-only files. Choose tokens with at least 128 random bits. Set `service_ping_interval` and `service_control_timeout` on the host to tune the default 30-second silent-work interval and 5-second control deadline, respectively.

A plugin value gets a new registration and copy per connection. If the plugin carries state in function closures or holds noncopyable resources, pass a zero-argument factory to `serve` so each connection gets fresh state. ACP's `actors` entries are `{"token_file": path, "actor": {"id": ..., "kind": ..., "rights": [...]}, "tenants": [...], "projects": [...]}`. Tenant scope defaults to no tenant; include `None` to allow it alongside named tenants. An explicit project list contains canonical project roots; omitting it allows the projects the serving composition admits. Tokens for the same actor id must agree on kind, but can impose different rights ceilings on the same recorded grants. An authorized second connection can attach to an open session's existing writer without sharing the first connection's ACP handshake or leaving the session suspended on its disconnect.

## Remaining Python implementation gaps

Provider-owned tool dispatch, live sessions and late answers are outside the SDK 0.1 Provider port ([API, Providers](../docs/sdk/api.md#providers)).

ADR 0030 is not complete. Represented actors can submit attributed input and explicit answers, but approval and form routing and final authority checks through every callback are not all covered. Trusted plugin code and external resources still need operator confinement. The reservation ledger accounts for saved records and unfinished work; it does not yet prove enough settlement space for every oversized result, auxiliary attempt, cleanup failure or stalled recipient. The native registry does not supply a portable coordinator, a restore freshness witness outside the database, or full settlement and remote deletion of affected in-flight work. These are not conformance claims.

## Specification findings

- **SDK API, The agent.** The stdio options describe how to constrain a configured principal but give no way to select that principal, which `ma` policy requires. Replace the first sentence starting “On stdio, `serveAcp` accepts” with: “On stdio, `serveAcp` accepts an operator-supplied `actor` with `id`, `kind` and `rights`, and optional `projects`, `tenants`, `rights` and `represents` lists. When both the actor and a rights list are supplied, intersect the two rights lists. Without an actor, use the local principal as defined in the ACP binding.”
- **SDK placement, History.** The binding does not expose the registry needed to reproduce the shared erasure fault cutoffs. Add after the raw access paragraph: “`httpHistory(url, tokenFile)` alone does not enable coordinated erasure. A deployment that enables it must also supply a common pending-state implementation and a restore freshness witness. Test fault cutoffs against that implementation, not solely against /1.”
- **ACP capacity fixture.** The tenant fixture races two initial admissions for one pending slot, but needs both initial prompts to start a turn before racing the admissions it measures. Replace the simultaneous initial starts with: “Start each initial prompt in sequence. Wait for its committed input consumption and open question before starting the next prompt. Then race the two new input keys for the last pending slot.”

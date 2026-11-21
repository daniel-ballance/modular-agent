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

- **Shared scenarios:** 153/153 with `MODULAR_AGENT_SDK_REQUIRE=all`: all 17 in process, all 17 with each SDK's fixture programs on stdio, and all 17 with each SDK's fixtures over WebSocket.
- **Reference `ma`:** 18/18. The stderr regression checks the actual dispatched `codemode` call, not `tool(null)`.
- **ACP kit against `ma`:** 188/188 on stdio and 193/193 over WebSocket, with crash, probe and job checks. The standard declaration keeps several actors, limits and tenants off.
- **Plugin kit:** 146/146 on stdio and 153/153 over WebSocket, with both Runtime tiers.
- **Command lifetime:** the WebSocket plugin kit checks disconnect cleanup. A regression also kills the agent's entire process group while a background descendant is still running; the separate lifetime watcher must survive the group kill and stop it on pipe EOF.
- **Secret crash recovery:** three actual SIGKILL cutoffs: after staging, after committing the selection, and after activation. A separate test checks idempotence and generations.
- **Python suites:** 483 passed and 2 live checks skipped in each process-binding run (transient and durable). Each native run finished with 482 passed, 2 live checks skipped and one timeout in the split-plugin ACP kit at `rewind one`. The split-plugin check passed when run alone, but the cause of those timeouts remains unconfirmed. An earlier transient-process run also timed out waiting for the fake model in `test_lowering_limit_takes_effect_during_a_turn`. No timeout was extended and no isolated pass substitutes for a failed suite. The containment test now has a private delegated cgroup subtree: other agents' orphan sweeps could previously change what it was checking. Ruff lint, Ruff format (183 files) and strict mypy (34 source files) passed.

## Built so far

| Area | State |
|---|---|
| Composition | Awaitable or async context manager; local, memory and file/HTTP-backed parts, three durability modes, explicit `transient_runtime()` and `durable_runtime()`, Provider and tool options, local, stdio and WebSocket plugins. `local_environment(root)` uses `root` as the project when none is given; if both are given they must match. |
| Session and turn | Create, reopen, prompt and steer with shared Content, stream, last turn, history, send, cancel, settings, move, fork, erase and close. Direct calls use the Runtime's gates. Structured turn results are checked with feedback and retry. `events(from_entry)` replays kept entries and follows live events, with `lost` and the last delivered entry cursor on lag. |
| Authority | `several_actors`, `session_limits` and `tenants` opt in. `session(actors=..., tenant=...)`, `join`, `leave`, `as_actor`, proposal release/withdrawal and `set_limit` use recorded grants and current effective rights. ACP authenticates its own actors. |
| Questions | `on_question` can override the agent-wide handler. `questions()` lists only open questions and reports per-recipient `answerable`; `answer` submits by ID. Without a handler an untimed non-approval can wait for an eligible offline actor, while an approval still needs a present eligible answerer. A text `declined` and a tagged decline are distinct. `late_answers_start_turns=True` enables a timed non-approval to leave a call open. |
| Secrets | `environment_credentials()` is read-only. `file_credentials(path)` provides durable `stage`, `lookup_staged`, `activate` and `discard`; `ma` uses it for `auth.json` and keeps active values under `answers`. Recovery discards unselected staging and completes a committed selection before resuming work. |
| Tools | Input from type hints, one Pydantic model, or `Tool.from_schema`; exact hints, structured results, cancellation, refusal, questions, progress, log, history pages, environment and nested calls. Nesting is four levels including the outer call. The public wire Runtime placement does not declare nesting. |
| Plugins and parts | Register tools, changing tool sources, Providers, commands, hooks, working environments and job owners, in process or served. Custom configuration, credential stores, Interfaces and plugin-defined hooks run in process. `HookContext` supports history, cancellation and custom events. Local hooks include actor joins/leaves and Provider pieces; a flagged local gate can leave its tool call pending. |\n| Jobs | A tool or command from a registered owner can start keyed work with `context.jobs.start()`. A job handle can report progress and settle the job. Owner cancellation runs in both placements; owner resume runs before the reopen hook returns. |\n| Providers and commands | Embedded catalog invalidation with `ProviderCatalog.changed()`; polling over the binding without a private notification. In-process commands can ask questions or request models under their own recorded step without starting a turn. API-key OpenAI Responses and Anthropic Messages use the shared, byte-checked model table. Pass `models` to select exact ids or to enroll unlisted ids with explicit limits and input types; unlisted ids send no reasoning controls. |
| Testing and guides | Scripted Provider, memory environment, `test_agent`, `answers(...).assert_done()`, `over_wire` and `restart`. Seven shared fixture plugins, a fixture program and a runner. Offline tests cover guides 01–09. `restart` interrupts tracked work without graceful plugin stops; it does not simulate detached work or child-process cleanup. |
| WebSocket transport | `await serve(plugin, listen=ADDR, token_file=path, tls=...)` starts a plugin service. `create_agent(service_plugins=[{"url": url, "token_file": path, "config": {...}}])` loads it after process plugins and before entries from `MODULAR_AGENT_PLUGINS`. That variable uses wire casing (`tokenFile`). `await agent.serve_acp(listen=ADDR, actors=[...], tls=...)` serves independent, authenticated ACP connections. `ma --acp --listen ADDR --token-file FILE` is the loopback service for the local user. |
| HTTP history | `http_history(url, token_file)` selects the client. `serve_history(file_history(directory), address=(host, port), token_file=path)` blocks and serves an opaque-record SQLite database; it does not import existing native history. Memory and client-backed stores are ineligible. Plain HTTP is numeric loopback only. |

The six standard file tools come from `modular_agent.files.file_tools(output_directory)`. `modular_agent.mcp.mcp(servers)` connects stdio or Streamable HTTP tool servers. Register these in `plugins`. Local paths are not confined. At command dispatch, the default local environment requires delegated cgroup v2; `local_process_groups=True` opts in to a weaker fallback.

`agent.sessions(project=...)` and `agent.session_info(id)` inspect saved sessions without acquiring writer leases. `agent.serve_acp(compose=..., compose_reopen=..., project_settings=..., project_mcp=...)` can select compositions by canonical project and saved session ID. Compositions that reopen sessions share the serving Agent's persistent history, and the MCP resolver must check project trust before returning configured programs.

Both WebSocket servers return a listener with `url` (the bound address including the port chosen for `:0`) and async `close()`. Plain `ws:` is loopback-only. To serve `wss:`, pass `tls={"cert_file": ..., "key_file": ...}`. The SDK client verifies the certificate and hostname against the default TLS trust store (which supports `SSL_CERT_FILE` for a private CA). Tokens stay in owner-only files. Choose tokens with at least 128 random bits. Set `service_ping_interval` and `service_control_timeout` on the host to tune the default 30-second silent-work interval and 5-second control deadline, respectively.

A plugin value gets a new registration and copy per connection. If the plugin carries state in function closures or holds noncopyable resources, pass a zero-argument factory to `serve` so each connection gets fresh state. ACP's `actors` entries are `{"token_file": path, "actor": {"id": ..., "kind": ..., "rights": [...]}, "tenants": [...], "projects": [...]}`. Tenant scope defaults to no tenant; include `None` to allow it alongside named tenants. An explicit project list contains canonical project roots; omitting it allows the projects the serving composition admits. Tokens for the same actor id must agree on kind, but can impose different rights ceilings on the same recorded grants. An authorized second connection can attach to an open session's existing writer without sharing the first connection's ACP handshake or leaving the session suspended on its disconnect.

## Remaining Python implementation gaps

- Custom Runtime and history ports still need public registrations and life-cycle adapters. The built-in Runtime and history choices and the base conformance Runtime exercise the protocols but do not expose a developer-written port.
- `HookContext` and typed dictionary payloads are available for `tool.before`, `tool.after` and `provider.piece`; the other payloads and answers are still generic shared dictionaries. Events still use `EventData.fields` rather than a complete tagged union. These need a complete public type surface and parity tests, not another wire encoding.
- Named tool/Provider credentials, Provider-owned state beyond optional discard, command environment callbacks over the binding, and gate-driven pending calls with a hosted Runtime are not yet exposed. Job-owner cancellation and local resume are tested through the SDK; resume through the SDK wire adapter and unconfirmed owner cleanup need coverage.

## Specification findings

- [Languages, Python](../docs/sdk/languages.md#python) says `r.on` takes a shared dictionary payload but does not explain the context or how its type interacts with wire keys. Replace the first two sentences of the bullet starting “Inherit `ProviderCatalog`” with: “Inherit `ProviderCatalog` to call `changed()`. A hook handler registered with `r.on(point, handler, order='normal')` receives a payload dictionary with shared wire keys and a `HookContext`; handlers that do not need the context may take just the payload.”
- [API, Sessions and turns](../docs/sdk/api.md#sessions-and-turns) says proposed input works but does not name the embedded operations. After `send`, add: “`proposals()` lists parked proposals as the actor may see them. `release(inputId, timing, options?)` takes a proposal with timing `now`, `steer` or `after`, or hands it back with `declined: true`; it returns an InputReceipt. `withdraw(inputId)` hands a proposal back on behalf of its proposer or an actor with `input`. A second settlement raises `conflict`.”

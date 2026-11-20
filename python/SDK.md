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
(cd python && uv sync --python 3.13)
(cd python && uv run --offline pytest -q --runtime transient)
(cd python && uv run --offline pytest -q --runtime durable)
(cd python && uv run --offline pytest -q --runtime transient --binding process)
(cd python && uv run --offline pytest -q --runtime durable --binding process)
(cd python && uv run --offline ruff check . && uv run --offline ruff format --check . && uv run --offline mypy)
node conformance/reference/run.mjs --agent python
MODULAR_AGENT_CONFORMANCE=1 node conformance/acp/run.mjs --crash-checks --probe-checks --job-checks -- "$PWD/python/.venv/bin/ma" --acp
```

Build each fixture using its command in [`conformance/sdk/fixtures/`](../conformance/sdk/fixtures/). Then run `(cd python && MODULAR_AGENT_SDK_REQUIRE=all uv run --offline python -m modular_agent._scenarios)`. Omit `MODULAR_AGENT_SDK_REQUIRE` to skip unbuilt programs. Pass individual scenario paths to run a subset.

The two [live checks](../docs/sdk/testing.md#live-checks) in `tests/test_sdk_live.py` are skipped by default and skip separately if their Provider's environment key is absent. Run them by hand before a release with `MODULAR_AGENT_LIVE=1`. The offline suite does not need real credentials.

## What is checked

- **Shared scenarios:** 28/28 in process and served by Python. The original eleven passed 55/55 with all programs required. The complete matrix passed 67/70: the Go, Rust and TypeScript fixture programs built from this checkout do not yet register `note`.
- **Reference `ma`:** 17/17. The stderr regression checks the actual dispatched `codemode` call, not `tool(null)`.
- **ACP kit against `ma`:** 188/188 with crash, probe and job checks. The standard declaration keeps several actors, limits and tenants off.
- **Secret crash recovery:** three actual SIGKILL cutoffs: after staging, after committing the selection, and after activation. A separate test checks idempotence and generations.
- **Python suites:** 405 passed and 2 live checks skipped in each of the four configurations: transient and durable, both with normal and process binding. Ruff lint, Ruff format (172 files), strict mypy (30 files) and the repository link check passed.

## Built so far

| Area | State |
|---|---|
| Composition | Awaitable or async context manager; local, memory and file/HTTP-backed parts, three durability modes, explicit `transient_runtime()` and `durable_runtime()`, Provider and tool options, local and stdio plugins. `local_environment(root)` uses `root` as the project when none is given; if both are given they must match. |
| Session and turn | Create, reopen, prompt, stream, last turn, history, send, cancel, settings, fork and close. Structured results are checked with feedback and retry. `events(from_entry)` replays kept entries and follows live events, with `lost` and the last delivered entry cursor on lag. |
| Authority | `several_actors`, `session_limits` and `tenants` opt in. `session(actors=..., tenant=...)`, `join`, `leave`, `as_actor`, and `set_limit` use recorded grants and current effective rights. ACP authenticates its own actors. |
| Questions | `on_question` can override the agent-wide handler. `questions()` lists only open questions and reports per-recipient `answerable`; `answer` submits by ID. Without a handler an untimed non-approval can wait for an eligible offline actor, while an approval still needs a present eligible answerer. A text `declined` and a tagged decline are distinct. `late_answers_start_turns=True` enables a timed non-approval to leave a call open. |
| Secrets | `environment_credentials()` is read-only. `file_credentials(path)` provides durable `stage`, `lookup_staged`, `activate` and `discard`; `ma` uses it for `auth.json` and keeps active values under `answers`. Recovery discards unselected staging and completes a committed selection before resuming work. |
| Tools | Input from type hints, one Pydantic model, or `Tool.from_schema`; exact hints, structured results, cancellation, refusal, questions, progress, log, history pages, environment and nested calls. Nesting is four levels including the outer call. The public wire Runtime placement does not declare nesting. |
| Plugins, hooks and Providers | Setup/config, tools, commands, Providers and hooks. Developer Providers can check readiness with `available()` and invalidate an embedded catalog with `ProviderCatalog.changed()`. The stdio host polls the current catalog and availability and forwards model pieces, both Provider hook callbacks and the scoped Provider credential. Includes API-key OpenAI Responses and Anthropic Messages adapters. |
| Testing and guides | Scripted Provider, memory environment, `test_agent`, `answers(...).assert_done()`, `over_wire` and `restart`. Seven shared fixture plugins, a fixture program and a runner. Offline tests cover guides 01–09. `restart` interrupts tracked work without graceful plugin stops; it does not simulate detached work or child-process cleanup. |
| HTTP history | `http_history(url, token_file)` selects the client. `serve_history(file_history(directory), address=(host, port), token_file=path)` blocks and serves an opaque-record SQLite database; it does not import existing native history. Memory and client-backed stores are ineligible. Plain HTTP is numeric loopback only. |

The six standard file tools come from `modular_agent.files.file_tools(output_directory)`. `modular_agent.mcp.mcp(servers)` connects stdio or Streamable HTTP tool servers. Register these in `plugins`. Local paths are not confined. At command dispatch, the default local environment requires delegated cgroup v2; `local_process_groups=True` opts in to a weaker fallback.

`agent.sessions(project=...)` and `agent.session_info(id)` inspect saved sessions without acquiring writer leases. `agent.serve_acp(compose=..., compose_reopen=..., project_settings=..., project_mcp=...)` can select compositions by canonical project and saved session ID. Compositions that reopen sessions share the serving Agent's persistent history, and the MCP resolver must check project trust before returning configured programs.

## Remaining Python implementation gaps

- There is no general public registration adapter for custom Runtime, environment, changing tool source, job owner, configuration, Interface or plugin-defined hooks. The shipped Runtime choices are not custom Runtime implementations. SDK `serve` does not expose WebSocket placement or the base's public Runtime/environment serving implementations. These need typed public adapters and placement parity tests; the base binding alone does not supply them.
- Hook handlers receive shared dictionaries, not typed payload and context objects. Some local-only hook points and answers are not exposed, including `session.join`, `session.leave`, `provider.piece`, and returning `pending(question)` from `tool.before`. Tool questions use the separate `ToolContext.ask` path. Named tool credentials, command questions, and general job contexts are not exposed.
- Embedded APIs for moving, erasing and releasing or withdrawing proposed input are not yet exposed. The ACP Interface has these operations independently of the SDK methods. Provider-owned state beyond optional discard is not exposed.

## Findings for the SDK specification

Proposed replacement text, not edits to the shared docs:

1. **[API — Sessions and turns](../docs/sdk/api.md#sessions-and-turns):** add a row: “`lastTurn()` returns the latest settled turn as a PromptResult, or no value if none exists; it does not admit input.”
2. **[Languages — Python](../docs/sdk/languages.md#python):** add: “`session.as(actorId)` is `session.as_actor(actor_id)` in Python because `as` is reserved.” The actor options are available through `await agent.session(actors=..., tenant=...)`, not through an ACP client identity parameter.
3. **[API — Building an agent](../docs/sdk/api.md#building-an-agent):** replace the two `credentials` rows with one: “`credentials` | a credential store | environment variables. A writable store such as `fileCredentials(path)` implements the staging operations for secret questions.”
4. **[Guide 04 — Ask for a choice](../docs/sdk/guides/04-questions-and-approvals.md#ask-for-a-choice-and-answer-from-your-ui):** replace the Python caveat with: “Python's `await session.questions()` lists open questions. An app can start the turn with `send`, show those questions, and call `await session.answer(id, reply)` without keeping a handler pending. A handler is still needed to make the embedded actor present for approval.”
5. **[Guide 06 — Write a Provider](../docs/sdk/guides/06-write-a-provider.md):** replace the Python readiness and serving caveats with: “Python Providers may implement `available()` and inherit `ProviderCatalog` to call `changed()` after changing their catalog. Register a request/response Provider with `r.provider(provider)` and serve the plugin with `serve(plugin)`. Use `cx.credential()` in either placement; the served adapter obtains it through `host/credentials/read`.”
6. **[Guide 07 — Register the hooks](../docs/sdk/guides/07-hooks.md#register-the-hooks):** in the Python example, retain the exact reply shapes: “`r.on(point, handler, order='normal')` receives a shared dictionary. A `tool.before` rewrite is `{'change': {'input': new_input}}`, a `tool.after` rewrite is `{'change': {'content': content}}`, a prompt contribution is `{'add': {'system': text}}`, and a `step.after` refusal is `{'end': reason}`.” Typed hook contexts remain an implementation gap, not a different contract.
7. **[API — The agent](../docs/sdk/api.md#the-agent):** add: “Python's `serve_acp` additionally accepts `compose_reopen(project, id)` to choose the composition for a stored session. The async factories receive a canonical `Path`. The settings and trusted MCP configuration callbacks are synchronous; a composition that opens saved sessions shares the serving Agent's history.”
8. **[Placement — Services](../docs/sdk/placement.md#services):** the separate opaque-record namespace is now documented. In Python the example's exact call is `serve_history(file_history(directory), address=(host, port), token_file=path)` in the service process and `http_history(url, token_file)` in the client.

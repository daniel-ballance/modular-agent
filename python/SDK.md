# modular-agent: the Python SDK

The Python SDK implements the embedded slice of [SDK draft 0.1](../docs/sdk/README.md) over the edition-3 Python build. Applications import `modular_agent`; they do not need to import the Harness or its plugins. The `modular-agent` console script and `python -m modular_agent` still run the base CLI. Its composition is now in `ma_cli`.

```python
from modular_agent import run
from modular_agent.testing import test_agent


async def main() -> None:
    async with test_agent(script=[{"text": "Hello."}]) as agent:
        session = await agent.session()
        result = await session.prompt("Say hello.")
        print(result.text)


run(main())
```

## Run the checks

From `python/`:

```sh
# The existing ACP kit needs its Node client.
(cd ../conformance/acp && npm ci --offline)
uv sync --python 3.13
uv run --offline pytest -q --runtime transient
uv run --offline pytest -q --runtime durable
uv run --offline ruff check .
uv run --offline ruff format --check .
uv run --offline mypy
```

For the cross-language runs, from the repository root:

```sh
(cd rust && mise exec -- cargo build -p sdk-scenarios --bin modular-agent-fixtures)
(cd python && MODULAR_AGENT_SDK_REQUIRE=python,rust uv run --offline python -m modular_agent._scenarios)
mkdir -p "$HOME/.cache/ma-std-tmp"
(cd rust && TMPDIR="$HOME/.cache/ma-std-tmp" MODULAR_AGENT_SDK_REQUIRE=python \
  mise exec -- cargo test -p sdk-scenarios --test shared -- --nocapture)
```

The runner accepts optional scenario file paths. It checks all registered fixture programs that have been built. A configured but unbuilt fixture is a failure when its SDK is named in `MODULAR_AGENT_SDK_REQUIRE` or that variable is `all`.

Pydantic generates the schemas. The SDK declares two dependencies the base already installs: `jsonschema` enforces the wire schema before conversion, and `httpx2` streams the API-key Providers' HTTP responses. Mypy is a development dependency. It runs in strict mode on the SDK; imports from the untyped base form the private adapter boundary.

## What is checked

- **Shared scenarios:** 21 passed in the Python runner: seven in process, seven served by Python, seven served by Rust. The Rust runner also reported 21 passes, including all seven served by Python. Both runners use real `SIGKILL` process-group crashes in the crash scenarios. A deliberately wrong text expectation in a temporary copy of `first-turn.json` failed in all three Python-runner placements with the scenario name, step, expected value and actual value.
- **SDK tests:** 23 cases, including four guide tests (stream, scripted prompt, typed tool, served tool), four loopback Provider tests (success and credentials failure for each API), and one prompt through a real ACP client. The remaining 14 cover composition, local actor questions, registration, settings, fork, cancellation, structured tool output, refusal parity and the binding's refusal of an in-process-only registration. The API tests do not contact a model service.
- **Base and SDK:** 327 passed in each of four runs: transient and durable, each with the normal and process base bindings (304 existing tests and 23 SDK tests per run). Ruff lint and formatting passed; strict mypy checked 17 source files. The top-level [Python README](README.md) lists all four commands.

## Built so far

| Milestone | State |
|---|---|
| 1. Compose an Agent | Awaitable or async context manager; project, data directory, three durability modes, model, settings, optional approval, and process and local plugins. History overrides for the shipped stores. General Runtime, environment and credentials overrides are not exposed. |
| 2. Session and turn | Create, reopen, prompt, stream, last turn, history, send, cancel, settings, fork, close. Structured tool values are supported; requesting a structured turn result is not. General event following and history cursors are not exposed. |
| 3. Local actor | `user`; question handler presence, including per-session override; no-handler approval refuses. ACP supplies its own presence. |
| 4. Tools | Type hints or one Pydantic model; schema, exact hints, structured results, cancellation, refusal, questions, progress and log. No leave-open questions or nested tools. The general environment and history context members are not exposed. |
| 5. Errors | `AgentError.code` is an `ErrorCode`; translates known native codes. Untyped base failures can still map to `internal`. |
| 6. Plugins | Setup/config, tools, commands, item replacement, `input`, session start/end, turn before/start/end, step after, tool before/after. General part registration and the remaining hooks are not exposed. |
| 7. Serve | Base stdio transport, same tool result mapper locally and on the wire, questions via `host/ask`, supported hooks and commands, and refusal of flagged items. |
| 8. Process plugins | Uses the base host, including preflight collisions and startup errors. Environment opt-in is explicit or implied by `process_plugins`. |
| 9. Testing | Scripted Provider, `test_agent`, `answers`, four fixture plugins, fixture program and shared runner. Memory working environment, `overWire` and `restart` helpers are not implemented. `test_agent` defaults to a temporary project, as in Rust. |
| 10. Guides | Four offline tests from guides 01–03 (examples needing a real model are not run). |
| 11. Providers | Developer Provider protocol and API-key OpenAI Responses and Anthropic Messages request/response adapters, including SSE text and tool calls. Provider registration in the SDK's `serve` and provider-owned state handling beyond discard are not included. |
| 12. Nested calls | Not implemented. The edition-3 base needs nested lineage, authority checks, distinct records, hide-from-model projection, cancellation/settlement and host callbacks together; adding only the callback would bypass those rules. |
| 13. Declaration and ACP | Declaration reports implemented capabilities; `serve_acp` reuses the base Interface. A real ACP client test checks text and outcome. |
| 14. HTTP history | `http_history(url, token_file)` selects the existing base client. There is no history service implementation in the Python base to wrap for `serve_history`. |

## Where the base and the specification differ

| Difference | Handling |
|---|---|
| The base CLI writes history and installs approval by default. | SDK composition does not call the CLI build. It uses memory history for ephemeral agents and installs approval only when requested. |
| Native tool and approval shapes use private status, hint and policy names. | Adapter uses the base's shared-wire converters. A Python refusal is the reason text in both placements; the Rust base's prefix is not needed by Python. |
| The base treats stateless Providers as repeatable by default. | A developer Provider in the SDK follows its explicit `safe_to_repeat` promise. The SDK Runtimes also refuse to repeat interrupted tools without a separately confirmed environment repeat guarantee. |
| Base durable Runtime restarts queued inputs. | The SDK's built-in durable Runtime hands back inputs not yet taken, then recovers the interrupted turn. |
| Base local paths are not confined and commands require delegated cgroup v2. | SDK resolves and rejects file paths outside the project. Commands keep the existing `strong` containment instead of falling back to weaker cleanup. |
| Base refuses settings changes during a turn and represents text decline internally as `"declined"`. | The SDK advertises `settingsDuringTurn: refused`; a text or choice answer of exactly `declined` still collides with the native sentinel. |
| Base does not implement edition-4 nested calls, and history HTTP is client-only. | Declare `nestedToolCalls: false`; delegate HTTP history to the base client without claiming a service. |

## Findings for the SDK specification

1. **[`api.md`, Building an agent](../docs/sdk/api.md#building-an-agent) and [`placement.md`, Durability](../docs/sdk/placement.md#durability): persistent store without `dataDir`.** The milestone asks for `invalid_composition` without `dataDir`; Placement permits another persistent store. The command environment also needs somewhere to find its cleanup journal after a restart. Proposed replacement: “`kept` and `durable` require `dataDir` for local recovery bookkeeping, even when an explicit persistent history store keeps the entries elsewhere. A composition with no local durable bookkeeping MAY omit `dataDir` if all its persistent parts have storage elsewhere.”
2. **[`api.md`, The declaration](../docs/sdk/api.md#the-declaration): some values are capabilities, not constants.** The base has strong containment, refuses setting changes during turns, and does not support nested calls. Memory erasure is outside this milestone. Proposed table values: “`commandContainment`: the active environment's containment”; “`settingsDuringTurn`: `nextTurn` or `refused`, as declared by the Runtime and host”; “`nestedToolCalls`: true only if the host and Runtime both support nested calls in the chosen placement”; “`erasure`: true only if the active history store implements erasure.”
3. **[`api.md`, Contexts and Questions](../docs/sdk/api.md#contexts): time unit and decline.** Python uses `wait` in seconds, while the binding uses integer milliseconds; `declined` is also valid text. Proposed text: “Python `wait` is a finite, nonnegative number of seconds; for the wire the SDK converts it to integer milliseconds. A decline is a tagged answer, not a reserved string value. A text answer of `declined` remains a value.” The latter needs a native question-record change in Python.
4. **[`api.md`, Hooks](../docs/sdk/api.md#hooks): step termination and transform shape.** The binding calls `step.after` a gate; refusal ends the turn, and `tool.after` transforms the full wire payload. Proposed text: “`step.after`'s `end(reason)` is the binding gate refusal and ends the turn with a failed outcome. A `tool.after` `change({ content?, value? })` is serialized as a full wire transform with the enclosing scope, call and all other result fields unchanged.”
5. **[`testing.md`, The testing kit](../docs/sdk/testing.md#the-testing-kit): unexpected answers.** `answers` raises when exhausted, but the normal question policy catches handler exceptions as declines, so this alone cannot fail a test. Proposed text: “`answers(list)` raises if exhausted; the agent treats that question as declined. To assert that no extra questions were asked, use the helper's assertion at the end of the test.” The assertion helper is not yet exposed.
6. **[`testing.md`, The model script](../docs/sdk/testing.md#the-model-script): counting failed or compacted model messages.** Indexing counts the messages actually offered in the request; it is not the number of prior attempts. Proposed text: “Only messages present in the final ModelRequest count. Failed attempts omitted from context and responses dropped by compaction do not advance the index. Use a literal script without compaction to check successive answers.”
7. **[`guides/01`, Ask a question](../docs/sdk/guides/01-first-agent.md#ask-a-question): the illustrative model must be offered.** Python validates `model` against the Provider's configured catalog at startup. Proposed replacement in the Python example: `async with create_agent(providers=[openai(models=["gpt-6-luna"])], model="openai/gpt-6-luna") as agent:`. Treat the model id as a placeholder, not a claim of availability.
8. **[`guides/03`, Load it into an agent](../docs/sdk/guides/03-tool-in-another-process.md#load-it-into-an-agent): no Python load example.** The serve example runs verbatim, but the three load examples omit Python. Proposed example: `agent = await create_agent(providers=[openai()], process_plugins=[ProcessPlugin(["/srv/tides/.venv/bin/python", "/srv/tides/tides.py"])])` (import `ProcessPlugin` from `modular_agent`).

9. **[`languages.md`, Python](../docs/sdk/languages.md#python): distinguish object attributes from wire records.** The SDK uses snake case for Python objects and preserves the shared field names in raw history, hooks and Provider request/response dictionaries. Proposed text: “Python attributes and keyword arguments use `snake_case`. A dictionary explicitly representing shared wire data uses the shared names; passing or returning it does not rename its keys.”

Proposed shared scenarios: **queued-input-after-crash** (a held tool from the first input; queue a second input, crash, reopen and verify the second is handed back); **decline-is-not-text** (ask a text question twice, answer once with the string `declined` and once with a tagged decline, and check distinct tool results in every placement); **tool-refusal-parity** (run a fixture tool that calls `refuse`, and compare its status and reason in every placement).

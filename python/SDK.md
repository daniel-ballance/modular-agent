# modular-agent: the Python SDK

The Python SDK implements the embedded and ACP slices of [SDK draft 0.1](../docs/sdk/README.md) over the Python build, including the edition-4 draft's nested-call binding. Applications import `modular_agent`; they do not need to import the Harness or its plugins. The `modular-agent` console script and `python -m modular_agent` still run the base CLI. Its composition is now in `ma_cli`.

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
uv run --offline pytest -q --runtime transient --binding process
uv run --offline pytest -q --runtime durable --binding process
uv run --offline ruff check .
uv run --offline ruff format --check .
uv run --offline mypy
```

For the cross-language runs, from the repository root:

```sh
(cd rust && mise exec -- cargo build -p sdk-scenarios --bin modular-agent-fixtures)
(cd go && mise exec -- go build -o .bin/modular-agent-fixtures ./modular/cmd/fixtures)
(cd typescript && npm ci && npm run build)
(cd python && MODULAR_AGENT_SDK_REQUIRE=python uv run --offline python -m modular_agent._scenarios)
mkdir -p "$HOME/.cache/ma-std-tmp"
(cd rust && TMPDIR="$HOME/.cache/ma-std-tmp" MODULAR_AGENT_SDK_REQUIRE=python \
  mise exec -- cargo test -p sdk-scenarios --test shared -- --nocapture)
```

The runner accepts optional scenario file paths. It checks all registered fixture programs that have been built. A configured but unbuilt fixture is a failure when its SDK is named in `MODULAR_AGENT_SDK_REQUIRE` or that variable is `all`.

Pydantic generates the schemas. The SDK declares two dependencies the base already installs: `jsonschema` enforces the wire schema before conversion, and `httpx2` streams the API-key Providers' HTTP responses. Mypy is a development dependency. It runs in strict mode on the SDK; imports from the untyped base form the private adapter boundary.

## What is checked

- **Shared scenarios:** 49/55 passed with the Python runner: 11/11 in process, 11/11 served by Python, 9/11 each served by Go, Rust and TypeScript. All 35 original-matrix runs passed. The six failures are the missing `quay` and `pilot` fixtures in the other programs. Both runners kill the agent's process group and wait for it to stop in the crash scenarios.
- **Rust runner:** 43 scenario passes, including all 28 original scenarios across the four served placements and 10/11 total served by Python. Rust executes the Python `pilot` successfully, but this checkout's Rust SDK reports both the parent's and child's results in `PromptResult.toolResults`. Six other served failures lack the new fixtures. The Rust in-process run passed its first six scenarios, then panicked on missing `pilot` and did not run its last four.
- **ACP:** 116/116 checks in each of transient and durable, normal and process binding, including 11 nested-call checks. The split-plugin variant passed 121/121 checks for each Runtime. Pytest also runs the crash and job variants.
- **Plugin:** 146/146 checks, including `nest` and directory listing. One earlier run of the background-process checks was timing-sensitive.
- **History service:** 42/42 checks with `--restart-ttl` from 6 seconds to 1 second, covering record survival and old-lease exclusion. `serve_history(file_history(directory), address=("127.0.0.1", 39071), token_file=token)` uses a dedicated SQLite database; do not point the kit at real data. No model services or real credentials were used.
- **Base and SDK:** 336 cases per configuration (including nine new SDK cases). Full runs: transient normal 336 passed; durable normal 335 passed, one process-bootstrap cancellation timeout; transient process 334 passed, one foreign-job timeout and one tool-ordering failure; durable process 334 passed, one process-bootstrap cancellation timeout and one tool-ordering failure. The registration check responsible for the ordering failure was moved to the Harness and all three ordering cases then passed in both process configurations. Targeted reruns including the bootstrap test passed 13/13 for durable; the transient foreign-job case still timed out (12/13 passed). Ruff lint and format passed; strict mypy checked 18 source files.

## Built so far

| Milestone | State |
|---|---|
| 1. Compose an Agent | Awaitable or async context manager; project, data directory, three durability modes, model, settings, optional approval, and process and local plugins. History overrides for the shipped stores and a memory environment override. General Runtime and credentials constructors are not exposed. |
| 2. Session and turn | Create, reopen, prompt, stream, last turn, history, send, cancel, settings, fork, close. `prompt(..., result=schema)` checks a final JSON value, with feedback and retry. `events(from_entry)` replays kept entries and follows live events, with `lost` and the last delivered entry cursor on lag. |
| 3. Local actor | `user`; question handler presence, including per-session override; no-handler approval refuses. ACP supplies its own presence. |
| 4. Tools | Type hints or one Pydantic model; schema, exact hints, structured results, cancellation, refusal, questions, progress, log and nested tools. No leave-open questions from SDK tools. The general environment and history context members are not exposed. |
| 5. Errors | `AgentError.code` is an `ErrorCode`; translates known native codes. Untyped base failures can still map to `internal`. |
| 6. Plugins | Setup/config, tools, commands, item replacement, `input`, session start/end, turn before/start/end, step after, tool before/after. General part registration and the remaining hooks are not exposed. |
| 7. Serve | Base stdio transport, same tool result mapper locally and on the wire, questions via `host/ask`, supported hooks and commands, and refusal of flagged items. |
| 8. Process plugins | Uses the base host, including preflight collisions and startup errors. Environment opt-in is explicit or implied by `process_plugins`. |
| 9. Testing | Scripted Provider, `test_agent`, `answers(...).assert_done()`, six fixtures, fixture program and shared runner. `test_agent` defaults to a memory environment and temporary project. `over_wire` runs a plugin over a socket pair through the real binding. `restart` interrupts tracked work and rebuilds on the same store, with no graceful plugin stops; it does not simulate detached work or child-process cleanup. |
| 10. Guides | Four offline tests from guides 01–03 (examples needing a real model are not run). |
| 11. Providers | Developer Provider protocol and API-key OpenAI Responses and Anthropic Messages request/response adapters, including SSE text and tool calls. Provider registration in the SDK's `serve` and provider-owned state handling beyond discard are not included. |
| 12. Nested calls | `cx.tools.list()` and `cx.tools.call(name, input)` in process and over stdio. Four levels including the outer call. Children are committed separately, not sent to the model, and settled without redispatch on recovery. `modelTools` narrows only the model's offer. A Runtime hosted over the public plugin binding does not declare nesting. |
| 13. Declaration and ACP | Reports selected-part capabilities. `serve_acp` reuses the base Interface; load/resume installs recovery without waiting for execution. A nested call's first ACP update carries its parent ID. |
| 14. HTTP history | `http_history(url, token_file)` selects the client. `serve_history` serves opaque records in a dedicated SQLite database under the file store directory; does not import existing native history. Memory and client-backed stores are ineligible. Serves numeric loopback only; no retention, replication or TLS termination. |

## Where the base and the specification differ

| Difference | Handling |
|---|---|
| The base CLI writes history and installs approval by default. | SDK composition does not call the CLI build. It uses memory history for ephemeral agents and installs approval only when requested. |
| Native tool and approval shapes use private status, hint and policy names. | Adapter uses the base's shared-wire converters. A Python refusal is the reason text in both placements; the Rust base's prefix is not needed by Python. |
| The base treats stateless Providers as repeatable by default. | A developer Provider in the SDK follows its explicit `safe_to_repeat` promise. The SDK Runtimes also refuse to repeat interrupted tools without a separately confirmed environment repeat guarantee. |
| Base durable Runtime restarts queued inputs. | The SDK's built-in durable Runtime hands back inputs not yet taken, then recovers the interrupted turn. |
| Local paths are not confined and commands require delegated cgroup v2. | Report unconfined files and strong command containment: an unavailable cgroup makes commands fail rather than fall back to weaker cleanup. The memory environment has confined files and declares no command containment. |
| Base refuses settings changes during a turn and represents text decline internally as `"declined"`. | The SDK advertises `settingsDuringTurn: refused`; a text or choice answer of exactly `declined` still collides with the native sentinel. |
| Base's in-process and private-process Runtimes support nested execution; public wire Runtime placement does not. | Declare `nestedToolCalls` only with the checked dispatch path. Public wire **tools** can nest when that path is present. |

## Findings for the SDK specification

1. **Resolved in round 2.** **[`api.md`, Building an agent](../docs/sdk/api.md#building-an-agent) and [`placement.md`, Durability](../docs/sdk/placement.md#durability): persistent store without `dataDir`.** The milestone asks for `invalid_composition` without `dataDir`; Placement permits another persistent store. The command environment also needs somewhere to find its cleanup journal after a restart. Proposed replacement: “`kept` and `durable` require `dataDir` for local recovery bookkeeping, even when an explicit persistent history store keeps the entries elsewhere. A composition with no local durable bookkeeping MAY omit `dataDir` if all its persistent parts have storage elsewhere.”
2. **Resolved in round 2.** **[`api.md`, The declaration](../docs/sdk/api.md#the-declaration): some values are capabilities, not constants.** The base has strong containment, refuses setting changes during turns, and does not support nested calls. Memory erasure is outside this milestone. Proposed table values: “`commandContainment`: the active environment's containment”; “`settingsDuringTurn`: `nextTurn` or `refused`, as declared by the Runtime and host”; “`nestedToolCalls`: true only if the host and Runtime both support nested calls in the chosen placement”; “`erasure`: true only if the active history store implements erasure.”
3. **Specification resolved in round 2; Python still has the native decline sentinel.** **[`api.md`, Contexts and Questions](../docs/sdk/api.md#contexts): time unit and decline.** Python uses `wait` in seconds, while the binding uses integer milliseconds; `declined` is also valid text. Proposed text: “Python `wait` is a finite, nonnegative number of seconds; for the wire the SDK converts it to integer milliseconds. A decline is a tagged answer, not a reserved string value. A text answer of `declined` remains a value.” The latter needs a native question-record change in Python.
4. **Resolved in round 2.** **[`api.md`, Hooks](../docs/sdk/api.md#hooks): step termination and transform shape.** The binding calls `step.after` a gate; refusal ends the turn, and `tool.after` transforms the full wire payload. Proposed text: “`step.after`'s `end(reason)` is the binding gate refusal and ends the turn with a failed outcome. A `tool.after` `change({ content?, value? })` is serialized as a full wire transform with the enclosing scope, call and all other result fields unchanged.”
5. **Resolved in round 2.** **[`testing.md`, The testing kit](../docs/sdk/testing.md#the-testing-kit): unexpected answers.** `answers` raises when exhausted, but the normal question policy catches handler exceptions as declines, so this alone cannot fail a test. Proposed text: “`answers(list)` raises if exhausted; the agent treats that question as declined. To assert that no extra questions were asked, use the helper's assertion at the end of the test.” The assertion helper is not yet exposed.
6. **Resolved in round 2.** **[`testing.md`, The model script](../docs/sdk/testing.md#the-model-script): counting failed or compacted model messages.** Indexing counts the messages actually offered in the request; it is not the number of prior attempts. Proposed text: “Only messages present in the final ModelRequest count. Failed attempts omitted from context and responses dropped by compaction do not advance the index. Use a literal script without compaction to check successive answers.”
7. **Resolved in round 2.** **[`guides/01`, Ask a question](../docs/sdk/guides/01-first-agent.md#ask-a-question): the illustrative model must be offered.** Python validates `model` against the Provider's configured catalog at startup. Proposed replacement in the Python example: `async with create_agent(providers=[openai(models=["gpt-6-luna"])], model="openai/gpt-6-luna") as agent:`. Treat the model id as a placeholder, not a claim of availability.
8. **Resolved in round 2.** **[`guides/03`, Load it into an agent](../docs/sdk/guides/03-tool-in-another-process.md#load-it-into-an-agent): no Python load example.** The serve example runs verbatim, but the three load examples omit Python. Proposed example: `agent = await create_agent(providers=[openai()], process_plugins=[ProcessPlugin(["/srv/tides/.venv/bin/python", "/srv/tides/tides.py"])])` (import `ProcessPlugin` from `modular_agent`).

9. **Resolved in round 2.** **[`languages.md`, Python](../docs/sdk/languages.md#python): distinguish object attributes from wire records.** The SDK uses snake case for Python objects and preserves the shared field names in raw history, hooks and Provider request/response dictionaries. Proposed text: “Python attributes and keyword arguments use `snake_case`. A dictionary explicitly representing shared wire data uses the shared names; passing or returning it does not rename its keys.”

10. **[`placement.md`, Services](../docs/sdk/placement.md#services): native storage versus the opaque record backend.** Proposed addition after the eligibility sentence: “A file-store constructor may select a dedicated opaque-record namespace for `serveHistory`. `serveHistory` does not imply that an existing native store can be exported live. Document which namespace the server uses and whether it can open existing native sessions.” This avoids confusing co-located files with shared lease state.

Proposed shared scenarios: **queued-input-after-crash** (a held tool from the first input; queue a second input, crash, reopen and verify the second is handed back); **decline-is-not-text** (ask a text question twice, answer once with the string `declined` and once with a tagged decline, and check distinct tool results in every placement); **tool-refusal-parity** (run a fixture tool that calls `refuse`, and compare its status and reason in every placement).

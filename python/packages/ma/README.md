# ma — Python standard configuration

`ma` is the Python implementation of the [standard configuration](../../../docs/reference/standard-configuration.md). Its package is `modular-agent-standard`. It uses the public `modular_agent` SDK and its official plugins.

## Build, install and run

From the repository root:

```sh
cd python
uv sync --python 3.13
.venv/bin/ma --version
.venv/bin/ma --help
```

`uv sync` installs `ma` in `python/.venv/bin`. Add that directory to `PATH`, or give the ACP host the absolute path to the executable. To build distribution files, run `uv build --package modular-agent-standard` from `python/`; the package needs the matching SDK distribution.

From a project folder, run `ma` for line mode, `ma -p 'Describe this project'` for one turn, or `ma --acp` for an ACP host. `ma -c` continues the most recently active session in that folder. Use `--runtime transient` to keep history without resuming a turn interrupted by a crash. Use `ma auth` or `ma login PROVIDER` to manage sign-ins. `ma --trust-project` records trust for the canonical project folder; only trusted projects can start servers configured in `.mcp.json`. Project session defaults never start plugins.

The configuration folder is shared across languages; sessions live under `$XDG_STATE_HOME/modular-agent/python` (or `~/.local/state/modular-agent/python`). With `MODULAR_AGENT_DATA_DIR` set, configuration goes directly in it and state goes under `state/`. New terminal secret answers go in `auth.json` under `answers`; use `/answer REQUEST_ID` without a value for an echo-disabled prompt.

Use `ma login chatgpt` to sign in with a browser or add `--device` for a code. Use `ma login grok` for Grok. `ma login claude` runs Anthropic's own `claude auth login`. Python uses the Claude Agent SDK directly; it does not need a Node sidecar. A metered Claude Code account is not a subscription login.

The Provider ids are `chatgpt`, `grok` and `claude`. `ma` still accepts `openai-codex` and `xai` in `--model`, `login`, `logout`, `settings.json`, `models.json` and saved sessions. On the next write of `auth.json`, it moves logins to their new ids. If both entries exist, it keeps the login under the new id.

## Client identity

By default, ChatGPT requests and browser sign-in use `modular-agent` as the `originator`. Grok device sign-in uses it as the `referrer`. The identity is a label, not a credential. It does not change the services' sign-in client IDs.

Set `MA_CLIENT_IDENTITY=my-agent` in the environment that starts `ma` to use another name. The name must be 1 to 64 characters from `A`–`Z`, `a`–`z`, `0`–`9`, `.`, `_` and `-`. If the variable is set to an invalid name, including an empty string, `ma` reports the error and exits with status 1.

In an agent built on the Python SDK, pass `client_identity` to `modular_agent.chatgpt.chatgpt` and `modular_agent.sign_in`. These options do not read the environment variable. Grok's sign-in and requests remain in `ma`; the SDK does not ship `grok()`.

## Code sandbox

Each `codemode` call checks out a fresh worker process from [Monty 1.6.0's async pool](https://github.com/pydantic/monty/blob/v1.6.0/docs/api/python/pools.md). The interpreter never runs in the agent process. Sandbox code cannot access files, the network, processes, wall clocks, sleep or system entropy. Process and thread clocks read zero. An explicitly seeded generator such as `random.Random(7)` works.

Calls on `tools` go through the agent as nested SDK tool calls. You can call functions by keyword, by position, or with a single dict of named arguments if the first parameter does not take an object. The result starts with printed output and ends with the last expression as text, JSON or `repr`, or with Monty's traceback if the script failed.

Monty's [`max_memory`](https://github.com/pydantic/monty/blob/v1.6.0/docs/resource-limits.md) is 256 MiB of interpreter allocations, not a cap on the worker's total process memory. The active wall-clock limit is 30 seconds between nested tool calls. `ma` reads the worker's cumulative clock at each pause and at the end of the run. Waiting on the host does not count. A separate deadline stops a worker that does not reply. Up to 200 levels of recursion and 500 nested tool calls are allowed. Lookups do not spend the nested-call budget.

When the worker delivers more than 1 MiB of printed output, the call stops and returns `RuntimeError: printed output exceeded 1048576 bytes` followed by the printed UTF-8 prefix. The text result keeps up to 2,000 whole lines or 50 KB before a cut notice. If the traceback does not fit, its last line comes first. A memory or time limit ends the session with `MemoryError` or `TimeoutError`. A worker crash fails the call without replaying it, and cancellation stops the run. The next call starts with a fresh worker and no variables from the previous call.

## What is checked

- **Reference:** 24/24, including client identity validation, sandbox limits, ambient access, tool calls and result rendering.
- **ACP:** 188/188 with `--crash-checks --probe-checks --job-checks`. The standard composition does not declare several actors, tenants or session limits.
- **WebSocket kits:** 153/153 for the plugin binding, 14/14 for separate-listener isolation, and 193/193 for ACP.
- **Python suites:** 617 passed and four live checks skipped in each full Runtime and binding combination (transient/local, transient/process, durable/local and durable/process). The final focused subscription and alias checks passed 47 tests and skipped four live checks in each combination. The sandbox tests cover memory and active time, waiting on the host, worker death, cancellation, the recursion and nested-call limits, ambient access, UTF-8 output and result rendering.
- **Subscriptions:** offline SDK checks cover sign-in, model requests, refresh, reasoning and Claude tools. Product checks cover all former Provider id entry points, including sessions saved before the rename.
- **Python static checks:** Ruff lint and format checks passed; strict mypy passed.

```sh
# From the repository root, after uv sync above:
npm ci --prefix conformance/acp
npm ci --prefix conformance/tools
node conformance/reference/run.mjs --agent python
MODULAR_AGENT_CONFORMANCE=1 node conformance/acp/run.mjs --crash-checks --probe-checks --job-checks -- "$PWD/python/.venv/bin/ma" --acp
scripts/websocket-kits.sh python
cd python
uv run --offline pytest -q --runtime transient
uv run --offline pytest -q --runtime durable
uv run --offline pytest -q --runtime transient --binding process
uv run --offline pytest -q --runtime durable --binding process
uv run --offline ruff check .
uv run --offline ruff format --check .
uv run --offline mypy
```

See the [SDK README](../../SDK.md) for fixture build commands and SDK scenario results. If running Python suites concurrently, give each a separate writable delegated `MA_CGROUP_ROOT` so containment recovery in one suite does not clean up another suite's deliberate crash.

## Known gaps

- The local environment does not confine paths. Strong command containment requires a writable, delegated Linux cgroup v2 subtree. Without it, `ma` declares `processGroup`, which cannot stop descendants that leave the group. The terminal and local tool environment are for POSIX systems.
- Some file and MCP errors still differ from the Rust wording. The file search uses Git enumeration or `find` plus Python glob matching; it does not support every Rust glob extension. Monty requires a finite suspension ceiling, separate from the 500 nested-call budget; Python sets it to 2,147,483,647 so lookups do not spend that budget.
- Terminal secret answers use the SDK's staged credential store. ACP does not accept secret answers. Served tools have byte, directory and command callbacks; served commands do not have working-environment access.
- No real sign-ins or model requests were made. The new Claude Provider was tested with Python Agent SDK message fixtures.

## Served Runtime findings

The base ACP Interface forwarded proposed input, actor joins, limit changes and tenant queries to the underlying APIs despite the SDK's session declaration. The bound handlers now use that declaration to return `not_supported`. They still allow `proposals`, `release` and `withdraw` for parked job reports. This change does not touch served Runtime composition or the Provider callback.


The Python SDK rejected the transient Runtime fixtures after registration because their recovery declaration differed from the default `durable` composition. Offline ACP conformance now allows the registered Runtime to determine recovery with persistent history; normal SDK durability validation still applies outside that profile. The two `step.after` probes actually failed at `session/new`, not at recovery: the fixture's Provider made the catalog contain more than one model, so automatic single-model selection left ACP without a current model. `ma` now selects `conformance/echo` by default in that profile and still allows the host to select a fixture Provider.

Suggested text. No shared specification documents were changed.

- **Reference, Checks** — replace the ACP-kit bullet with: “the ACP kit against `MODULAR_AGENT_CONFORMANCE=1 ma --acp` with `--crash-checks --probe-checks --job-checks`, including refusal of operations disabled by the session declaration;”

The newly reachable Provider check also found that Python accepted an unknown `provider.response` payload member but inserted an absent `model` into the recorded assistant message. The bridge now leaves that field absent unless it needs trusted provenance to replay opaque Provider data. When it binds provenance, it uses the associated request's model, not the Provider's claimed identity.

## Findings for the shared docs

Suggested replacement text. No shared documents were changed.

- **Reference, Rules for every implementation** — replace “One language” with: “Use the implementation language and its SDK. Rust and Go reach Claude through the TypeScript Agent SDK sidecar. Python and TypeScript use Anthropic's Agent SDK for their own language.”
- **Reference, Providers** — replace “These are the SDK's subscription Providers” through “`ma` adds none of its own” with: “ChatGPT and Claude use the SDK's subscription Providers. Until the SDK specifies Grok sign-in and requests, `ma` keeps its current Grok code under `grok`.” Replace “The Claude Provider is the sidecar” with: “The Claude Provider uses the SDK's language-specific Claude adapter.”
- **Reference, Files** — replace the `models.json` description with: “Catalog additions or replacements. ChatGPT entries use `id`, `contextWindow` and `maxTokens`, and may specify `input`. Shared ChatGPT reasoning mappings cannot be changed by this file. Grok keeps its existing `effort` mapping.”

- **SDK, Durability** — replace the last invalid-composition bullet with: “a Runtime that does not declare `continuesAfterRestart` under `durable`, except in the offline ACP conformance profile when a fixture explicitly replaces the Runtime over the plugin binding and history is persistent. In that case the registered Runtime determines recovery and its declaration.”
- **ACP, Conformance mode** — replace the first sentence with: “With `MODULAR_AGENT_CONFORMANCE=1` the agent MUST offer the fixture model `conformance/echo` and fixture tools `bash` (`{ command: string }`) and `read` (`{ path: string }`). Use `conformance/echo` when no model was explicitly selected, even when a served fixture adds a Provider.”
- **Plugin binding, The host asks a Provider** — replace the sentence beginning “It MUST compare that response” with: “The host MUST compare that response with the final result before canonicalizing call IDs and fail an inconsistent attempt without dispatching its calls. An omitted assistant `model` stays omitted unless trusted model attribution is needed to replay opaque Provider data. Any `model` attribution MUST use the associated request's model.”
- **Reference, What it declares** — replace the `commandContainment` value cell with: “`strong` when the local environment can stop every descendant of a command; `processGroup` when only the command's process group is contained.” Linux alone does not guarantee delegated cgroup access.
- **SDK, The agent** — replace the `compose(project)` clause with: “`compose(project, reopening?)` builds an Agent for a canonical project. On reopening, pass the saved session id so the factory can choose the Provider before opening it. The Interface uses the serving Agent's history to find saved sessions; agents returned by the factory must use the same persistent history when they serve those sessions.” Python takes the optional reopening factory as `compose_reopen(project, id)`.
- **SDK, Contexts** — replace the environment row's Over the wire cell with: “Yes for tools; in process only for commands until the plugin binding gives a served command's context its canonical project or defaults `host/env/*` to it. An ignore-aware file walk is in process only.”

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

Build the [Claude sidecar](../../../typescript/sidecars/claude/README.md) with Node 22 or newer. `ma` looks for it in a development checkout, at `~/.local/share/modular-agent/sidecars/claude/dist/main.js`, or at `MODULAR_AGENT_CLAUDE_SIDECAR`. `ma login claude` uses the installed `claude` program. ACP selects a composition for the client’s project; it does not start the Claude sidecar for sessions that select another Provider.

## Code sandbox

Each `codemode` call checks out a fresh worker process from [Monty 1.6.0's async pool](https://github.com/pydantic/monty/blob/v1.6.0/docs/api/python/pools.md). The interpreter never runs in the agent process. Sandbox code cannot access files, the network, processes, wall clocks, sleep or system entropy. An explicitly seeded generator such as `random.Random(7)` works.

Calls on `tools` go through the agent as nested SDK tool calls. You can call functions by keyword, by position, or with a single dict of named arguments if the first parameter does not take an object. The result starts with printed output and ends with the last expression as text, JSON or `repr`, or with Monty's traceback if the script failed.

Monty's [`max_memory`](https://github.com/pydantic/monty/blob/v1.6.0/docs/resource-limits.md) is 256 MiB of interpreter allocations, not a cap on the worker's total process memory. The active wall-clock limit is 30 seconds between host round trips. Waiting on the host does not count. Monty restarts this clock on every resume, not just after nested tools. Up to 200 levels of recursion and 500 nested tool calls are allowed. Lookups do not spend the nested-call budget.

When the worker delivers more than 1 MiB of printed output, the call stops and returns `RuntimeError: printed output exceeded 1048576 bytes` followed by the printed UTF-8 prefix. The whole text result is cut to 2,000 lines or 50 KB. A memory or time limit ends the session with `MemoryError` or `TimeoutError`. A worker crash fails the call without replaying it, and cancellation stops the run. The next call starts with a fresh worker and no variables from the previous call.

## What is checked

- **Reference:** 22/22, including sandbox limits, ambient access, tool calls and result rendering.
- **ACP:** 188/188 with `--crash-checks --probe-checks --job-checks`. The standard composition does not declare several actors, tenants or session limits.
- **WebSocket kits:** 153/153 for the plugin binding and 193/193 for ACP.
- **Python suites:** 537 passed and 2 live tests skipped in each Runtime and binding combination (transient/local, transient/process, durable/local and durable/process). The sandbox tests cover memory and active time, waiting on the host, worker death, cancellation, the recursion and nested-call limits, ambient access, UTF-8 output and result rendering.
- **Python static checks:** Ruff lint and format checks passed; strict mypy passed (38 source files).

```sh
# From the repository root, after uv sync above:
npm ci --prefix conformance/acp
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
- The terminal stores secret answers before recording their credential names. The SDK does not yet provide the staged credential-store recovery protocol; a crash between these two writes can leave an unused answer in `auth.json`. ACP does not accept secret answers. Served tools have byte, directory and command callbacks; served commands do not have working-environment access.
- Real services were not tested. The earlier Claude test used the sidecar’s fake SDK; the new ACP project tests use the SDK's scripted Provider.

## Served Runtime findings

The base ACP Interface forwarded proposed input, actor joins, limit changes and tenant queries to the underlying APIs despite the SDK's session declaration. The bound handlers now use that declaration to return `not_supported`. They still allow `proposals`, `release` and `withdraw` for parked job reports. This change does not touch served Runtime composition or the Provider callback.


The Python SDK rejected the transient Runtime fixtures after registration because their recovery declaration differed from the default `durable` composition. Offline ACP conformance now allows the registered Runtime to determine recovery with persistent history; normal SDK durability validation still applies outside that profile. The two `step.after` probes actually failed at `session/new`, not at recovery: the fixture's Provider made the catalog contain more than one model, so automatic single-model selection left ACP without a current model. `ma` now selects `conformance/echo` by default in that profile and still allows the host to select a fixture Provider.

Suggested text. No shared specification documents were changed.

- **Reference, Checks** — replace the ACP-kit bullet with: “the ACP kit against `MODULAR_AGENT_CONFORMANCE=1 ma --acp` with `--crash-checks --probe-checks --job-checks`, including refusal of operations disabled by the session declaration;”

The newly reachable Provider check also found that Python accepted an unknown `provider.response` payload member but inserted an absent `model` into the recorded assistant message. The bridge now leaves that field absent unless it needs trusted provenance to replay opaque Provider data. When it binds provenance, it uses the associated request's model, not the Provider's claimed identity.

## Findings for the shared docs

Suggested replacement text. No shared documents were changed.

- **SDK, Durability** — replace the last invalid-composition bullet with: “a Runtime that does not declare `continuesAfterRestart` under `durable`, except in the offline ACP conformance profile when a fixture explicitly replaces the Runtime over the plugin binding and history is persistent. In that case the registered Runtime determines recovery and its declaration.”
- **ACP, Conformance mode** — replace the first sentence with: “With `MODULAR_AGENT_CONFORMANCE=1` the agent MUST offer the fixture model `conformance/echo` and fixture tools `bash` (`{ command: string }`) and `read` (`{ path: string }`). Use `conformance/echo` when no model was explicitly selected, even when a served fixture adds a Provider.”
- **Plugin binding, The host asks a Provider** — replace the sentence beginning “It MUST compare that response” with: “The host MUST compare that response with the final result before canonicalizing call IDs and fail an inconsistent attempt without dispatching its calls. An omitted assistant `model` stays omitted unless trusted model attribution is needed to replay opaque Provider data. Any `model` attribution MUST use the associated request's model.”
- **Reference, What it declares** — replace the `commandContainment` value cell with: “`strong` when the local environment can stop every descendant of a command; `processGroup` when only the command's process group is contained.” Linux alone does not guarantee delegated cgroup access.
- **Reference, Tools (arguments)** — in the arguments bullet, replace the first sentence with: “Arguments go by keyword or position. Positional arguments follow the JSON Schema's `required` array, then the remaining property names in lexicographic order.” Rust sorts optional names. The current text reads as declaration order, which Python preserves, but JSON objects do not define a portable member order.
- **Reference, Tools (time limit)** — replace the first sentence of the Limits bullet with: “Limits: 30 seconds of interpreter wall time between host round trips. Waiting for a tool, an import, a name lookup, `describe_tool` or `search_tools` does not count. The budget restarts on every resume from a host round trip.” Monty 1.6.0 exposes a feed clock and a turn clock. The feed clock does not restart after tools. The turn clock restarts after all host round trips. Neither can restart only after nested tools.
- **Reference, Tools (printed output)** — replace the printed-output sentence with: “1 MiB of printed output: when the worker delivers output past the limit, the host stops the run before dispatching any further nested tool call. The result starts with `RuntimeError: printed output exceeded 1048576 bytes`, then the output up to the limit, cut at a UTF-8 character boundary.” Monty buffers output even with line buffering, so the host cannot stop the run at the exact instruction that crosses the limit.
- **Reference, Tools (entropy)** — replace the ambient access bullet with: “The sandbox has no file, network or process access, no wall clock, no sleep and no system entropy: `open`, `time.time()`, `time.sleep()` and random operations that request system entropy raise. Creating `random.Random()` without a seed can succeed because it requests entropy only when first used. A generator the code seeds itself, such as `random.Random(7)`, works.”
- **Reference, Tools (images)** — add to the result bullet: “An image dict, such as one returned by `tools.read`, is sent as image content if it is the last value or an element of a final list or tuple.” This preserves the existing way the model can see a read image.
- **SDK, The agent** — replace the `compose(project)` clause with: “`compose(project, reopening?)` builds an Agent for a canonical project. On reopening, pass the saved session id so the factory can choose the Provider before opening it. The Interface uses the serving Agent's history to find saved sessions; agents returned by the factory must use the same persistent history when they serve those sessions.” Python takes the optional reopening factory as `compose_reopen(project, id)`.
- **SDK, Contexts** — replace the environment row's Over the wire cell with: “Yes for tools; in process only for commands until the plugin binding gives a served command's context its canonical project or defaults `host/env/*` to it. An ignore-aware file walk is in process only.”

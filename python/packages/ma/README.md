# ma — Python standard configuration

`ma` is the Python implementation of the [standard configuration](../../../docs/reference/standard-configuration.md). Its package is `modular-agent-standard`. It uses the public `modular_agent` SDK and its official plugins. Monty runs each code call in a fresh worker; it reaches the working environment only through nested SDK tool calls.

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

## What is checked

- **Reference:** 15/15, including the declaration, crash recovery, the prompt tail and SDK-shaped JSON events.
- **ACP:** 87/87 default, 94/94 with `--crash-checks`, 111/111 with `--crash-checks --job-checks`. With `--probe-checks` added, 158/162 passed, including all six late-question checks. The four failures are optional remote Runtime probes (see Known gaps). These runs use the standard declaration; actor, tenant and session-limit cases are not enabled.
- **Python ma and SDK revisions:** 29/29 focused tests, including loopback browser and device sign-in, concurrent token refresh, encrypted reasoning replay and isolation on Provider switch, the shared `auth.json` format, Monty limits, project trust and multi-project ACP, SDK environment callbacks in process and over the wire, and late answers. No real sign-in, credentials or model calls were used.
- **SDK scenarios:** 55/55: 11 in process and 11 each through the built Python, Rust, Go and TypeScript fixture programs.
- **Python suites:** 365/365 in each of the four runs: transient and durable, with the local binding and with the process binding.
- **Python static checks:** Ruff lint and format checks passed; strict mypy passed (30 source files).

```sh
# From the repository root, after uv sync above:
npm ci --prefix conformance/acp
node conformance/reference/run.mjs --agent python
MODULAR_AGENT_CONFORMANCE=1 node conformance/acp/run.mjs -- "$PWD/python/.venv/bin/ma" --acp
MODULAR_AGENT_CONFORMANCE=1 node conformance/acp/run.mjs --crash-checks --job-checks -- "$PWD/python/.venv/bin/ma" --acp
cd python
uv run --offline pytest -q --runtime transient
uv run --offline pytest -q --runtime durable
uv run --offline pytest -q --runtime transient --binding process
uv run --offline pytest -q --runtime durable --binding process
uv run --offline ruff check .
uv run --offline ruff format --check .
uv run --offline mypy
```

See the [SDK README](../../SDK.md) for fixture build commands. Process-binding tests include the base's intermittent `test_foreign_job_report_runs_as_a_turn`.

## Known gaps

- The local environment does not confine paths. Strong command containment requires a writable, delegated Linux cgroup v2 subtree. Without it, `ma` declares `processGroup`, which cannot stop descendants that leave the group. The terminal and local tool environment are for POSIX systems.
- Some file and MCP errors still differ from the Rust wording. The file search uses Git enumeration or `find` plus Python glob matching; it does not support every Rust glob extension. Monty requires a finite suspension ceiling, separate from the 500 nested-call budget; Python sets it to 2,147,483,647 so lookups do not spend that budget.
- The terminal stores secret answers before recording their credential names. The SDK does not yet provide the staged credential-store recovery protocol; a crash between these two writes can leave an unused answer in `auth.json`. ACP does not accept secret answers. Served tools have byte, directory and command callbacks; served commands do not have working-environment access.
- The optional ACP remote Runtime probes are not all supported by `ma`: the two transient replacement probes conflict with the default durable composition; the two `step.after` crash probes fail to load their interrupted fixture sessions. The standard local Runtime crash checks, late answers and recovered job reports pass.
- Real services were not tested. The earlier Claude test used the sidecar’s fake SDK; the new ACP project tests use the SDK's scripted Provider.

## Findings for docs/reference and docs/sdk

Suggested text. No shared documents were changed.

- **Reference, What it declares** — replace the `commandContainment` value cell with: “`strong` when the local environment can stop every descendant of a command; `processGroup` when only the command's process group is contained.” Linux alone does not guarantee delegated cgroup access.
- **Reference, Tools** — replace the first sandbox rule with: “Arguments go by keyword or position. Positional arguments follow the JSON Schema's `required` array, then the remaining property names in lexicographic order. Passing `None` omits an argument.” Rust sorts optional names. The revised text reads as declaration order, which Python preserves, but JSON objects do not define a portable member order.
- **SDK, The agent** — replace the `compose(project)` clause with: “`compose(project, reopening?)` builds an Agent for a canonical project. On reopening, pass the saved session id so the factory can choose the Provider before opening it. The Interface uses the serving Agent's history to find saved sessions; agents returned by the factory must use the same persistent history when they serve those sessions.” Python takes the optional reopening factory as `compose_reopen(project, id)`.
- **SDK, Contexts** — replace the environment row's Over the wire cell with: “Yes for tools; in process only for commands until the plugin binding gives a served command's context its canonical project or defaults `host/env/*` to it. An ignore-aware file walk is in process only.”

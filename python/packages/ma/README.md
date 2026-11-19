# ma — Python standard configuration

`ma` is the Python implementation of the [standard configuration](../../../docs/reference/standard-configuration.md). Its package is `modular-agent-standard`. It builds on `modular_agent`, not on the base CLI or Harness. Monty runs each code call in a fresh worker; only nested SDK tool calls can reach the working environment.

## Build, install and run

From the repository root:

```sh
cd python
uv sync --python 3.13
.venv/bin/ma --version
.venv/bin/ma --help
```

`uv sync` installs `ma` in `python/.venv/bin`. Use that executable by absolute path outside the checkout, or add that directory to your `PATH`. To build distribution files, run `uv build --package modular-agent-standard` in `python/`; the package depends on the matching SDK distribution.

From a project folder, run `ma` for line mode, `ma -p 'Describe this project'` for one turn, or `ma --acp` for an ACP host. `ma -c` continues the most recently active session in the folder. Use `--runtime transient` to keep history without carrying on a turn interrupted by a crash. Use `ma auth`, `ma login openai-codex`, or `ma login xai` to manage subscription sign-ins. Auth is shared with other implementations; session files live under `$XDG_STATE_HOME/modular-agent/python` (or `~/.local/state/modular-agent/python`). With `MODULAR_AGENT_DATA_DIR` set, configuration is read from that directory and state is kept under `state/` inside it.

Claude uses the [TypeScript sidecar](../../../typescript/sidecars/claude/README.md). Build it with Node 22 or newer as that README describes. `ma` can find it in a development checkout, at `~/.local/share/modular-agent/sidecars/claude/dist/main.js` or via `MODULAR_AGENT_CLAUDE_SIDECAR`. `ma login claude` uses the installed `claude` program. The terminal and the tool environment are for POSIX systems. The local environment does not confine file access; it uses cgroup v2 when delegated, or a process-group supervisor otherwise. In the latter case a descendant that leaves the process group is not contained.

## What is checked

- **Reference:** 12/12 checks, including both crash cases, MCP over stdio, tool offers and session continuation.
- **ACP:** 116/116 default checks; 123/123 with `--crash-checks`. The kit ran against `ma --acp` with `MODULAR_AGENT_CONFORMANCE=1`.
- **Python ma:** 19/19 tests. They test both device flows and Codex browser PKCE against loopback servers, both Providers' Responses requests and concurrent 401 refresh, an `auth.json` fixture in Rust's serde format, Monty limits and errors, skill discovery and prompt wording, MCP configuration and project trust, and the public SDK boundary. No real sign-in, credentials or model calls were used.
- **Claude sidecar:** One offline end-to-end request from `ma` through the TypeScript sidecar's own fake SDK. The fake confirmed the requested model, system prompt and input; it did not start Claude Code.
- **Python checks:** Ruff lint and format checks passed; strict mypy passed for the SDK and ma (27 source files). The existing base and SDK suite passed 336/336 in each local-binding run, transient and durable. With the 19 new tests included, durable process binding passed 355/355. Transient process binding passed 354/355; `test_foreign_job_report_runs_as_a_turn`, the known base timeout, passed on its isolated rerun (1/1). See the run commands below.

```sh
# From the repository root, after uv sync above:
npm ci --prefix conformance/acp
node conformance/reference/run.mjs --agent python
MODULAR_AGENT_CONFORMANCE=1 node conformance/acp/run.mjs -- "$PWD/python/.venv/bin/ma" --acp
MODULAR_AGENT_CONFORMANCE=1 node conformance/acp/run.mjs --crash-checks -- "$PWD/python/.venv/bin/ma" --acp
cd python
uv run --offline pytest -q tests/test_standard_ma.py
uv run --offline pytest -q --runtime transient
uv run --offline pytest -q --runtime durable
uv run --offline pytest -q --runtime transient --binding process
uv run --offline pytest -q --runtime durable --binding process
uv run --offline ruff check .
uv run --offline ruff format --check .
uv run --offline mypy
```

Run the full Python suites one at a time and do not edit the base plugins during a process-binding run: its child processes import the modules they use. Process-binding tests include the base's known intermittent foreign-job case.

## Known gaps

- The Responses Providers replay text and tool calls, but do not replay encrypted vendor reasoning items. The SDK does not yet give an in-process Provider a store whose opaque data is guaranteed to come back only to that Provider. No real service verified the replay or current endpoint behavior.
- The Claude launcher uses the SDK's process plugin API and was tested with the sidecar's built-in fake only. ACP starts the sidecar, when installed, at interface startup so it can advertise the catalog; line and print mode load it only when selected, or for `ma models`.
- `auth.json` preserves Rust's `answers` map but `ma` does not yet put new secret answers into it. Line mode declines secret questions rather than accepting secret text in the terminal. There is no general SDK credential-store override to connect the shared file to the question lifecycle.
- File tools use the working environment. Their byte and directory callbacks are currently available only in-process. The SDK's MCP transport supports stdio and Streamable HTTP; the reference kit exercises stdio. MCP and file-tool error wording is not identical for every invalid input and filesystem failure. `find` uses Git enumeration (or `find` outside a repository) and Python glob matching; not every Rust glob extension is supported.
- The CLI uses the SDK's event names and shared ids for JSON lines; it does not reproduce the Rust build's native event envelope. It does not interpret executable plugin entries in `.modular-agent.json`. Only trusted project MCP can start project-configured programs.

## Findings for docs/reference and docs/sdk

Suggested text. No shared documents were edited in this branch.

- **Reference, `--trust-project`** — replace its Meaning cell with: “Record trust for this canonical project folder. Read `.modular-agent.json` as session settings regardless of trust; only a trusted project's `.mcp.json` can start its configured MCP servers.” Rust's standard composition does not load its configuration plugin plan either. If executable entries are intended, specify their shared schema and supported placement instead.
- **Reference, Prompt** — replace the final clause with: “then the `codemode` functions, `<cwd>` containing the absolute working folder, and `<date>` containing the local date in `YYYY-MM-DD` form.” The starting Rust implementation gives the code catalog at normal hook order, project context at last order, and no date. Python uses the order given in the product page.
- **Reference, `--json`** — replace its Meaning cell with: “Print one JSON object per event, using the SDK event's `type`, `time`, ids (`sessionId`, `turnId`, `stepId`, `toolCallId` when present), and `data`.” The starting Rust sink exposes a different native envelope.
- **Reference, state folder** — add: “`MODULAR_AGENT_DATA_DIR` does not replace `XDG_CONFIG_HOME` or `XDG_STATE_HOME` for other programs. The agent's configuration goes directly in it and its private files go in `state/`.” The starting Rust path constructor uses the supplied directory for both, without `state/`; Python follows the normative description.
- **SDK, Tools and Contexts** — append: “An SDK can register a tool with an existing JSON Schema plus an async handler, without generating the schema from language types. Tools can read and write file bytes, list directory entries and run commands through a scoped working environment. Mark byte and directory access in-process-only unless the binding can carry those operations.” This covers Python's `Tool.from_schema` and `ToolContext.environment` used by the official `modular_agent.files.file_tools` plugin.
- **SDK, building an agent** — append: “For an ACP composition, a project settings resolver may supply new-session defaults for the client's canonical project path. A configured MCP resolver may supply that project's configured servers on session attach, after checking configuration trust; it must not read executable settings from another project.” Python exposes `project_settings` and `project_mcp` on `create_agent`.
- **SDK, Agent and Session operations** — append: “Session summaries include the last activity when known. `sessionInfo(id)` reads the saved project and settings without opening a session or resuming a turn. `waitIdle()` waits for admitted work to finish without sending input.” The terminal uses these operations to select saved Providers, implement `-c`, and drain admitted input at end of file.
- **SDK, Providers** — append: “An in-process Provider may return opaque `providerData`. Keep it in the record, bind it to the producing Provider's identity, and include it only in a model request to that same Provider. Never include it in output or history projections.”

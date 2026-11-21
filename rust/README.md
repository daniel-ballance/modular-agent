# Modular Agent in Rust

An agent build and SDK based on [production edition 3](../docs/adr/0021-production-edition.md) and the [edition 4 draft](../docs/adr/0023-edition-4-draft.md). The Rust workspace has three parts:

- **The base.** The Harness, the transient and durable Runtimes, ACP, the plugin host, history stores and the fixtures. This is the clean-room Rust build from the experiment (`modular-agent-rs` at `bc59845`), copied in unchanged and then extended. Its own notes are in [docs/clean-room](docs/clean-room/). Its binary is `modular-agent`, and it still passes every kit.
- **The standard configuration.** A coding agent in Pi's shape, built on the public Rust SDK and its official plugins. Its binary is `ma`. [ADR 0022](../docs/adr/0022-standard-configuration.md) records the decisions.
- **The SDK.** [`crates/sdk`](crates/sdk/README.md), the library crate `modular-agent`. Compose agents with `Agent::builder()`, embed sessions or serve them over ACP, and write tools, hooks and commands that run in process or over the plugin binding. Use `testing::test_agent()` for offline tests. [`crates/sdk-scenarios`](crates/sdk-scenarios) runs the shared scenarios and builds `modular-agent-fixtures`.

The base's binary crate is now `crates/agent-base`, package `agent-base`, so that the SDK can have the name `modular-agent`. The binary is still `modular-agent`; the clean-room notes use the old package name.

## The standard configuration

| Part | Crate | What it does |
|---|---|---|
| Providers | `provider-responses` | ChatGPT subscription (`openai-codex/...`) and Grok subscription (`xai/...`) over the Responses API. Stateless. Sign-in and token refresh included. |
| Provider | [`sidecars/claude`](../typescript/sidecars/claude/README.md) | Claude subscription (`claude/...`) through the Claude Agent SDK for TypeScript. A plugin in its own process over the plugin binding, started only when a Claude model is used. |
| Tools | `modular-agent-files` | `read`, `exec`, `edit`, `write`, `find` and `list`, with Pi's inputs, limits and wording. They work through the session's working environment. |
| Tool | `tools-code` | `codemode`: Python in a [Monty](https://github.com/pydantic/monty) sandbox. Every other tool is a function on its `tools` object. |
| MCP client | `modular-agent-mcp`, `standard::mcp` | Servers from `mcp.json`, over stdio and Streamable HTTP. Their tools are `tools.mcp_SERVER__TOOL`. |
| Agent Skills | `standard::skills` | Finds skills, lists them in the prompt, and loads one on `/skill:NAME`. |
| Prompt | `standard::prompt` | Pi's prompt structure: rules, `AGENTS.md` files, skills, codemode functions, the working folder and the date. |
| Credential store | `credentials-auth` | `auth.json`, readable only by its owner, with a lock so two agents never spend one refresh token. |
| The rest | `modular-agent`, `standard::terminal` | Durable Runtime, local working environment, file history, compaction, model selection, commands, questions, terminal and ACP Interfaces. |

### One tool

The model is offered a single tool, `codemode`. It writes Python, and the functions on `tools` are the only way out of the sandbox:

```python
text = tools.read(path="src/main.rs")
run = tools.exec(command="cargo test 2>&1 | tail -20")
if run["exit_code"] != 0:
    tools.edit(path="src/main.rs", edits=[{"oldText": "old", "newText": "new"}])
print(run["output"])
```

- A function call leaves the sandbox as a **nested tool call**. The Harness checks it as it checks any call (rights, gates, registration), records it with `startedBy: "tool"` and its parent's id, and keeps it out of the model's view. The model sees its own call and that call's result.
- Use the `tools` object or `import tools`. Tool functions can be assigned to variables. A failed call raises `RuntimeError` with the tool result's text. A timed-out `exec` raises; a command that exits non-zero returns its dict.
- `ma` uses [Monty's Rust pool](https://github.com/pydantic/monty/blob/v1.6.0/crates/monty-pool/README.md) to start a fresh Monty 1.6.0 worker process for each run. The pool re-executes `ma` in worker mode and speaks Monty's framed protocol over stdin and stdout. The worker does not load agent settings or credentials. Code has no direct access to files, network, processes, wall clocks, sleep or system entropy. `random.Random(7)` works because it has an explicit seed.
- A run has 30 seconds of active interpreter wall time between nested tool calls. `ma` checks the worker's elapsed time at each pause and at completion. Waiting for a tool, import or lookup does not count. Only a dispatched nested tool call resets the budget. A separate pipe deadline stops a worker that stops answering. The worker allocator limits memory to 256 MiB. A run can make 500 nested tool calls and use 200 levels of Python recursion. Imports and lookups, including `describe_tool` and `search_tools`, do not count as calls.
- Results show printed text followed by the last value, as plain text for strings, JSON where possible and Python `repr` of the worker value otherwise. Images are attached separately. Printing past 1 MiB stops the run. The print-limit error comes first, then the printed prefix, cut at a UTF-8 boundary. Result cuts keep whole lines within 2,000 lines and 50 KiB. If the traceback does not fit after printed text, its last line comes first.
- No session is reused. A run that reaches a memory or time limit reports `MemoryError` or `TimeoutError`. If the worker dies, the call fails and the next run starts a new worker. Cancelling the call kills its worker.
- `describe_tool(name)` and `search_tools(query)` let the model look up a function when there are too many to list in full.

The session setting `model_tools` holds the names the model is offered, `["codemode"]` by default. Set it to `null` in `settings.json` to offer the six tools and MCP tools directly as well.

## Use it

Linux only. Needs [mise](https://mise.jdx.dev) for the pinned Rust toolchain, and Node.js 22 or newer for the Claude sidecar.

```sh
cd rust
mise exec -- cargo build --locked --release -p standard        # target/release/ma
(cd ../typescript/sidecars/claude && npm ci --ignore-scripts && npm run build)
scripts/install.sh                                    # optional: ~/.local/bin/ma and the sidecar
```

Sign in to at least one Provider:

```sh
ma login openai-codex     # ChatGPT: opens a browser; add --device for a code instead
ma login xai              # Grok: a code to enter at the address shown
ma login claude           # runs `claude auth login`; Claude Code keeps this sign-in
ma auth                   # what is signed in
ma models                 # what is on offer
```

Then, in a project folder:

```sh
ma                                           # talk to it; a line typed while it works steers it
ma -p "Summarise the README"                 # one prompt, answer on stdout
ma --model xai/grok-4.7 --thinking high
ma -c                                        # reopen this folder's last session
ma -v                                        # also show each call the code makes
ma --acp                                     # serve ACP on stdio, for an editor or T3 Code
ma --acp --listen 127.0.0.1:7401 --token-file /path/to/owner-only-token
```

`ma --help` lists the rest. With no `--model` and none in settings, `ma` uses the first Provider that is signed in.

### Files

| File | Purpose |
|---|---|
| `~/.config/modular-agent/settings.json` | Session defaults: `model`, `thinking`, `step_limit`, `output_limit`, `model_tools` |
| `~/.config/modular-agent/auth.json` | Sign-ins. Written by `ma login`. Mode 0600. |
| `~/.config/modular-agent/mcp.json` | `{"mcpServers": {...}}` in the form Pi and other clients use. `${NAME}` takes a value from the environment. |
| `~/.config/modular-agent/models.json` | Catalog additions or replacements: `{"openai-codex": [{"id", "name", "contextWindow", "maxTokens", "effort"}], "xai": [...]}` |
| `~/.config/modular-agent/AGENTS.md` | Your own standing instructions, for every project |
| `~/.config/modular-agent/skills/`, `~/.agents/skills/` | Your skills |
| `PROJECT/AGENTS.md` (or `CLAUDE.md`), and the same in each folder above it | Project instructions |
| `PROJECT/.agents/skills/`, `PROJECT/.modular-agent/skills/` | Project skills |
| `~/.config/modular-agent/trusted-projects.json` | Canonical project paths explicitly trusted by the operator |
| `PROJECT/.modular-agent.json` | Project session defaults. It starts no programs, even in a trusted project. |
| `PROJECT/.mcp.json` | Project MCP servers. Used only after `ma --trust-project`, because it starts programs. |
| `~/.local/state/modular-agent/rust/` | Sessions, command state and the full output of commands whose output was cut |

`MODULAR_AGENT_DATA_DIR` puts the configuration files directly in that folder and puts the state in its `state/` subfolder. Without it, the XDG configuration and state variables take precedence over the paths above. `MODULAR_AGENT_CLAUDE_SIDECAR` names the sidecar's `dist/main.js` if it is not beside the build or under `~/.local/share/modular-agent/sidecars/claude`.

## What is checked

Run from `rust/` with `TMPDIR` off `/tmp`:

```sh
export TMPDIR="$HOME/.cache/ma-std-tmp"; mkdir -p "$TMPDIR"
(cd ../conformance/acp && npm ci)
(cd ../conformance/tools && npm ci)
mise exec -- cargo build --locked -p standard --bin ma
mise exec -- cargo build --locked -p agent-base
node ../conformance/reference/run.mjs --agent rust
MODULAR_AGENT_CONFORMANCE=1 node ../conformance/acp/run.mjs -- "$PWD/target/debug/ma" --acp
MODULAR_AGENT_CONFORMANCE=1 node ../conformance/acp/run.mjs --crash-checks -- "$PWD/target/debug/ma" --acp
MODULAR_AGENT_CONFORMANCE=1 node ../conformance/acp/run.mjs --crash-checks --probe-checks --job-checks -- "$PWD/target/debug/ma" --acp
mise exec -- cargo test --workspace --no-fail-fast -- --test-threads=1 > "$TMPDIR/ma-workspace.log" 2>&1
mise exec -- cargo fmt --all -- --check
mise exec -- cargo clippy --workspace --all-targets -- -D warnings
../scripts/websocket-kits.sh rust
```

- **Standard reference checks:** 22/22, including tool values, denial of ambient access, result formatting, timeout and print-limit errors, memory limits, and both Runtime crash cases.
- **ACP with `--crash-checks --probe-checks --job-checks`:** `ma` passed 188/188 on stdio and 193/193 on its built-in loopback WebSocket listener. The base build passes 214/214 on stdio. The expanded run covers late answers and job report turns, including after a crash.
- **Plugin binding:** The Rust conformance plugin passed 146/146 on stdio and 153/153 on WebSocket, including the transient and durable Runtime services. Neither WebSocket run used a bridge.
- **Standard and codemode:** 26 tests for `ma` and 5 for `tools-code`. These cover tool results, sandbox limits, OS policy, worker death and cancellation, crash recovery, and the dependency boundary.
- **Workspace:** 394 Rust tests passed. Formatting and Clippy with `-D warnings` pass. See the [SDK verification matrix](crates/sdk/README.md#what-is-checked) for shared scenarios.
- **Offline only:** browser sign-in uses a simulated browser on loopback; both device flows and refresh use loopback HTTP fixtures. No credentials, real sign-ins or model requests were used.

To try the terminal without a login:

```sh
scratch=$(mktemp -d)
printf '[{"text":"Hello from the scripted model."}]\n' > "$scratch/script.json"
MODULAR_AGENT_DATA_DIR="$scratch" MODULAR_AGENT_SCRIPT="$scratch/script.json" \
  MODULAR_AGENT_SCRIPT_LOG="$scratch/requests.jsonl" target/debug/ma -p "Say hello."
```

## Known gaps

- **Claude:** The sidecar must be installed separately. `ma --acp` loads it when the launch settings or the reopened session choose a Claude model, not when a client later switches a session that was composed without Claude. Claude Code starts per request and adds some text of its own; see the [sidecar's gaps](../typescript/sidecars/claude/README.md#known-gaps-and-open-problems). This migration did not exercise the sidecar with a real model.
- **Images:** They are attached as read, up to 4.5 MiB. They are not resized.
- **MCP:** tools only, no OAuth negotiation. The official MCP plugin's changing catalog is local to this agent; the SDK does not yet serve that plugin over stdio. It can still connect to remote MCP servers.
- **Terminal:** line-based, with no markdown rendering. Embedded reopening waits for recovery before reading another terminal line. ACP installs recovery before returning the session and does not wait for the recovered turn to finish.
- **Credential staging:** the Rust base stores a named answer directly; it does not implement the full staged-secret transaction.

## Findings for docs/reference and docs/sdk

These are proposed edits; the shared documents are unchanged in this branch.

- **[`docs/reference`, Tools](../docs/reference/standard-configuration.md#tools):** Replace “256 MiB of memory (Monty's `max_memory`, which counts what the interpreter allocates)” with “256 MiB of memory (Monty's `max_memory`, which counts live allocations against the worker's baseline, not the worker's resident memory)”. Monty 1.6.0 also counts compiled code and interpreter internals in worker mode.
- **ACP declarations:** `interface-acp` dispatched proposed input, actor joins, session limits and tenant queries without consulting the SDK factory's session declaration. It now refuses disabled operations with `not_supported`, without changing the declarations or gating `proposals`, `release` or `withdraw`, which also serve parked job reports. The base declares all three features true and still passes the positive checks.
- **[`docs/reference`, Checks](../docs/reference/standard-configuration.md#checks):** Replace the ACP-kit bullet with: “the ACP kit against `MODULAR_AGENT_CONFORMANCE=1 ma --acp` with `--crash-checks --probe-checks --job-checks`, including refusal of operations disabled by the session declaration;”
- **[`docs/sdk`, Building an agent](../docs/sdk/api.md#building-an-agent):** Add: “A builder may accept file-backed configuration and an explicit project trust ledger, a local credential store, deployment tenant configuration, and an option to replace the default prompt. SDK adapters may use the base's direct credential-write contract where staged secrets are not implemented, and must document that limitation.”
- **[`docs/sdk`, The agent](../docs/sdk/api.md#the-agent):** Replace the ACP options description with: “`compose(project, reopeningId?)` builds an Agent for the canonical project. The saved session id, when present, lets the factory select Providers and other launch parts before recovery. `projectSettings(project)` supplies settings for new sessions. `projectMcp` attaches the project’s trusted sources; client-supplied server specifications still follow the ACP binding’s separate `hostMcpServers` policy. A multi-project host supplies a shared history index and an explicit trust operation.”
- **[`docs/sdk`, Hooks](../docs/sdk/api.md#hooks):** Add to `turn.before`: “A contribution may name the history entry ids it used in `sources`. An empty list means the contribution did not use session history. When omitted, the agent conservatively treats the contribution as derived from the current history.”
- **[`docs/sdk`, Working environment](../docs/sdk/api.md#contexts):** Add: “The tool environment exposes byte reads and writes, directory listing and a command timeout. Command output includes exit code, status and whether it timed out. A native ignore-aware file walk is optional and in-process only; a served file tool may fall back to a command. Shared content parts, including images, are preserved in ToolOutput and ToolResult.”

## Where the specification was silent

Building this turned up seven places where edition 3 was silent. They are now the edition 4 draft rules, in [ADR 0023](../docs/adr/0023-edition-4-draft.md), and this build implements all of them:

| Rule | Where it lives here |
|---|---|
| A tool can start a nested call, in process or over the plugin binding (`host/tools/list`, `host/tools/call`) | `Runtime::nested_tool` in `runtime-engine`; the host side in `plugin-stdio`; the fixture tool `nest` |
| A nested call needs a registration that allows a plugin as caller, not a place in the model's offer | `nested_tool_definitions` in `agent-api` |
| A nested call is never left open; nesting is at most 4 deep | `runtime-engine` |
| `modelTools` is a standard setting (`model_tools` in this build's settings files) | `agent-harness`, `agent-api::portable` |
| An ACP client is told a nested call's parent | `interface-acp` |
| `env/list` and `host/env/list` | `WorkingEnvironment::list_dir`, `plugin-stdio` |
| A cancelled Provider request sends no response callback; an unlisted reasoning level is lowered, never raised; `outOfReach` text is for people | `provider-responses`, `sidecars/claude` |

See the [SDK's checks](crates/sdk/README.md#what-is-checked) for the scenario matrix.

## Changes to the base since the seed

Beyond the draft rules, these defects in the seeded build were fixed:

- **A result with no call in the model's context is left out of it,** as shared data requires. The seed showed the model a call the UI had made.
- **A tool result reads the same before and after a reopen.** The seed put the status in front of the text while the session was live and not after it was reloaded, so a restart changed the model's context.
- **A command's deadline belongs to the working environment** (`WorkingEnvironment::exec`), so a remote environment enforces it where the command runs.
- **Tool results can carry content beyond text,** such as an image, live and through the store.
- **A Provider's credential goes only to the plugin that claimed its name** at load (`Registrar::claim_credentials`). Both credential stores refuse a sign-in to anyone else, and a second plugin claiming a held name fails to load.
- **Strong-containment kit check:** Cancelling a `setsid` escapee after it opened its heartbeat with `>` but before it wrote the timestamp left an empty file. The kit reported a changing heartbeat even though the process was stopped. Gating the second write at that boundary reproduced the failure. [Command lifetime](../docs/bindings/plugin.md#command-lifetime) requires stopping descendants, not completing an interrupted write: the kit now requires a heartbeat before cancel and checks that its append-only length stops changing. Rust containment code is unchanged.
- **Lint:** `cargo clippy --workspace --all-targets -- -D warnings` and `cargo fmt --all -- --check` are clean.

## Layout

```text
rust/
  crates/
    agent-api, agent-harness, runtime-*        the base
    interface-*, history-*, plugin-stdio, ...  the base
    sdk, tools-files, sdk-mcp                  SDK and official file/MCP plugins
    mcp-client                                 shared MCP transport
    tools-code                                 standard: codemode
    provider-responses, credentials-auth       standard: Providers and sign-in
    standard                                   standard: composition, prompt, skills, MCP config, the ma binary
  scripts/                                     fixtures and install.sh
  docs/clean-room/                             the base build's own notes and gap log
  conformance -> ../conformance                the kits
typescript/sidecars/claude/                    the Claude Provider, in TypeScript
```

To swap a part, change `builder` in [`crates/standard/src/lib.rs`](crates/standard/src/lib.rs): it is the one place that names the plugins.

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
- The functions sit on `tools` because `exec` and `list` are also Python builtins.
- The sandbox has no file, network, clock or process access of its own. It is bounded: 30 seconds of computation between calls, 500 calls a run, a recursion limit and a cap on printed output.
- Each run starts fresh. No variables carry over.
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
| `PROJECT/.modular-agent.json` | Project session defaults |
| `PROJECT/.mcp.json` | Project MCP servers. Used only after `ma --trust-project`, because it starts programs. |
| `~/.local/state/modular-agent/rust/` | Sessions, command state and the full output of commands whose output was cut |

`MODULAR_AGENT_DATA_DIR` puts the configuration files directly in that folder and puts the state in its `state/` subfolder. Without it, the XDG configuration and state variables take precedence over the paths above. `MODULAR_AGENT_CLAUDE_SIDECAR` names the sidecar's `dist/main.js` if it is not beside the build or under `~/.local/share/modular-agent/sidecars/claude`.

## What is checked

Run from `rust/` with `TMPDIR` off `/tmp`:

```sh
export TMPDIR="$HOME/.cache/ma-std-tmp"; mkdir -p "$TMPDIR"
(cd ../conformance/acp && npm ci)
mise exec -- cargo build --locked -p standard --bin ma
node ../conformance/reference/run.mjs --agent rust
MODULAR_AGENT_CONFORMANCE=1 node ../conformance/acp/run.mjs -- "$PWD/target/debug/ma" --acp
MODULAR_AGENT_CONFORMANCE=1 node ../conformance/acp/run.mjs --crash-checks -- "$PWD/target/debug/ma" --acp
mise exec -- cargo test --workspace --no-fail-fast -- --test-threads=1
mise exec -- cargo fmt --all -- --check
mise exec -- cargo clippy --workspace --all-targets -- -D warnings
```

- **Standard reference checks:** 12/12, including the durable and transient process crashes and the exact scripted request log.
- **ACP against `ma`:** 116/116 by default and 123/123 with `--crash-checks`.
- **Standard and its plugins:** 34 Rust tests. Of these, 16 cover the CLI composition, dependency boundary, prompt and skills, MCP, nested calls and crash recovery; 4 cover file handling; 2 cover auth bytes, permissions and refresh locking; and 12 cover subscription sign-in, refresh, request mapping, streaming, failures and cancellation.
- **Workspace:** 302 passed, 0 failed, 0 ignored, including doctests and the base build's kit tests. Formatting and Clippy with `-D warnings` pass.
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
- **Monty runs in the agent process.** There is no sandbox memory limit. An interpreter abort can still stop the agent. The durable Runtime keeps the recorded history. Images are attached as read, up to 4.5 MiB; they are not resized.
- **MCP:** tools only, no OAuth negotiation. The official MCP plugin's changing catalog is local to this agent; the SDK does not yet serve that plugin over stdio. It can still connect to remote MCP servers.
- **Terminal:** line-based, with no markdown rendering. Embedded reopening waits for recovery before reading another terminal line. ACP installs recovery before returning the session and does not wait for the recovered turn to finish.
- **Credential staging:** the Rust base stores a named answer directly; it does not implement the full staged-secret transaction.

## Findings for docs/reference and docs/sdk

These are proposed edits; the shared documents are unchanged in this branch.

- **[`docs/reference`, Tools](../docs/reference/standard-configuration.md#tools):** The existing Rust catalog used the full text for all entries only if the whole catalog fit. Replace the last sentence of the lookup bullet with: “The prompt describes every function in full if there are at most twelve. With more than twelve, it shows each signature and a short description; `describe_tool(name)` returns the full definition.” Replace “500 calls a run” with “500 nested tool calls a run; catalog lookups are not nested calls.”
- **[`docs/reference`, Files](../docs/reference/standard-configuration.md#files):** Add after the per-language state bullet: “Rust no longer reads native sessions from the old, unsuffixed state root. To retain those sessions, move its `sessions/` and `commands/` directories together into `modular-agent/rust/` while the agent is stopped.” No configuration file needs moving.
- **[`docs/reference`, Providers](../docs/reference/standard-configuration.md#providers):** Replace the last sentence with: “The Claude Provider uses the sidecar. The CLI starts it to run a Claude model or list its catalog. ACP starts it when the launch or saved session selects Claude; a client cannot switch to Claude in a composition that did not load it.”
- **[`docs/sdk`, Building an agent](../docs/sdk/api.md#building-an-agent):** Add: “A builder may accept file-backed configuration and an explicit project trust ledger, a local credential store, deployment tenant configuration, and an option to replace the default prompt. SDK adapters may use the base's direct credential-write contract where staged secrets are not implemented, and must document that limitation.”
- **[`docs/sdk`, Sessions and Interfaces](../docs/sdk/api.md#sessions-and-turns):** Add: “A persistent History can list and inspect saved session metadata without taking a writer lease. Interfaces may follow live Agent events before a session opens and dispatch a tool as the local actor without starting a turn. A project-aware ACP host supplies a composed Agent for each project and optional saved session, a history store, an explicit trust operation and an optional MCP attachment callback.”
- **[`docs/sdk`, Hooks and tool sources](../docs/sdk/api.md#hooks):** Add: “An in-process session-prepare hook can install resources before recovery; the session-end hook releases them. An in-process turn-before contribution can receive the session project and the current tool definitions callable by other tools, including tools not offered to the model. Rust tool sources with a session-varying catalog are currently in-process only; serving such a source is refused until the SDK supports catalog change notifications over the binding.”
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

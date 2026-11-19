# Modular Agent in Rust

A working agent built on [production edition 3](../docs/adr/0021-production-edition.md) of the specification. It has two layers:

- **The base.** The Harness, the transient and durable Runtimes, ACP, the plugin host, history stores and the fixtures. This is the clean-room Rust build from the experiment (`modular-agent-rs` at `bc59845`), copied in unchanged and then extended. Its own notes are in [docs/clean-room](docs/clean-room/). Its binary is `modular-agent`, and it still passes every kit.
- **The standard configuration.** A coding agent in Pi's shape, made only of plugins on that base. Its binary is `ma`. [ADR 0022](../docs/adr/0022-standard-configuration.md) records the decisions.

## The standard configuration

| Part | Crate | What it does |
|---|---|---|
| Providers | `provider-responses` | ChatGPT subscription (`openai-codex/...`) and Grok subscription (`xai/...`) over the Responses API. Stateless. Sign-in and token refresh included. |
| Provider | [`sidecars/claude`](../sidecars/claude/README.md) | Claude subscription (`claude/...`) through the Claude Agent SDK for TypeScript. A plugin in its own process over the plugin binding, started only when a Claude model is used. |
| Tools | `tools-files` | `read`, `exec`, `edit`, `write`, `find` and `list`, with Pi's inputs, limits and wording. They work through the session's working environment. |
| Tool | `tools-code` | `codemode`: Python in a [Monty](https://github.com/pydantic/monty) sandbox. Every other tool is a function on its `tools` object. |
| MCP client | `tools-mcp`, `standard::mcp` | Servers from `mcp.json`, over stdio and Streamable HTTP. Their tools are `tools.mcp_SERVER__TOOL`. |
| Agent Skills | `standard::skills` | Finds skills, lists them in the prompt, and loads one on `/skill:NAME`. |
| Prompt | `standard::prompt` | Pi's prompt structure: rules, `AGENTS.md` files, skills and the working folder. |
| Credential store | `credentials-auth` | `auth.json`, readable only by its owner, with a lock so two agents never spend one refresh token. |
| The rest | base crates | Durable Runtime, local working environment, file history, compaction, model selection, commands, questions, terminal and ACP Interfaces. |

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
mise exec -- cargo build --release -p standard        # target/release/ma
(cd ../sidecars/claude && npm install --ignore-scripts && npm run build)
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
| `~/.local/state/modular-agent/` | Sessions, command state and the full output of commands whose output was cut |

`MODULAR_AGENT_DATA_DIR` puts all of it in one folder, as the ACP binding requires of a host that isolates an agent. `MODULAR_AGENT_CLAUDE_SIDECAR` names the sidecar's `dist/main.js` if it is not beside the build or under `~/.local/share/modular-agent/sidecars/claude`.

## What has been checked

Run from `rust/` with `TMPDIR` off `/tmp`:

```sh
export TMPDIR="$HOME/.cache/ma-std-tmp"; mkdir -p "$TMPDIR"
(cd ../conformance/acp && npm ci --ignore-scripts)          # once: the ACP kit's one dependency
mise exec -- cargo test --workspace -- --test-threads=1
(cd ../sidecars/claude && npm test)
```

- **The whole workspace: 259 tests pass, none fail** (2026-11-19). That includes the base build's suite, which runs the ACP kit and the plugin kit against the `modular-agent` binary, so the changes to the base did not cost conformance.
- **The standard configuration: 9 integration tests** with a scripted model, in `crates/standard/tests`:
  - the model is offered only `codemode`, and a direct call to another tool is refused;
  - nested calls are recorded with their parent and stay out of the model's context;
  - a nested call passes its own gate, and a refusal reaches the code as an exception;
  - tool failures, bad arguments, unknown functions and syntax errors come back readable;
  - the sandbox cannot read a file itself, and the compute, call and recursion limits hold;
  - instructions and skills reach the prompt in order, and `/skill:NAME` loads one;
  - MCP servers from `mcp.json` become functions, and a server that fails to start is skipped;
  - `model_tools: null` offers the tools directly;
  - **a `kill -9` in the middle of a code run:** on reopening, the durable Runtime finishes the turn, the code run and the command it had started are both settled as outcome unknown, and neither runs again.
- **The two Responses Providers: 5 tests**, three of them against a loopback fixture: request shape per vendor, streamed text and tool calls, usage, error kinds, cancel, and that one vendor's reasoning items are never sent to the other.
- **Sign-in: 4 tests** for the browser callback, the token claims, refresh and the credential file. Both sign-in flows were also started against the real services, which issued codes; no sign-in was completed.
- **The Claude sidecar: 44 offline tests**, and four real requests of its own.
- **Real runs through `ma`, on `claude/claude-haiku-5-5`:** one prompt that read a file and ran a command over two tool rounds; a two-input session that followed a project skill and wrote a file; and `ma -c` in a new process, which answered from the saved session.
- **ACP:** `ma --acp` was driven by hand through `initialize`, `session/new` and `session/prompt` with a scripted model. The code call and its nested call arrived as tool calls, and the reply as text.

## What has not been checked, and known gaps

- **ChatGPT and Grok have not made a real request.** Their sign-in needs you. The request shapes, headers, endpoints and client ids follow Pi 1.5.2. After `ma login openai-codex` and `ma login xai`, try `ma --model openai-codex/gpt-6.1-sol -p "say hi"` and the same for `xai/grok-4.7`. The Codex backend takes an `originator` header; this build sends Pi's value, `pi`, because that is the one known to be accepted.
- **`ma` does not offer the conformance fixture,** so the ACP kit cannot run against it. The kits run against `modular-agent`, the same Harness with the fixture plugin set.
- **Monty runs inside the agent's process.** Its authors recommend `monty-pool`, which runs the interpreter in worker processes, because a stack overflow or allocator abort in the interpreter takes its host with it. The limits above make that unlikely, not impossible. With the durable Runtime such a crash loses no history.
- **No memory limit on the sandbox.** Monty's needs its own global allocator.
- **Images.** `read` on an image reports its type and size. Nothing passes images to a model yet.
- **`edit` matches exactly.** Pi falls back to a fuzzy match on whitespace and quote style.
- **MCP:** tools only. No resources, prompts, sampling, elicitation or OAuth sign-in to a server. A server whose tool names are not letters, digits, `_` or `-`, or run past 64 characters with the prefix, is skipped whole.
- **No approval, subagent or guardrail plugin** in the standard set, as in Pi. The base has all three (`feature-approval`, `feature-subagents`, `guardrail`).
- **The terminal is line-based.** No full-screen UI, no markdown rendering, no history search.
- **Claude through the sidecar** starts a Claude Code process per model request, replays earlier turns as text, and Claude Code adds some text of its own around the prompt. See the [sidecar's gaps](../sidecars/claude/README.md#known-gaps-and-open-problems).
- **The production gaps of edition 3** are unchanged: secret staging, per-connection isolation, resource reservations and cross-session erasure.

## Where the specification was silent

Logged in the experiment's habit, with the swap test: would two builds that chose differently break a plugin or a host?

- **A tool calling a tool in process.** [Contracts](../docs/contracts.md#tool-dispatch) say a nested call passes its own gates, and [shared data](../docs/bindings/data.md#tools) gives it `startedBy: "tool"` and `parentCallId`. Neither says how an in-process tool source asks for one. This build adds `Runtime::nested_tool`. The plugin binding has no equivalent, so a tool source in another process cannot make nested calls. Swap test: yes for a code tool served over the wire.
- **Whether a nested call must be in the model's offer.** The [recorded offer](../docs/contracts.md#recovery-and-repeating-work) governs calls "from that attempt". This build reads that as the model's own calls: a nested call needs a live registration that allows a tool as caller, not a place in the offer. Swap test: yes. A build that required the offer would refuse every nested call here.
- **A nested call that asks a question past its deadline.** The call cannot be left open, since its parent would have to stay open too. This build refuses it. Swap test: no; it is a refusal either way.
- **Which registered tools the model is offered.** `callers` on a definition is the tool source's own statement. This build adds a session setting, `model_tools`, for the operator's. Another build reopening the session ignores the key and offers its own set from then on; the turns already recorded keep their offers. Swap test: mild. Nothing breaks, but the model's tools change.
- **Announcing a nested call.** This build emits the same event as for a model's call, so an ACP client receives `tool_call` before `tool_call_update`. The [ACP binding](../docs/bindings/acp.md#updates) does not say whether a client should be told the parent.

## Layout

```text
rust/
  crates/
    agent-api, agent-harness, runtime-*        the base
    interface-*, history-*, plugin-stdio, ...  the base
    tools-files, tools-code                    standard: tools
    provider-responses, credentials-auth       standard: Providers and sign-in
    standard                                   standard: composition, prompt, skills, MCP config, the ma binary
  scripts/                                     fixtures and install.sh
  docs/clean-room/                             the base build's own notes and gap log
  conformance -> ../conformance                the kits
sidecars/claude/                               the Claude Provider, in TypeScript
```

To swap a part, change `compose` in [`crates/standard/src/lib.rs`](crates/standard/src/lib.rs): it is the one place that names the plugins.

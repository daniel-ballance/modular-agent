# The standard configuration

**Status: 0.1.** All four implementations exist and pass the [reference checks](../../conformance/reference/README.md): [Rust](../../rust/README.md), [TypeScript](../../typescript/packages/ma/README.md), [Go](../../go/cmd/ma/README.md) and [Python](../../python/packages/ma/README.md). [ADR 0026](../adr/0026-one-reference-product.md) records why there is one product. Where an implementation must guess, the guess becomes a change here first.

The standard configuration is the reference implementation of layer 4 ([ADR 0024](../adr/0024-five-layers.md)): a coding agent with Pi's feature set, for everyday use. There is one product and four implementations of it, one per language. A person can install any one of them and get the same program: the same commands, files, tools, prompt and behavior. Each is written the way its language is written.

## Rules for every implementation

- **Built only on its language's SDK.** It uses the public API of that SDK ([`docs/sdk`](../sdk/README.md)) and nothing else from the base build. When it needs something the SDK cannot give, the SDK gains it first, then the SDK specification records it.
- **One language.** It is written in its own language. The one exception is the Claude Provider, which needs the Claude Agent SDK for TypeScript: the Rust, Go and Python implementations load [`typescript/sidecars/claude`](../../typescript/sidecars/claude/README.md) as a process plugin. The TypeScript implementation may load it in process.
- **The same product.** Commands, options, file names and formats, tool names, inputs, descriptions and limits, the prompt's structure and wording, and error messages a person reads are the same in all four. The Rust implementation's texts are the reference: the tool definitions in `rust/crates/tools-files` and `rust/crates/tools-code`, the prompt in `rust/crates/standard/src/prompt.rs` and the skills listing in `rust/crates/standard/src/skills.rs`. A difference is a bug in one of them, fixed by changing this page or the code that is wrong.
- **Shared configuration, separate state.** All four read the same configuration folder, so a person can switch implementation without setting anything up again. Each keeps its sessions in its own state folder, because their native session files differ.

## The program

The command is `ma` in every language. Only one is installed at a time.

```
ma [options]                 talk to the agent in this folder
ma [options] -p PROMPT       answer one prompt and exit
ma login PROVIDER [--device] sign in: openai-codex, xai or claude
ma logout PROVIDER
ma auth                      show what is signed in
ma models                    list the models on offer
ma skills                    list the skills found for this folder
ma mcp                       list the configured MCP servers
ma sessions [--all]          list saved sessions
```

| Option | Meaning |
|---|---|
| `--model PROVIDER/ID` | the model, such as `openai-codex/gpt-6.1-sol`, `xai/grok-4.7` or `claude/claude-sonnet-5-5` |
| `--thinking LEVEL` | `off`, `minimal`, `low`, `medium`, `high` or `xhigh`, as the model allows |
| `--session ID` | reopen a session |
| `-c`, `--continue` | reopen this folder's most recent session |
| `--project DIR` | work in `DIR` instead of the current folder |
| `--trust-project` | record trust for this project's canonical folder in `trusted-projects.json`, so its own `.mcp.json` can start programs |
| `--runtime KIND` | `durable` (default: a turn cut off by a crash carries on) or `transient` |
| `-v`, `--verbose` | also show each call the code makes and what commands print |
| `--json` | print each event as one JSON object per line, in the SDK's event shape: `type`, `time`, the ids that apply (`sessionId`, `turnId`, `stepId`, `toolCallId`) and `data` |
| `--history` | print the session's history, in the shared format |
| `--declaration` | print the declaration (below) as one JSON object |
| `--acp` | serve ACP on stdio, for an editor or host. Any project the client names is served, each with its own trust; the declaration names no `projectRoot`. |
| `-h`, `--help`; `-V`, `--version` | help; the version, which names the implementation's language |

With no `--model` and none in settings, `ma` uses the first Provider that is signed in, in the order `openai-codex`, `xai`, `claude`. With none signed in it exits with status 1 and says how to sign in.

**Interactive mode** is line-based. While the agent works, a line typed steers the running turn; `/after TEXT` queues a new turn; `/cancel` or Ctrl-C stops the turn. Commands: `/commands`, `/model`, `/thinking`, `/compact`, `/skills`, `/skill:NAME`. Model text streams to stdout; calls and diagnostics go to stderr.

**Print mode** (`-p`) runs one prompt and prints the final answer's text to stdout, followed by a newline. Exit status is 0 for a completed turn and 1 otherwise. Approval is not part of the standard set, so print mode never waits for a person.

## Files

| File, under the configuration folder | Purpose |
|---|---|
| `settings.json` | Session defaults: `model`, `thinking`, `step_limit`, `output_limit`, `model_tools` |
| `auth.json` | Sign-ins, written by `ma login`. Mode 0600. Format below. |
| `mcp.json` | `{"mcpServers": {...}}` in the form Pi and other clients use. `${NAME}` takes a value from the environment. |
| `models.json` | Catalog additions or replacements: `{"openai-codex": [{"id", "name", "contextWindow", "maxTokens", "effort"}], "xai": [...]}` |
| `AGENTS.md` | Standing instructions for every project |
| `skills/` | Skills |
| `trusted-projects.json` | Projects trusted with `--trust-project`: an object mapping each canonical project path to `true`. Written by replacing the file atomically. |

| File, in the project | Purpose |
|---|---|
| `AGENTS.md` (or `CLAUDE.md`), and the same in each folder above it | Project instructions |
| `.agents/skills/`, `.modular-agent/skills/` | Project skills |
| `.modular-agent.json` | Project session defaults, read whether or not the project is trusted. It starts nothing: the standard configuration loads no plugins from project settings. |
| `.mcp.json` | Project MCP servers, used only once the project is trusted |

`~/.agents/skills/` holds more skills for every project.

- **The configuration folder** is `$XDG_CONFIG_HOME/modular-agent`, or `~/.config/modular-agent`.
- **The state folder** is `$XDG_STATE_HOME/modular-agent/<language>`, or `~/.local/state/modular-agent/<language>`, where `<language>` is `rust`, `typescript`, `go` or `python`. It holds sessions, command state and the full output of commands whose output was cut.
- **`MODULAR_AGENT_DATA_DIR`** puts both in that one folder, as the ACP binding requires of a host that isolates an agent: the configuration files directly in it, and the state in `state/` under it. It affects only `ma`, not other programs reading `XDG_CONFIG_HOME` or `XDG_STATE_HOME`.
- **Earlier Rust sessions.** Before this page, the Rust `ma` kept state directly in `modular-agent/`. To keep those sessions, stop the agent and move `sessions/` and `commands/` together into `modular-agent/rust/`.

**`auth.json`** is `{"logins": {PROVIDER: LOGIN}, "answers": {NAME: VALUE}}`. A login is `{"type": "oauth", "access", "refresh", "expires", "account"?}`, with `expires` in milliseconds since the epoch already brought forward by the refresh margin, or `{"type": "api_key", "key"}`. Every implementation writes it with mode 0600 and, while refreshing a token, holds an exclusive lock on `auth.lock` beside it, so two agents in any languages never spend one refresh token.

## Providers

| Provider | Models | Sign-in |
|---|---|---|
| `openai-codex` | ChatGPT subscription models over the Responses API | `ma login openai-codex`: browser, or a device code with `--device`. Tokens refresh. |
| `xai` | Grok subscription models over the Responses API | `ma login xai`: a device code |
| `claude` | Claude subscription models, through the Claude Agent SDK | `ma login claude` runs `claude auth login`; Claude Code keeps the sign-in |

Request shapes, headers, endpoints and client ids follow Pi 1.5.2, as the Rust `provider-responses` crate does. The Claude Provider is the sidecar. The terminal starts it to run a Claude model or list its models; ACP starts it when the launch or the session's saved settings select a Claude model. An agent started without it cannot switch to a Claude model until it is started again.

## Tools

The model is offered one tool, `codemode`, which runs Python in a [Monty](https://github.com/pydantic/monty) sandbox. Every other tool is a function on its `tools` object, and each call is a [nested call](../contracts.md#nested-calls) through the agent.

| Function | Input | Does |
|---|---|---|
| `read` | `path`, `offset?`, `limit?` | Reads a text file, or an image as a dict |
| `exec` | `command`, `timeout?` | Runs a shell command; returns `output`, `exit_code`, `truncated`, `wall_time_seconds` and `full_output_path` when cut |
| `edit` | `path`, `edits` (`[{oldText, newText}]`) | Replaces exact text |
| `write` | `path`, `content` | Writes a file, creating folders |
| `find` | `pattern`, `path?`, `limit?` | Finds files by glob |
| `list` | `path?`, `limit?` | Lists a folder |
| `mcp_SERVER__TOOL` | the server's schema | Calls an MCP server's tool |

The inputs, limits and wording are Pi's, as the Rust `tools-files` crate has them. In the sandbox:

- Arguments go by keyword, or by position: the schema's required fields in order, then its optional fields in order. Passing `None` for an argument omits it.
- A function returns the result's structured value if it has one, otherwise its text. A call that fails, is refused or is cancelled raises `RuntimeError` with the result's text; `exec` with a non-zero exit returns its dict rather than raising.
- `describe_tool(name)` and `search_tools(query)` look functions up. With at most twelve functions the prompt describes each in full. With more, it lists every function by its signature and the first line of its description, cut to 160 characters, and `describe_tool` gives the rest.
- The value of the last expression and everything printed come back as the result. Each run starts fresh.
- Limits: 30 seconds of computation between calls, 500 nested tool calls a run (`describe_tool` and `search_tools` do not count), a recursion limit of 200, 1 MiB of printed output, and a result cut to 2,000 lines or 50 KB.
- The sandbox has no file, network, clock or process access of its own.

The session setting `model_tools` holds the names offered to the model, `["codemode"]` by default. `null` offers every tool that allows the model as a caller: `codemode`, the six tools and the MCP tools.

## Prompt, skills and MCP

- **The prompt** has Pi's structure, in this order: the rules, the global `AGENTS.md`, project `AGENTS.md` (or `CLAUDE.md`) files from the outermost folder in, the skills listing, the `codemode` functions, a `<cwd>` section with the absolute working folder, and a `<date>` section with the local date as `YYYY-MM-DD`.
- **Agent Skills** are found in the skills folders above. Each `SKILL.md` has a `name` and `description` in its front matter. The listing shows each skill's name, description and path. `/skill:NAME` puts that skill's body into the input. `ma skills` lists what was found and any that were skipped, with the reason.
- **MCP** servers come from `mcp.json`, and from the project's `.mcp.json` once it is trusted, over stdio and Streamable HTTP. Tools only. A server that fails to start is skipped with a warning. One whose tool names are not letters, digits, `_` or `-`, or are longer than 64 characters with the prefix, is skipped whole.

## The parts

Durable Runtime by default, transient with `--runtime transient`; history kept on disk in the state folder; the local working environment; context compaction; model selection; commands; questions; the terminal and ACP Interfaces. Approval, subagents and guardrails are not in the standard set, as in Pi.

## What it declares

With the durable Runtime on Linux, every implementation declares the same values, so a client sees the same agent whichever is installed. With `--runtime transient`, `continuesAfterRestart` and `waitingThroughRestart` are false.

| Key | Value | | Key | Value |
|---|---|---|---|---|
| `inputDuringTurn` | true | | `continuesAfterRestart` | true |
| `waitingThroughRestart` | true | | `questionsOutlastTurns` | true |
| `lateAnswersStartTurns` | true | | `startsTurnsUnasked` | `jobReports` |
| `queuedInputAfterRestart` | `handedBack` | | `queuedJobReportsAfterRestart` | `run` |
| `settingsDuringTurn` | `refused` | | `erasureDuringTurn` | `refused` |
| `movingWithUnfinishedWork` | `refused` | | `mixedActorInput` | `refused` |
| `rewinding`, `forking`, `erasure`, `portableSessions`, `nestedToolCalls`, `inputKeys` | true | | `commandContainment` | `strong` |
| `confinesFiles`, `severalActors`, `sessionLimits`, `tenants`, `holdsOutput`, `outputBypassesAgent`, `cancellingTurnCancelsJobs`, `pluginsDuringSession`, `keepsStateAtProvider`, `runsToolsAtProvider`, `liveSessions` | false | | `projectRoot` | omitted |

These are what the Rust implementation declares. An implementation that cannot meet one declares what it does meet, and the difference is a gap to close, not a choice.

The same values go out on every path: `ma --declaration`, the ACP `initialize` result, every session reply and every configuration update. Conformance mode changes none of them: the ACP kit checks the agent as shipped, so a test-only declaration would have it check a different agent.

## Hooks for testing

Each implementation honors these environment variables, so one set of [checks](../../conformance/reference/README.md) can drive all four without a model:

| Variable | Effect |
|---|---|
| `MODULAR_AGENT_SCRIPT` | A file holding a [model script](../sdk/testing.md#the-model-script). The only Provider is then the SDK's scripted Provider, with the model `scripted/script`; no sign-in is needed. |
| `MODULAR_AGENT_SCRIPT_LOG` | With `MODULAR_AGENT_SCRIPT`: a file to which each model request is appended as one JSON line, `{"system": string, "tools": [name], "messages": [message]}`. A message is `{"role": "user", "text"}`, `{"role": "assistant", "text", "toolCalls": [{"name", "input"}]}` or `{"role": "toolResult", "name", "text"}`; `text` joins the message's text parts. |
| `MODULAR_AGENT_CONFORMANCE` | `1` adds the conformance parts the [ACP kit](../../conformance/acp/README.md) needs ([conformance mode](../bindings/acp.md#conformance-mode)), so the kit can run against `ma --acp`. |

## Checks

Each implementation passes:

- the [reference checks](../../conformance/reference/README.md), which run `ma` with a scripted model and look only at its output and its effects on files;
- the ACP kit against `MODULAR_AGENT_CONFORMANCE=1 ma --acp`;
- its own tests, including that it depends only on its SDK's public API.

# The standard configuration

**Status: 0.1.** All four implementations exist and pass the [reference checks](../../conformance/reference/README.md): [Rust](../../rust/README.md), [TypeScript](../../typescript/packages/ma/README.md), [Go](../../go/cmd/ma/README.md) and [Python](../../python/packages/ma/README.md). [ADR 0026](../adr/0026-one-reference-product.md) records why there is one product. Where an implementation must guess, the guess becomes a change here first.

The standard configuration is the reference implementation of layer 4 ([ADR 0024](../adr/0024-five-layers.md)): a coding agent with Pi's feature set, for everyday use. There is one product and four implementations of it, one per language. A person can install any one of them and get the same program: the same commands, files, tools, prompt and behavior. Each is written the way its language is written.

## Rules for every implementation

- **Built only on its language's SDK.** It uses the public API of that SDK ([`docs/sdk`](../sdk/README.md)) and nothing else from the base build. When it needs something the SDK cannot give, the SDK gains it first, then the SDK specification records it.
- **One language.** It is written in its own language. Rust and Go load the [TypeScript Claude Provider](../../typescript/packages/claude/README.md) as a process plugin. TypeScript and Python can use their native Claude Agent SDKs.
- **The same product.** Commands, options, file names and formats, tool names, inputs, descriptions and limits, the prompt's structure and wording, and error messages a person reads are the same in all four. The Rust implementation's texts are the reference: the tool definitions in `rust/crates/tools-files` and `rust/crates/tools-code`, the prompt in `rust/crates/standard/src/prompt.rs` and the skills listing in `rust/crates/standard/src/skills.rs`. A difference is a bug in one of them, fixed by changing this page or the code that is wrong.
- **Shared configuration, separate state.** All four read the same configuration folder, so a person can switch implementation without setting anything up again. Each keeps its sessions in its own state folder, because their native session files differ.

## The program

The command is `ma` in every language. Only one is installed at a time.

```
ma [options]                 talk to the agent in this folder
ma [options] -p PROMPT       answer one prompt and exit
ma login PROVIDER [--device] sign in: chatgpt, grok or claude
ma logout PROVIDER
ma auth                      show what is signed in
ma models                    list the models on offer
ma skills                    list the skills found for this folder
ma mcp                       list the configured MCP servers
ma sessions [--all]          list saved sessions
```

| Option | Meaning |
|---|---|
| `--model PROVIDER/ID` | the model, such as `chatgpt/gpt-6.1-sol`, `grok/grok-4.7` or `claude/claude-sonnet-5-5` |
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
| `--acp` | serve ACP on stdio, for an editor or host. With no operator project restriction this local mode serves any project the client names, each with its own trust. |
| `--listen ADDR` | with `--acp`, serve ACP on a WebSocket instead of stdio ([an agent service](../bindings/websocket.md#an-agent-service)); with `--agui`, serve AG-UI over HTTP; with both, both on one listener. `ADDR` is a loopback `HOST:PORT`, or a `ws:` URL for ACP alone; `ma` has no TLS options. `ma` serves until stopped. |
| `--agui` | serve the AG-UI HTTP and SSE binding on `--listen ADDR`, including the [wait-closure feed](../bindings/agui.md#wait-closures) and, for kept sessions, [run receipts](../bindings/agui.md#run-receipts). It requires a listener and never uses stdio. With `--acp`, the same listener accepts ACP WebSocket upgrades at `/`. `ma` prints the HTTP origin when ready. `ma` has no TLS options; bind to loopback. Use `--token-file FILE` for the local user with client ID `ma-local`, or supply policy `actors` with a nonempty `clientId` on every entry. Tokens that share a client ID must bind the same principal and scope. The operator's `--project` selects the AG-UI creation project; the single-user configuration creates sessions without a tenant. See the [AG-UI binding](../bindings/agui.md). |
| `--resume-open` | with `--acp` or `--agui`, reopen at start-up every kept session in the operator's project that has an interrupted turn, so durable turns carry on without waiting for a client. See [Resuming at start-up](#resuming-at-start-up). Also the setting `resume_open`. |
| `--approval POLICY` | load the approval feature with this default policy: `off`, `ask`, `all` or `never`. Overrides the setting `approval`. See [Approval](#approval). The help line is `set each new session's default approval policy: off, ask, all or never`. |
| `--token-file FILE` | with `--listen`, shorthand for one token acting as the local user. Do not combine with a policy `actors` list. |
| `--policy FILE` | read this operator policy instead of `policy.json` in the configuration folder. |
| `-h`, `--help`; `-V`, `--version` | help; the version, as `ma VERSION (LANGUAGE)` with the language in lowercase |

ACP project scope, tenant reach and any narrower rights come from operator configuration, never from project files. `ma` MUST enforce an operator restriction before reading project settings or composing that project. Its single-user profile does not enable configured representation. The unrestricted local shorthand is for a trusted launcher, not an untrusted stdio proxy. See [ACP starting](../bindings/acp.md#starting) and [ACP authorization](../bindings/acp.md#authorization).

With no `--model` and none in settings, `ma` uses the first Provider that is signed in, in the order `chatgpt`, `grok`, `claude`. With none signed in it exits with status 1 and says how to sign in.

**Listing sessions.** `ma sessions` prints one line for each saved session of the project: the session ID, two spaces, and the project's canonical folder. The most recently active session comes first; sessions active at the same time follow in ID order. `--all` lists the saved sessions of every project, in the same form and order. With no sessions to list, `ma sessions` prints nothing. It exits with status 0 in both cases.

```
$ ma sessions --all
0b6f1c2e9d4a47c1a5e3b8f2d7c90e14  /home/me/code/app
5d2e8a7b1c3f4e6d9a0b2c4e6f8a1b3d  /home/me/code/site
```

**Interactive mode** is line-based. While the agent works, a line typed steers the running turn; `/after TEXT` queues a new turn; `/cancel` or Ctrl-C stops the turn. Commands: `/commands`, `/model`, `/thinking`, `/compact`, `/skills`, `/skill:NAME`. Model text streams to stdout; calls and diagnostics go to stderr.

**Questions** in interactive mode go to stderr. An approval of a tool call takes `y` or `n` ([Approval](#approval)). The terminal shows one approval at a time. For other questions, the terminal shows `Question REQUEST_ID: QUESTION`, any options, and how to answer. The terminal registers a question before it shows it, so an `/answer` it reads after the line appears finds that question. More than one question can be open. `/answer REQUEST_ID VALUE` answers the named question, and `/answer REQUEST_ID decline` declines it. End of input declines every open question.

**Secret answers** are never typed on the visible line:

- For a secret question the terminal says `Use /answer REQUEST_ID (hidden input)`. `/answer REQUEST_ID` with no value then shows `Secret: ` and reads the next line with echo off. It turns echo back on once it has the line. The value goes to the credential store, as for any [secret answer](../contracts.md#secrets).
- `ma` refuses a secret given as `/answer REQUEST_ID VALUE`. It says `Do not put the secret on the command line; use /answer REQUEST_ID`, does not use the value, and leaves the question open. No option or setting supplies a secret answer.
- When standard input is not a terminal, `ma` cannot hide what is typed, so it declines a secret question as soon as it opens. It also declines the question when it cannot turn echo off, or when input ends before the line.

**Print mode** (`-p`) runs one prompt and prints the final answer's text to stdout, followed by a newline. Exit status is 0 for a completed turn and 1 otherwise. Without [approval](#approval) configured, print mode never waits for a person. With it, print mode has no one to answer, so a call that needs approval is refused, as the [approval policy](../contracts.md#approval-policy) requires.

## Files

| File, under the configuration folder | Purpose |
|---|---|
| `settings.json` | Session defaults: `model`, `thinking`, `step_limit`, `output_limit`, `model_tools`; and `resume_open` (boolean, default false), `approval` (`off`, `ask`, `all` or `never`; absent loads no approval feature) and `approval_wait` (`live` or `untilDeadline`, default `live`), these three read only from the global file, never from a project |
| `policy.json` | Operator-owned [connection policy and limits](#connection-policy-and-limits). |
| `auth.json` | Sign-ins, written by `ma login`. Mode 0600. Format below. |
| `mcp.json` | `{"mcpServers": {...}}` in the form Pi and other clients use. `${NAME}` takes a value from the environment. |
| `models.json` | Catalog additions or replacements: `{"chatgpt": [{"id", "name", "contextWindow", "maxTokens", "effort"}], "grok": [...]}` |
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

**`auth.json`** is `{"logins": {PROVIDER: LOGIN}, "answers": {NAME: VALUE}}`. A login is `{"type": "oauth", "access", "refresh", "expires", "account"?}`, with `expires` in milliseconds since the epoch already brought forward by the refresh margin, or `{"type": "api_key", "key"}`. Every implementation writes it with mode 0600 and, while refreshing a token, holds an exclusive lock on `auth.lock` beside it, so two agents in any languages never spend one refresh token.

## Connection policy and limits

`ma` reads one operator-owned JSON object for both ACP transports and for limits in all modes. Its optional keys are `stdio`, `actors`, `limits` and `approvalWaitMaxMs`. The file and referenced token files must be outside project and client control. Relative `tokenFile` paths resolve beside the policy. A malformed, unreadable or inconsistent policy MUST fail startup with a message naming the file and the problem. An explicitly named file must exist; only the default file may be absent.

- `stdio`: `{ actor: { id, kind, rights }, tenants?, projects?, represents?, traceTrusted? }`. Without this entry, stdio acts as the local user with all prospective rights, using `MODULAR_AGENT_ACTOR` if set and retaining the recorded-actor fallback. It serves any project but no named tenant. An explicit `stdio.actor` sets the principal and rights ceiling.
- `actors`: a list of `{ tokenFile, actor: { id, kind, rights }, tenants?, projects?, represents?, clientId?, traceTrusted? }` as in [SDK placement](../sdk/placement.md#the-whole-agent). A listener requires this list or the single-token shorthand. Every token must be distinct. The shorthand acts as the local user with no named tenant and ignores `MODULAR_AGENT_ACTOR`.
- `projects` lists exact canonical absolute paths, not subtrees. Omission uses the composition's project scope. `tenants` lists tenant IDs or `null` for no tenant; omission permits only no tenant. An empty list grants no scope. `rights` lists [core rights](../contracts.md#authority) and caps, but does not change, recorded grants. `represents` lists additional actor IDs, empty if omitted. `traceTrusted` puts the connection in the operator's [trace trust scope](../telemetry.md#context-on-the-wire): `ma` then continues the trace context the peer sends on work requests, so a host's trace runs through `ma`'s turns. It defaults to true for `stdio` and false for each `actors` entry and the single-token shorthand. It grants no rights and does not change what the connection may do. `ma` does not declare `severalActors` and MUST reject a nonempty `represents` list.

`approvalWaitMaxMs` is the longest an [approval may wait](#approval), in milliseconds; omitted, approvals are live only.

`limits` has `session`, `tenant` and `agent` objects. Each accepts the nonnegative integer fields below. Omitted fields use finite defaults. The unassigned tenant has its own bucket. `MiB` means 1,048,576 bytes.

| Field | Unit | Session | Tenant | Agent |
|---|---|---:|---:|---:|
| `inputs` | Pending input slots, including reserved job reports | 32 | 128 | 512 |
| `calls` | Unfinished model attempts and tool calls together | 64 | 256 | 1,024 |
| `jobs` | Unfinished jobs | 16 | 64 | 256 |
| `bufferedBytes` | Buffered bytes | 16 MiB | 64 MiB | 256 MiB |
| `storageBytes` | Retained and reserved storage bytes | 1 GiB | 8 GiB | 32 GiB |
| `controlBytes` | Bytes within `storageBytes` kept for control work | 8 MiB | 32 MiB | 128 MiB |

The ordinary pool cannot use control headroom or outstanding settlement reservations. Operators MUST provision the write space and processing capacity these limits require, especially with shared history. See [Resource reservations](../contracts.md#resource-reservations).

## Providers

| Provider | Models | Sign-in |
|---|---|---|
| `chatgpt` | ChatGPT plan models | `ma login chatgpt`: browser, or a device code with `--device`. Tokens refresh. |
| `grok` | The X Subscription's Grok models | `ma login grok` |
| `claude` | Claude plan models, through the Claude Agent SDK | `ma login claude` runs `claude auth login`, Anthropic's own sign-in; Claude Code keeps it |

These are the SDK's [subscription Providers](../sdk/subscription-providers.md), with their sign-in, login file, refresh, request shapes and model table; `ma` adds none of its own. `auth.json` is their login file. For subscriptions, use only `chatgpt`, `grok` and `claude` for selection, configuration, stored sessions and login records ([ADR 0031](../adr/0031-subscription-providers.md)).

**Signing in to ChatGPT** works where the browser is not on the agent's machine, as over SSH:

- `ma login chatgpt` prints the sign-in address and, when standard input is a terminal, also asks the person to paste. The browser returns to `http://localhost:1455/auth/callback`. If the browser runs on the agent's machine, `ma` hears that on port 1455 and finishes. If it runs elsewhere the page fails to load; the person copies the address from the browser's address bar and pastes it. Whichever comes first finishes the sign-in.
- A pasted line may be the whole address, its query (`code=…&state=…`), `code#state`, or the bare code. A state that is present must match the sign-in's; a mismatch, or an `error` in the address, is reported and the prompt asks again.
- If port 1455 is in use, pasting is the only way back. If it is in use and standard input is not a terminal, `ma` uses the device code sign-in.
- `--device` uses the device code sign-in: a code typed at a page on any machine. The ChatGPT account must allow device code sign-in in its security settings.
- `ma` opens a browser itself only when there is a local display and no SSH session (`SSH_CONNECTION` or `SSH_TTY`), and never when `MA_NO_BROWSER` is set.
- Over SSH, `ssh -L 1455:localhost:1455` also works: the browser's return then reaches the agent's machine directly.

**The client identity.** Requests and sign-ins name the client to the service: `originator` on ChatGPT requests and in the sign-in address, `referrer` when starting a Grok sign-in. It is `modular-agent` unless `MA_CLIENT_IDENTITY` names another: 1 to 64 characters from `A`–`Z`, `a`–`z`, `0`–`9`, `.`, `_` and `-`. `ma` refuses to start, with exit status 1 and a message naming the variable, if the value is anything else. The ChatGPT and Grok constructors accept the client identity, so an agent built from this code sets its own name in one place, and the SDK never reads `MA_CLIENT_IDENTITY` itself. Pass the same identity to sign-in. Grok sends it only when starting a device sign-in. The identity is a label, not a credential: the sign-in client IDs are the services' own, as Pi uses them. The Claude Provider is the sidecar. The terminal starts it to run a Claude model or list its models; ACP starts it when the launch or the session's saved settings select a Claude model. An agent started without it cannot switch to a Claude model until it is started again.

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

- The Python is Monty's, at the same pinned version in every implementation, so a script behaves the same in all four.
- `tools` is there without an import. `import tools` gives the same functions, though not necessarily the identical module object. Functions are values: `f = tools.read` then `f(path='a.txt')` makes the same call as `tools.read(path='a.txt')`. A tool is reached only through `tools`: a bare `read(...)` raises `NameError`.
- Arguments go by keyword, or by position: the schema's `required` fields in that array's order, then its other fields in alphabetical order, since JSON gives an object's members no order every language keeps. The prompt's signatures list them in the same order, such as `read(path, limit=None, offset=None)`. A single dict as the only argument supplies the arguments by name, unless the first parameter itself takes an object. Passing `None` for an argument omits it. Too many arguments, or a missing required one, raises `TypeError`, and so does an argument the agent cannot carry exactly as JSON, such as an integer beyond what the host's JSON numbers hold; the call is then not made.
- A function returns the result's structured value if it has one, otherwise its text. A call that fails, is refused or is cancelled raises `RuntimeError` with the result's text; this includes an `exec` that times out. An `exec` that ran to a non-zero exit returns its dict rather than raising.
- `describe_tool(name)` and `search_tools(query)` look functions up. With at most twelve functions the prompt describes each in full. With more, it lists every function by its signature and the first line of its description, cut to 160 characters, and `describe_tool` gives the rest.
- The result is everything printed, then the value of the last expression unless it is `None`, or `(no output)` if both are empty. A string value is given as it is. Any other value is given as `json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False)` would give it, with tuples as lists, if that succeeds, and as `repr(value)` otherwise: so `1.0` is `1.0`, `2**70` is all its digits, and `b'hi'`, `{1}`, `float('nan')` and `{(1,): True}` are their `repr`. The agent builds this text from the value the worker returns, so a class instance appears as its class name and attributes, such as `P(x=1, y='a')`, without calling the class's own `__repr__`; code that wants that calls `print(repr(value))`. Each run starts fresh.
- An image dict returned as the value, or among the top-level items of a returned list or tuple, is attached to the result as an image rather than given as JSON; its note, if any, is in the text.
- An exception the code does not catch ends the run: the result is what was printed, then Monty's traceback of the exception, whose last line is `Type: message`, or just `Type` when the exception has no message.
- Limits: 30 seconds on the interpreter's active wall clock between nested tool calls. Waiting for a tool, an import, a name lookup or `describe_tool` and `search_tools` does not count, and only a nested tool call starts the next 30 seconds. Monty's worker restarts its own clock at every resume, so the agent adds up the active time the worker reports and checks the total each time the worker pauses or finishes; a separate deadline stops a worker that stops answering. 256 MiB of memory (Monty's `max_memory`, which counts what the interpreter allocates). 500 nested tool calls a run (`describe_tool` and `search_tools` do not count). A recursion limit of 200. 1 MiB of printed output: the agent stops the run as soon as it receives output past the limit, and the result starts with `RuntimeError: printed output exceeded 1048576 bytes`, then the output printed before the limit, cut at a UTF-8 character boundary. The whole result keeps at most 2,000 whole lines or 50 KB, then a cut notice; when an uncaught error's traceback does not fit, its last line comes first. The agent may refuse a worker value larger than it can decode.
- The sandbox has no file, network or process access, no wall clock, no sleep and no system entropy: `open`, `time.time()`, `time.sleep()` and a draw from an unseeded generator raise. Process and thread clocks read zero. A generator the code seeds itself, such as `random.Random(7)`, works.
- The sandbox runs in a worker process, never in the agent's process, so neither a limit that fires nor a fault in the interpreter can stop the agent. A run that hits a memory or time limit fails with the limit's error, such as `MemoryError`, and the worker's session is discarded, never reused. If the worker process dies during a run, the call fails with an error that says so, and the next run gets a new worker. Cancelling a call ends its run.

The session setting `model_tools` holds the names offered to the model, `["codemode"]` by default. `null` offers every tool that allows the model as a caller: `codemode`, the six tools and the MCP tools.

## Rewind points

Moving back in a session with `rewind` also puts the project's files back as they were. That needs a saved point at the start of each turn. The local working environment keeps points in the project's git repository:

- **What a point holds:** a commit of the project's files as they are on disk, tracked and untracked, except those git ignores. It is written with a private index: the person's own index, `HEAD` and branches are never touched, and no commit appears in `git log`.
- **Where:** under `refs/modular-agent/points/<session>/<point>` in the repository. Git keeps it through `gc`, and it survives the agent's restart. Unchanged files cost nothing; new untracked files are stored once.
- **Restoring** writes back every file the point has and removes files made since, within the project only. Ignored files, such as build output, are left alone. The files as they were just before are kept under `refs/modular-agent/recovery/` until the restore succeeds.
- **No git, no points.** A project outside a git work tree, or one that holds the agent's own state folder (such as a home folder), has no points: its sessions declare `rewinding: false`, and `ma` says nothing about it.
- **Removing them:** `git for-each-ref --format='%(refname)' refs/modular-agent/ | xargs -r -n1 git update-ref -d`, then `git gc`.

## Prompt, skills and MCP

- **The prompt** has Pi's structure, in this order: the rules, the global `AGENTS.md`, project `AGENTS.md` (or `CLAUDE.md`) files from the outermost folder in, the skills listing, the `codemode` functions, a `<cwd>` section with the absolute working folder, and a `<date>` section with the local date as `YYYY-MM-DD`.
- **Agent Skills** are found in the skills folders above. Each `SKILL.md` has a `name` and `description` in its front matter. The listing shows each skill's name, description and path. `/skill:NAME` puts that skill's body into the input. `ma skills` lists what was found and any that were skipped, with the reason.
- **MCP** servers come from `mcp.json`, and from the project's `.mcp.json` once it is trusted, over stdio and Streamable HTTP. Tools only. A server that fails to start is skipped with a warning. One whose tool names are not letters, digits, `_` or `-`, or are longer than 64 characters with the prefix, is skipped whole.

## The parts

Durable Runtime by default, transient with `--runtime transient`; history kept on disk in the state folder; the local working environment; context compaction; model selection; commands; questions; the terminal and ACP Interfaces. Approval is loaded only when the operator configures it ([Approval](#approval)). Subagents and guardrails are not in the standard set, as in Pi.

## Telemetry

`ma` uses the SDK's [metadata-only telemetry profile](../telemetry.md) and sets `gen_ai.agent.name` to `ma`. It exports no session content and writes no disclosure markers. It does not enable GenAI content capture or export logs through this profile.

Export is off unless the operator sets an OTLP endpoint. `ma` MUST NOT fall back to the OpenTelemetry default endpoint. It reads these variables from its launch environment, not project settings:

| Variable | Effect |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base OTLP endpoint for traces and inference metrics. For HTTP, append `v1/traces` or `v1/metrics` as the OTLP rules specify. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Override the base endpoint for that signal. Use a signal-specific HTTP URL as supplied. Without a base or signal-specific endpoint, do not export that signal. An empty value is unset. |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | OTLP transport. `ma` supports `http/protobuf` (default) and `grpc`. `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` and `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL` override it for each signal. |
| `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_TIMEOUT` | Export request headers and timeout in milliseconds. The corresponding `OTEL_EXPORTER_OTLP_TRACES_HEADERS`, `OTEL_EXPORTER_OTLP_TRACES_TIMEOUT`, `OTEL_EXPORTER_OTLP_METRICS_HEADERS` and `OTEL_EXPORTER_OTLP_METRICS_TIMEOUT` override these per signal. Never copy headers into telemetry payloads or diagnostics. |
| `OTEL_SERVICE_NAME` | Resource `service.name`, default `ma`. It does not change the agent name. |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | OpenTelemetry trace sampling. Default `parentbased_always_on`; `always_off` records no spans. The argument applies only to samplers that take one. Metrics do not depend on trace sampling. |
| `OTEL_SDK_DISABLED` | `true` disables telemetry recording and export, even with endpoints set. |

Use the [OpenTelemetry SDK environment rules](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/) and the [OTLP exporter rules](https://opentelemetry.io/docs/specs/otel/protocol/exporter/) for these values. Do not enable baggage or take additional attributes from project settings. Export failure does not change turn outcomes. The declaration reports support whether export is on or off.

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
| `rewinding` | true when the session's project is in a git work tree ([rewind points](#rewind-points)); false otherwise |
| `forking`, `portableSessions`, `nestedToolCalls`, `inputKeys` | true | | `commandContainment` | `strong` on Linux; `processGroup` on macOS, where a process that leaves its command's process group is not stopped |
| `confinesFiles`, `severalActors`, `sessionLimits`, `holdsOutput`, `outputBypassesAgent`, `cancellingTurnCancelsJobs`, `pluginsDuringSession`, `keepsStateAtProvider`, `runsToolsAtProvider`, `liveSessions` | false | | `projectRoot` | omitted |
| `telemetry` | `1`, independent of export |

With [approval](#approval) configured, the agent also declares `approvalCoversNested: true`, and `approvalsOutlastTurns: true` when `approvalWaitMaxMs` is set. Without it, both are omitted.

`tenants` is false unless the operator's [policy](#connection-policy-and-limits) names tenants; then `ma` enables those tenants' buckets and applies each connection's tenant reach, and a connection with no tenant list still reaches only sessions without a tenant.

These are what the Rust implementation declares. An implementation that cannot meet one declares what it does meet, and the difference is a gap to close, not a choice.

`ma` MUST declare `erasure` only when its history configuration supports [pending erasure](../contracts.md#cross-session-coordination) across its readers and writers. It MUST NOT infer that support from a configured history HTTP endpoint.

The declaration MUST include the [reservation count ceilings](../bindings/acp.md#the-declaration) enforced by the SDK under `resourceReservations`. `ma --declaration` also prints the effective operator configuration under `limits`, including byte bounds and control headroom, but no tokens, policy principals or live usage. Operator limits are outside project settings; the project MUST NOT raise them.

The same values go out on every path, subject to the binding's projection for the declared scope: `ma --declaration`, the ACP `initialize` result, every session reply and every configuration update. Conformance mode changes none of them: the ACP kit checks the agent as shipped, so a test-only declaration would have it check a different agent.

## Hooks for testing

Each implementation honors these environment variables, so one set of [checks](../../conformance/reference/README.md) can drive all four without a model:

| Variable | Effect |
|---|---|
| `MODULAR_AGENT_SCRIPT` | A file holding a [model script](../sdk/testing.md#the-model-script). The only Provider is then the SDK's scripted Provider, with the model `scripted/script`; no sign-in is needed. |
| `MODULAR_AGENT_SCRIPT_LOG` | With `MODULAR_AGENT_SCRIPT`: a file to which each model request is appended as one JSON line, `{"system": string, "tools": [name], "messages": [message]}`. A message is `{"role": "user", "text"}`, `{"role": "assistant", "text", "toolCalls": [{"name", "input"}]}` or `{"role": "toolResult", "name", "text"}`; `text` joins the message's text parts. |
| `MODULAR_AGENT_CONFORMANCE` | `1` adds the conformance parts the [ACP kit](../../conformance/acp/README.md) needs ([conformance mode](../bindings/acp.md#conformance-mode)), so the kit can run against `ma --acp`. |

## Approval

Off by default: with no `approval` setting and no `--approval`, `ma` loads no approval feature and behaves as without one. When configured:

- `ma` loads the approval feature with the configured policy as each new session's default. On reopen, `ma` uses the [recorded policy or its fallback](../contracts.md#approval-policy). An ACP or AG-UI client with the `settings` right can change it per session through the `approval` option. `ask` asks for every `codemode` call, since `codemode` is not read-only.
- `ma` turns on [covered approvals](../contracts.md#approvals-that-cover-nested-calls) and declares `approvalCoversNested: true`. An allow for a `codemode` call covers the file and command calls its script makes in that run. The approval view shows the whole script and says that it covers them.
- With `approvalWaitMaxMs` (a positive number of milliseconds) in [the operator policy](#connection-policy-and-limits), `ma` also supports [approvals that wait](../contracts.md#approvals-that-wait) and declares `approvalsOutlastTurns: true`. A session waits only when its `approval_wait` setting is `untilDeadline`; the default is `live`. Without `approvalWaitMaxMs`, approvals are live only.
- In interactive mode the terminal asks on stderr and reads `y` or `n`; it is a present answerer for its own session.

## Resuming at start-up

Off by default: a restart is not an automatic wake service ([Recovery](../contracts.md#recovery-and-repeating-work)). With `--resume-open` or `resume_open: true`, `ma` serving `--acp` or `--agui` MUST, before it accepts connections:

- list the kept sessions in the operator's configured project, and reopen each one whose committed records show an interrupted turn, as an open by the operator's local actor with `watch`, so the normal recovery rules apply. A durable turn carries on; with `--runtime transient` the interrupted turn ends as failed, as on any reopen.
- skip a session it cannot open because another writer holds it, and report each session it resumed or skipped on stderr, one line each, without content.
- not reopen sessions that have only open questions or open Interface-run calls and no interrupted turn: those wait for a client, as without the option.

The option changes when recovery starts, not what it may do: authority, repeat-safety and the output gate are those of an ordinary reopen. It has no effect on interactive or print mode, which open one session already.

## Checks

Each implementation passes:

- the [reference checks](../../conformance/reference/README.md), which run `ma` with a scripted model and look only at its output and its effects on files;
- the ACP kit against `MODULAR_AGENT_CONFORMANCE=1 ma --acp`, and with `--connect` against `ma --acp --listen`;
- the [AG-UI kit](../../conformance/agui/README.md) against `ma --agui --listen`, including the thread listing, the [wait-closure feed](../bindings/agui.md#wait-closures) and [run receipts](../bindings/agui.md#run-receipts) (from 0.3.0);
- its own tests, including that it depends only on its SDK's public API.

The reference check `approval-covers-script` configures `--approval ask` and a script that writes two files: a denied `codemode` call writes nothing; an allowed one writes both without further questions, and each write's `toolStarted` names the covering request. With `approvalWaitMaxMs` and `approval_wait: untilDeadline` it stops `ma` while the approval waits, answers from a new process, and checks the script runs once.

The reference check `resume-open` starts a durable scripted turn under `ma --agui --listen`, kills `ma` with `SIGKILL` during a tool call, restarts it with `--resume-open`, and checks that the turn finishes and its effect happens once without any client connecting; without the option, the turn stays interrupted until a client opens the session.

The reference check `telemetry-export` runs a scripted turn without endpoints and checks that it sends nothing to the default OTLP endpoint. The check uses a private network namespace for this assertion and skips only this assertion if it cannot create one. With a loopback endpoint and always-on sampler, check the invocation and inference spans, `gen_ai.agent.name=ma` and no content, and check the configured `service.name` on the OTLP resource as the receiver gets it; a backend's span query may not return resource attributes. Repeat with `OTEL_SDK_DISABLED=true`; export stops and the declaration stays the same.

# `ma` in TypeScript

This is the TypeScript implementation of the [standard configuration](../../../docs/reference/standard-configuration.md). It composes `@modular-agent/core`, the SDK's file and MCP plugins, and Monty for `codemode`. It does not import the TypeScript base or its CLI.

## Build, install and run

From the repository root, with Node.js 26, npm and Bash:

```sh
cd typescript
npm ci
npm run build
node packages/ma/dist/src/main.js --help
npm link --workspace @modular-agent/ma
```

The link installs `ma` on npm's global bin path. Remove any other implementation's `ma` link first. The direct Node command above also works without a link. The TypeScript packages have not been published; keep the checkout and its built dependencies when using the link.

```sh
ma login chatgpt               # add --device to use a code
ma login grok                  # device sign-in
ma models
ma -p 'Summarize the files in this folder.'
ma -c                          # continue the last session in this folder
ma --acp                       # ACP over stdio
ma --acp --listen 127.0.0.1:7401 --token-file /path/to/token  # ACP over WebSocket
ma --agui --listen 127.0.0.1:7401 --token-file /path/to/token # AG-UI over HTTP and SSE
ma --agui --acp --listen 127.0.0.1:7401 --policy /path/to/policy.json
```

With `--agui`, ma prints the HTTP origin. Send authorized requests to `/agui/v1`. Add `--acp` for ACP on the same port. Policy actors need a stable `clientId`; the single-token shorthand uses `ma-local`. The AG-UI creation project is the operator's project. See [Serving AG-UI](../core/README.md#serving-ag-ui) for the SDK and the proposed standard configuration text.

The WebSocket listener requires a loopback address and an owner-only bearer token file. It acts as `ma`'s local ACP user, irrespective of `MODULAR_AGENT_ACTOR`.

`ma` uses `chatgpt({ logins })` and `grok({ logins })` from `@modular-agent/subscription`. Subscription login writes and refreshes use `auth.lock` next to the private `auth.json`. The lock is shared with the other SDKs. Linux needs util-linux `flock`; macOS uses `/usr/bin/perl` to call `flock(2)`. `ma login claude` runs `claude auth login`. The TypeScript `ma` uses the Claude Agent SDK in process and does not need a sidecar.

`openai-codex` and `xai` still work in `--model`, `ma login`, `ma logout`, `settings.json`, `models.json`, and saved sessions. `ma` moves old login keys to `chatgpt` and `grok` on the next write. If old and new keys coexist, the new key wins. `ma models` prints only the new ids.

Configuration is shared in `$XDG_CONFIG_HOME/modular-agent`, or `~/.config/modular-agent`. State is kept in `$XDG_STATE_HOME/modular-agent/typescript`, or `~/.local/state/modular-agent/typescript`. `MODULAR_AGENT_DATA_DIR` sets the configuration directory and puts state under its `state/` subdirectory. Use `--runtime transient` to keep history without resuming a turn cut off by a crash.

## Built so far

`ma` names the agent `ma` on GenAI spans and defaults the OTLP resource `service.name` to `ma`. [Standard `OTEL_*` settings](../../../docs/reference/standard-configuration.md#telemetry) control export from the launch environment. A signal with no endpoint does not export. HTTP uses binary protobuf by default; `grpc` is also supported. `OTEL_SDK_DISABLED=true` leaves recording and export off. No prompts, tool content, secrets, baggage or logs go through this profile. The agent and session still declare `telemetry: 1` with export off.

## Client identity

`ma` sends `modular-agent` as the ChatGPT request and browser sign-in `originator`, and as the Grok device sign-in `referrer`. To use another name, set `MA_CLIENT_IDENTITY` when running `ma`, including when signing in. For example:

```sh
export MA_CLIENT_IDENTITY=my-agent_2.0
ma login chatgpt
```

Use 1 to 64 characters from `A`–`Z`, `a`–`z`, `0`–`9`, `.`, `_` and `-`. An empty or invalid value makes `ma` name `MA_CLIENT_IDENTITY` on stderr and exit with status 1.

For another app, use `chatgpt({ logins, clientIdentity })` and `signIn("chatgpt", logins, { clientIdentity, onStep })`, or `grok({ logins })` and `signIn("grok", logins, { clientIdentity, onStep })`. Grok sends the identity only when starting the sign-in. The SDK does not read `MA_CLIENT_IDENTITY`. The identity is a label, not a credential or a sign-in client ID.

## Code sandbox

`codemode` uses the native [Monty 1.6.0 worker protocol](https://github.com/pydantic/monty/blob/v1.6.0/crates/monty-proto/proto/monty/v1/monty.proto). Each run gets a fresh subprocess and session. `tools` is prebound and importable. Calls to its functions go through the agent as nested calls. The worker sends typed Python values, so result text keeps floats such as `1.0`, large integers, dictionary order and the Python representations of non-JSON values.

The worker measures active wall time. `ma` allows 30 seconds between nested tool calls. Waiting on the host does not count, and only a dispatched nested tool call resets the budget. The run allows 500 nested tool calls and 200 recursive frames. It has a [256 MiB Monty memory budget](https://github.com/pydantic/monty/blob/v1.6.0/docs/resource-limits.md#memory), not an RSS limit. At 1 MiB of printed output, `ma` stops the worker when it receives excess output and keeps the UTF-8 prefix. Result text is cut to 2,000 lines or 50 KB, including the cut note.

The sandbox has no direct file, network or process access. Wall clocks, sleep and system entropy are denied. Process and thread clocks return zero. `random.Random(7)` works without system entropy.

A memory or time limit ends the run with `MemoryError` or `TimeoutError`. If the worker dies, the call reports the death. Cancelling a call stops its worker. No run reuses a worker.

## What is checked

The loopback OTLP test checks that `ma` sends nothing without endpoints or with `OTEL_SDK_DISABLED=true`. It checks protobuf traces and metrics, endpoint and header overrides, the service and agent names, and prompt omission. A scripted run also sent `invoke_agent ma`, `chat script` and `execute_tool codemode` to local Phoenix. Phoenix’s span query does not return OTLP resource attributes. The trace and span IDs in that response matched the outbound protobuf carrying `service.name=ma-typescript`.

From the repository root:

```sh
npm ci --prefix conformance/acp
npm ci --prefix conformance/tools
(cd typescript && npm ci && npm run build && npm test)
(cd typescript && MA_REMOTE=provider-pi-ai,runtime-transient,tools-files,env-local npm test)
(cd typescript/sidecars/claude && npm ci && npm test)
node conformance/reference/run.mjs --agent typescript
MODULAR_AGENT_CONFORMANCE=1 node conformance/acp/run.mjs --crash-checks --probe-checks --job-checks -- node "$PWD/typescript/packages/ma/dist/src/main.js" --acp
scripts/websocket-kits.sh typescript
git diff --check
```

- Reference checks: **26/26**, including `resume-open`, `telemetry-export`, `client-identity`, all four codemode profile checks, `sandbox-memory` and both crash-recovery modes.
- ACP with crash, probe and job checks: **188/188** on stdio. Over WebSocket, ACP passed **193/193**, the plugin kit passed **153/153**, and listener isolation passed **14/14**.
- TypeScript workspace: **447 offline tests passed** in both normal and `MA_REMOTE` configurations. Five live tests skipped. That includes **51/51** shared scenario runs across embedded, TypeScript stdio and TypeScript WebSocket placements. The other SDK fixtures were not built for these runs. See the [SDK README](../core/README.md#what-is-checked) for fixture build commands.
- Claude sidecar: **51 offline tests passed** and one live check skipped. No real sign-ins or model requests ran, and no real credentials were read.
- `tsc -b` and `git diff --check` pass. The workspace has no separate lint or formatting command.

## Known gaps

- macOS local commands use process-group containment, not strong containment. A process that leaves its group is outside that guarantee.
- HTTP history on macOS needs no clock setting: the writer derives a sleep-aware clock ([SDK history configuration](../core/README.md#registering-or-serving-a-custom-history-store)).
- `ma` selects the Claude Provider at composition time. To switch to Claude from a launch that did not load it, start with `--model claude/ID` or reopen a saved Claude session. See the [Claude package gaps](../claude/README.md#known-gaps-and-open-problems).
- `find` honors `.gitignore` files at or below its search root, but not parent or global Git rules, `.ignore` or `.git/info/exclude`. Its glob parser, filesystem diagnostics and Monty's tracebacks can differ from Rust.

## Findings for docs/reference and docs/sdk

Proposed replacement text; the shared documents are unchanged in this branch.

**Reference — Providers.** Replace the last three sentences of **The client identity** with:

> The terminal and ACP load Claude when the launch or the saved session selects a Claude model. A composition without Claude cannot switch to a Claude model. TypeScript uses the Claude Agent SDK in process. Rust and Go launch the Claude process plugin.


**ACP declarations.** The base Interface called the session API for proposals, actor joins, limits and tenant queries regardless of the SDK's session declaration. Its extension dispatcher now returns `not_supported` for disabled operations, while leaving `proposals`, `release` and `withdraw` available for parked job reports. The base declares all three features true and still passes the positive checks.

**Reference — Checks.** Replace the ACP-kit bullet with:

> the ACP kit against `MODULAR_AGENT_CONFORMANCE=1 ma --acp` on stdio and `MODULAR_AGENT_CONFORMANCE=1 ma --acp --listen ADDR --token-file FILE` on WebSocket, both with `--crash-checks --probe-checks --job-checks`, including refusal of operations disabled by the session declaration;

**SDK — ACP factory.** Replace the `compose(project)` option sentence with:

> `compose(project, saved?)` builds an Agent for a canonical project the client names. For a load or resume, the host can pass the saved session metadata to select parts before recovery. The serving agent's history indexes the sessions that its project compositions open. Without `compose`, the agent refuses other project paths.

**SDK — Declaration choices.** Add these rows to the `createAgent` option table:

| Option | Type | Default |
|---|---|---|
| `questionsOutlastTurns` | boolean | false. Enables both `questionsOutlastTurns` and `lateAnswersStartTurns`. |
| `settingsDuringTurn` | `nextTurn` or `refused` | `nextTurn`. With `refused`, changing settings during a running turn raises `busy`. |

**SDK — Command time units.** In the scoped environment row, replace `exec(command, { timeout })` with:

> `exec(command, { timeout })`, with `timeout` in milliseconds,

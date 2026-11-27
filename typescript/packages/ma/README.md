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

Run the build and link commands from the permanent `main` checkout when installing or rebuilding the local `ma`. The link installs `ma` on npm's global bin path and points to the workspace build. Remove any other implementation's `ma` link first. Keep the checkout and its built dependencies while using the link. Use the direct Node command above to test a build in a temporary worktree.

```sh
ma login chatgpt               # add --device to use a code
ma login grok                  # device sign-in
ma models
ma -p 'Summarize the files in this folder.'
ma -c                          # continue the last session in this folder
ma --acp                       # ACP over stdio
ma --acp --resume-open         # start interrupted turns before accepting ACP requests
ma --acp --listen 127.0.0.1:7401 --token-file /path/to/token  # ACP over WebSocket
ma --agui --listen 127.0.0.1:7401 --token-file /path/to/token # AG-UI over HTTP and SSE
ma --agui --acp --listen 127.0.0.1:7401 --policy /path/to/policy.json
```

With `--agui`, ma prints the HTTP origin. Send authorized requests to `/agui/v1`. Add `--acp` for ACP on the same port. Policy actors need a stable `clientId`; the single-token shorthand uses `ma-local`. The AG-UI creation project is the operator's project. List kept threads with `GET /agui/v1/threads`; the counts identify open work without opening the thread. ACP returns the same waiting summary for its own connection on `session/list`. See [Serving AG-UI](../core/README.md#serving-ag-ui).

The authenticated thread snapshot also returns `waitCursor`. Pass it as `after` to `GET /agui/v1/threads/{threadId}/wait-closures` for committed reasons in order. It is not a presence or answer route. For kept sessions, `runReceipts: 1` offers `GET /agui/v1/threads/{threadId}/run-receipt?runId=…` to the posting client. Its `terminal` describes the exchange; its `work` describes the linked input or turn. Neither read starts a run. These offers are snapshot fields, not new ma flags or declaration keys.

The WebSocket listener requires a loopback address and an owner-only bearer token file. It acts as `ma`'s local ACP user, irrespective of `MODULAR_AGENT_ACTOR`.

`ma` uses `chatgpt({ logins })` and `grok({ logins })` from `@modular-agent/subscription`. Subscription login writes and refreshes use `auth.lock` next to the private `auth.json`. The lock is shared with the other SDKs. Linux needs util-linux `flock`; macOS uses `/usr/bin/perl` to call `flock(2)`. `ma login claude` runs `claude auth login`. The TypeScript `ma` uses the Claude Agent SDK in process and does not need a sidecar.

Configuration is shared in `$XDG_CONFIG_HOME/modular-agent`, or `~/.config/modular-agent`. State is kept in `$XDG_STATE_HOME/modular-agent/typescript`, or `~/.local/state/modular-agent/typescript`. `MODULAR_AGENT_DATA_DIR` sets the configuration directory and puts state under its `state/` subdirectory. Use `--runtime transient` to keep history without resuming a turn cut off by a crash.

### Approval

Without configuration, `ma` loads no approval feature. Use `--approval off|ask|all|never`, or set `approval` in the **global** `settings.json`. The command line wins. Explicit `off` still loads the feature, so a client can change the session's policy.

With `ask`, the terminal shows the complete `codemode` call on stderr, says the decision covers its nested calls and asks for `y` or `n`. An allow is for this run of the script only. Print mode has no approver and refuses calls that need one. It does not close an earlier session's parked call to start a print run.

To let a new session wait, set a positive `approvalWaitMaxMs` in the operator's `policy.json` and `"approval_wait": "untilDeadline"` in global settings. The default is `"live"`. Project settings cannot select either approval policy or wait mode. With approval configured, look for `approvalCoversNested: true` in the declaration. With a maximum it also declares `approvalsOutlastTurns: true`.

ACP clients can change the `approval` session option with `session/set_config_option`. AG-UI clients can post `{"approval":"ask"}` to `/agui/v1/threads/{threadId}/settings`. Both require the session's `settings` right. Answer a waiting approval on a fresh ACP polling or AG-UI presence route, not from history.

### Resuming at startup

Pass `--resume-open` with `--acp` or `--agui`, or put `{"resume_open":true}` in the global `settings.json`. The default is false. A project file cannot turn it on or off. The option has no effect in print or interactive mode.

Before accepting connections, ma checks kept sessions in the operator's project. It reopens interrupted turns as a local actor with watch authority. A durable turn carries on under ordinary recovery rules; a transient turn ends as failed. A session held by another writer is skipped. Stderr gets one line per resumed or skipped session, with the session ID and no conversation content. Open questions and Interface calls left by a finished turn wait for a client.

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
npm ci --prefix conformance/telemetry
(cd typescript && npm ci && npm run build && npm test)
(cd typescript && MA_REMOTE=provider-pi-ai,runtime-transient,tools-files,env-local npm test)
node conformance/reference/run.mjs --agent typescript
scripts/acp-kit.sh typescript core
scripts/acp-kit.sh typescript covered
scripts/acp-kit.sh typescript waiting
scripts/websocket-kits.sh typescript
typescript/scripts/check-agui.sh
git diff --check
```

- Earlier reference run: **28/28**, including `approval-covers-script`, `trace-trust`, `resume-open`, `telemetry-export`, `client-identity`, all four codemode profile checks, `sandbox-memory` and both crash-recovery modes.
- Stdio ACP: **190/190** core checks. The covered group runs both bindings against `ma`. The waiting group passes **50/50** using the disposable SDK fixture instead of enabling test controls in `ma`. Over WebSocket, ACP passed **195/195**, the plugin kit **157/157**, listener isolation **14/14**, and named callers **29/29**.
- At the four-language checkpoint the workspace passed **918 offline tests** both with in-process and remote base parts, with all four fixture programs built. Five live tests are opt-in. The TypeScript runner passed **405/405** shared scenarios across all four SDKs. See the [SDK README](../core/README.md#what-is-checked) for fixture build commands.
- AG-UI passed **49/49** adapter cases, including the structured approval call, wait closures and run receipts.
- Claude workspace package: **51 offline tests passed** and one live check skipped. No real sign-ins or model requests ran, and no real credentials were read.
- `tsc -b` and `git diff --check` pass. The workspace has no separate lint or formatting command.

## Platform and Provider limits

- macOS local commands use process-group containment. A process that leaves its group is not stopped. Stronger containment is tracked in [#255](https://github.com/daniel-ballance/modular-agent/issues/255).
- `ma` selects the Claude Provider at composition time. To run a Claude model when the current launch did not load it, start with `--model claude/ID` or reopen a saved Claude session. Switching without a restart is tracked in [#37](https://github.com/daniel-ballance/modular-agent/issues/37).

## Findings for docs/reference and docs/sdk

Tracked in #42.

Proposed replacement text; the shared documents are unchanged in this branch.

**Reference — Providers.** Replace the last three sentences of **The client identity** with:

> The terminal and ACP load Claude when the launch or the saved session selects a Claude model. A composition without Claude cannot switch to a Claude model. TypeScript uses the Claude Agent SDK in process. Rust launches the Claude process plugin.


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

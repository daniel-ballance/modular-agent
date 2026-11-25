# ma, the Go standard configuration

`ma` is the Go implementation of the [standard configuration](../../../docs/reference/standard-configuration.md). It composes the agent through the [Go SDK](../../modular/README.md), including its file, command and MCP tools. It does not import the base Harness or its API.

## Build and use

On Linux with unprivileged user, PID and mount namespaces, from `go/`:

```sh
./scripts/build-monty.sh
mise exec -- go build -o .bin/ma ./cmd/ma
.bin/ma --help
```

The script checks out [Monty v1.6.0](https://github.com/pydantic/monty/tree/v1.6.0) at its pinned commit and uses the Rust toolchain from `rust/mise.toml` to build it with `cargo build --locked --release`. It writes `go/.bin/monty`. To install `ma`, copy both executables into the same directory on `PATH`. `go install ./cmd/ma` on its own does not install the worker. No Rust toolchain, cgo, Python installation or worker download is needed at run time. Go uses Unix file locking on Linux and macOS.

```sh
ma login chatgpt                 # browser; add --device to enter a code
ma login grok                    # device code
ma auth
ma models
ma --project ./my-project
ma --project ./my-project -p 'Explain the tests.'
ma --project ./my-project -c
ma --project ./my-project --acp
ma --project ./my-project --acp --resume-open
ma --agui --listen 127.0.0.1:7400 --token-file /path/to/private.token
```

Claude needs Node.js 22 or later and the [Claude program](../../../typescript/packages/claude/README.md). Run `npm ci && npm run build` in `typescript`. Set `MODULAR_AGENT_CLAUDE_SIDECAR` to the absolute path to `packages/claude/dist/src/main.js` if the package is not in the checkout or installed under `~/.local/share/modular-agent/sidecars/claude/`. `ma login claude` hands sign-in to Claude Code. The sidecar receives `HOME`, `PATH` and, if set, `CLAUDE_CONFIG_DIR`; it is not given credential values. The terminal starts the sidecar for a Claude model or for `ma models`. ACP starts it when the launch or a reopened session selects Claude. A session whose composition has no Claude Provider cannot switch to it.

The four languages share `$XDG_CONFIG_HOME/modular-agent` (or `~/.config/modular-agent`). Go saves sessions, command state and spilled output under `$XDG_STATE_HOME/modular-agent/go` (or `~/.local/state/modular-agent/go`). `MODULAR_AGENT_DATA_DIR` puts configuration directly in that directory and puts state in its `state/` subdirectory. `ma --trust-project` records the canonical project path in `trusted-projects.json` outside the project. A project's own settings are read without granting it permission to start a server. One ACP connection can serve several canonical projects, each with its own settings, prompt and trusted MCP servers.

Use `chatgpt`, `grok` or `claude` for a subscription. A file readable by other users is refused; make it private with `chmod 600` before use.

## Approval

Without an approval setting, `ma` does not load the approval feature. Set `approval` in the global `settings.json` or pass `--approval off|ask|all|never`. The flag wins. An explicit `off` loads the feature without asking. `ask` asks before a `codemode` call; `all` asks even for read-only calls; `never` refuses without asking.

The approval view shows the full script and says that an allow covers the calls the script makes on this run. The interactive terminal asks on stderr; answer `y` or `n`. Print mode has no answerer and refuses a call that needs consent. Look for `approvalCoversNested: true` in the declaration and `approvalCoveredBy` on each covered nested start in history.

To offer waiting approvals, also set a positive integer `approvalWaitMaxMs` in the operator's `policy.json`. This declares `approvalsOutlastTurns: true`. The global setting `"approval_wait": "untilDeadline"` makes waiting the default for new sessions. The default without it is `"live"`. Project settings never select approval or its lifetime. An allow given after restart is for the original request, not a new script.

ACP clients can change a session's `approval` option with `session/set_config_option`. AG-UI clients can POST `{"approval":"ask"}` to `/agui/v1/threads/{threadId}/settings`. Both require the session's `settings` right. Neither changes another session or the operator's defaults.

## AG-UI listener

`--agui` serves HTTP and SSE in the operator's project. Add `--acp` for ACP WebSocket upgrades on the same port. Use `HOST:0` to choose a free loopback port; the first line on stdout is the HTTP origin. Every request needs the bearer token. `ma` has no TLS options. A policy can supply `actors` instead of `--token-file`; give each client a stable `clientId`. The single-token shorthand uses client `ma-local`. No browser tool is registered by default.

Run `go/scripts/check-agui.sh` from the repository root for the managed kit. It runs listener, thread listing, encoding, history and stock conversation against `ma`. The other cases need the SDK app's registered tool, scripted hooks, clock, store or test controls. Those controls are not in `ma`.

Use `GET /agui/v1/threads` to find this client's kept threads without opening them. Each row reports counts of eligible questions and Interface calls, and whether its turn is running, interrupted or absent. Use the thread snapshot to read content.

The thread snapshot offers two host reads. Use `waitCursor` with `GET /agui/v1/threads/{threadId}/wait-closures?after=...`. Apply notices in order and save the last applied cursor. After `cursor_expired`, get a new snapshot. On kept history, `runReceipts: 1` offers `GET /agui/v1/threads/{threadId}/run-receipt?runId=...` to the original authenticated client. It reports the released terminal class and the disposition of that run's work. Neither read marks presence, grants permission to answer or tells a client to execute a tool. There is no new flag or declaration key.

## Resuming at startup

Recovery normally waits for a client to open the session. Pass `--resume-open` with `--acp` or `--agui` to start it before accepting clients. To make that the default, put `{"resume_open": true}` in the global `settings.json`. A project setting cannot enable or disable it. The option does not change interactive or print mode.

`ma` checks the operator's project for interrupted turns. It uses the local operator's watch authority, not the rights of a future client. A durable turn continues under its recorded authority and repeat-safety rules. With `--runtime transient`, it ends as failed. A held writer is skipped. The service reports `resumed ID` or `skipped ID` on stderr, without prompts or tool details. It does not open an idle session just because that session has a question or an Interface call outstanding.

## Client identity

The default is `modular-agent`. ChatGPT receives it as `originator` on model requests and in the browser sign-in address. Grok receives it as `referrer` when starting device sign-in. It is a label, not a credential or an OAuth client ID.

Set `MA_CLIENT_IDENTITY` before running `ma`, including when you sign in. For example, run `export MA_CLIENT_IDENTITY=my-agent_2.0` in your shell. The value must be 1 to 64 characters from `A`–`Z`, `a`–`z`, `0`–`9`, `.`, `_` and `-`. Unset the variable to use the default. An empty or invalid value stops startup with status 1.

The SDK's `subscription.ChatGPT`, `subscription.Grok` and `subscription.SignIn` accept `ClientIdentity: &label` in their options. Use nil for the default. The SDK does not read `MA_CLIENT_IDENTITY`; `ma` reads it and passes the label to both Providers and to sign-in.

## Code sandbox

Each `codemode` call starts `monty subprocess` next to the running `ma`. The agent checks the binary's version and requires an acknowledgement of protocol 8 before sending Python. It never searches `PATH`, the project or the network for the worker. Only the worker compiles and runs Python. It sends length-prefixed protobuf frames over stdio; the agent makes each nested tool call and sends the result back. The worker receives no agent environment variables. `tools` is prebound and importable; its functions can be assigned and called later.

The 256 MiB memory limit is Monty's `max_memory`, not a limit on resident memory. The worker reports active wall time. Waiting for a nested tool, import, name lookup or catalog query does not count. Only a nested tool call resets the 30-second budget. A pipe deadline stops a worker that fails to reply. A run can make 500 nested calls and use 200 frames of recursion. Printing past 1 MiB ends the run with `RuntimeError: printed output exceeded 1048576 bytes` first, then the UTF-8 prefix that fit.

The last value is text for a string, Python-style JSON when encodable, and a representation of the original value otherwise. JSON retains dict order, integer digits and float spelling. The result keeps up to 2,000 whole lines or 50 KiB of text before a cut notice. The agent caps wire frames at 32 MiB and checks decoded and expanded value sizes. Python has no ambient files, network, processes, wall clock, sleep or system entropy. Process and thread clocks return zero. A seeded generator such as `random.Random(7)` works.

A memory or time limit fails the call. The agent discards and reaps the worker after each run, even on success. If it dies during a run, the call reports that the worker died; the next call starts a new worker. Cancelling the call kills and reaps the worker.

## What is checked

From the repository root:

```sh
(cd conformance/acp && npm ci && cd ../tools && npm ci && cd ../telemetry && npm ci)
(cd go && ./scripts/build-monty.sh && mise exec -- go build -o .bin/ma ./cmd/ma && mise exec -- go build -o .bin/modular ./cmd/modular && mise exec -- go build -o .bin/modular-agent-fixtures ./modular/cmd/fixtures)
node conformance/reference/run.mjs --agent go
MODULAR_AGENT_CONFORMANCE=1 node conformance/acp/run.mjs --crash-checks --probe-checks --job-checks -- "$PWD/go/.bin/ma" --acp
scripts/websocket-kits.sh go
(cd go && mise exec -- go build ./... && mise exec -- go vet ./... && test -z "$(mise exec -- gofmt -l .)")
(cd go && mise exec -- go test -count=1 ./...)
(cd go && mise exec -- go test -race -count=1 ./modular/... ./cmd/ma/...)
```

- **Telemetry:** a loopback OTLP receiver checks binary protobuf and `service.name`. No export provider is installed without an endpoint or when `OTEL_SDK_DISABLED=true`. Phoenix received `invoke_agent ma`, `chat script` and `execute_tool codemode` from an offline scripted prompt run with `OTEL_SERVICE_NAME=ma-go`.
- **Reference checks:** 28/28 against Go `ma`, including `approval-covers-script` (one allow for two writes, live and after restart), `resume-open`, `trace-trust`, telemetry export, client identity validation, tool function values, denied ambient access, codemode results and memory failure followed by recovery.
- **ACP with `--crash-checks --probe-checks --job-checks`:** 190/190 on stdio against Go `ma`. With `--approval off`, the coverage and waiting-declaration checks passed (193/193). The WebSocket run passed 195/195 for ACP, 153/153 for plugins and 14/14 for separate listeners. The AG-UI kit passed 34/34, including a covered nested call in the waiting continuation.
- **Sandbox regressions:** the Go tests cover imports and function values, schema-order arguments, JSON and repr, terminal memory and time limits, which suspensions reset the active clock, a tool wait longer than the compute budget, 500 nested calls, recursion at 200 and 201, a UTF-8 print cut, worker death and cancellation, malformed messages, denied OS operations and seeded random.
- **Go checks:** build, vet and formatting passed. The full Go suite passed 38 tested packages. The race run for `modular/...` and `cmd/ma/...` passed seven tested packages. `cmd/modular` takes several minutes; use the default package timeout.
- **No network:** the Go `codemode-tools-values` and `sandbox-memory` reference checks both passed in a separate Linux network namespace.
- **Subscriptions:** the login test checks the device and waiting instructions. SDK tests cover Grok device polling, request shape, encrypted reasoning and refresh, both ChatGPT sign-ins, and the Claude binding. No real sign-ins or model requests were made.

## Built so far

`ma` exports metadata-only OpenTelemetry when `OTEL_EXPORTER_OTLP_ENDPOINT` or a signal endpoint is set. It supports `http/protobuf` (default) and `grpc`, including per-signal overrides. It uses `ma` as the default service name and as the agent name. `OTEL_SDK_DISABLED=true` disables recording and export. The declaration does not change. See [Telemetry](../../../docs/reference/standard-configuration.md#telemetry).

`ma` uses `subscription.ChatGPT`, `subscription.Grok` and `subscription.Claude`. It handles terminal instructions; the SDK handles OAuth, token refresh and model requests.

## Known gaps

Tracked in #32.

- `find` uses `git ls-files` where Git can read a worktree and falls back to `find` otherwise. It does not interpret `.gitignore` outside a Git worktree. The existing SDK command environment is required for this tool. Very long command output is held by that environment before being cut and spilled.
- The SDK's question handler supports in-turn text and choice answers. Secret answers are staged and stored in `auth.json` through the SDK's credential store; the terminal reads them on the visible line (#52). The SDK's question tool keeps its existing definition, which is not word-for-word the Rust question tool.
- Only offline fixtures checked the subscription protocols in this round. ChatGPT and Grok streams honor request cancellation and a response-header timeout; a quiet stream after headers has no independent idle timeout.

## Findings for docs/reference and docs/sdk

Tracked in #33.

The base ACP server published the SDK's declaration but went straight to Harness operations for proposed input, joining another actor, changing the session limit and querying the tenant. It now checks the session declaration first and returns `not_supported` where appropriate, leaving `proposals`, `release` and `withdraw` usable for parked job reports. The base declares all three features true and still passes the positive checks.

Proposed replacement text, without changing the shared documents from this worktree:

**`docs/reference/standard-configuration.md`, Checks.** Replace the ACP-kit bullet with:
> the ACP kit against `MODULAR_AGENT_CONFORMANCE=1 ma --acp` with `--crash-checks --probe-checks --job-checks`, including refusal of operations disabled by the session declaration;

5. **`docs/sdk/api.md`, The agent.** Add after `serveAcp`:
   > On reopen, the composition factory can read the saved session ID before building the agent, so it can start a Provider selected by the saved settings. Inspecting the ID does not start recovery. Project compositions on one connection share the history store and are closed when the connection ends.
6. **`docs/sdk/api.md`, The agent.** Add after `sessionInfo`:
   > A file or HTTP history handle exposes `sessions` and `sessionInfo` before an Agent is constructed, so an application can choose the project or Provider for a reopen without starting recovery.

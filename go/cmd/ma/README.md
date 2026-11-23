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
ma --agui --listen 127.0.0.1:7400 --token-file /path/to/private.token
```

Claude needs Node.js 22 or later and the [Claude sidecar](../../../typescript/sidecars/claude/README.md). Build it with `npm ci --ignore-scripts && npm run build` in `typescript/sidecars/claude`. Set `MODULAR_AGENT_CLAUDE_SIDECAR` to the absolute path to its `dist/main.js` if it is not found next to the checkout or under `~/.local/share/modular-agent/sidecars/claude/`. `ma login claude` hands sign-in to Claude Code. The sidecar receives `HOME`, `PATH` and, if set, `CLAUDE_CONFIG_DIR`; it is not given credential values. The terminal starts the sidecar for a Claude model or for `ma models`. ACP starts it when the launch or a reopened session selects Claude. A session whose composition has no Claude Provider cannot switch to it.

The four languages share `$XDG_CONFIG_HOME/modular-agent` (or `~/.config/modular-agent`). Go saves sessions, command state and spilled output under `$XDG_STATE_HOME/modular-agent/go` (or `~/.local/state/modular-agent/go`). `MODULAR_AGENT_DATA_DIR` puts configuration directly in that directory and puts state in its `state/` subdirectory. `ma --trust-project` records the canonical project path in `trusted-projects.json` outside the project. A project's own settings are read without granting it permission to start a server. One ACP connection can serve several canonical projects, each with its own settings, prompt and trusted MCP servers.

ChatGPT, Grok and Claude come from the SDK. The former ids `openai-codex` and `xai` work in `--model`, `ma login`, `ma logout`, settings, `models.json` and reopened sessions. Reads find old sign-ins; the next write of `auth.json` moves them to `chatgpt` and `grok`, preferring the new slot if both exist. A file readable by other users is refused; make it private with `chmod 600` before use.

## AG-UI listener

`--agui` serves HTTP and SSE in the operator's project. Add `--acp` for ACP WebSocket upgrades on the same port. Use `HOST:0` to choose a free loopback port; the first line on stdout is the HTTP origin. Every request needs the bearer token. `ma` has no TLS options. A policy can supply `actors` instead of `--token-file`; give each client a stable `clientId`. The single-token shorthand uses client `local`. No browser tool is registered by default.

Run `go/scripts/check-agui.sh` from the repository root for the managed kit. It runs listener, encoding, history and stock conversation against `ma`. The other cases need the SDK app's registered tool, scripted hooks, clock, store or test controls. Those controls are not in `ma`.

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
export TMPDIR="$HOME/.cache/ma-std-tmp"
mkdir -p "$TMPDIR"
(cd conformance/acp && npm ci && cd ../tools && npm ci)
(cd go && ./scripts/build-monty.sh && mise exec -- go build -o .bin/ma ./cmd/ma && mise exec -- go build -o .bin/modular ./cmd/modular && mise exec -- go build -o .bin/modular-agent-fixtures ./modular/cmd/fixtures)
node conformance/reference/run.mjs --agent go
MODULAR_AGENT_CONFORMANCE=1 node conformance/acp/run.mjs --crash-checks --probe-checks --job-checks -- "$PWD/go/.bin/ma" --acp
scripts/websocket-kits.sh go
(cd go && mise exec -- go build ./... && mise exec -- go vet ./... && test -z "$(mise exec -- gofmt -l .)")
(cd go && mise exec -- go test -count=1 ./... > "$TMPDIR/ma-go-full.log" 2>&1)
(cd go && mise exec -- go test -race -count=1 ./modular/... ./cmd/ma/... > "$TMPDIR/ma-go-race.log" 2>&1)
```

- **Telemetry:** a loopback OTLP receiver checks binary protobuf and `service.name`. No export provider is installed without an endpoint or when `OTEL_SDK_DISABLED=true`. Phoenix received `invoke_agent ma`, `chat script` and `execute_tool codemode` from an offline scripted prompt run with `OTEL_SERVICE_NAME=ma-go`.
- **Reference checks:** 26 in the suite (25 checked here before `resume-open`), including `telemetry-export`, including client identity validation, tool function values, denied ambient access, codemode results and memory failure followed by recovery.
- **ACP with `--crash-checks --probe-checks --job-checks`:** 188/188 on stdio against Go `ma` with the SDK's Grok Provider. Earlier WebSocket runs passed 193/193 for ACP and 153/153 for plugins.
- **Sandbox regressions:** the Go tests cover imports and function values, schema-order arguments, JSON and repr, terminal memory and time limits, which suspensions reset the active clock, a tool wait longer than the compute budget, 500 nested calls, recursion at 200 and 201, a UTF-8 print cut, worker death and cancellation, malformed messages, denied OS operations and seeded random.
- **Go checks:** build, vet and formatting passed. The full Go suite passed 38 tested packages. The race run for `modular/...` and `cmd/ma/...` passed seven tested packages. `cmd/modular` takes several minutes; use the default package timeout.
- **No network:** the Go `codemode-tools-values` and `sandbox-memory` reference checks both passed in a separate Linux network namespace.
- **Subscriptions:** the alias tests cover both former ids in every listed entry point, including reopening a saved session. The login test checks that the SDK's device and waiting steps retain the terminal instructions. SDK tests cover Grok device polling, request shape, encrypted reasoning and refresh, both ChatGPT sign-ins, and the Claude binding. No real sign-ins or model requests were made.

## Built so far

`ma` exports metadata-only OpenTelemetry when `OTEL_EXPORTER_OTLP_ENDPOINT` or a signal endpoint is set. It supports `http/protobuf` (default) and `grpc`, including per-signal overrides. It uses `ma` as the default service name and as the agent name. `OTEL_SDK_DISABLED=true` disables recording and export. The declaration does not change. See [Telemetry](../../../docs/reference/standard-configuration.md#telemetry).

`ma` uses `subscription.ChatGPT`, `subscription.Grok` and `subscription.Claude`. It handles terminal instructions and aliases; the SDK handles OAuth, token refresh and model requests.

## Known gaps

- `find` uses `git ls-files` where Git can read a worktree and falls back to `find` otherwise. It does not interpret `.gitignore` outside a Git worktree. The existing SDK command environment is required for this tool. Very long command output is held by that environment before being cut and spilled.
- The SDK's question handler supports in-turn text and choice answers. `auth.json` preserves named answers written by Rust, but this configuration does not store new secret answers. The SDK's question tool keeps its existing definition, which is not word-for-word the Rust question tool.
- Only offline fixtures checked the subscription protocols in this round. ChatGPT and Grok streams honor request cancellation and a response-header timeout; a quiet stream after headers has no independent idle timeout.

## Findings for docs/reference and docs/sdk

The base ACP server published the SDK's declaration but went straight to Harness operations for proposed input, joining another actor, changing the session limit and querying the tenant. It now checks the session declaration first and returns `not_supported` where appropriate, leaving `proposals`, `release` and `withdraw` usable for parked job reports. The base declares all three features true and still passes the positive checks.

Proposed replacement text, without changing the shared documents from this worktree:

**`docs/reference/standard-configuration.md`, Checks.** Replace the ACP-kit bullet with:
> the ACP kit against `MODULAR_AGENT_CONFORMANCE=1 ma --acp` with `--crash-checks --probe-checks --job-checks`, including refusal of operations disabled by the session declaration;

5. **`docs/sdk/api.md`, The agent.** Add after `serveAcp`:
   > On reopen, the composition factory can read the saved session ID before building the agent, so it can start a Provider selected by the saved settings. Inspecting the ID does not start recovery. Project compositions on one connection share the history store and are closed when the connection ends.
6. **`docs/sdk/api.md`, The agent.** Add after `sessionInfo`:
   > A file or HTTP history handle exposes `sessions` and `sessionInfo` before an Agent is constructed, so an application can choose the project or Provider for a reopen without starting recovery.

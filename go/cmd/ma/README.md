# ma, the Go standard configuration

`ma` is the Go implementation of the [standard configuration](../../../docs/reference/standard-configuration.md). It composes the agent through the [Go SDK](../../modular/README.md), including its file, command and MCP tools. It does not import the base Harness or its API.

## Build and use

On Linux with unprivileged user, PID and mount namespaces, from `go/`:

```sh
./scripts/build-monty.sh
mise exec -- go build -o .bin/ma ./cmd/ma
.bin/ma --help
```

The script checks out [Monty v1.6.0](https://github.com/pydantic/monty/tree/v1.6.0) at its pinned commit and uses the Rust toolchain from `rust/mise.toml` to build it with `cargo build --locked --release`. It writes `go/.bin/monty`. To install `ma`, copy both executables into the same directory on `PATH`. `go install ./cmd/ma` on its own does not install the worker. No Rust toolchain, cgo, Python installation or worker download is needed at run time. Go's working environment and credential locking are Linux-specific.

```sh
ma login openai-codex            # browser; add --device to enter a code
ma login xai                     # device code
ma auth
ma models
ma --project ./my-project
ma --project ./my-project -p 'Explain the tests.'
ma --project ./my-project -c
ma --project ./my-project --acp
```

Claude needs Node.js 22 or later and the [Claude sidecar](../../../typescript/sidecars/claude/README.md). Build it with `npm ci --ignore-scripts && npm run build` in `typescript/sidecars/claude`. Set `MODULAR_AGENT_CLAUDE_SIDECAR` to the absolute path to its `dist/main.js` if it is not found next to the checkout or under `~/.local/share/modular-agent/sidecars/claude/`. `ma login claude` hands sign-in to Claude Code. The sidecar receives `HOME`, `PATH` and, if set, `CLAUDE_CONFIG_DIR`; it is not given credential values. The terminal starts the sidecar for a Claude model or for `ma models`. ACP starts it when the launch or a reopened session selects Claude. A session whose composition has no Claude Provider cannot switch to it.

The four languages share `$XDG_CONFIG_HOME/modular-agent` (or `~/.config/modular-agent`). Go saves sessions, command state and spilled output under `$XDG_STATE_HOME/modular-agent/go` (or `~/.local/state/modular-agent/go`). `MODULAR_AGENT_DATA_DIR` puts configuration directly in that directory and puts state in its `state/` subdirectory. `ma --trust-project` records the canonical project path in `trusted-projects.json` outside the project. A project's own settings are read without granting it permission to start a server. One ACP connection can serve several canonical projects, each with its own settings, prompt and trusted MCP servers.

## Code sandbox

Each `codemode` call starts `monty subprocess` next to the running `ma`. The agent checks the binary's version and requires an acknowledgement of protocol 8 before sending Python. It never searches `PATH`, the project or the network for the worker. Only the worker compiles and runs Python. It sends length-prefixed protobuf frames over stdio; the agent makes each nested tool call and sends the result back. The worker receives no agent environment variables. `tools` is prebound and importable; its functions can be assigned and called later.

The 256 MiB memory limit is Monty's `max_memory`, not a limit on resident memory. The worker measures active execution on its wall clock. The agent allows 30 seconds between nested calls and does not charge import, lookup or discovery suspensions as tool calls or let them reset the compute budget. Time spent waiting for a nested tool does not count. A pipe deadline stops a worker that fails to reply. A run can make 500 nested calls, use 200 frames of recursion and collect 1 MiB of print output. Result text is cut to 2,000 lines or 50 KiB. The agent also caps wire frames at 32 MiB and checks both decoded and expanded value sizes before converting them. Python gets no ambient files, network, wall clock, entropy, sleep or processes.

A memory or time limit fails the call. The agent discards and reaps the worker after each run, even on success. If it dies during a run, the call reports that the worker died; the next call starts a new worker. Cancelling the call kills and reaps the worker.

## What is checked

From the repository root:

```sh
export TMPDIR="$HOME/.cache/ma-std-tmp"
mkdir -p "$TMPDIR"
(cd conformance/acp && npm ci && cd ../tools && npm ci)
(cd go && ./scripts/build-monty.sh && mise exec -- go build -o .bin/ma ./cmd/ma && mise exec -- go build -o .bin/modular ./cmd/modular)
node conformance/reference/run.mjs --agent go
MODULAR_AGENT_CONFORMANCE=1 node conformance/acp/run.mjs --crash-checks --probe-checks --job-checks -- "$PWD/go/.bin/ma" --acp
scripts/websocket-kits.sh go
(cd go && mise exec -- go build ./... && mise exec -- go vet ./... && test -z "$(mise exec -- gofmt -l .)")
(cd go && mise exec -- go test -count=1 ./... > "$TMPDIR/ma-go-full.log" 2>&1)
(cd go && mise exec -- go test -race -count=1 ./modular/... ./cmd/ma/... > "$TMPDIR/ma-go-race.log" 2>&1)
```

- **Reference checks:** 19/19 in each language, including tool function values and memory failure followed by recovery.
- **ACP with `--crash-checks --probe-checks --job-checks`:** 188/188 on stdio and 193/193 over WebSocket against Go `ma`. The Go plugin WebSocket kit passed 153/153.
- **Sandbox regressions:** the Go tests cover imports and aliases, argument binding, structured and failed results, terminal memory and time limits, time waiting on a tool, worker death and cancellation, call and recursion boundaries, print and result limits, malformed worker messages and denied OS operations.
- **Go checks:** build, vet and formatting pass. The full suite passed 37 packages. The race run for `modular/...` and `cmd/ma/...` passed 7 tested packages. `cmd/modular` takes several minutes; use the default package timeout.
- **Claude:** the first pass tested the sidecar over stdio with its scripted SDK. No real sign-ins or model requests were made for any Provider.

## Known gaps

- `find` uses `git ls-files` where Git can read a worktree and falls back to `find` otherwise. It does not interpret `.gitignore` outside a Git worktree. The existing SDK command environment is required for this tool. Very long command output is held by that environment before being cut and spilled.
- The SDK's question handler supports in-turn text and choice answers. `auth.json` preserves named answers written by Rust, but this configuration does not store new secret answers. The SDK's question tool keeps its existing definition, which is not word-for-word the Rust question tool.
- The subscription Providers use the documented endpoints, not API-key Providers supplied by the SDK. Only loopback fixtures have checked the protocols. Model streams honor request cancellation and a response-header timeout; a quiet stream after headers has no independent idle timeout.

## Findings for docs/reference and docs/sdk

The base ACP server published the SDK's declaration but went straight to Harness operations for proposed input, joining another actor, changing the session limit and querying the tenant. It now checks the session declaration first and returns `not_supported` where appropriate, leaving `proposals`, `release` and `withdraw` usable for parked job reports. The base declares all three features true and still passes the positive checks.

Proposed replacement text, without changing the shared documents from this worktree:

**`docs/reference/standard-configuration.md`, Checks.** Replace the ACP-kit bullet with:
> the ACP kit against `MODULAR_AGENT_CONFORMANCE=1 ma --acp` with `--crash-checks --probe-checks --job-checks`, including refusal of operations disabled by the session declaration;

1. **`docs/reference/standard-configuration.md`, Tools.** Replace the argument sentence with:
   > Pass arguments by keyword or position: required fields in schema order, then optional fields by name. A single dict supplies named arguments unless the first parameter takes an object. `None` omits an argument.
2. **`docs/reference/standard-configuration.md`, Tools.** Monty 1.6.0 [does not cache host imports](https://github.com/pydantic/monty/blob/v1.6.0/crates/monty/src/bytecode/vm/module_cache.rs). In Go, the prebound and imported `tools` have the same boundary module ID and the same function values, but comparing the module objects with `is` returns false. Importing once in a separate prelude also returned distinct objects. Replace the `tools` bullet with:
   > The sandbox supplies `tools` without an import. `import tools` exposes the same functions; it need not return an identical Python module object. Functions are values: `f = tools.read` then `f(path='a.txt')` makes the same call as `tools.read(path='a.txt')`.
3. **`docs/reference/standard-configuration.md`, Tools.** Replace the OS-access bullet with:
   > The sandbox denies ambient files, networking, process creation, wall clocks, system entropy and sleep. Process and thread clocks return zero. Scripts can seed their own pseudorandom generator.
   Rust and Python set the wall clock and sleep to call the host but leave Monty's default for unseeded randomness. TypeScript and Go explicitly delegate entropy and deny it. Go follows Rust's error for denied OS calls.
4. **`docs/reference/standard-configuration.md`, Tools.** Replace “30 seconds of computation between calls” with:
   > 30 seconds on the interpreter's active wall clock between nested tool calls. Waiting for tools, import, name lookup and catalog discovery does not count, but only a nested tool call resets the budget.
   Rust, TypeScript and Python use Monty's per-turn budget, which resets at other suspensions too. Go keeps the worker's per-turn limit and accumulates active time across those suspensions until a nested tool call runs.
5. **Other differences.** Go uses Rust's JSON shape for results and Python representations for non-JSON values. TypeScript and Python use their own host conversions, so unusual values need a shared output profile. Go follows Rust in stopping at the print limit and keeping the UTF-8 prefix; TypeScript can run to the next suspension and drops the segment that did not fit. Rust and Python prefer image content over a structured value and return an `exec` dict even for a timeout. TypeScript and Go prefer the structured value and raise for a timeout; Go gives the failed `exec` dict only for a non-zero exit, as specified. Go, TypeScript and Python dispatch qualified tool function names; Rust also accepts a bare unresolved call if its name matches a registered tool.
6. **`docs/sdk/api.md`, The agent.** Add after `serveAcp`:
   > On reopen, the composition factory can read the saved session ID before building the agent, so it can start a Provider selected by the saved settings. Inspecting the ID does not start recovery. Project compositions on one connection share the history store and are closed when the connection ends.
7. **`docs/sdk/api.md`, The agent.** Add after `sessionInfo`:
   > A file or HTTP history handle exposes `sessions` and `sessionInfo` before an Agent is constructed, so an application can choose the project or Provider for a reopen without starting recovery.

# ma, the Go standard configuration

`ma` is the Go implementation of the [standard configuration](../../../docs/reference/standard-configuration.md). It composes the agent through the [Go SDK](../../modular/README.md), including its file, command and MCP tools. It does not import the base Harness or its API.

## Build and use

On Linux with unprivileged user, PID and mount namespaces, from `go/`:

```sh
mkdir -p .bin
mise exec -- go build -o .bin/ma ./cmd/ma
.bin/ma --help
mise exec -- go install ./cmd/ma  # installs to GOBIN or GOPATH/bin
```

Monty comes from [gomonty v0.0.14](https://github.com/ewhauser/gomonty/tree/v0.0.14). The tag embeds the native library and loads it through `purego`. No cgo, Rust compiler, interpreter, or separate library install is needed. It writes the library to the user's cache, or the temporary directory when a cache directory is unavailable. The Go working environment and credential locking are Linux-specific in this build.

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

Each `codemode` call starts a fresh worker by re-executing `ma`. Only the worker compiles and runs the Python code. It sends requests over framed stdio; the agent makes each nested tool call and returns its result through the same connection.

The worker sets Monty's heap limit to 256 MiB. This is an approximate count of the interpreter heap, not a cap on the process's resident memory. The other limits are 30 seconds of computation between nested calls, 500 nested calls per run, recursion depth 200, 1 MiB of printed output, and 2,000 lines or 50 KiB of result text. Each stdio frame is limited to 64 MiB. Time spent waiting for a nested result does not count against the compute limit. Print formatting can differ from Python's.

A memory or time limit fails the call with Monty's error. The worker exits after each run, even on success. If it dies during a run, the call reports that the worker died; the next call starts a new worker. Cancelling the call kills and reaps the worker.

## What is checked

From the repository root:

```sh
export TMPDIR="$HOME/.cache/ma-std-tmp"
mkdir -p "$TMPDIR"
(cd conformance/acp && npm ci)
(cd go && mkdir -p .bin && mise exec -- go build -o .bin/ma ./cmd/ma && mise exec -- go build -o .bin/modular ./cmd/modular)
node conformance/reference/run.mjs --agent go
MODULAR_AGENT_CONFORMANCE=1 node conformance/acp/run.mjs --crash-checks --probe-checks --job-checks -- "$PWD/go/.bin/ma" --acp
scripts/websocket-kits.sh go
(cd go && mise exec -- go build ./... && mise exec -- go vet ./... && test -z "$(mise exec -- gofmt -l .)")
(cd go && mise exec -- go test -count=1 ./... > "$TMPDIR/ma-go-full.log" 2>&1)
(cd go && mise exec -- go test -race -count=1 ./modular/... ./cmd/ma/... > "$TMPDIR/ma-go-race.log" 2>&1)
```

- **Reference checks:** 18/18, including the sandbox memory limit and recovery.
- **ACP with `--crash-checks --probe-checks --job-checks`:** 188/188 on stdio and 193/193 over WebSocket against `ma`.
- **Sandbox regressions:** the Go tests cover memory and time limits, worker death, cancellation, the 500-call budget, nested calls and exceptions, and printed output and return values.
- **Go checks:** build, vet and formatting pass. The full suite passed 37 packages. The race run for `modular/...` and `cmd/ma/...` passed 7 tested packages. `cmd/modular` takes several minutes; use the default package timeout.
- **Claude:** the first pass tested the sidecar over stdio with its scripted SDK. No real sign-ins or model requests were made for any Provider.

## Known gaps

- `gomonty` v0.0.14 is the latest release, and its main branch resolves to that tag. It pins Monty 0.0.9 at [`c9802b5`](https://github.com/pydantic/monty/tree/c9802b5f30d11fecf9f153feb1dfdab3abda070e), not Monty 1.6.0. The binding exposes external functions and dataclasses but no module registration or import handler. Monty's [compiler](https://github.com/pydantic/monty/blob/c9802b5f30d11fecf9f153feb1dfdab3abda070e/crates/monty/src/bytecode/compiler.rs#L575-L591) emits an instruction that raises `ModuleNotFoundError` for unknown modules without calling the host. In [`Dataclass.py_call_attr`](https://github.com/pydantic/monty/blob/c9802b5f30d11fecf9f153feb1dfdab3abda070e/crates/monty/src/types/dataclass.rs#L260-L303), a public name missing from the dataclass yields a host method call, but a present field raises `TypeError` on direct call syntax, even when it holds an external function. Leaving the field absent supports `tools.read(...)` and `t = tools; t.read(...)`, but `f = tools.read` then raises `AttributeError`. The binding cannot support both forms on the same object. Go keeps direct calls and does not rewrite Python source.
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
2. **`docs/reference/standard-configuration.md`, Tools.** Add after the `tools` object description:
   > The sandbox supplies `tools` without an import. Call a function directly as `tools.name(...)`. Importing `tools` or reading an individual function as a value is not required of every build.
3. **`docs/reference/standard-configuration.md`, Tools.** Replace the memory limit clause with:
   > 256 MiB of interpreter memory (Monty's `max_memory`; the binding decides what allocations to count, and this is not a limit on the worker's resident memory)
4. **`docs/sdk/api.md`, The agent.** Add after `serveAcp`:
   > On reopen, the composition factory can read the saved session ID before building the agent, so it can start a Provider selected by the saved settings. Inspecting the ID does not start recovery. Project compositions on one connection share the history store and are closed when the connection ends.
5. **`docs/sdk/api.md`, The agent.** Add after `sessionInfo`:
   > A file or HTTP history handle exposes `sessions` and `sessionInfo` before an Agent is constructed, so an application can choose the project or Provider for a reopen without starting recovery.

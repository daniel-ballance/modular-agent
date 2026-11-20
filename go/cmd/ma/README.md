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

## What is checked

From the repository root:

```sh
(cd conformance/acp && npm ci)
(cd go && mkdir -p .bin && mise exec -- go build -o .bin/ma ./cmd/ma)
node conformance/reference/run.mjs --agent go
MODULAR_AGENT_CONFORMANCE=1 node conformance/acp/run.mjs -- "$PWD/go/.bin/ma" --acp
MODULAR_AGENT_CONFORMANCE=1 node conformance/acp/run.mjs --crash-checks -- "$PWD/go/.bin/ma" --acp
MODULAR_AGENT_CONFORMANCE=1 node conformance/acp/run.mjs --crash-checks --probe-checks --job-checks -- "$PWD/go/.bin/ma" --acp
(cd go && mise exec -- go build ./... && mise exec -- go vet ./... && mise exec -- gofmt -l .)
(cd go && mise exec -- go test -json -count=1 ./... > /tmp/ma-go-full.log 2>&1)
(cd go && mise exec -- go test -race -json -count=1 ./cmd/ma/... ./modular/... ./acpinterface ./harness ./mcptools ./turnrun ./pluginrpc ./contextview ./portable > /tmp/ma-go-race.log 2>&1)
```

- **Reference checks:** 15/15. No changes to the runner.
- **ACP:** 87/87 default, 94/94 with `--crash-checks`, and 184/184 with `--crash-checks --probe-checks --job-checks`, including late answers and job reports after recovery.
- **Shared SDK scenarios:** 55/55 with the Go, Python, Rust and TypeScript fixture programs built.
- **Go regressions:** 19 focused tests and 19 subtests cover the Rust auth format, simultaneous refresh, loopback sign-in and Responses requests, Provider data isolation, in-process late answers, the standard 500-call Monty budget and exceptions, prompt order and wording, skills, project trust and multi-project ACP, file tools, MCP and the SDK import boundary. The reference runner separately exercises stdio MCP and real process loss with a scripted Provider.
- **Go build and lint:** build and vet pass; `gofmt -l .` is empty. The race run passed 14 tested packages (155 top-level tests, 316 subtests); the 500-call regression also passed a targeted race run. The full run with a five-minute package timeout passed 35 packages (249 top-level tests, 498 subtests) before `cmd/modular` timed out in its existing split-plugin ACP test. Fifteen packages have no tests.
- **Claude:** the first pass tested the sidecar over stdio with its scripted SDK. No real sign-ins or model requests were made for any Provider.

## Known gaps

- `gomonty` main is still at v0.0.14. It supports `tools.read(...)` and calls on another reference to `tools`. `import tools` fails with `ModuleNotFoundError`. A dataclass adapter with external functions in its attributes let `f = tools.read; f(...)` work but made direct calls fail with `TypeError: 'function' object is not callable`. Go keeps direct calls rather than rewriting Python source. Codemode uses Monty throughout. It resets the compute clock after each nested call and bounds `print` in the host, so edge-case object formatting can differ. The additional heap limit is 64 MiB.
- `find` uses `git ls-files` where Git can read a worktree and falls back to `find` otherwise. It does not interpret `.gitignore` outside a Git worktree. The existing SDK command environment is required for this tool. Very long command output is held by that environment before being cut and spilled.
- The SDK's question handler supports in-turn text and choice answers. `auth.json` preserves named answers written by Rust, but this configuration does not store new secret answers. The SDK's question tool keeps its existing definition, which is not word-for-word the Rust question tool.
- The subscription Providers use the documented endpoints, not API-key Providers supplied by the SDK. Only loopback fixtures have checked the protocols. Model streams honor request cancellation and a response-header timeout; a quiet stream after headers has no independent idle timeout.

## Findings for docs/reference and docs/sdk

Proposed replacement text, without changing the shared documents from this worktree:

1. **`docs/reference/standard-configuration.md`, Tools.** Replace the argument sentence with:
   > Pass arguments by keyword or position: required fields in schema order, then optional fields by name. A single dict supplies named arguments unless the first parameter takes an object. `None` omits an argument.
2. **`docs/reference/standard-configuration.md`, Tools.** Add after the `tools` object description:
   > The `tools` object is already available; call a function directly as `tools.name(...)`. Importing `tools` or storing a function from it is not portable across Monty bindings.
3. **`docs/sdk/api.md`, The agent.** Add after `serveAcp`:
   > On reopen, the composition factory can read the saved session ID before building the agent, so it can start a Provider selected by the saved settings. Inspecting the ID does not start recovery. Project compositions on one connection share the history store and are closed when the connection ends.
4. **`docs/sdk/api.md`, The agent.** Add after `sessionInfo`:
   > A file or HTTP history handle exposes `sessions` and `sessionInfo` before an Agent is constructed, so an application can choose the project or Provider for a reopen without starting recovery.

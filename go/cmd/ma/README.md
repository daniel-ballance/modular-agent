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

Claude needs Node.js 22 or later and the [Claude sidecar](../../../typescript/sidecars/claude/README.md). Build it with `npm ci --ignore-scripts && npm run build` in `typescript/sidecars/claude`. Set `MODULAR_AGENT_CLAUDE_SIDECAR` to the absolute path to its `dist/main.js` if it is not found next to the checkout or under `~/.local/share/modular-agent/sidecars/claude/`. `ma login claude` hands sign-in to Claude Code. The sidecar receives `HOME`, `PATH` and, if set, `CLAUDE_CONFIG_DIR`; it is not given credential values.

The four languages share `$XDG_CONFIG_HOME/modular-agent` (or `~/.config/modular-agent`). Go saves sessions, command state and spilled output under `$XDG_STATE_HOME/modular-agent/go` (or `~/.local/state/modular-agent/go`). `MODULAR_AGENT_DATA_DIR` puts configuration directly in that directory and puts state in its `state/` subdirectory. `ma --trust-project` records the canonical project path in `trusted-projects.json` outside the project. A project's own settings are read without granting it permission to start a server.

## What is checked

From the repository root:

```sh
(cd conformance/acp && npm ci)
(cd go && mkdir -p .bin && mise exec -- go build -o .bin/ma ./cmd/ma)
node conformance/reference/run.mjs --agent go
MODULAR_AGENT_CONFORMANCE=1 node conformance/acp/run.mjs -- "$PWD/go/.bin/ma" --acp
MODULAR_AGENT_CONFORMANCE=1 node conformance/acp/run.mjs --crash-checks -- "$PWD/go/.bin/ma" --acp
(cd go && mise exec -- go build ./... && mise exec -- go vet ./... && mise exec -- gofmt -l .)
(cd go && mise exec -- go test -json -count=1 ./... > /tmp/ma-go-full.log 2>&1)
(cd go && mise exec -- go test -race -json -count=1 ./cmd/ma/... ./modular/... ./mcptools ./turnrun ./pluginrpc > /tmp/ma-go-race.log 2>&1)
```

- **Reference checks: 12/12.** No changes to the runner.
- **ACP:** 87/87 default, 94/94 with `--crash-checks`.
- **New Go tests:** 14 top-level tests and 18 subtests pass, including under `-race`. Tests cover a Rust-format auth fixture, file modes and simultaneous refresh, loopback browser and device-code sign-in, loopback Responses requests and refresh for both vendors, Provider data isolation, Monty limits and exceptions, prompt order and wording against the Rust sources, skill discovery, project trust, file tools in process and over the plugin binding, Streamable HTTP MCP and the public SDK import boundary. The reference runner separately exercises stdio MCP and real process loss with a scripted Provider.
- **Race run:** 10 test packages pass (96 top-level tests, 174 subtests); five packages have no tests. Build and vet pass, and `gofmt -l .` lists no files.
- **Claude:** a separate smoke test built the TypeScript sidecar in a temporary directory and loaded it from Go over stdio with the sidecar's scripted SDK. It completed one prompt. No real sign-ins or model requests were made for any Provider.

## Known gaps

- The pinned native bridge can dispatch `tools.read(...)` and calls on another reference to `tools`, but it cannot expose a module of first-class functions like Rust Monty. `f = tools.read` and `import tools` are not supported. Codemode uses Monty's paused dataclass-method calls, never an alternate interpreter. A new native snapshot resets the compute clock after a tool call. It shadows `print` with a bounded host adapter; edge-case object formatting follows the bridge rather than CPython. The additional Monty heap limit is 64 MiB. A native interpreter crash still takes down the process, as it does in the Rust configuration.
- An ACP connection is bound to the launch project (`--project`, otherwise the working directory). The SDK cannot create one project-specific composition per client-selected directory on one connection. Start one process per project. The SDK preloads the sidecar for ACP if installed so that Claude is selectable; ordinary terminal runs load it when the selected model is Claude. `ma models` also loads it when installed.
- `find` uses `git ls-files` where Git can read a worktree and falls back to `find` otherwise. It does not interpret `.gitignore` outside a Git worktree. The existing SDK command environment is required for this tool. Very long command output is held by that environment before being cut and spilled.
- The SDK's question handler supports in-turn text and choice answers. `auth.json` preserves named answers written by Rust, but this configuration does not store new secret answers. The SDK's question tool keeps its existing definition, which is not word-for-word the Rust question tool.
- The subscription Providers use the documented endpoints, not API-key Providers supplied by the SDK. Only loopback fixtures have checked the protocols. Model streams honor request cancellation and a response-header timeout; a quiet stream after headers has no independent idle timeout.

## Findings for docs/reference and docs/sdk

Proposed replacement text, without changing the shared documents from this worktree:

1. **`docs/reference/standard-configuration.md`, Files and command table.** Replace the `--trust-project` meaning and the description of project settings with:
   > `--trust-project` records this project's canonical path in `trusted-projects.json` in the shared configuration folder and lets this project's `.mcp.json` start programs. `.modular-agent.json` supplies session defaults regardless of trust. The standard configuration does not load arbitrary plugin declarations from project settings.
2. **`docs/reference/standard-configuration.md`, Tools.** Replace the sentence on argument binding with:
   > Pass arguments by keyword, or by position in signature order: required fields in schema order, then optional fields by name. A single dict can supply named arguments unless the first parameter itself takes an object. `None` omits an argument.
3. **`docs/reference/standard-configuration.md`, Tools.** Replace the sentence on `null` with:
   > `null` offers every tool that allows a model caller, including codemode, the six file and command tools, the question tool when loaded, and MCP tools.
4. **`docs/reference/standard-configuration.md`, Prompt, skills and MCP.** Replace the sentence on function listings with:
   > Show the first twelve function descriptions in full. List later functions by signature and the first line of their description, up to 160 characters; `describe_tool` returns the rest.
   At the pinned Rust revision the prompt lists *all* descriptions in abbreviated form above twelve; Go follows the written first-twelve rule. The Rust prompt also has no date section; Go follows the written order and puts `<date>` after `<cwd>`.
5. **`docs/sdk/api.md`, The agent and Contexts.** Replace the session-listing row and add an environment note:
   > `sessions(filter?)` lists stored sessions without opening them: ID, canonical project, selected model and last activity. A file or HTTP history handle exposes the same operation before an Agent is constructed, so an application can choose the project and Provider for a reopen without recovering work early.
   > A tool's working environment is scoped to the invocation and resolves relative paths against that session's project. In either placement the SDK exposes read, write, directory listing and structured execution with deadline and progress. An unavailable optional operation returns `not_supported`.
6. **`docs/sdk/api.md`, Tools and Events.** Add:
   > Tool constructors accept explicit JSON Schema as an alternative to schema generation, preserving the definition's names, descriptions and required-field order. A composed agent can list the plugin-callable tool catalog for a session before preparing that session's system prompt. Inspection does not grant authority to execute the tools.
   > A line-oriented Interface can check whether a session has active work and wait for it to become idle without admitting input or closing the session.
7. **`docs/sdk/api.md`, ACP.** Add:
   > An ACP Interface may take a project factory that composes a new agent for each canonical project. A factory receives the host's trust decision and the stdio connection supplies isolated state. Without a factory, an agent bound to one project rejects other project paths.
8. **`docs/sdk/concepts.md`, What the SDK includes.** Add:
   > The SDK exposes the file and command tools, and trusted MCP configuration, through official public packages. A configured MCP source may take a warning handler that skips an unstartable server without dropping the others. ACP attachments remain scoped to their owning sessions.

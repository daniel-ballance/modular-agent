# `ma` in TypeScript

This is the TypeScript implementation of the [standard configuration](../../../docs/reference/standard-configuration.md). It composes `@modular-agent/core`, the SDK's file and MCP plugins, and a crash-isolated Monty worker for `codemode`. It does not import the TypeScript base or its CLI.

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
ma login openai-codex          # add --device to use a code
ma login xai                   # device sign-in
ma models
ma -p 'Summarize the files in this folder.'
ma -c                          # continue the last session in this folder
ma --acp                       # ACP over stdio
```

Subscription credential writes and refreshes require a `flock` command that supports locking an inherited descriptor, as provided by util-linux. Claude uses Claude Code's own sign-in. To use it, build the sidecar (`cd typescript/sidecars/claude && npm ci && npm run build` from the repository root), install Claude Code, then run `ma login claude`. An installed sidecar can instead be named with `MODULAR_AGENT_CLAUDE_SIDECAR`.

Configuration is shared in `$XDG_CONFIG_HOME/modular-agent`, or `~/.config/modular-agent`. State is kept in `$XDG_STATE_HOME/modular-agent/typescript`, or `~/.local/state/modular-agent/typescript`. `MODULAR_AGENT_DATA_DIR` sets the configuration directory and puts state under its `state/` subdirectory. Use `--runtime transient` to keep history without resuming a turn cut off by a crash.

## What is checked

From the repository root:

```sh
npm ci --prefix conformance/acp
(cd typescript && npm ci && npm run build && npm test)
(cd typescript && MA_REMOTE=provider-pi-ai,runtime-transient,tools-files,env-local npm test)
(cd typescript/sidecars/claude && npm ci && npm test)
node conformance/reference/run.mjs --agent typescript
MODULAR_AGENT_CONFORMANCE=1 node conformance/acp/run.mjs -- node "$PWD/typescript/packages/ma/dist/src/main.js" --acp
MODULAR_AGENT_CONFORMANCE=1 node conformance/acp/run.mjs --crash-checks -- node "$PWD/typescript/packages/ma/dist/src/main.js" --acp
```

- Reference checks: **12/12**, including durable and transient crash recovery.
- ACP against `ma`: **116/116** default; **123/123** with crash checks.
- TypeScript workspace: **185/185** tests in each of the normal and `MA_REMOTE` placements, including **19/19** `ma` tests. The `ma` tests cover the Rust credential-file format, lock exclusion during refresh, browser and device sign-in, Responses requests, codemode calls and limits, file tools, prompt wording and ordering, skills, stdio and HTTP MCP, ACP session MCP, terminal queueing and SDK-only imports.
- Claude sidecar: **44/44**; one further `ma` smoke run with the sidecar's fake SDK completed. Sign-in and Responses request tests used numeric loopback endpoints only. No real sign-ins, credentials or models were used.
- `tsc -b` and `git diff --check` pass. There is no separate TypeScript lint or formatting command in this workspace.

## Known gaps

- Tested on Linux. On platforms without a compatible `flock`, Claude and scripted runs still work, but subscription credential changes and refreshes fail rather than using a different, incompatible locking scheme.
- The SDK installs process Providers when it creates an agent. A terminal run started without the Claude sidecar cannot switch into Claude with `/model`; restart with `--model claude/ID`. `ma models` and normal ACP load the sidecar when it is installed so the catalog is available. See the [sidecar's own gaps](../../sidecars/claude/README.md#known-gaps-and-open-problems).
- On ACP load or resume, project-configured MCP servers connect before turn recovery, but servers supplied on the ACP request attach only after recovery is installed. A turn already resuming may not be able to call those client-supplied servers.
- `find` honors `.gitignore` files at or below the search root. It does not read parent or global Git ignore rules, `.ignore`, or `.git/info/exclude`, and its glob parser is not Rust's `globset`. Platform filesystem errors and Monty's traceback display can also differ from Rust.
- Standard MCP tool lists are discovered when the server connects. Changes announced after connect do not refresh the catalog until the session reopens.

## Findings for docs/reference and docs/sdk

Proposed replacements; the shared documents are unchanged in this branch.

**Reference — `--trust-project`.** Rust standard reads project defaults independently of trust and does not install the general base plugin plan. Replace the option's Meaning cell with:

> Use this project's `.mcp.json` and remember the decision in `trusted-projects.json` in the configuration folder. `.modular-agent.json` supplies session defaults; it does not start plugins in the standard configuration.

**Reference — tools and limits.** Rust `find` and `list` accept a `limit`. Replace their Input cells with `pattern`, `path?`, `limit?` and `path?`, `limit?`, respectively. Replace “The prompt describes up to twelve functions in full and lists the rest by name” with:

> The prompt describes every function in full when there are at most twelve. Above twelve, it lists every signature with the first line of its description, cut to 160 characters.

**Reference — date.** The Rust prompt supplied for this work ends at `<cwd>` and has no date tag. To keep the documented date and make it testable, replace the end of the prompt-order bullet with:

> … the `codemode` functions, a `<cwd>` section containing the absolute project path, and a `<date>` section containing the current date in UTC (`YYYY-MM-DD`).

**SDK — call contexts.** Append to the call context table in the API specification:

> In-process hook and command handlers may declare `inProcessOnly` and read the current session's canonical project and tool definitions through their call context. This is a snapshot, does not grant dispatch authority, and is unavailable without a live session or over the plugin binding.

**SDK — Sessions and turns.** Append to the session methods:

> `waitForIdle()` waits for the running turn and admitted follow-up inputs. `agent.savedSession(id)` reads a kept session's project, settings, creation and most recent record times without opening the session or starting recovery.

**SDK — ACP and official plugins.** Append to the Interfaces and SDK-includes descriptions:

> An ACP host can supply initial session settings scoped to the client's project and attach MCP servers scoped to a session. The binding checks tool rights before attaching client-supplied servers. Do not keep their headers or environment values in session history. A composition without approval does not advertise an approval option.

> Export the file and command tools, a session-scoped MCP client, and context compaction (including its command) as official SDK parts. An app can compose these without importing a base-build API.

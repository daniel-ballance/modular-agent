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
MODULAR_AGENT_CONFORMANCE=1 node conformance/acp/run.mjs --crash-checks --probe-checks --job-checks -- node "$PWD/typescript/packages/ma/dist/src/main.js" --acp
```

- Reference checks: **15/15**, including declaration, JSON events, prompt tail and both crash-recovery modes.
- ACP with crash, probe and job checks together: **188/188** against `ma` and **214/214** against the base build. The expanded run includes late answers and job take-up after a crash.
- TypeScript workspace: **186/186** in both the normal and `MA_REMOTE` placements, including **19/19** `ma` tests. Each workspace run includes **22/22** shared SDK scenarios across embedded and TypeScript process fixtures (the built fixture in this checkout). The `ma` tests cover Rust-format credentials, lock exclusion during refresh, loopback sign-in and Responses requests, codemode limits, file tools, prompt order, skills, stdio and HTTP MCP, per-project ACP settings and trust, terminal queueing and SDK-only imports.
- Claude sidecar: **44/44**. No real sign-ins, credentials or models were used.
- `tsc -b` and `git diff --check` pass. The workspace has no separate lint or formatting command.

## Known gaps

- Tested on Linux. Subscription credential changes and refreshes need a compatible `flock`; without one they fail rather than using an incompatible lock.
- The terminal cannot switch to Claude unless it started the sidecar. In ACP, a project composition that did not start the sidecar does not offer Claude. Reopen with saved Claude settings or launch with `--model claude/ID`. See the [sidecar's own gaps](../../sidecars/claude/README.md#known-gaps-and-open-problems).
- `find` honors `.gitignore` files at or below its search root, but not parent or global Git rules, `.ignore` or `.git/info/exclude`. Its glob parser, filesystem diagnostics and Monty's tracebacks can differ from Rust.

## Findings for docs/reference and docs/sdk

Proposed replacement text; the shared documents are unchanged in this branch.

**ACP declarations.** The base Interface called the session API for proposals, actor joins, limits and tenant queries regardless of the SDK's session declaration. Its extension dispatcher now returns `not_supported` for disabled operations, while leaving `proposals`, `release` and `withdraw` available for parked job reports. The base declares all three features true and still passes the positive checks.

**Reference — Checks.** Replace the ACP-kit bullet with:

> the ACP kit against `MODULAR_AGENT_CONFORMANCE=1 ma --acp` with `--crash-checks --probe-checks --job-checks`, including refusal of operations disabled by the session declaration;

**SDK — ACP factory.** Replace the `compose(project)` option sentence with:

> `compose(project, saved?)` builds an Agent for a canonical project the client names. For a load or resume, the host can pass the saved session metadata to select parts before recovery. The serving agent's history indexes the sessions that its project compositions open. Without `compose`, the agent refuses other project paths.

**SDK — Declaration choices.** Add these rows to the `createAgent` option table:

| Option | Type | Default |
|---|---|---|
| `questionsOutlastTurns` | boolean | false. Enables both `questionsOutlastTurns` and `lateAnswersStartTurns`. |
| `settingsDuringTurn` | `nextTurn` or `refused` | `nextTurn`. With `refused`, changing settings during a running turn raises `busy`. |

**SDK — Command time units.** In the scoped environment row, replace `exec(command, { timeout })` with:

> `exec(command, { timeout })`, with `timeout` in milliseconds,

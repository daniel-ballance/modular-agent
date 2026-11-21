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
ma login openai-codex          # add --device to use a code
ma login xai                   # device sign-in
ma models
ma -p 'Summarize the files in this folder.'
ma -c                          # continue the last session in this folder
ma --acp                       # ACP over stdio
ma --acp --listen 127.0.0.1:7401 --token-file /path/to/token  # ACP over WebSocket
```

The WebSocket listener requires a loopback address and an owner-only bearer token file. It acts as `ma`'s local ACP user, irrespective of `MODULAR_AGENT_ACTOR`.

Subscription credential writes and refreshes require a `flock` command that supports locking an inherited descriptor, as provided by util-linux. Claude uses Claude Code's own sign-in. To use it, build the sidecar (`cd typescript/sidecars/claude && npm ci && npm run build` from the repository root), install Claude Code, then run `ma login claude`. An installed sidecar can instead be named with `MODULAR_AGENT_CLAUDE_SIDECAR`.

Configuration is shared in `$XDG_CONFIG_HOME/modular-agent`, or `~/.config/modular-agent`. State is kept in `$XDG_STATE_HOME/modular-agent/typescript`, or `~/.local/state/modular-agent/typescript`. `MODULAR_AGENT_DATA_DIR` sets the configuration directory and puts state under its `state/` subdirectory. Use `--runtime transient` to keep history without resuming a turn cut off by a crash.

## Code sandbox

`codemode` uses the native [Monty 1.6.0 worker protocol](https://github.com/pydantic/monty/blob/v1.6.0/crates/monty-proto/proto/monty/v1/monty.proto). Each run gets a fresh subprocess and session. `tools` is prebound and importable. Calls to its functions go through the agent as nested calls. The worker sends typed Python values, so result text keeps floats such as `1.0`, large integers, dictionary order and the Python representations of non-JSON values.

The worker measures active wall time. `ma` allows 30 seconds between nested tool calls. Waiting on the host does not count, and only a dispatched nested tool call resets the budget. The run allows 500 nested tool calls and 200 recursive frames. It has a [256 MiB Monty memory budget](https://github.com/pydantic/monty/blob/v1.6.0/docs/resource-limits.md#memory), not an RSS limit. At 1 MiB of printed output, `ma` stops the worker when it receives excess output and keeps the UTF-8 prefix. Result text is cut to 2,000 lines or 50 KB, including the cut note.

The sandbox has no direct file, network or process access. Wall clocks, sleep and system entropy are denied. Process and thread clocks return zero. `random.Random(7)` works without system entropy.

A memory or time limit ends the run with `MemoryError` or `TimeoutError`. If the worker dies, the call reports the death. Cancelling a call stops its worker. No run reuses a worker.

## What is checked

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

- Reference checks: **22/22**, including all four codemode profile checks, `sandbox-memory` and both crash-recovery modes.
- ACP with crash, probe and job checks: **188/188** on stdio and **193/193** on WebSocket. The WebSocket plugin kit passed **153/153** checks.
- TypeScript workspace: **336/336** offline checks in both normal and `MA_REMOTE` configurations, with two live checks skipped. That includes **51/51** shared scenario runs across embedded, TypeScript stdio and TypeScript WebSocket placements. The other SDK fixtures were not built for these runs. See the [SDK README](../core/README.md#what-is-checked) for fixture build commands.
- Claude sidecar: **44/44**. No real sign-ins, credentials or models were used.
- `tsc -b` and `git diff --check` pass. The workspace has no separate lint or formatting command.

## Known gaps

- Tested on Linux. Subscription credential changes and refreshes need a compatible `flock`; without one they fail rather than using an incompatible lock.
- The terminal cannot switch to Claude unless it started the sidecar. In ACP, a project composition that did not start the sidecar does not offer Claude. Reopen with saved Claude settings or launch with `--model claude/ID`. See the [sidecar's own gaps](../../sidecars/claude/README.md#known-gaps-and-open-problems).
- `find` honors `.gitignore` files at or below its search root, but not parent or global Git rules, `.ignore` or `.git/info/exclude`. Its glob parser, filesystem diagnostics and Monty's tracebacks can differ from Rust.

## Findings for docs/reference and docs/sdk

Proposed replacement text; the shared documents are unchanged in this branch.

**Reference — Tools, last value.** Monty 1.6.0 exports a sandbox class instance as its type and attributes, not its custom `__repr__`. For example, `print(repr(C()))` can print `custom repr` while a final `C()` is exported as `C()`. The image result also needs an exception to text rendering. Replace the paragraph starting “The result is everything printed” with:

> Return everything printed, then the value of the last expression unless it is `None`, or `(no output)` if both are empty. Return strings unchanged. Format other values as `json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False)` would, with tuples as lists, when the exported value can be encoded as JSON. Otherwise use the Python representation of Monty's exported value. This need not call a sandbox object's custom `__repr__`. Attach image dicts returned alone or in a list or tuple as image content instead of printing their encoded data. Each run starts fresh.

**Reference — Tools, traceback.** Monty omits the colon and message if the exception has no message. Replace the exception bullet with:

> An uncaught exception ends the run. Return what was printed, then Monty's traceback, ending in `Type: message` or just `Type` when the exception has no message.

**Reference — Tools, execution and print limits.** Monty 1.6.0 reports active time at suspensions and feed completion. It cannot accept a different time limit on a resume. Its print events can arrive after Python has run more instructions; the host cannot stop it at the exact byte inside `print`. Replace the time and printed-output limit sentences with:

> Allow 30 seconds of active interpreter wall time between nested tool calls, as reported by Monty. Waiting on the host does not count. Check the accumulated time at each suspension and at completion; reset it only for a dispatched nested tool call. A host watchdog may stop a worker that has not replied within the remaining time plus a bounded delivery allowance.

> Allow 1 MiB of printed output. When a print event crosses the limit, retain only the UTF-8 prefix that fits and terminate the worker without servicing another call or using its final value. Start the result with `RuntimeError: printed output exceeded 1048576 bytes`, then the retained prefix.

**Reference — Tools, worker message size.** The worker exports a whole typed value before `ma` cuts the result text. A large value can exceed the separate protocol frame and decode budgets. Add after the result text limit:

> The host may refuse a worker message that exceeds its protocol frame or decode budget, before rendering and cutting the result text.

**Reference — Tools, tool arguments.** TypeScript tool inputs are JSON values in the SDK. Python integers outside the JavaScript safe integer range cannot be carried reliably as JSON numbers through that SDK. Add after the argument binding rules:

> Tool inputs must fit the host's JSON representation. If conversion would lose an integer's precision or cannot encode a value, raise `TypeError` without dispatching the call. This does not limit the integers that sandbox code can compute or return as its last value.

**Reference — Tools, OS policy.** Monty 1.6.0 initializes `random.Random()` lazily; constructing it requests no system entropy. Its process and thread clocks return zero. Replace the OS policy bullet with:

> The sandbox has no ambient file, network or process access, no wall clock, no sleep and no system entropy. Process and thread clocks return zero. A draw from an unseeded generator, or a request to seed it from system entropy, raises. A generator the script seeds itself, such as `random.Random(7)`, works.

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

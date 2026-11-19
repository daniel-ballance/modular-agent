# Modular Agent in TypeScript

The TypeScript build from the experiment. It implements [production edition 3](../docs/adr/0021-production-edition.md): a Harness, transient and durable Runtimes, the vanilla Pi plugin set, subagents, a terminal UI, an ACP Interface that T3 Code drives, plugins over the plugin binding, and parts as HTTP services. The SDK, [`@modular-agent/core`](packages/core/README.md), wraps that build with embedded agents, sessions, typed tools, and plugins that can run in process or over stdio. There is no TypeScript reference implementation yet.

| Path | Holds |
|---|---|
| `packages/` | The edition 3 base and SDK, as npm workspaces |
| `packages/core/` | Public SDK and testing kit |
| `packages/fixtures/` | SDK fixture program and shared-scenario runner |
| `packages/openai/`, `packages/anthropic/` | SDK API-key Providers |
| `sidecars/claude/` | The Claude Provider that Rust's standard configuration loads over the plugin binding. A separate package; see [its README](sidecars/claude/README.md). |
| `scripts/acp-smoke.mjs` | Drives `ma --acp` over stdio with a real model |
| `conformance` | A link to this repository's kits |

## Build and check

Tested with Node.js 26. The kit tests need the ACP kit's dependencies: run `npm ci` in `../conformance/acp` first.

```sh
npm ci
npm run build
npm test
MA_REMOTE=provider-pi-ai,runtime-transient,tools-files,env-local npm test
```

`npm test` includes runs of the ACP kit against the agent, with history kept locally and in a history service, and of the history kit against its own service. It also runs the SDK tests and shared scenarios against each built fixture program. [Status](../docs/status.md) records what the build exercises.

## Run

```sh
npm run agent              # the terminal agent, ma
npm run agent -- --acp     # ACP on stdio, for a host such as T3 Code
```

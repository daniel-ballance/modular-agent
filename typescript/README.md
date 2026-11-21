# Modular Agent in TypeScript

This directory contains the TypeScript base, the public SDK, and [`ma`](packages/ma/README.md), the TypeScript reference implementation of the [standard configuration](../docs/reference/standard-configuration.md). The SDK, [`@modular-agent/core`](packages/core/README.md), wraps the base with embedded agents, sessions, typed tools, and plugins that can run in process, over stdio, or as WebSocket services.

| Path | Holds |
|---|---|
| `packages/` | The edition 4 base and SDK, as npm workspaces |
| `packages/core/` | Public SDK and testing kit |
| `packages/ma/` | The standard configuration, with the `ma` executable |
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

`npm test` includes runs of the ACP kit against the agent, with history kept locally and in a history service, and of the history kit against its own service. It also runs the SDK tests and shared scenarios in process, over stdio and over WebSocket against each built fixture program. Set `MODULAR_AGENT_SDK_REQUIRE=all` after building the four fixture programs to require the full matrix. [Status](../docs/status.md) records what the build exercises.

## Run

```sh
node packages/ma/dist/src/main.js              # the standard terminal agent
node packages/ma/dist/src/main.js --acp        # ACP over stdio
node packages/ma/dist/src/main.js --acp --listen 127.0.0.1:7401 --token-file /path/to/token
```

`npm run agent` still starts the development CLI for the base build.

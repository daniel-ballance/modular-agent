# API reference

The [API](api.md) page describes the SDK in language-neutral terms. Each language's reference is generated from its source, so it always matches the code you build. Nothing is published to a registry; build the reference locally.

| Language | Command, from the language's directory | Result |
|---|---|---|
| Rust | `mise exec -- cargo doc --no-deps -p modular-agent --open` | HTML in `rust/target/doc/modular_agent/` |
| TypeScript | `npm run build`, then read `packages/core/dist/src/*.d.ts` | Type declarations with doc comments; any editor shows them on hover |
| TypeScript, HTML | `npx typedoc --entryPoints packages/core/src/index.ts --tsconfig packages/core/tsconfig.json --out ../docs-html/typescript` | HTML; downloads TypeDoc on first use |
| Go | `mise exec -- go doc -all ./modular`, or one symbol: `go doc ./modular Agent.Session` | Text; `go doc` covers every package under `modular/` |
| Python | `uv run python -m pydoc modular_agent`, or a browser: `uv run python -m pydoc -b` | Text or a local HTML server |

The official parts have their own entries: the file and command tools and the MCP client in Rust (`modular-agent-files`, `modular-agent-mcp`), TypeScript (`@modular-agent/tools-files/sdk`, `@modular-agent/tools-mcp/sdk`), Go (`modular/files`, `modular/mcp`) and Python (`modular_agent.files`, `modular_agent.mcp`). The testing kit is `modular_agent::testing`, `@modular-agent/core/testing`, `modular/modulartest` and `modular_agent.testing`.

When the reference and [api.md](api.md) disagree, api.md says what the SDK should do; the difference is a bug in the SDK or a gap to record in [api.md](api.md) first.

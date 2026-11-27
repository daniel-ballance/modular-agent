# API reference

The [API](api.md) page describes the SDK in language-neutral terms. Each language's reference is generated from its source, so it always matches the code you build. Nothing is published to a registry; build the reference locally.

| Language | Command, from the language's directory | Result |
|---|---|---|
| Rust | `mise exec -- cargo doc --no-deps -p modular-agent --open` | HTML in `rust/target/doc/modular_agent/` |
| TypeScript | `npm run build`, then read `packages/core/dist/src/*.d.ts` | Type declarations with doc comments; any editor shows them on hover |
| TypeScript, HTML | `npx typedoc --entryPoints packages/core/src/index.ts --tsconfig packages/core/tsconfig.json --out ../docs-html/typescript` | HTML; downloads TypeDoc on first use |

The official parts have their own entries: the API-key Providers, file and command tools, and MCP client in Rust (`modular-agent-openai`, `modular-agent-anthropic`, `modular-agent-files`, `modular-agent-mcp`) and the file and command tools and MCP client in TypeScript (`@modular-agent/tools-files/sdk`, `@modular-agent/tools-mcp/sdk`). The testing kit is `modular_agent::testing` in Rust and `@modular-agent/core/testing` in TypeScript.

When the reference and [api.md](api.md) disagree, api.md says what the SDK should do; the difference is a bug in the SDK or a gap to record in [api.md](api.md) first.

---
status: accepted
date: 2026-11-14
---

> **Amended** on 2026-11-16 by [ADR 0011](0011-minimal-harness-everything-is-a-plugin.md): the Harness still defines the standard forms, but plugins do the adapting. Interfaces, Providers and tool sources are all plugins.

# The Harness is the centre, and the boundary where things are standardized

Everything outside the system arrives in its own format: interfaces, provider APIs and credentials, built-in tools, MCP servers, context-management settings, hook configuration. The Harness adapts all of it and passes only a small set of standard forms to the Runtime: messages, tool definitions, tool calls and results, and a Provider handle. The Runtime cannot tell a built-in tool from an MCP tool, or one vendor from another. This is ports and adapters (hexagonal architecture). Interfaces are driving adapters. Providers and tool sources are driven adapters.

## Considered options

- **Seven equal components** (Core, Runtime, Harness, Provider, Tools, Context, Storage), as the original ChatGPT conversation proposed. Rejected because Provider, Tools, Context and Storage are not peers of the Harness. They are things the Harness adapts.

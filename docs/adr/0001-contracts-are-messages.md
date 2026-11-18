---
status: superseded by 0010
date: 2026-11-14
---

**Current rule:** The core prescribes no transport or encoding; see [Contracts](../contracts.md). [Security](../security.md#plugins) limits the observability claim to mediated interactions and excludes protected data.

> **Superseded** on 2026-11-16 by [ADR 0010](0010-describe-parts-not-wiring.md): we now describe parts and how they fit together, and leave wiring to each implementation. The aim of making every interaction observable and recordable is kept as a requirement.

# Every contract is a message, and bindings are separate

Components may share one process, talk over RPC, or run as separate services, so every contract between them is defined as plain data passed in messages. No contract passes live objects, function references or "interfaces". How the messages travel (in-process calls, JSON-RPC, HTTP) is a separate, thin layer called a binding. This is how LSP, MCP, A2A and AG-UI are built. It also serves the project's goal of laying the system open, because every interaction can be logged, read and replayed.

## Consequences

- Anything that is an object in an in-process design must become something addressable. A Provider "client" becomes a Provider handle (see 0005). A tool function becomes a tool call that the Runtime sends to the Harness.
- Pi passes functions where we pass messages (tools as objects with `execute()`, `streamFn`, hook callbacks). In one process the two are equivalent. Pi's design is fine for Pi, but it gives us nothing to copy at the wire level.

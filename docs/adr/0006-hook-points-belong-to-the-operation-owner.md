---
status: accepted
date: 2026-11-14
---

**Current rule:** The operation owner defines each point and the Harness dispatches and combines handlers in the [specified order](../contracts.md#hook-execution), including handlers in other processes. Core plugins can define extra points; [plugin `/1`](../bindings/plugin.md#the-host-asks-a-hook-handler) carries only its named points and specifies [the Runtime's other exchanges](../bindings/plugin.md#the-host-asks-the-runtime).

> **Amended** on 2026-11-16 by [ADR 0011](0011-minimal-harness-everything-is-a-plugin.md): hook handlers come from plugins rather than Harness configuration. The Runtime still never runs them itself.

# Whoever owns an operation defines its hook points, and handlers always run in the Harness

A hook point is defined by the component that controls the operation:
- The Runtime defines points around turns, steps and tool calls.
- The Harness defines points for sessions, input, turn preparation, compaction and model selection.
- Interception inside the model call itself is Provider middleware.

Hook handlers are Harness configuration, bound to hook points, in the same way MCP servers and providers are configured. When the Runtime reaches a hook point, it calls up to the Harness and waits for the answer. It never runs handler code itself, and it never manages handler lists or their order. Running several handlers for one point, and deciding their order, is the Harness's internal business. Pi does the same: `pi-agent-core` has one function per slot, and the coding agent spreads each slot across many extensions.

The Runtime must provide a standard set of hook points, so that hook configuration survives swapping one Runtime for another. Each hook point declares what a handler may do there: observe, modify, or stop the operation.

## Consequences

- The Runtime calls up to the Harness for only two things: **run this tool call** and **invoke this hook point**.
- Whether Runtimes may advertise hook points beyond the standard set is still open.

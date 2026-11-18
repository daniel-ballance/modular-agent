---
status: accepted
date: 2026-11-14
---

**Current rule:** The Runtime initiates model requests with [model access](../contracts.md#model-access); a remote Runtime uses `host/runtime/model` through the host ([plugin binding](../bindings/plugin.md#the-host-asks-the-runtime), [ADR 0017](0017-plugins-in-any-language.md)). The three original loop boundaries below are only part of the current [Interactions](../contracts.md#interactions).

# There is no separate Core: the Runtime owns turns and makes the model call

We first split the agent loop into a Core, which executed one step, and a Runtime, which ran the turn. Our later decisions emptied the Core out. The Context hook point decides what the model sees (0007). The Harness supplies the tools. The Provider returns normalized tool calls and a finish reason. Whether to continue is the Runtime's decision, with a vote from the Harness. What was left only repackaged data between the Runtime and the Provider.

The promised benefit, swapping a "ReAct Core" for a "Plan/Execute Core", also failed. Those strategies sequence steps, which is turn-level work, and so belongs to the Runtime. A component that owns only one step cannot hold a strategy. Pi does not split them either: `pi-agent-core` is a single loop.

So the Runtime calls the Provider directly through the handle the Harness gives it. The step remains a named unit in the spec, as a concept rather than a component. It is the Runtime ↔ Provider exchange, the boundary where step hook points fire, and the natural checkpoint for a durable Runtime.

## Consequences

- This reverses an earlier decision: "the Core calls the Provider and the Runtime never touches inference."
- Anything that really belongs inside a step, such as parsing tool calls out of plain text for models without native tool calling, goes in Provider middleware rather than a new layer.
- There are three contracts: Interface ↔ Harness, Harness ↔ Runtime, and Runtime ↔ Provider.

---
status: accepted
date: 2026-11-14
---

**Current rule:** Without a context handler, the [default model view](../bindings/data.md#context-and-interrupted-work) projects the current branch, not the raw history. [Provider conversation state](../contracts.md#provider-state) can represent only an exact prefix of the permitted view.

> **Amended** on 2026-11-16 by [ADR 0011](0011-minimal-harness-everything-is-a-plugin.md): the Harness doesn't decide what the model sees; a context management plugin does, at this hook point.
>
> **Amended** on 2026-11-16 by the [pressure test](../pressure-test/synthesis.md#5-history-grows-in-normal-use-with-stated-exceptions): history grows in normal use, and is deleted only by retention or erasure. What the model sees is the view of the current branch plus whatever a Provider keeps or adds. See [History](../architecture.md#history).

# Context management is a hook point before each step, not a component

Before each step, the Runtime asks the Harness, through a hook point: "here is the turn so far and the last step's usage; what should the model see?" The Harness decides how: trimming, compaction, retrieval or injected memory. If no handler is configured, the default is to send everything.

## Considered options

- **The Harness sends the Runtime a context policy to carry out.** Rejected for two reasons. First, compaction needs a model call, and the Runtime has no reason to hold Provider access for that. Second, every Runtime would have to implement every policy, so Runtimes would stop being interchangeable, and context management would be limited to what the policy format can express.

## Consequences

- History and model context are different things. History is append-only. Model context is a view computed from it before every step. Pi works the same way: compaction appends a summary entry and deletes nothing.
- The check runs between steps, not just at the start of a turn, because a single turn can outgrow the context window.

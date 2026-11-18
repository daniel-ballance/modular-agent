---
status: accepted
date: 2026-11-14
---

**Current rule:** The Harness owns sessions and the Runtime owns turns; a step is not a separate part. A session can have no turns and a turn no steps; another step can follow steering, retry or result correction as well as tool results, as described in [Harness and Runtime](../contracts.md#harness-and-runtime) and [Hook execution](../contracts.md#hook-execution).

> **Amended** on 2026-11-16 by the [pressure test](../pressure-test/synthesis.md#4-a-turn-returns-a-result-and-can-wait): a turn now runs until the agent has nothing more to do for now, or it stops. Waiting for an answer is part of a turn, not its end, and a turn returns a result. **Jobs** run beside turns. An exchange unit was added between session and turn, then dropped in round 2. See [Units of work](../architecture.md#units-of-work).

# Sessions, turns and steps are nested lifetimes with one owner each

- A **session** is one or more turns. The Harness owns it.
- A **turn** is one or more steps plus their tool calls. The Runtime owns it.
- A **step** is one model request and response.

Each owner holds the longer-lived state and gives the layer below only what its unit of work needs. A turn ends when the agent cannot continue without input from outside the agent. The Runtime decides when a turn ends. The Harness gets a vote at each step boundary, and the Runtime may also end a turn for its own reasons: a step limit, cancellation, or an error.

Reasoning happens inside a step. A new step starts only when a tool result has to go back to the model.

## Consequences

- Pi, Tau and PiG call our *step* a "turn" and our *turn* an "agent run". Translate their terms when reading their docs.
- The same three-level nesting appears in AG-UI (thread, run, step), A2A (context, task) and the OpenTelemetry GenAI conventions (conversation, `invoke_agent`, `chat` plus `execute_tool`).

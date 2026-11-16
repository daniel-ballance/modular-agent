---
status: accepted
date: 2026-11-14
---

# Sessions, turns and steps are nested lifetimes with one owner each

- A **session** is one or more turns. The Harness owns it.
- A **turn** is one or more steps plus their tool calls. The Runtime owns it.
- A **step** is one model request and response.

Each owner holds the longer-lived state and gives the layer below only what its unit of work needs. A turn ends when the agent cannot continue without input from outside the agent. The Runtime decides when a turn ends. The Harness gets a vote at each step boundary, and the Runtime may also end a turn for its own reasons: a step limit, cancellation, or an error.

Reasoning happens inside a step. A new step starts only when a tool result has to go back to the model.

## Consequences

- Pi, Tau and PiG call our *step* a "turn" and our *turn* an "agent run". Translate their terms when reading their docs.
- The same three-level nesting appears in AG-UI (thread, run, step), A2A (context, task) and the OpenTelemetry GenAI conventions (conversation, `invoke_agent`, `chat` plus `execute_tool`).

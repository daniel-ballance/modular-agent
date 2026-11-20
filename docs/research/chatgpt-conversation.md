# Origin: the ChatGPT conversation

This project continues a ChatGPT conversation titled "Break Down Py Coding Agent". "Py" in the title is a transcription of "Pi".

## How it developed

1. **Pi broken into parts:** `pi-tui` (frontend), `pi-coding-agent` (application layer), `pi-agent-core` (agent loop), `pi-ai` (inference), plus tools, context and storage.
2. **Generalized** to Interface, Harness and Core, with Provider, Tools, Context and Storage as capabilities.
3. **Hooks:** first owned by the Core, with handlers configured by the Harness. Hooks (which can change or block) were separated from events (which only report).
4. **Providers:** the Harness gives the Core a provider interface.
5. **Pi Durable:** a combined harness and agent loop, using `pi-ai` but not `pi-agent-core`. Durability needs the Core's cooperation.
6. **Core, Runtime and Harness split apart.** Durable and transient Runtimes; which Cores work with which Runtime depends on capabilities.
7. **The user's reframing:**
   - **step** = one provider call and its response
   - **turn** = steps plus tool calls until done
   - **session** = many turns

   The Runtime owns turns, the Core owns steps, and the Harness owns capabilities.
8. **Hooks moved to the Runtime.** Rule: whoever owns an operation defines its hook points.
9. **Inputs, process and outputs for seven components:** `Core.step`, `Runtime.run_turn`, `Harness.handle`, `Provider.generate`, `Tool.execute`, `Context.build`, `Storage.read/write`.
10. **Tau and PiG** compared against the design (see below).

## What we kept, changed or dropped

- **Kept:** step, turn and session; hooks versus events; the hook-ownership rule; durability as a Runtime concern; one Runtime contract for both durable and transient Runtimes.
- **Changed:**
  - The Core is merged into the Runtime ([ADR 0004](../adr/0004-merge-core-into-runtime.md)).
  - Seven equal components became a Harness that adapts the others ([ADR 0002](../adr/0002-harness-is-the-standardizing-boundary.md)).
  - The Context component became a hook point ([ADR 0007](../adr/0007-context-management-is-a-hook.md)).
  - The "provider interface" passed down became a Provider handle with no credentials ([ADR 0005](../adr/0005-provider-handles-from-the-harness.md)).
- **Dropped:** swappable "ReAct / Plan-Execute / Graph" Cores. Those are turn-level strategies, so they belong to the Runtime.

## Tau and PiG (unverified)

These claims come from ChatGPT and have **not** been checked against either project's source. Check them before relying on them.

- **Tau (Python):**
  - packages `tau_coding` (application), `tau_agent` (`AgentHarness`, `run_agent_loop()`, tool execution, events) and `tau_ai` (providers)
  - its loop combines our step and turn
  - suggested as the better Python starting point
- **PiG (Go):**
  - packages `agent/`, `ai/`, `coding/` (including a `coding.Runtime` that hosts extensions and sessions, which is not our Runtime), `extensions/` and `tui/`
  - extensive hook points, and extensions in Go, Python, Rust or Node running as separate processes
  - deliberately does not replay interrupted operations
  - suggested as the better reference for hooks and SDK design
- **Both** use "turn" to mean our step.

---
status: withdrawn
date: 2026-11-14
---

**Current rule:** [Bindings](../bindings/README.md) lists the adopted wire profiles. The [ACP projection](../bindings/acp.md#entry) need not preserve every field in the shared record.

> **Withdrawn** on 2026-11-16 by [ADR 0010](0010-describe-parts-not-wiring.md). Which protocols to define or reuse is a wiring decision, set aside until we design wiring. The question is kept in [open questions](../open-questions.md#parked-how).

# Define our own messages for Harness ↔ Runtime, and adapt to existing standards elsewhere

No existing standard covers the Harness ↔ Runtime boundary, so the spec defines its own minimal messages for it. Everything outside the Harness is an adapter onto an existing standard rather than something the spec defines:
- AG-UI and A2A for Interfaces
- MCP and A2A for tool sources
- A2A push notifications for outbound webhooks
- OpenTelemetry for telemetry

This keeps the spec small and puts changes in the outside world into replaceable adapters. The Runtime ↔ Provider exchange might reuse an existing chat-completions shape. That is not decided.

## Consequences

- The Runtime's event stream must be translatable into AG-UI events, A2A task updates and OpenTelemetry spans without losing information. That is the test for our event vocabulary.

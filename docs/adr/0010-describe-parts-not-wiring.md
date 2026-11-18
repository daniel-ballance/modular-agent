---
status: accepted
date: 2026-11-16
---

**Current rule:** Core contracts such as [Interface and Harness](../contracts.md#interface-and-harness) pick no transport, but the [bindings](../bindings/README.md), including ACP, define optional wire profiles. Observability covers mediated interactions, not all effects or secret-bearing payloads; [Security](../security.md) governs what can be recorded or disclosed.

# Describe the parts and how they fit together, not how they are wired

We describe the system the way a product requirements document would: which parts it has, what each is responsible for and owns, what each needs from the others, what happens when they work together, and what must always be true. We do not define message formats, transports, process layout or wire protocols. An implementation may put every part in one process, as Pi does, or put them behind wire protocols as separate services. Both should fit the description unchanged.

We are doing this because wiring detail was pulling the discussion into technical design before we know what the system has to do.

## Considered options

- **Every contract is a message, with bindings kept separate** ([ADR 0001](0001-contracts-are-messages.md)). This decides wiring early, and as written it rules out Pi's in-process design, which passes functions instead of messages.

## Consequences

- This supersedes ADR 0001. Its goal stays, as something the system must do rather than a rule about how parts talk: every interaction between parts can be observed and recorded.
- This withdraws [ADR 0009](0009-own-protocol-south-adapters-north.md), which proposed our own Harness ↔ Runtime protocol and adapters to outside standards elsewhere. That is a wiring choice, to be reopened when we design wiring.
- An interaction such as "the Runtime asks the Harness to run a tool call" says which part depends on which. It does not say that anything crosses a wire, and a function call satisfies it.
- Outside protocols (MCP, A2A, AG-UI, ACP, OpenTelemetry) are research into how others divide the work, not targets we must map onto yet.
- Wiring questions are kept apart in [open questions](../open-questions.md), so they are not lost.
- The acceptance test in the README now asks whether existing systems can be described in our terms.

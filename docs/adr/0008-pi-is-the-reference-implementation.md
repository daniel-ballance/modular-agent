---
status: accepted
date: 2026-11-14
---

> **Amended** on 2026-11-16 by [ADR 0010](0010-describe-parts-not-wiring.md): we describe Pi's essentials as parts and how they fit together, not as messages. The rest of this decision stands.

# Pi is the reference implementation, and the spec restates its essentials as messages

Reasoning from first principles took us to almost the same design Pi already uses. We treat that as evidence the design is natural, and use Pi as the reference instead of fighting it. Pi is not a spec, though. Its boundaries are TypeScript signatures inside one process, which is why Tau and PiG port its code instead of implementing a shared contract.

The spec is therefore three things: Pi's essential behaviour restated as language-agnostic messages; the minimum every Runtime must provide, without Pi's coding-specific and UI-specific features; and separations Pi does not need, chiefly one Runtime contract that both transient and durable Runtimes can meet. We are free to depart from Pi where there is a reason to.

## Consequences

- The acceptance test is in the README.
- Pi's terms differ from ours (see 0003).

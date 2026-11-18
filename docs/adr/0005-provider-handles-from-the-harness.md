---
status: accepted
date: 2026-11-14
---

**Current rule:** Model selection and prompts are plugin work, access is credential-free, and [settings](../contracts.md#settings) pin the model for the turn and its recovery; Providers get their own authorized credentials from the [credential store](../contracts.md#asking-the-credential-store). Even a stateless, tool-free request can disclose data, incur cost or leave remote records, so all callers, including the Harness, follow [Security](../security.md) and [recovery rules](../contracts.md#recovery-and-repeating-work).

> **Note,** 2026-11-16: the Provider handle is now called **model access** in the [glossary](../../GLOSSARY.md). With [ADR 0011](0011-minimal-harness-everything-is-a-plugin.md), the Harness holds credentials through a credential store plugin.
>
> **Amended** on 2026-11-16 by the [pressure test](../pressure-test/synthesis.md#2-a-provider-can-keep-state-and-run-tools): the consequence "a model call has no effects outside the system" is true only when the Provider keeps no state and runs no tools. A Provider may do either, and declares it. The decision itself, that the Runtime gets access to a model without credentials and never chooses it, stands.

# The Harness owns Providers, and the Runtime gets a handle with no credentials

The Harness chooses the Provider, configures it, and holds its credentials, which the user supplies through an Interface. The Runtime receives a Provider handle: an address that speaks the standard generate request and response. Below that, the Provider adapter speaks the vendor's API with the credentials attached. LiteLLM and OpenRouter work the same way. Credentials never travel below the Harness.

The Runtime never chooses a model. If a step needs a different model, that is decided above the Runtime before the step starts. We rejected named "role" handles (such as "fast" or "strong") that a lower layer would choose between.

## Consequences

- A model call has no effects outside the system. If a process dies partway through a step, the step can be rerun at the cost of tokens alone. Tool calls are the operations that need care for durability.
- The Harness may also call Providers directly for its own work, such as summaries for compaction or session titles.

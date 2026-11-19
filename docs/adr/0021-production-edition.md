---
status: accepted
date: 2026-11-19
---

# Production edition 3: the specification for handoff

Four rounds of review found about 350, then 108, 22 and 18 issues. The reviews made it clear which documents set rules and caught gaps in authority, recovery and the wire. Fewer findings did not tell us whether independent builders would still have to guess. We froze the first edition and had all five builders work from it rather than ask for another review.

## Decision

Hand off edition 3 as the specification, not any of the reference builds. [Conformance](../conformance.md#the-documents), [Contracts](../contracts.md), [Security](../security.md) and the four [bindings](../bindings/README.md) set the requirements. The [Implementer's guide](../implementers-guide.md), architecture, scenarios and decision records explain them. An edition pins the specification for acceptance; it is not a binding major version. See [Versioning](../conformance.md#versioning).

- **Edition 1** froze the reviewed documents and kits and added the Implementer's guide.
- **Edition 2** resolved gaps found when all five builders implemented edition 1. All five needed a bound for fork preflight, and four needed a way to check a rewind point without restoring it. The kit also tried to close sessions with work running without the right to cancel.
- **Edition 3** resolved the gaps left by the edition 2 builds and the cross-language swaps. The rules now cover how to identify the same connection actor across builds, what happens if a configured plugin fails to start, and what the Harness and Runtime hand each other at refusal and recovery. The bindings' Changes sections record the wire changes.

The [kits](../conformance.md#the-conformance-kits) are a floor, not a certificate. A pass covers the cases the kit runs for the features the build declares. It does not show that every applicable rule holds or that a deployment is ready for production.

## Evidence

- **Builder round.** TypeScript, Rust, Python, Go and Elixir worked from the frozen edition. After the edition 2 fixes, all five passed their suites and applicable kits. They found faults in both the fixtures and their own builds.
- **Cross-language swaps.** The first pass exposed failures in all five matrices. Diagnosticians could read every build; clean-room builders received wire evidence, not peer code. The second pass left only Runtime failures. A stricter check exposed a false pass as well: listing a call left open was not enough without checking the turn outcome. After those fixes, the final rerun passed 125/125 pairings across the five matrices. [Status](../status.md#production-edition-3) has the results.
- **Real model.** Rust and Elixir reopened each other's durable sessions with `gpt-6-luna`, a shared history service and the same configured actor. The first Elixir-to-Rust run found an OpenAI reasoning translation bug that the scripted model missed. After Rust fixed it, both directions recovered the turn as completed, recorded the interrupted command as `outcomeUnknown` without running it again, and answered a follow-up from history.

## Consequences

A team can pin this edition, choose its wire profiles and repeat the checks for the combinations it plans to ship. [Round seven](../build-notes.md#round-seven) explains how to run those checks without masking failures.

The reference builds are not production systems. The team still needs to implement and test the gaps its deployment exposes:

- **Secret staging and recovery:** interruption between storing a secret and closing its question. See [Secrets](../contracts.md#secrets).
- **Per-connection isolation:** operator-controlled identity, representation, and project and tenant reach. See [Trust boundaries](../security.md#trust-boundaries).
- **Resource reservations:** capacity for work and its settlement under concurrent load. See [Resource limits](../security.md#resource-limits-and-denial-of-service).
- **Cross-session erasure coordination:** tracking pending copies across readers and writers. See [Erasure](../contracts.md#erasure) and [Security's deliberate limits](../security.md#deliberate-limits).

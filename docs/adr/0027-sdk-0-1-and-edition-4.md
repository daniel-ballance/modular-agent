---
status: accepted
date: 2026-11-20
---

# SDK specification 0.1 accepted, and edition 4 replaces edition 3

Two drafts waited on the same evidence. The [edition 4 draft](0023-edition-4-draft.md) was to stay a draft "until another build has met these rules and a matrix has run"; only the Rust build implemented it. The [SDK specification](0025-sdk-specification.md) was to move to accepted "when one SDK passes every scenario and guide". Both conditions now hold, for all four languages.

## Decision

Edition 4 and SDK specification 0.1 were accepted on the evidence below. **Current rule:** implement the [normative documents](../conformance.md#versioning) and [SDK scenarios](../sdk/testing.md) at the same revision. Change the SDK specification before changing its API.

## Evidence

- **All four bases implement edition 4.** Rust, TypeScript, Go and Python declare `nestedToolCalls` and pass the ACP and plugin kits' edition 4 checks.
- **The matrix ran.** The `nested-call` [shared scenario](../../conformance/sdk/README.md) passes in every SDK's runner with the fixture plugins served by every SDK, so a tool in one language makes nested calls through a host in another: part of the 220-run matrix, all passed.
- **Every SDK passes every scenario and guide.** All eleven shared scenarios in all four runners and five placements, and the guides' examples as tests in each language.
- **The reference implementations agree.** All four builds of `ma` pass the fifteen [reference checks](../../conformance/reference/README.md) and the identical set of 188 ACP kit checks.

## Considered options

- **Keep both as drafts until a real model has been used through every SDK.** Real-model runs test Providers and services, not the rules these documents set; the specification's rules were settled by kits and swaps, as editions 1 to 3 were. Real-model checks are tracked as a gap instead.
- **Promote edition 4 with a new binding version.** Nothing on the wire became mandatory, so a major version would only make edition 3 builds look incompatible when they are not.

## Consequences

- Production gaps from [ADR 0021](0021-production-edition.md) still stand.

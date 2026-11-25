---
status: accepted
date: 2026-11-25
---

# Two languages: Rust and TypeScript

[ADR 0036](0036-four-languages-in-lockstep.md) kept the four SDKs and the four `ma` programs in lockstep. Its argument still holds: a rule that more than one builder has built from the documents has been shown to be specifiable. What changed is the cost. A day of issue-driven work under the rule showed what it costs, and the project owner decided to keep two languages instead of four.

## Decision

The project keeps two languages, Rust and TypeScript.

- **Layer 3 has two SDKs**, in Rust and TypeScript. They are one SDK in two languages, in lockstep: a change to one is a change to both, or a gap recorded as an issue with the other's `lang:` label. Everything else ADR 0036 says about lockstep stays.
- **Layer 4 has two reference implementations of `ma`**, in Rust and TypeScript, implementing the [standard configuration](../reference/standard-configuration.md). Rust's texts stay the reference for wording ([ADR 0026](0026-one-reference-product.md)). The reference checks run against both.
- **Go and Python leave `main`.** The tag `four-languages` will mark the last commit that has them, made just before they are removed. Their results up to that commit stand as evidence, as Elixir's did ([ADR 0024](0024-five-layers.md)). A language comes back the way a new builder starts: built from the documents, passing the kits, the shared scenarios and the reference checks, then joining the lockstep through an ADR. The code at the tag is a starting point for that, not a promise to keep it current.
- **Interchangeability is still checked.** The shared scenarios run each SDK's fixture plugins in process and served by either SDK over stdio and WebSocket. The erasure matrix runs each language's agents on the other language's history service over HTTP.
- **Demonstrations use the pair.** A demonstration keeps mixing languages and placements, now with parts in Rust and TypeScript only.

This supersedes ADR 0036. It amends ADR 0024, whose layer 3 named four SDKs and whose swap matrices paired them, and ADR 0026, whose reference product was implemented in four languages.

## Why

At `main` 3af75e6 on 2026-11-25, the tracked `.rs`, `.go`, `.py`, `.ts` and `.tsx` files held about 91,000 lines of Rust, 97,000 of Go, 64,000 of Python and 39,000 of TypeScript, counting source and tests. ADR 0036 asked for each rule to be implemented in all four. The day showed what that costs beyond the writing:

- **The full check took about 37 minutes** on the reference machine (2,198 s, recorded in [CONTRIBUTING](../../CONTRIBUTING.md#checking-a-change)). Each language runs its own lane, and Python runs its suite in four configurations.
- **Most of the deadline issues were Go or Python steps.** Of the ten issues grouped under [#154](https://github.com/daniel-ballance/modular-agent/issues/154), five were Python only, one was Go only and one was TypeScript and Python.
- **Seventeen open issues carried only `lang: go` or `lang: python` labels**, counted before #130 closed #76.
- **A reviewed pull request waited on those steps.** [#130](https://github.com/daniel-ballance/modular-agent/pull/130), whose review had passed, waited on reruns of a Go kit step and a Python test before it could land.

Two builders keep what ADR 0036 was for: under the lockstep rule, each new rule is implemented from the documents in two separate SDKs instead of four, unless a gap is recorded. [ADR 0029](0029-sdk-decisions-after-four-builds.md) records the decisions the four builds needed, and those decisions are now in the documents.

**Why these two.** Rust's texts are already the reference for wording, and Rust has the standard configuration's first implementation. TypeScript is the smallest of the other three codebases, and the [Claude Provider](../../typescript/packages/claude/README.md) that the Rust `ma` loads is already written in it, so keeping TypeScript keeps that Provider in a maintained SDK. Two separate implementations can expose different mistakes in the documents; this record makes no claim that one pair would find more than another.

## Considered options

- **Keep four (ADR 0036).** It keeps four independent implementations of each rule, at the cost above.
- **Rust and Python.** It would suit a project that wants to be used inside Python applications. But the Python code is larger than TypeScript's, five of the ten deadline issues were Python only, and the Claude Provider would still be TypeScript.
- **Rust alone, with one `ma`.** It leaves the least code to maintain. But no second builder would check a new rule, which is the case ADR 0036 rejected.
- **One Harness wrapped for the other languages.** ADR 0024 rejected this because it stops showing that the documents are enough to build from. That still holds.
- **Keep Go and Python as plugin and client SDKs, with their Harness frozen.** It would keep plugin authoring and the ACP, AG-UI and history clients current in those languages. But a frozen Harness left in the repository either decays or keeps being fixed whenever the shared kits change. Separating the plugin and client code from the rest is a refactoring for users the project does not have: before 1.0 the project owner is the only user, and nothing is kept for backward compatibility.
- **Keep the TypeScript SDK but only the Rust `ma`.** It saves about 2,700 lines of TypeScript `ma`. The reference checks would still run, but the standard configuration would have one implementation, and no second builder would check that its document is enough to build from.

## Consequences

- `go/` and `python/` are removed from `main` right after the tag is made. `scripts/check.sh` and the other check scripts run only the Rust and TypeScript lanes. The erasure matrix has two pairings: each language's agents on the other's history service.
- Open issues about only Go or only Python close as not planned and point to the tag. Shared issues lose their `lang: go` and `lang: python` labels.
- Documents that describe four SDKs or four `ma` builds as current change to two. Records and research that describe the four builds stay as they are, as history.
- A plugin or Provider wanted in another language is written against the [plugin binding](../bindings/plugin.md), and the Rust and TypeScript SDKs load it over stdio or WebSocket. A service, such as a history service, is written against its own binding, such as [history over HTTP](../bindings/history-http.md). Neither needs an SDK in that language.

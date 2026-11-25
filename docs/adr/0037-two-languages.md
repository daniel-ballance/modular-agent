---
status: accepted
date: 2026-11-25
---

# Two languages: Rust and TypeScript

[ADR 0036](0036-four-languages-in-lockstep.md) kept the four SDKs and the four `ma` programs in lockstep. Its argument still holds: a rule that more than one builder has built from the documents has been shown to be specifiable. What changed is the cost. Running the rule for a day of issue-driven work measured it, and the operator decided to keep two languages instead of four.

## Decision

The project keeps two languages, Rust and TypeScript.

- **Layer 3 has two SDKs**, in Rust and TypeScript. They are one SDK in two languages, in lockstep: a change to one is a change to both, or a gap recorded as an issue with the other's `lang:` label. Everything else ADR 0036 says about lockstep stays.
- **Layer 4 has two `ma` builds**, in Rust and TypeScript, implementing the [standard configuration](../reference/standard-configuration.md). Rust's texts stay the reference for wording ([ADR 0026](0026-one-reference-product.md)). The reference checks run against both.
- **Go and Python leave `main`.** The tag `four-languages` marks the last commit that has them. Their results up to that commit stand as evidence, as Elixir's did ([ADR 0024](0024-five-layers.md)). A language comes back the way a new builder starts: built from the documents, passing the kits, the shared scenarios and the reference checks, then joining the lockstep through an ADR. The code at the tag is a starting point for that, not a promise to keep it current.
- **Interchangeability is still checked.** The kits, the shared scenarios and the erasure matrix pair the two SDKs, in process and served by each other.
- **Demonstrations use the pair.** A demonstration keeps mixing languages and placements, now with parts in Rust and TypeScript only.

This supersedes ADR 0036. It amends ADR 0024, whose layer 3 named four SDKs and whose swap matrices paired them, and ADR 0026, whose reference product was implemented in four languages.

## Why

On 2026-11-25, `main` had about 92,000 lines of Rust, 97,000 of Go, 64,000 of Python and 39,000 of TypeScript, counting source and tests. Each rule was written four times, as ADR 0036 said it would be. The day showed what that costs beyond the writing:

- **The full check took 37 to 46 minutes.** Each language runs its own lane, and Python runs its suite in four placements.
- **Most failures under machine load were in Go or Python.** Six of the ten issues grouped under [#154](https://github.com/daniel-ballance/modular-agent/issues/154) were Go or Python steps, and a seventh was partly Python. Each one cost a rerun and a decision before a pull request could land.
- **Seventeen of the open issues were about Go or Python alone.**
- **Several pull requests waited on one language.** A fix found in one build had to be made, tested and reviewed in three more before it could land.

Two independent builders keep what ADR 0036 was for: every new rule is still built twice from the documents, by builders that do not share code. Four builders found more, and [ADR 0029](0029-sdk-decisions-after-four-builds.md) records what they found; those findings are now in the documents.

**Why these two.** They are the most different pair of the four, a compiled language without a garbage collector and a garbage-collected one, so they are the least likely to share a mistake. TypeScript is also the smallest codebase, it runs where web and editor hosts run, and the [Claude Provider](../../typescript/packages/claude/README.md) that the Rust `ma` loads is already written in it.

## Considered options

- **Keep four (ADR 0036).** It gives the strongest check, at the cost above.
- **Rust and Python.** Python reaches the most agent developers. But it had the most open issues and failures under load, and a TypeScript Provider would still be needed for Claude.
- **Rust alone, with one `ma`.** It is the cheapest option. But no second builder would check a new rule, which is the case ADR 0036 rejected.
- **One Harness wrapped for the other languages.** ADR 0024 rejected this because it stops showing that the documents are enough to build from. That still holds.
- **Keep Go and Python as plugin and client SDKs, with their Harness frozen.** It would keep plugin authoring and the ACP, AG-UI and history clients current in those languages. But a frozen Harness left in the repository either decays or keeps being fixed whenever the shared kits change. Separating the plugin and client code from the rest is a refactoring for users the project does not have: before 1.0 the owner is the only user, and nothing is kept for backward compatibility.
- **Keep the TypeScript SDK but only the Rust `ma`.** It saves the 2,700 lines of TypeScript `ma`. But the standard configuration would then have one builder, and the reference checks, such as identical help text, would compare one build with itself.

## Consequences

- `go/` and `python/` are removed from `main` once the tag is made. `scripts/check.sh` and the other check scripts run only the Rust and TypeScript lanes. The erasure matrix has two pairings: each language's agents on the other's history service.
- Open issues about only Go or only Python close as not planned and point to the tag. Shared issues lose their `lang: go` and `lang: python` labels.
- Documents that describe four SDKs or four `ma` builds as current change to two. Records and research that describe the four builds stay as they are, as history.
- Plugins, Providers or services wanted in another language are written against the [plugin binding](../bindings/plugin.md) or a service binding. They need no SDK in that language, and the Rust and TypeScript SDKs load them over stdio or WebSocket.

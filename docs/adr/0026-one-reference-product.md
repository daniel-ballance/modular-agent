---
status: accepted
date: 2026-11-19
---

# One reference product, implemented in all four languages

[ADR 0024](0024-five-layers.md) gave each of the four languages a reference implementation. Each could have been a different kind of agent that plays to its language: a notebook agent in Python, a service in Go, an editor agent in TypeScript. Instead all four are the same product, the [standard configuration](../reference/standard-configuration.md): `ma`, a coding agent with Pi's feature set, written in each language on that language's SDK from one description.

## Considered options

- **A different agent per language.** It would show each language at its best and cover more uses. But four products need four descriptions, and nothing would check that the SDKs are equally capable, because no two implementations would do the same thing.
- **Same product, Rust only, with the other SDKs untested by a real application.** Cheaper, but the SDKs would only be exercised by their tests and guides.

The same product makes the SDKs comparable: the [reference checks](../../conformance/reference/README.md) and the ACP kit run unchanged against all four, and anything one implementation needed from its SDK, the others needed too.

## Consequences

- The configuration folder and its files, including `auth.json` and its lock and `trusted-projects.json`, are shared, so a person can switch implementation without signing in again. Sessions stay per language.
- The Rust implementation's texts are the reference for wording; a difference between implementations is a bug.
- Building the four found eleven SDK operations none of the SDKs had, such as listing saved sessions without opening them and serving several projects over ACP. They are now in the [SDK specification](../sdk/api.md).
- The Go code tool depends on a community Monty binding, `gomonty`, which does not yet support `import tools` or assigning a function to a variable.

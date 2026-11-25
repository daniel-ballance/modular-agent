---
status: accepted
date: 2026-11-19
---

**Current rule:** [ADR 0037](0037-two-languages.md) keeps two languages, Rust and TypeScript. Where this record says four SDKs or four `ma` builds, read two. Go and Python will be kept at the tag `four-languages` when they leave `main`.

# Five layers, from the specification to demonstrations

Seven rounds proved the specification, and [ADR 0022](0022-standard-configuration.md) built the first system meant to be used. There are now five builds. Each has its own internal API, and none is published for other developers to build on. The next step is to give developers that base in TypeScript, Python, Rust and Go, without losing the property the rounds proved: every part can be swapped for another build's part.

## Decision

The project has five layers. Each is made only from the layers below it.

| Layer | What it is | What keeps it honest |
|---|---|---|
| 1. [Specification](../conformance.md#the-documents) | What every agent and part must do, the trust boundaries, and the wire. It is what makes parts interchangeable. | Conformance kits and the swap matrix |
| 2. SDK specification | What a developer sees: concepts, names, the shape of the API, and how each language expresses them | A shared set of scenarios, and guides whose examples run as tests |
| 3. SDKs | One published library for each of TypeScript, Python, Rust and Go | The checks of layers 1 and 2, for all four |
| 4. Reference implementations | Batteries-included agents for everyday use, each in one language | Built only on the public API of its SDK |
| 5. Demonstrative implementations | Opinionated agents that show the ecosystem, such as one agent with parts in all four languages, or parts as services | Built only on the public SDKs and the bindings |

The rules between the layers:

- **A gap goes down a layer.** When a layer needs something the layer below cannot give, the lower layer changes first: documents, then code, then the layer that found the gap. No layer works around one below it.
- **The documents still build the code.** An agent builds each SDK from layers 1 and 2, as the clean-room builders built from the specification. Where the builder has to guess, the guess becomes a change to the documents.
- **The SDK specification sets requirements for the SDKs, not for conformance.** An agent built without an SDK still conforms if it meets layer 1. Layer 1 still prescribes no in-process API ([ADR 0010](0010-describe-parts-not-wiring.md)).
- **The four SDKs are one SDK in four languages.** They share concepts, names and API shape, each expressed the way its language does things. A developer writes a plugin once. Where it runs, in the agent's process, in a child process over the [plugin binding](../bindings/plugin.md) or as a service, is a choice made when the agent is put together, not a change to the plugin. So is the choice between the transient and durable Runtimes.
- **Interchangeability is checked, not assumed.** The kits and the swap matrix run across the four SDKs as part of their tests.
- **A reference implementation is not a demonstration.** A reference implementation is a product someone uses every day, so it is written in one language. It can load a plugin from another SDK only for something its own language cannot reach, as the standard configuration does to reach Claude through the TypeScript Agent SDK. A demonstration mixes languages and placements to show what the ecosystem can do, and it need not be a daily tool.

This supersedes one point of [ADR 0017](0017-plugins-in-any-language.md): "It doesn't port one plugin API to every language." That suited four independent builds. One team now owns all four SDKs, which is the case 0017 said a common API fits.

### Choices

- **SDK order: Rust, TypeScript, Go, Python.** Rust goes first because it is the only build on the [edition 4 draft](0023-edition-4-draft.md) and already carries a reference implementation, so it puts the SDK specification to work soonest. Each later SDK builds from the documents as the earlier ones revised them. Work that does not wait on an earlier SDK runs in parallel.
- **One reference implementation for each of the four languages.** The [standard configuration](0022-standard-configuration.md) is Rust's.
- **Elixir has no SDK.** It was built for language diversity while the specification was being tested, and there is no other reason to keep it. The Elixir build stays in its own repository as evidence for editions 1 to 3, and its results stand. Swap matrices from now on pair the four SDKs.
- **One repository for every language.** The specification, the kits and the four languages live together, so one change can update a document, a kit and every SDK:

| Path | Holds |
|---|---|
| `docs/`, `GLOSSARY.md`, `conformance/` | Layer 1, and layer 2 when it is written |
| `rust/`, `typescript/`, `go/`, `python/` | Each language's SDK, reference implementation and anything else written in that language, such as the Claude Provider in `typescript/packages/claude` |

The languages are peers: nothing specific to one language sits at the top level. Each keeps its own toolchain and lockfile in its directory, and links `conformance` to the shared kits. Python and Go are copied in from their clean-room repositories as Rust was, with each build's own notes in its `docs/clean-room/`. Demonstrative implementations get a top-level directory when the first one is written.

## Considered options

- **Publish each build with its own API.** The least work. Developers would face four different products under one specification, and what they learn in one language would not carry to another.
- **Put the developer API in the specification.** It would make every conforming agent carry an SDK and reverse ADR 0010. An agent built another way, as Pi is, could no longer conform.
- **One implementation, wrapped for the other languages.** A single Harness in Rust, called from the other three, would be one codebase to maintain. But it would stop showing that the documents are enough to build from, and the swap matrix would test one Harness against itself.
- **Reference implementations and demonstrations as one layer.** Mixing languages to show the ecosystem makes a daily tool harder to install and run, and keeping one language would hide the ecosystem. They serve different readers.
- **A repository for each language.** Each SDK would version and release on its own. But a change to the specification would land in five places at once, and the swap matrix would need five checkouts at matching revisions.

## Consequences

- **Layer 2 has to be written.** It needs an SDK specification, a set of scenarios each SDK runs, and guides for the common tasks, starting with a first agent and adding a tool. It also needs a machine-readable schema for [shared data](../bindings/data.md), from which each SDK generates its types. That schema belongs to layer 1.
- **Services need a change to layer 1 first.** The plugin binding runs a plugin as a child process over stdio. Only history has an HTTP binding. The services in [ADR 0015](0015-parts-as-services.md) used private APIs. A part served over a network needs a binding before an SDK can offer it.
- **The Rust reference implementation is not yet separate from its base.** The standard configuration shares a workspace with the Rust base and can reach its internals. [`packages/claude`](../../typescript/packages/claude/README.md) is a TypeScript Provider the Rust reference implementation loads, not a demonstration.
- **The SDKs reach one edition together.** Only the Rust build implements the [edition 4 draft](0023-edition-4-draft.md).
- **Names.** *Reference implementation* now names layer 4. The standard configuration is the first. [ADR 0008](0008-pi-is-the-reference-implementation.md) used the phrase for Pi; Pi stays the reference for features. The five experiment builds are *builds*, not reference builds.

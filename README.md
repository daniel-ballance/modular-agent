# Modular Agent

A specification for an AI agent made of a small **Harness** and replaceable **plugins**: the model Providers, the tools, the working environment, where history is kept, the Interfaces, and the Runtime that runs the agent loop itself.

The specification says **what** each part does, what passes between the parts, and what must always hold. It doesn't prescribe how a part works inside. The core prescribes no transport. Optional **bindings** fix the wire where two builds need to work together: ACP for hosts, a plugin protocol, and an HTTP history service. The bindings share JSON shapes.

The current handoff is [production edition 3](docs/adr/0021-production-edition.md). An [edition 4 draft](docs/adr/0023-edition-4-draft.md) adds rules found by the first working build; only the Rust build implements it.

## Why it holds up

Five builds were made from these documents: one in TypeScript, and four clean-room builds in Rust, Python, Go and Elixir whose builders saw only the documents. In the final swap round, each build passed the kits and ran with every other build's parts:
- every host with every build's Provider, hooks, tools and working environment;
- every host with every build's Runtime, through a real `kill -9` mid-tool-call;
- every agent reopening, continuing and recovering every other agent's sessions, including their unfinished jobs.

All 125 pairings passed across the five final matrices. [Status](docs/status.md#production-edition-3) records the results. [Build notes](docs/build-notes.md#round-seven) explains what the swaps found and how to repeat them.

## Layers

The project has five layers. Each is made only from the layers below it, and a gap found in one is fixed in the layer below first. [ADR 0024](docs/adr/0024-five-layers.md) records the decision.

| Layer | What it is | Where it is |
|---|---|---|
| 1. Specification | What every agent and part must do, and the wire | [`docs/`](docs/conformance.md#the-documents), [kits](conformance/) |
| 2. SDK specification | What a developer sees, in each language | Not yet written |
| 3. SDKs | One SDK in Rust, TypeScript, Go and Python, in that order | Not yet; the [builds](#builds) are the starting points |
| 4. Reference implementations | Batteries-included agents, one for each language | Rust's [standard configuration](#rust); the others not yet |
| 5. Demonstrative implementations | Agents that show the ecosystem, across languages and placements | None yet |

Each language is a peer directory with its own toolchain: [`rust/`](rust/README.md), [`typescript/`](typescript/README.md), [`go/`](go/README.md) and [`python/`](python/README.md). Each links `conformance` to the shared [kits](conformance/).

## Reading order

| Read | To learn | Status |
|---|---|---|
| [Conformance](docs/conformance.md) | which documents set requirements, how to claim conformance, and how bindings change | normative |
| [Implementer's guide](docs/implementers-guide.md) | what to build, how a turn runs, and which kit checks each milestone | informative |
| [Glossary](GLOSSARY.md) | the vocabulary | informative |
| [Architecture](docs/architecture.md) | the parts, their responsibilities, and why | informative |
| [Contracts](docs/contracts.md) | what passes between the parts, and the rules every implementation follows | normative |
| [Security](docs/security.md) | the trust boundaries, and the rules that keep them | normative |
| [Scenarios](docs/scenarios.md) | seventeen situations, told with the parts and rules | informative |
| [Bindings](docs/bindings/README.md) | the wire: [shared data](docs/bindings/data.md), [plugins](docs/bindings/plugin.md), [ACP](docs/bindings/acp.md), [history service](docs/bindings/history-http.md) | linked bindings are normative |
| [Conformance kits](conformance/) | programs that check a build against the bindings | informative |
| [Decision records](docs/adr/README.md) | why each decision was made, and what was rejected | informative |
| [Open questions](docs/open-questions.md) | this edition's limits and implementation choices, with safe defaults | informative |

## Background

Not requirements. They record how the specification was reached.

| File | What it holds |
|---|---|
| [docs/build-notes.md](docs/build-notes.md) | What the independent builds, cross-language swaps and real-model runs found |
| [docs/status.md](docs/status.md) | Edition 3 results for all five builds and earlier TypeScript evidence |
| [docs/examples/](docs/examples/) | Existing agents described in these terms: [vanilla Pi](docs/examples/vanilla-pi.md), and [two durable agents](docs/examples/durable-agents.md) |
| [docs/research/](docs/research/) | Notes on prior art and protocols, and a map of how each fills these parts |
| [docs/pressure-test/](docs/pressure-test/) | The early tests of the design against Pi, agent frameworks, T3 Code and an everything-at-once system |
| [docs/one-pager.html](docs/one-pager.html) | A one-page overview |

## Builds

The four builds below are the starting points for the SDKs. They are builds for testing the specification, not production systems. The Elixir build was used only for language diversity in the experiment; it stays in its own repository and gets no SDK.

### Rust

[`rust/`](rust/README.md) holds a working agent: the clean-room Rust build as its base, and on it a **standard configuration** with Pi's feature set. It has one code tool backed by a Monty sandbox, Providers for ChatGPT, Grok and Claude subscriptions, Agent Skills, an MCP client and a CLI, `ma`. [ADR 0022](docs/adr/0022-standard-configuration.md) records the decisions. The Claude Provider is a TypeScript plugin in its own process, in [`typescript/sidecars/claude`](typescript/sidecars/claude/README.md).

### TypeScript

[`typescript/`](typescript/README.md) holds the TypeScript build: a Harness, transient and durable Runtimes, the vanilla Pi plugin set, subagents, a terminal UI, an ACP Interface that T3 Code drives, plugins over the plugin binding, and parts as HTTP services. [Status](docs/status.md) shows what it exercises.

### Go and Python

[`go/`](go/README.md) and [`python/`](python/README.md) hold the clean-room Go and Python builds, copied in unchanged. Each has a Harness, both Runtimes, ACP, the plugin host and served plugins, and history kept locally or in a service.

## Acceptance test

The [conformance rules](docs/conformance.md#what-conforms) define the core and optional wire profiles. A production deployment pins the specification revision for acceptance and records its own deployment profile: the bindings and versions, required declarations and guarantees, and kit results for the builds it accepts. It rejects a startup that cannot meet its authentication, isolation, limits, audit, retention or recovery requirements. Performance targets are each deployment's own.

Conformance does not establish production readiness. In addition to the applicable kit checks, test that the deployment preserves authority, isolation and recovery across the swaps it allows. See [Security](docs/security.md) for the trust boundaries.

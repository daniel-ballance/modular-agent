# Modular Agent

A specification for an AI agent made of a small **Harness** and replaceable **plugins**: the model Providers, the tools, the working environment, where history is kept, the Interfaces, and the Runtime that runs the agent loop itself.

The specification says **what** each part does, what passes between the parts, and what must always hold. It doesn't prescribe how a part works inside. The core prescribes no transport. Optional **bindings** fix the wire where two builds need to work together: ACP for hosts, a plugin protocol, and an HTTP history service. The bindings share JSON shapes.

## Why it holds up

Five builds were made from these documents: one in TypeScript, and four clean-room builds in Rust, Python, Go and Elixir whose builders saw only the documents. In the final swap round, each build passed the kits and ran with every other build's parts:
- every host with every build's Provider, hooks, tools and working environment;
- every host with every build's Runtime, through a real `kill -9` mid-tool-call;
- every agent reopening, continuing and recovering every other agent's sessions, including their unfinished jobs.

The swaps found gaps that led to rules and kit checks. [Build notes](docs/build-notes.md) tell that story.

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
| [docs/build-notes.md](docs/build-notes.md) | What building it, six rounds of cross-language swaps, and real-model runs found |
| [docs/status.md](docs/status.md) | Which rules the TypeScript build in `packages/` exercises |
| [docs/examples/](docs/examples/) | Existing agents described in these terms: [vanilla Pi](docs/examples/vanilla-pi.md), and [two durable agents](docs/examples/durable-agents.md) |
| [docs/research/](docs/research/) | Notes on prior art and protocols, and a map of how each fills these parts |
| [docs/pressure-test/](docs/pressure-test/) | The early tests of the design against Pi, agent frameworks, T3 Code and an everything-at-once system |
| [docs/one-pager.html](docs/one-pager.html) | A one-page overview |

## Reference

### The TypeScript build

`packages/` holds the TypeScript build: a Harness, transient and durable Runtimes, the vanilla Pi plugin set, subagents, a terminal UI, an ACP Interface that T3 Code drives, plugins over the plugin binding, and parts as HTTP services. [Status](docs/status.md) shows what it exercises. It is a reference build, not a production build.

## Acceptance test

The [conformance rules](docs/conformance.md#what-conforms) define the core and optional wire profiles. A production deployment pins the specification revision for acceptance and records its own deployment profile: the bindings and versions, required declarations and guarantees, and kit results for the builds it accepts. It rejects a startup that cannot meet its authentication, isolation, limits, audit, retention or recovery requirements. Performance targets are each deployment's own.

Conformance does not establish production readiness. In addition to the applicable kit checks, test that the deployment preserves authority, isolation and recovery across the swaps it allows. See [Security](docs/security.md) for the trust boundaries.

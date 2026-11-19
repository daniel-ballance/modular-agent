---
status: draft
date: 2026-11-19
---

# The SDK specification, draft 0.1

[ADR 0024](0024-five-layers.md) put an SDK specification between the specification and the four SDKs. The specification says what an agent must do and deliberately leaves the developer's API open ([ADR 0010](0010-describe-parts-not-wiring.md)). The four builds filled that gap four ways. TypeScript gives every plugin one wide API object at setup, Rust and Python pass raw JSON through much of theirs, and Go's is a list of untyped calls. None of them can say whether a plugin will still work in another process. The first draft is in [`docs/sdk/`](../sdk/README.md), with seven [shared scenarios](../../conformance/sdk/README.md).

## Decision

- **The developer's object is the Agent.** The Harness stays inside it. `createAgent` checks the whole composition and fails before anything runs.
- **What a plugin registers is what the plugin binding can carry.** A plugin built only from those items is *servable*: `serve(plugin)` runs it in its own process unchanged, under an agent in any language. The few features the wire cannot carry are marked in-process only. `serve` refuses a plugin that uses one; it does not serve the rest and drop the feature.
- **Authority travels with the work.** A plugin reaches the agent only through the context of the call it is serving, as served plugins do through host callbacks. Only Interfaces get the whole Agent.
- **Durability is one option:** `ephemeral`, `kept` or `durable`. It sets the history store and the Runtime together and rejects combinations that cannot keep its promise. The default is `ephemeral`.
- **Safe, quiet defaults.** One `local` actor, present only while the app has a question handler, so an approval no one can answer is refused, never left waiting. No approval plugin unless asked for. Credentials from environment variables.
- **The SDK covers what the specification names.** Each SDK ships an implementation of every part and every binding, plus API-key Providers for the OpenAI Responses and Anthropic Messages APIs. Features the specification does not describe, such as skills, a code tool, subscription sign-in and a CLI, belong to reference implementations.
- **One version for all four SDKs,** the revision of the SDK specification.
- **The swap matrix becomes part of each SDK's tests.** Every SDK runs every shared scenario with the fixture plugins in process and served by each of the four SDKs, and runs every guide example as a test.
- **Same names, the language's own idiom.** Operations, fields and error codes are the same everywhere. Construction follows each language: a builder in Rust, an options object in TypeScript, functional options in Go, keyword arguments in Python.

## Considered options

- **One wide plugin API handed over at setup,** as the TypeScript build does. It is convenient in process, but a served plugin cannot hold it, and it lets a plugin act with no work to answer for. Rejected.
- **Separate history and Runtime choices only.** That is accurate, but a developer has to know which pairs are valid. They remain as overrides beneath the one option.
- **`kept` or `durable` as the default.** It suits a product, and the reference implementations will choose it. A library that writes to disk unasked surprises the developer.
- **One shape in every language,** such as a builder everywhere. It is easier to check, but it reads as foreign code in three of the four languages. The names stay the same; the construction does not.
- **Wait for a machine-readable schema before writing the SDK specification.** The schema matters but does not block the API. Types are hand-written to the shared data names until it exists.

## Consequences

- **Rust starts.** The Rust workspace splits into the `modular-agent` core crate, official plugin crates, a testing module, a fixture program and a scenario runner. The standard configuration moves onto the public API.
- **Gaps found, for layer 1:**
  - The specification's standard events have no wire names except the output events in shared data. The SDK named the rest, and those names belong in shared data.
  - Parts other than history have no service binding.
  - Shared data has no JSON Schema.
- **The draft will change.** Building the Rust SDK and running the scenarios will find mistakes in it, and they are fixed here first. The status moves to accepted when one SDK passes every scenario and guide.

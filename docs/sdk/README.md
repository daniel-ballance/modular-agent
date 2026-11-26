# The SDK specification

**Status: 0.3, accepted.** [ADR 0027](../adr/0027-sdk-0-1-and-edition-4.md) accepted the first revision.

Both SDKs implement the specification: [Rust](../../rust/crates/sdk/README.md) and [TypeScript](../../typescript/packages/core/README.md). Each SDK runs the [shared scenarios](../../conformance/sdk/README.md) in process and served by every SDK. See [Status](../status.md) for release results. Each SDK runs the [guide examples](guides/README.md) as tests.

ADR 0025 records the [first](../adr/0025-sdk-specification.md#the-first-build-round) and [second](../adr/0025-sdk-specification.md#the-second-build-round) rounds of building the SDKs.

This is layer 2 of the [five layers](../adr/0024-five-layers.md). The [specification](../conformance.md#the-documents) says what an agent and its parts must do and what crosses the wire. It deliberately says nothing about the API a developer writes against. This document set does. It describes one SDK, expressed in two languages, so that someone who has built an agent in one language can build one in another without learning a new model.

An agent builds each SDK from these documents and the specification. Where it has to guess, the guess becomes a change here first.

## Reading order

| Read | To learn |
|---|---|
| This page | What the SDK is for, the principles behind it, how it is versioned and checked |
| [Concepts](concepts.md) | What a developer sees, what is hidden until needed, and the defaults |
| [API](api.md) | The shape of the API, in language-neutral terms |
| [Subscription Providers](subscription-providers.md) | `chatgpt`, `grok` and `claude`: using a person's own plan, sign-in and the login file |
| [Placement and durability](placement.md) | Where each part can run and what survives a restart, and how a developer chooses |
| [Testing](testing.md) | The testing kit each SDK ships, and the shared scenarios that check the SDKs against each other |
| [API reference](reference.md) | How to build each language's generated reference |
| [Languages](languages.md) | How each language expresses the API, and the package names |
| [Guides](guides/README.md) | Task-by-task walkthroughs in both languages. Their examples become tests. |

## What the SDK is for

Three kinds of developer use it:

- **Someone building on an agent.** They put an agent together from parts, start sessions, send input, follow events and answer questions. Most never write a plugin.
- **Someone writing a plugin.** Usually a tool, sometimes a Provider or a hook. They want to write it once and have it work in any agent, in any language, wherever it runs.
- **Someone running agents.** They choose where each part runs and what survives a crash, without editing the parts.

The SDK serves all three with one model. A developer meets the parts of the specification only when they need them.

## Principles

1. **The specification decides behavior; the SDK decides how it feels.** Every rule in [Contracts](../contracts.md), [Security](../security.md) and the bindings holds inside the SDK. The SDK hides rules a developer does not need to think about; it never relaxes one.
2. **The developer's object is the Agent.** In the specification an agent is the Harness plus plugins. The SDK gives the developer an Agent and keeps the Harness inside it.
3. **Write a plugin once, run it anywhere.** What a plugin registers is exactly what a [plugin binding registration](../bindings/plugin.md#starting-the-handshake) can carry. The same plugin runs in the agent's process or, unchanged, in its own process under an agent in any language. The few features the wire cannot carry are marked; a plugin that uses one says so, and the SDK refuses to serve it over the wire rather than dropping the feature.
4. **Authority travels with the work.** A plugin reaches the agent through the context of the call it is serving, as the binding's callbacks do. It keeps no handle that outlives that call, except the roles that can only run in process.
5. **Placement and durability are choices made when an agent is put together.** Moving a part into another process, or making turns survive a crash, changes one line of composition and no plugin code.
6. **Safe, quiet defaults.** With no configuration an agent keeps nothing on disk, has one local actor and no approval plugin, and refuses an approval no one can answer instead of waiting forever. Turning on more is one call each.
7. **Defined values, not messages.** Anything a program branches on is a typed value or a stable code, never the wording of an error. This is the specification's own rule, carried into the API.
8. **The same names in every language.** Concepts, operations, fields and errors use the glossary's names and the shared data's field names, cased the way each language expects.

## How the SDKs are checked

The SDK specification sets requirements for both SDKs. It does not change what conformance means: an agent built without an SDK still conforms if it meets the specification.

Requirements use the [keywords](../conformance.md#keywords) of the specification. An SDK passes when:

- its own tests pass;
- it passes the specification's [kits](../conformance.md#the-conformance-kits) for every binding it offers;
- it runs every [shared scenario](testing.md#the-shared-scenarios) with its fixture plugins in process, served from its own SDK, and served from each other SDK;
- every example in the [guides](guides/README.md) compiles and runs as a test.

The third check is the swap matrix of the experiment, made part of every SDK's tests.

## Versioning

Both SDKs share one version number, the revision of this specification. SDK 0.3 in any language implements SDK specification 0.3. Patch releases are each SDK's own. Implement the current normative documents and SDK scenarios from the same revision. Report the commit or tag tested and the binding versions implemented.

Until 1.0, a minor version can break the API. From 1.0, a breaking change needs a major version in both.

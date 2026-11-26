---
status: accepted
date: 2026-11-19
---

**Current rule:** accepted as SDK specification 0.1 by [ADR 0027](0027-sdk-0-1-and-edition-4.md). [ADR 0037](0037-two-languages.md) keeps two SDKs, Rust and TypeScript. Where this record says four SDKs, read two. Go and Python are kept at the tag `four-languages`.

# The SDK specification, draft 0.1

[ADR 0024](0024-five-layers.md) put an SDK specification between the specification and the four SDKs. The specification says what an agent must do and deliberately leaves the developer's API open ([ADR 0010](0010-describe-parts-not-wiring.md)). The four builds filled that gap four ways. TypeScript gives every plugin one wide API object at setup, Rust and Python pass raw JSON through much of theirs, and Go's is a list of untyped calls. None of them can say whether a plugin will still work in another process. The first draft is in [`docs/sdk/`](../sdk/README.md), with seven [shared scenarios](../../conformance/sdk/README.md).

## Decision

- **The developer's object is the Agent.** The Harness stays inside it. `createAgent` checks the whole composition and fails before anything runs.
- **What a plugin registers is what the plugin binding can carry.** A plugin built only from those items is *servable*: `serve(plugin)` runs it in its own process unchanged, under an agent in any language. The few features the wire cannot carry are marked in-process only, including context members such as a named credential. An item whose code uses one says so with an `inProcessOnly` flag, because `serve` can see registrations but not what a function will call. `serve` refuses a plugin with such an item; it does not serve the rest and drop the feature.
- **Authority travels with the work.** A plugin reaches the agent only through the context of the call it is serving, as served plugins do through host callbacks. Only Interfaces get the whole Agent.
- **Durability is one option:** `ephemeral`, `kept` or `durable`. It sets the history store and the Runtime together and rejects combinations that cannot keep its promise. The default is `ephemeral`.
- **Safe, quiet defaults.** One local actor, `user`, present only while the app has a question handler, so an approval no one can answer is refused, never left waiting. No approval plugin unless asked for. Credentials from environment variables. An embedded agent is not a plugin host, so it starts no program named in `MODULAR_AGENT_PLUGINS`, unless the app gives it process plugins.
- **Errors use the codes of the binding each surface mirrors.** What an app calls uses the ACP codes, so `serveAcp` passes them through. What a plugin's context calls uses the plugin binding codes, so a plugin sees the same code in process and served.
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

## Review

A cross-model review of the first draft found that it relaxed several rules it was meant only to hide, and this draft corrects them:

- it repeated a crashed call on the tool's promise alone;
- it refused a `replaces` entry that collided with nothing;
- it offered served plugins context members the binding does not allow;
- it named the tool schema fields `input` and `output` on the wire;
- it invented a `refused` error code where ACP uses `forbidden`.

The declaration now has a table of its values, so no key is guessed.

## The first build round

All four SDKs were built from draft 0.1, each wrapping its language's base. Every runner then passed the first seven scenarios in process and served by every SDK: 140 runs. The builders recorded about 35 findings; these changed the draft:

- **The declaration is computed from the chosen parts,** not a table of constants: erasure, command containment, settings during a turn and nested calls depend on the store, environment, host and Runtime. The draft had claimed the local environment confines files; it does not, and declares `confinesFiles: false`.
- **`pluginHost: false` with `processPlugins` is `invalid_composition`.** One builder proposed loading the listed programs while skipping `MODULAR_AGENT_PLUGINS`. An agent that loads plugin programs is a plugin host, and the binding requires every host to read the variable, so the combination is refused rather than allowed to ignore that rule.
- **Kept history needs a persistent store, not necessarily `dataDir`,** but a part with local recovery bookkeeping, such as the local environment, still needs `dataDir`.
- **An embedded `openSession` may wait for recovered work; `serveAcp` must not,** as ACP requires.
- **Diagnostics may differ between SDKs** but not between one SDK's placements; programs branch on the status.
- **Event lag, structured results, the `restart` helper, `serveHistory` and Provider errors** each got a precise rule.
- **Four scenarios** were added: a tool's own refusal, invalid input, a nested call, and read-only tools under `ask`.

## The second build round

Each SDK was brought to the revised draft and the eleven scenarios; Python and TypeScript and Go brought their bases to the [edition 4 draft](0023-edition-4-draft.md) for nested calls. The full matrix then passed 220 runs, and every SDK's own suite and kit runs passed. Three builders independently found that the revised `dataDir` rule rejected the default ephemeral agent, whose command bookkeeping lives in scratch; the rule now applies only where bookkeeping must survive a restart. The other changes: an unknown model is `invalid_params` over ACP; a `tool.after` that produces an invalid value settles safely without exposing it; a served Runtime's nested-call support and queued-input policy are decided by the host, since the plugin binding's `RuntimeSupports` carries no flag for them; and a volatile memory store cannot be served as a conforming history service.

## Consequences

- **Rust starts.** The Rust workspace splits into the `modular-agent` core crate, official plugin crates, a testing module, a fixture program and a scenario runner. The standard configuration moves onto the public API.
- **Gaps found, for layer 1:**
  - The specification's standard events have no wire names except the output events in shared data. The SDK named the rest, and those names belong in shared data.
  - Parts other than history have no service binding.
  - Shared data has no JSON Schema.
- **The draft will change.** Building the Rust SDK and running the scenarios will find mistakes in it, and they are fixed here first. The status moves to accepted when one SDK passes every scenario and guide.

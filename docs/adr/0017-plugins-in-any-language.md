---
status: accepted
date: 2026-11-17
---

# A plugin in any language, through one binding of the contracts

[ADR 0014](0014-plugins-in-other-processes.md) let a plugin run in another process, but only a TypeScript plugin under the TypeScript build: its RPC carried that build's own objects and callbacks. Four builds now exist, in TypeScript, Rust, Python and Go, each with its own plugin API. A plugin written for one couldn't run under another.

## Decision

The [plugin binding](../bindings/plugin.md), `modular-agent-plugin/1`, turns the interactions in [Contracts](../contracts.md#interactions) into JSON-RPC messages over a child process's stdio. It covers what the Harness asks:
- a tool source, a Provider and the working environment;
- a hook handler and a command;
- the Runtime.

It also covers what a plugin may ask back, under `host/*`. All data uses one [shared schema](../bindings/data.md). A plugin is never sent a build's plugin API, only these messages, so a plugin written once runs under every build.

The shape follows PiG, which hosts extensions in four languages over one wire ([PiG reference](../research/pig-reference.md)):
- a registration handshake is the only source of what a plugin provides;
- a plugin's callbacks name the request they belong to, which carries authority and cancelling;
- history is read on demand, in pages;
- messages have a size cap, and there is a heartbeat.

It differs from PiG in two ways.
- **It doesn't port one plugin API to every language.** PiG ships every SDK and keeps them consistent with a 225-row parity matrix. That suits one team, not four independent builds. Standardizing the contracts' interactions needs no parity matrix: a conformance kit and a swap matrix give the same assurance.
- **The binding is versioned.**

Some rules came from building it, and each is now in the binding:
- **The Runtime is a plugin like any other.** A turn is one request. The Runtime asks the host for each step's request, the model, tools, hooks and records, so it never chooses the model, sees credentials or runs a tool. Its state lives in the history, which it reads back with `host/history` after a restart.
- **The host emits the standard turn events itself,** because the model stream, steps and tool calls all pass through it. A Runtime reports only events of its own.
- **Anything a receiver branches on is a defined value.** That includes `timeoutMs: 0`, `not_found` for a missing file, the turn events and the answer to a cancelled request. It is never an error's wording or an unstated default.

## What showed it works

**Each build serves and hosts plugins,** and passes the plugin conformance kit (84 checks: handshake, Provider, tools, environment, hooks, and both Runtimes).

**Two swap matrices ran every host language against every other build's plugins:**
- **Plugins.** Each host ran with every build's Provider and hooks, and the next build's tools and environment: 16/16. Four more turns each used all four languages, one in each role: 4/4.
- **Runtimes.** Each host ran every build's Runtime, through a real `kill -9` during a `bash` call and a reopen in a new process: 16/16 durable, where the turn carried on, and 16/16 transient, where it ended as failed as declared. The interrupted command never ran twice.

**Each build passed every kit on its own before the matrices ran, and the matrices still failed at first.** They found five holes:
- `timeoutMs: 0`;
- how a missing file is reported;
- a model-output event the binding never named;
- whether a Runtime may read history;
- a host not answering a cancelled request.

The first four were gaps in the binding; the last was a host bug under one timing. None could be found by testing one build against itself, which is why the matrix, not the kit, is the real test of a binding.

## Considered options

- **Carry a build's own plugin API across languages,** as ADR 0014 does within one build. Rejected: the four APIs differ, and the description deliberately leaves them to each build.
- **Port one plugin API to every language,** as PiG does. Rejected for four independent builds (see above).
- **MCP for tool sources, ACP for whole agents, and nothing else.** Rejected. Neither covers hook points, Providers, the working environment or the Runtime.
- **One binding per capability, each with its own transport.** Rejected. One connection per plugin, with one envelope and one cancel, keeps a plugin that provides several capabilities simple.

## Consequences

- A host language and a plugin language are now independent choices, including for the Runtime.
- "Before output reaches a recipient" is not offered to a plugin in another process in `/1`: holding streamed output would cost a round trip per piece.
- History, credential and configuration stores are not hosted this way. History has its own HTTP binding, and the other two hold secrets or are trivial.
- Each build keeps its own wire format for its own process placement (ADR 0014 for TypeScript; Python's private one). The binding is what crosses languages.

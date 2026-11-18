---
status: accepted
date: 2026-11-16
---

**Current rule:** The design below describes the first build. [Conformance](../conformance.md#what-conforms) does not require its language, process layout or storage format.

# The first implementation is TypeScript in one process, with a package per part

The first implementation of the description runs in one Node.js process. Every part talks to the others through function calls. It is written in TypeScript, as one workspace in this repository, with a package for the Harness, the Runtime and each plugin. The Provider plugin wraps pi-ai, so we don't rewrite vendor adapters. The Harness and Runtime are written fresh, because they are what the project studies. File tools may copy from Pi, which is MIT-licensed. The first Interface is a line-based terminal with a JSON mode for scripts and tests. The history store writes one JSONL file per session, appending each batch of changes as one write.

## Considered options

- **Build on pi-coding-agent and pi-agent-core.** Rejected. Their boundaries are the ones the description reworks, such as tools built and wrapped by the Harness and approval as an extension. Reusing them would hide the parts we want to study.
- **Build on Pi Durable.** Rejected for the first build. It is experimental, and it puts history, plugin state and progress in one store, which is one implementation choice among several (see the [durable agents example](../examples/durable-agents.md)). It is a good model for the durable Runtime milestone.
- **A wire binding first, such as JSON-RPC between parts.** Deferred. The description must fit both, and one process is the quickest way to learn whether the plugin API is right.

## Consequences

- A package that imports another imports only its public types and plugin API, so a part can be swapped by loading a different package.
- The first milestone reproduces the vanilla Pi example's plugin set, plus the two hook points Pi lacks: a failed model request, and output before it reaches a recipient.
- The second milestone swaps in a durable Runtime without changing any other plugin.

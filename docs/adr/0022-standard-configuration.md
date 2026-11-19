---
status: accepted
date: 2026-11-19
---

# A standard configuration, built in Rust on the edition 3 base

Seven rounds settled the specification and proved it with five builds. None of those builds was meant to be used. The next step is a system someone can work with every day, and the question was what to build and from what.

## Decision

Build one **standard configuration** of the Harness: a coding agent with Pi's feature set, made only of plugins. Pi stays the reference for any detail this record does not settle ([ADR 0008](0008-pi-is-the-reference-implementation.md)). The build is in [`rust/`](../../rust/README.md), with one part in [`sidecars/claude`](../../sidecars/claude/README.md).

- **Start from the clean-room Rust build.** `modular-agent-rs` at `bc59845` is copied into `rust/` and extended. The clean-room rule ended with the experiment.
- **The model is offered one tool.** `codemode` runs Python in a Monty sandbox. `read`, `exec`, `edit`, `write`, `find`, `list` and every MCP tool are functions on its `tools` object, and each call is a nested tool call through the Harness.
- **Three Providers on subscriptions.** ChatGPT and Grok speak the Responses API from Rust. Claude goes through the Claude Agent SDK for TypeScript, served as a Provider over the plugin binding from its own process.
- **Agent Skills and an MCP client** as Pi has them, with the files in the forms other tools already use (`SKILL.md`, `mcpServers`).
- **A line-based CLI,** `ma`, plus ACP on stdio so a host can drive it.
- **Not in the standard set:** approval, subagents and guardrails. Pi has none built in. The base has all three as plugins.

## Considered options

- **Where to start.** Writing a new Rust workspace would have thrown away a Harness, two Runtimes, ACP and a plugin host that pass every kit and all five matrices. Working inside `modular-agent-rs` would have left the product in a repository shaped by the experiment's rules. Copying it into this repository keeps the proven code next to the specification it implements.
- **What the model sees.** Offering the six tools directly beside a code tool, as Pi does, gives the model two ways to do everything. The owner asked for all tools to go through Monty, so the code tool is the only offer. The choice is one session setting, `model_tools`, so the other arrangement costs nothing to try.
- **How the code tool reaches other tools.** Calling the tool sources directly from the sandbox would skip the gates and leave no record. [Contracts](../contracts.md#tool-dispatch) already require every agent-executed call to go through the Harness and a nested call to pass its own gates, and [shared data](../bindings/data.md#tools) already has `startedBy: "tool"` and `parentCallId`. The base gained one entry point for it.
- **Where the functions live in Python.** Bare names (`read(...)`) are shorter, but `exec` and `list` are Python builtins and would never reach the host. A `tools` object avoids every clash and matches Pi's `tools.NAME`.
- **Claude.** The Agent SDK has no Rust form, and the owner named the TypeScript SDK. A process speaking the plugin binding is exactly the case that binding was written for, and it needed no change to the host.
- **Monty in process or in a worker pool.** Monty's authors recommend `monty-pool` for untrusted code, since an interpreter abort takes its process with it. In-process came first because it is simpler and the durable Runtime loses no history to a crash. It is the first gap to close.

## Evidence

- The base build's suite still passes after the changes, including its runs of the ACP and plugin kits.
- With a scripted model, the standard configuration's own tests cover the single offer, nested records, a gate refusing a nested call, the sandbox's limits, skills, MCP and a `kill -9` in the middle of a code run. After the kill the durable Runtime finished the turn, and neither the code run nor the command it had started ran again.
- With a real model (`claude/claude-haiku-5-5`, through the sidecar), `ma` read files, ran commands, followed a project skill, wrote a file and resumed a session in a new process.
- ChatGPT and Grok were tested against a loopback fixture only. Their first real requests wait for the owner's sign-in.

[The Rust README](../../rust/README.md#what-has-been-checked) has the counts and commands.

## Consequences

- The specification gained no rule from this work. Five places where it was silent are [logged with the build](../../rust/README.md#where-the-specification-was-silent). The one most likely to need a rule is how a tool source in another process makes a nested call: the plugin binding has no request for it, so a code tool cannot yet be served over the wire.
- `ma` is a configuration, not a new conformance claim. The kits run against the base binary, `modular-agent`, which shares its Harness.
- The production gaps in [ADR 0021](0021-production-edition.md) still stand.

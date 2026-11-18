---
status: accepted
date: 2026-11-16
---

**Current rule:** This is evidence about the private, trusted TypeScript proxy, not `modular-agent-plugin/1` ([ADR 0017](0017-plugins-in-any-language.md), [plugin binding](../bindings/plugin.md)). The failed RPC is not a known tool outcome: [Parts that are lost](../contracts.md#parts-that-are-lost) handles a dispatched effect without a confirmed result.

# A plugin can run in another process, through one generic RPC

[ADR 0013](0013-first-binding-typescript-in-process.md) deferred a wire binding. The description claims an agent can be built in one process, over RPC, or as services. To test the RPC claim, any plugin can now run in a process of its own. The plugin is unchanged. A proxy plugin in the Harness's process starts a child process. That child loads the real plugin and reaches the plugin API over JSON-RPC 2.0, one message per line on the child's stdin and stdout.

The connection carries more than data:
- A function or an object with methods becomes a handle on the other side. Calling it comes back over the connection.
- An abort signal becomes a handle too. Aborting it sends a notification.
- An object the other side sent comes back to it as itself.

So a Runtime in one process can stream a model's output from a Provider in a second. It can also run a tool in a third, which uses a working environment in a fourth, with progress and cancellation flowing both ways.

A plugin says how to load it elsewhere: a module, the factory it exports, and options it can take as JSON. Which plugins move is chosen per run (`remote` in `createAgent`, or `MA_REMOTE`).

## What it showed

The whole test suite passes with the Runtimes, the file tools, the working environment and the MCP tool source each in its own process. Another test moves the Provider as well, so only the Harness stays in the test's process. The description held. Building it changed three things in the binding, and added one rule to the contracts:

- **What the Runtime asks the Harness during a turn is asynchronous.** Three calls answered at once: a new id, a tool's definition, and whether input is waiting. The description never said they were immediate; that came from the one-process binding.
- **Where the Harness asks without waiting, it keeps a copy.** That applies to a tool source's list of tools and a Provider's list of models. The contracts already let a tool source announce when its list changes, which is what keeps the copy right.
- **A stopping process announces no turn end.** A Runtime in another process finishes its turn after the process has begun to stop. Its turn is interrupted, not ended, as for a turn in the same process.
- **An answer comes after its effects.** A plugin announces a change before it answers the call that caused it. The copy is then refreshed before that answer reaches the caller. Without this, a host that gave a session an MCP server, then asked for the session's tools, did not see them. This is now a rule in [Contracts](../contracts.md#interactions).

Some plugin API calls answer at once: reading the history, a session's state, the tools, the jobs, the open questions, the declaration, and access to a model. A plugin in another process can't use them, and gets an error that says so. Two ways would make them available: make them asynchronous, which changes every plugin, or keep a copy built from the session's events. Neither is needed by the plugins moved so far.

## Considered options

- **A protocol per capability,** such as one for history stores and one for tool sources. Deferred to the services build, where each service has its own HTTP API. A generic RPC tests the claim that "a plugin is a plugin, wherever it runs", and a per-capability protocol does not.
- **Make the whole plugin API asynchronous now.** Rejected for now. It would change every plugin for calls that no moved plugin uses.
- **Use MCP or ACP between parts.** Rejected. They cover tools and whole agents, not hook points, capabilities and callbacks.

## Consequences

- A plugin in another process keeps the agent running only while the agent is waiting on it.
- If that process dies, calls waiting on it fail, the turn records the failure as the call's result, and the Harness reports the problem.
- Handles are never released, so a long run grows its handle tables. An object's data is copied when it is first sent, so it must not change afterwards. Both are recorded in [implementation concerns](../research/implementation-concerns.md#plugins-in-other-processes).

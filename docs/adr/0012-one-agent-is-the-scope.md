---
status: accepted
date: 2026-11-16
---

# One agent is the scope, and hosts drive it from outside

This system describes one agent: a Harness and its plugins. A system that coordinates several whole agents, such as T3 Code driving Pi, Codex and Claude Code, is a **host**. It is outside this system. The agent must let a host drive it fully through an Interface, and must say what it supports, so that a host never needs anything else.

The pressure test showed that a T3-like system can't be built as plugins on one Harness. The conversation its user sees spans several whole agents, each with its own session and history ([rung 3](../pressure-test/rung-3-multi-agent.md)). The same test showed that one of our agents can be driven the way T3 drives Pi, given a few additions.

## Considered options

- **Make coordination a layer of our system.** This would add a record above every agent's history, context handoffs between agents, and lineage across them. It would double the scope before the single agent is settled.
- **Make coordination a set of plugins on one Harness.** This doesn't work: the agents being coordinated are whole agents, each with its own Harness.

## Consequences

- The Architecture gains a section on [being driven by a host](../architecture.md#being-driven-by-a-host), which lists what the agent must offer a host. That list is kept there. How a host avoids giving the same input twice, and what reconnecting recovers, are [implementation concerns](../research/implementation-concerns.md#hosts-and-reconnecting).
- A host is an actor, with its own authority.
- Our agent can still use other agents, as tool sources or subagents, and be used by them.

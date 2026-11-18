---
status: accepted
date: 2026-11-18
---

# Tenants, session limits, output events, and one plugin per name

After round five, four things were still open:
- **Authority had no ceiling above the actor.** Contracts said an actor's rights are "narrowed by the session's limit", and usage is totalled "where budgets apply, per tenant". But nothing defined a session's limit, who sets it, or what a tenant is.
- **The output gate's events had no shared shape.** A gate in another process got each host's own event shapes. A handler that only redacted strings managed. One that looked at events by type couldn't work across hosts, and Elixir's gate failed outright on Python's events in round five.
- **Two plugin processes could register one name,** and jobs belong to a plugin by name. Which one took up an unfinished job was unspecified.
- **Proposed input couldn't be listed.** A host had to dig proposals out of the history.

## Decision

- **A session limit,** set by an actor with the new `administer` right, never above its own rights. It is a ceiling on every actor in the session, recorded as a `limit` entry, and takes effect at once.
- **A tenant,** chosen when a session is created and recorded as its first entry, never changing. It is defined in the agent's own configuration, outside any project, with a rights ceiling and an optional token budget across all its sessions. A turn starts only while the budget lasts, and ends with the limit `tenantTokens` when it runs out.
- **Effective rights** are an actor's own rights narrowed by both ceilings, checked at every action. Limits and tenants are records of authority, so they can't be erased.
- **Output events in shared shapes:** `text`, `reasoning`, `toolCall`, `toolOutput`, `toolResult`, `entry`, `turnEnded`, `reply`, and a build's own types with a dot. The host translates in both directions. A gate may redact strings in any event, but changes nothing else.
- **One plugin of each name per host.** A second plugin with a name already loaded is refused at the handshake, so a job always has exactly one owner.
- **Listing and withdrawing proposals** through ACP extensions.

## Considered options

- **For tenants:** leaving them to hosts, outside the agent. But a host can't enforce a ceiling inside a running turn, and a budget across sessions needs the agent's own count.
- **For limits:** making the session limit a setting. But settings are changed with the `settings` right, and a ceiling on authority must only be set by someone with authority over it.
- **For output events:** one opaque shape per host, which round five showed breaks gates; or a full event schema for everything a host emits, which would freeze each host's internals. A small vocabulary, with dotted escape hatches, standardizes only what crosses to a gate.
- **For plugin names:** letting several processes share a name and picking one owner by load order. But that is exactly the silent shadowing [Contracts](../contracts.md#plugins-and-capabilities) forbid.

## Consequences

- **All five builds do all of it,** and every 5×5 matrix holds: plugins 25/25; Runtimes through `kill -9`, 25/25 durable and 25/25 transient; portable sessions with jobs, 25/25 durable and 25/25 transient.
- **The swaps found one hole:** numbers. JavaScript writes `0.0` as `0`. A Rust host took every entry a TypeScript gate echoed back as changed, couldn't map it back, and blocked it, failing closed. Shared data now says numbers compare by value. The history service binding already said so; the data binding never had.
- **The real-model runs found one more,** about wording rather than the wire. Under a session limit, `gpt-6-luna` took a refused `read` for an empty answer, though the result gave the reason. Haiku, given another build's refusal, reported it exactly. A result that isn't completed now says plainly that the call didn't run.
- **Still not done:** a tenant's budget isn't reserved ahead, so steps already running in several sessions can cross it together. A build reopening a session in an unknown tenant refuses it.

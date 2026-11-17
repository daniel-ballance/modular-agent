---
status: accepted
date: 2026-11-16
---

# Parts can be services, each with its own HTTP API

The description claims an agent can be built as services over a network. To test that, three parts now run as services, each with its own small HTTP API and its own bearer token:
- **A history store service.** It keeps every session's history for any number of agents.
- **A working environment service.** It is a sandbox rooted at one folder, which runs commands and reads and writes files. It refuses paths outside its root.
- **A model gateway.** It holds the credentials and makes model requests. An agent using it holds no credentials at all.

In the agent, a client plugin stands for each service. It provides the usual capability and replaces the local plugin. The agent itself can be served over HTTP (`ma --serve`): JSON requests for sessions, input, answers and cancelling, and server-sent events for following a session.

Unlike [plugins in other processes](0014-plugins-in-other-processes.md), which share one generic RPC, each service has an API shaped by its capability. A service is reached over a network that can fail, so each client says which of its requests are safe to send again, and only those are retried.

## What it showed

A real turn ran across five processes: the agent, served over HTTP, and four services. These were the history store, the sandbox and the model gateway, plus a client following events. Tests cover a full turn, a second agent refused while another writes, lost answers from the history service, cancelling over HTTP, and a client that reconnects. The description held, and two points became explicit:

- **Keeping the same entries twice keeps them once.** Over a network, an agent can lose the answer to "keep these entries" and not know whether they were kept. It must be able to send them again. This is now in [Contracts](../contracts.md#harness-and-history-store). Entries already have identities, so the store needs no separate key.
- **A host that reconnects gets everything recorded since the last entry it saw.** Streamed pieces it missed are not sent again; the entries they became are. This is now in [Architecture](../architecture.md#being-driven-by-a-host). It answers part of the earlier question of what reconnecting recovers.

Four existing rules held as written:
- **"Refuses a second writer" works as a lease.** A lock tied to a process can't work across machines. The agent holds a session while it keeps renewing, so a crashed agent's session frees itself.
- **"Nothing a working environment starts outlives the agent".** The sandbox stops a command when the agent that started it hangs up, cancels or dies.
- **Hook points belong to the operation's owner** ([ADR 0006](0006-hook-points-belong-to-the-operation-owner.md)). In the agent, the gateway's client plugin is the Provider, so "before a model request" runs there, not in the gateway.
- **An outside effect with an unknown outcome is not repeated.** A model request and a command are never retried. Reading and writing files, and every history store request, are.

## Considered options

- **The generic plugin RPC over HTTP.** Rejected for services. A service shared by many agents needs an API it can reason about: leases, idempotency and confinement to a root. A generic call channel would hide them.
- **gRPC or another schema-first protocol.** Deferred. JSON over HTTP was enough to test the description, and the API of each service is small.

## Consequences

- An agent whose parts are services can run with no credentials, no local files and no local commands.
- Each service authenticates its callers with one bearer token. Several tenants, or per-actor tokens for the agent's own HTTP Interface, would need more.
- The agent's HTTP Interface acts for one actor. Several actors over HTTP need an Interface that maps each token to an actor.

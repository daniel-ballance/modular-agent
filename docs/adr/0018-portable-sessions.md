---
status: accepted
date: 2026-11-18
---

**Current rule:** [Portable sessions](../bindings/data.md#portable-sessions) cover jobs, plugin-set records, authority ceilings, display-only fork copies and erasure with stable lifecycle identities. The kit checks selected properties, not every entry. [ACP opening](../bindings/acp.md#sessions) and [Security](../security.md) govern access, recorded rights and trusted provenance.

# Portable sessions: one shared format for what history holds

Five builds now share a [history service](../bindings/history-http.md), and each could keep its sessions in another language's service. But the service stores entries without reading them. Each build wrote its own shapes: the Go agent wrote Go field names, times as strings, kinds such as `turn.start`, and whole-session snapshots. So no agent could reopen a session another language's agent wrote, let alone recover its interrupted turn. That was the main thing round three left undone.

## Decision

The [shared data binding](../bindings/data.md#portable-sessions) defines **portable sessions**. A build that declares `portableSessions`:
- **writes every entry in the shared shapes,** to whatever history store it uses;
- **records each standard meaning with its standard kind**, and needs nothing else to reopen a session. The standard kinds now include `toolStarted` (with `safeToRepeat`), `inputRequest`, `inputAnswer`, `actorJoined` and `actorLeft`. A `turnStart` carries what the turn started with. Settings and the names of rights have fixed meanings.
- **may write kinds of its own, with a dot in the name, but only as caches.** Reopening without them must give the same session.
- **reads a session by the same rules as every other build:** the branch, settings, actors, keys, the model context, an interrupted turn, and open questions.

The rest follows from this:
- **The Runtime recovers from the standard kinds alone,** through `host/history` ([plugin binding](../bindings/plugin.md)), since another build may have started the turn.
- **The host records a turn's start before the Runtime runs it** ([Contracts](../contracts.md#recovery-and-repeating-work)), so a turn lost at once is still on the record.
- **An agent reopening after a crash waits for the old writer's lease to run out.**
- **The connection's actor joins every session it opens** ([ACP binding](../bindings/acp.md#sessions)).

The ACP conformance kit checks it. With `--then`, every reopening uses a second agent, and `--portable-checks` checks every stored entry.

## Considered options

- **Keep history opaque, and convert at the edges.** An export and import format would move finished sessions between builds, but not recover a turn interrupted mid-call. And every pair of builds would depend on two converters.
- **Make the service read entries.** It would have to know every build's shapes, the opposite of what [ADR 0015](0015-parts-as-services.md) chose.
- **One format, opt-in (chosen).** It costs each build a translation at its history store, which most already had for the ACP history extension. A build that doesn't need portability can leave it undeclared.

## Consequences

- **It works.** With every pair of the five builds as writer and reopener, through a real `kill -9` during a `bash` call, the session reopened, its keys held, and the turn ended as the reopening agent declared: 25/25 durable, carried on; 25/25 transient, failed. The interrupted command never ran twice. Real-model runs did the same across Rust, Python and Elixir agents, on both models.
- **The swaps found what a format alone leaves open,** each time a value a receiver branches on:
  - the names of rights, which no document defined. The three clean-room builds had independently chosen the same five extra names, and those became the standard;
  - what a recovered call that started gets: "outcome unknown", whatever anyone's authority is now;
  - how a reopening connection relates to the session's recorded actors;
  - the conformance model's thinking levels;
  - the approval policy, found only by a real-model run. An agent that didn't know another's approval setting fell back to its own default. That was safe in the run, but would not have been in the other direction.
- **Outside the promise in `/1`:** jobs and the plugins a session had are recorded in each build's own kinds, and erasure is honoured but not cross-checked.

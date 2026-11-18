---
status: accepted
date: 2026-11-18
---

**Current rule:** [Rewinding](../bindings/data.md#rewinding) uses points from `turnStart` and out-of-turn `toolStarted`; [ADR 0020](0020-tenants-limits-and-output-events.md) adds ceilings and [shared output events](../bindings/data.md#output-events). The [remote output gate](../bindings/plugin.md#held-output) now receives a finished stream in bounded segments. [Contracts](../contracts.md#authority) defines `grant` and the connection's actor.

# ACP `/2`, several actors, jobs, rewinding and the output gate across processes

After round four, five builds interoperated, but some of what the description promises had never been tested across them, and two things the bindings knew were wrong had been left for later:
- **ACP's `refusal`.** `/1` reports a failed turn with ACP's `refusal`, which means something else to a host: that the refused prompt won't enter the next one. All three clean-room builders found this mismatch in round two.
- **The output gate couldn't run in another process.** Its handlers hold streamed pieces, and a round trip per piece was too costly, so `/1` refused it.
- **Jobs and the plugins a session had** were each build's own kinds, so another build couldn't take up an unfinished job.
- **Several actors and rewinding** were barely exercised. No build could rewind, and two builds declared a session had only one actor.

## Decision

- **ACP `/2`, by asking.** A client sends `modular-agent-acp/2` in `initialize`, and the agent answers with the version it will speak. In `/2`, a failed turn is a JSON-RPC error carrying the same `_meta`. A client that asks for nothing still gets `/1`, so existing hosts such as T3 Code are unaffected.
- **Several actors through ACP extensions:** `actors`, `join`, `leave` and `release`, with `actorId` on `input` and `answer`, and proposed input. A host acting for an actor gets only the rights both have, and a right can only be given by an actor that has it.
- **Jobs over the plugin binding,** recorded in standard kinds. A job belongs to its plugin by name, so the same plugin program, in whichever build reopens the session, finds and takes up its unfinished jobs. A job's report is its result, unchanged.
- **Rewinding belongs to the host and the working environment,** not the Runtime. The environment saves points of the project's files, recorded on `turnStart`, and restores them in place.
- **The output gate a stream at a time.** The host holds each stream to its declared end and asks a handler in another process once. A recipient behind such a gate sees each stream when it ends, not live. A failing handler blocks, failing closed.

## Considered options

- **For the gate:** a round trip per piece, which would make every stream as slow as the slowest plugin; or not offering it at all, which leaves a guardrail written in one language unusable in another. A stream at a time keeps every guardrail rule in [Contracts](../contracts.md#the-output-gate), at the cost of live output for that recipient. Hosts declare it with `holdsOutput`.
- **For the failed turn:** reusing `end_turn` with a failed outcome in `_meta`, which a plain ACP host would read as success. An error is what ACP hosts already show for a failed prompt.
- **For rewinding:** a Runtime request, which would make every Runtime track files. The working environment already owns the files, and the host already owns moving.

## Consequences

- **All five builds do all of it,** and the matrices hold across them: plugins 25/25; Runtimes through `kill -9` 25/25 durable and 25/25 transient; portable sessions, including a job taken up after a crash, 25/25 durable and 25/25 transient.
- **The swaps found five more holes,** each a value or behaviour a receiver relied on that the bindings left open:
  - what a job's report contains;
  - which side keeps the project folder in place on a restore;
  - the shape of output events, which a gate must accept whatever it is;
  - what an unused session's environment answers on close;
  - rewinding with another build's environment.
  Two were in the kit itself: a race in the several-actors check, and a hard-coded check count in one build's suite.
- **A real-model run showed the "missing model" rule working.** A session written under Haiku and reopened by an agent that offers only `gpt-6-luna` failed its next turn instead of quietly switching models, then carried on once a model was chosen.

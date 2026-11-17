# Implementation concerns

**Status:** collected 2026-11-16 from [pressure test round 2](../pressure-test/round-2/synthesis.md).

The pressure tests found many real questions that don't belong in the [architecture](../architecture.md). The test for the difference: if two implementations disagree on a point and that would break a plugin or a host when one is swapped for the other, the point belongs in the architecture. If only the inside of one part would behave differently, it belongs here.

Anyone building one of these parts will need to answer these questions. Each entry names the part it concerns and where it was found. R1–R4 are the round-2 reports: [rung 1](../pressure-test/round-2/rung-1-pi.md), [rung 2](../pressure-test/round-2/rung-2-frameworks.md), [rung 3](../pressure-test/round-2/rung-3-multi-agent.md) and [rung 4](../pressure-test/round-2/rung-4-maximal.md).

## Approval, approval plugins and Interfaces

- **Questions surviving a restart** are done in the first implementation: questions and answers are recorded, keyed, and reopened by a durable Runtime ([build notes](../build-notes.md)).
- **Separate lifecycles for approvals, questions and tool execution.** An approval can arrive after its call's turn has ended. A question can stay answerable after its tool call has returned, and can be answered by a message, as Codex's async questions are. (R2 F2, R3 F3)
- **Two actors answering at once.** The architecture says one answer closes a request. How a UI shows a request another actor has just answered is up to the Interface. (R4)

## Jobs and subagents

- **Held and paused job states,** and releasing a held job without starting work. (R1 "A hold is not a cancellation or an approval")
- **A subagent session that outlives the job that created it,** and a second assignment to the same child. (R1 "A persistent child is not one job")
- **Remote tasks that wait with no turn running,** such as an A2A task in `INPUT_REQUIRED`: a job with an open input request. (R4)
- **When a report arrives during a running turn,** whether it waits or is taken into the turn. (R4)

## Durable Runtime

- **Recording completion.** Every outside effect ends as completed, failed or uncertain. A later receipt can settle an uncertain effect as a new entry. (R2 F4, R4)
- **What an unanswered request means** for each interaction: the history store's "keep these entries", and a host's fork, cancel, answer and rewind. (R3 F7, R4)
- **Plugin reads and decisions** that a replay must not repeat. (R2 F4)
- **Late model answers:** how a turn continues when a batch answer arrives. (R2 F5)

## Providers

- **A Provider's own session** may live outside the history store and survive a restart. When it may be reused. (R1 "A kept Provider session")
- **An interrupted answer** may stay in the Provider's session. (R1)
- **Tool requests the Provider refuses on its own,** and whether they can be reported. (R1)
- **Replaying from our history** may drop parts the history still holds, such as earlier thinking. (R1)
- **Prompt caches** as a copy that erasure must reach. (R4 "Erasure misses caches")
- **Model fallback:** handing a new model to the Runtime between attempts. (R2 F8)

## Live sessions

- **Which hook points a live session can offer,** and how steering differs from interrupting in voice. (R2 F6, R4 "Live session")
- **What was heard versus what was generated** when the user interrupts. (R2 F7)

## Rewinding and forking

- **Which files a rewind restores,** when several sessions share one checkout. (R3 F5)
- **What happens when one part rewinds and another fails.** (R3 F5)
- **What a fork copies:** the path to a point, or the whole tree. (R1 "Moving the current position")
- **Work already running when a rewind starts,** such as a shell command still writing files. The architecture says it is cancelled; how is up to the implementation. (R4 "Current position")

## Erasure

- **Deliveries not yet sent,** such as queued webhook retries, and durable progress records. (R4)
- **Erasure in an ephemeral session** while the process is still running. (R4 "Ephemeral session")

## Tools and working environments

- **A tool with its own place to run,** such as computer-use on a remote Mac beside local file tools. Swapping the session's working environment doesn't move it. (R1 "A tool can have its own place to run")
- **Which tree skills and prompts read** when the working environment is not the project. (R4)
- **MCP Apps:** an Interface fetching a tool source's display resources, without the embedded UI gaining the user's authority. (R4 "MCP Apps")
- **An Interface running tools it owns,** and accepting a tool result from outside. (R4)

## Plugin lifecycle

- **Handover on reload,** deliberate replacement, and trust before loading, as rules a builder can follow. (R1 "Reload and replacement are still only names")
- **Plugins the model loads** during a session. (R4)
- **Which scoped offering wins** when two plugins offer the same thing to one session. (R2 F11)

## Plugins in other processes

From building plugin RPC ([ADR 0014](../adr/0014-plugins-in-other-processes.md)):
- **Handles are never released.** Every function or object passed across the connection stays in a table for the life of the process. A long-running agent needs release messages, or handles scoped to the call that passed them.
- **An object's data is copied once,** when it is first sent. Later changes don't follow. Objects passed this way must keep their data fixed, as working environments do.
- **Plugin API calls that answer at once** are unavailable to a plugin in another process. A copy of each session built from its events would make them available without changing the plugin API.
- **A crash test that abandons a harness** must also end its plugin processes, as the real crash would. An abandoned harness that is waiting on a remote plugin keeps the test process alive.

## Hosts and reconnecting

- **What reconnecting recovers:** open requests, running jobs, queued input, the running turn. (R3 F2)
- **Stable targets and keys** for host actions other than giving input, such as fork, cancel and rewind, so repeating one is harmless or its outcome is marked uncertain. Keys for input moved into the [contracts](../contracts.md#interface-and-harness) after the [durable agents example](../examples/durable-agents.md). (R3 F7)
- **Two outside protocols on one session,** such as ACP and AG-UI, and mapping each protocol's retries onto one rule. (R4 "Host")
- **What a host reads before it starts:** model catalogs, settings in effect, what the session offers. The architecture requires a declaration; the full catalog is an Interface matter. (R3 F1)

# Pressure test round 2: synthesis

**Date:** 2026-11-16. **Status:** complete. Applied in part: see [Decisions](#decisions) and [What was applied](#what-was-applied).

Four fresh reviewers tested the docs as revised after round 1 (commit `94d9d21`), against the same four rungs. Each rung went to the other model family this time ([plan](README.md)).

| Rung | Report | Reviewer | New findings |
|---|---|---|---|
| 1. Pi and pi-packages | [rung-1-pi.md](rung-1-pi.md) | Grok 4.7 | 10 |
| 2. DeepSeek Harness, Pydantic AI | [rung-2-frameworks.md](rung-2-frameworks.md) | GPT-6 Astra | 12 |
| 3. Driven by a host (T3 Code) | [rung-3-multi-agent.md](rung-3-multi-agent.md) | GPT-6 Astra | 10 |
| 4. Everything at once, and a red team | [rung-4-maximal.md](rung-4-maximal.md) | Grok 4.7 | 9, plus a red-team attack on every guarantee and new concept |

## Headline

**Round 1's fixes went in the right direction, but most are incomplete, and they introduced contradictions of their own.**

- Of 57 round-1 findings rechecked, **14 are resolved, 41 partly resolved and 2 not resolved**. None were rejected as wrong.
- **The structure held again.** No reviewer challenged the Harness plus plugins, the three things the Harness does, credentials never reaching the Runtime, or keeping a host outside the system ([ADR 0012](../../adr/0012-one-agent-is-the-scope.md)).
- **Three guarantees broke, on one rung each.** Two of the three breaks are contradictions inside our own text, not limits of the model.
- **Round 1 found missing concepts. Round 2 found missing lifecycles:** what happens to pending things (approvals, open calls, jobs, Provider sessions) when time passes, a rewind happens, a second actor acts, or an answer is lost. That is still a description of *what* happens, but at a finer grain.

## Verdicts

### Guarantees

| Guarantee | R1 | R2 | R3 | R4 | Synthesis |
|---|---|---|---|---|---|
| 1. Everything can be identified | strains | gap | gap | strains | **refine**: give exchanges one meaning, and give every target a stable identity (B, C) |
| 2. Everything can be observed by those allowed | strains | holds | gap | strains | **refine**: observers see the gated view, and reconnecting recovers current state (E, K) |
| 3. History grows in normal use | **breaks** | strains | holds | holds | **refine**: moving the current position is not rewinding (B) |
| 4. Every tool call ends with exactly one result | strains | gap | strains | strains | **refine**: approvals and questions are not tool results; one answer closes a request (A) |
| 5. Credentials never reach the Runtime | holds | holds | holds | strains | **holds**, once a secret goes only to the credential store (A) |
| 6. Nothing is lost in passing | strains | holds | holds | **breaks** | **false as written**: the record stays intact, but a recipient's view may differ (E) |
| 7. Plugins stay within the plugin API | holds | gap | holds | gap | **refine**: add the missing operations (I) |
| 8. Approval fails closed | holds | strains | holds | strains | **refine**: a late "allow" is checked again (A) |
| 9. Authority only narrows | strains | gap | gap | strains | **refine**: work caused by an action takes the narrowest authority involved (F) |
| 10. Differences are declared | strains | **breaks** | gap | strains | **false as written**: declarations describe the whole setup, and a fallback must not change policy (D) |

### Round 1's changes

| Change | R1 | R2 | R3 | R4 | Synthesis |
|---|---|---|---|---|---|
| 1. Several actors | strains | gap | gap | strains | refine (F) |
| 2. Providers keep state and run tools | strains | strains | holds | strains | refine (G) |
| 3. Work that isn't a turn | gap | gap | gap | gap | **needs reworking** (C) |
| 4. A turn returns a result and can wait | holds | gap | gap | strains | refine (A) |
| 5. History with stated exceptions | **breaks** | gap | gap | strains | refine (B) |
| 6. What may be seen and kept | holds | **breaks** | strains | gap | refine (E) |
| 7. Durability across parts | strains | **breaks** | gap | strains | **needs reworking** (H) |
| 8. Working environment, plugin-defined capabilities | strains | holds | holds | strains | refine (I) |
| 9. Complete the plugin API | strains | gap | gap | gap | refine (I) |
| 10. Declared support | strains | **breaks** | gap | strains | **needs reworking** (D) |

## Where the synthesis narrows the reviewers

- **Guarantee 3 and Pi's `/tree` (R1).** Pi moves its current position without recording the move, so a restart doesn't restore it. That is a real difference between Pi and our rule, but the rule doesn't have to go. The reviewer's real catch is that the docs treat moving the position and rewinding the world (files, Provider state) as one act, and make a part that can't rewind block a move that only touches history. Separating the two fixes it. Pi then fits as an agent that doesn't keep its position across restarts.
- **Change 6 and voice (R2).** Media that goes straight from the Provider to the browser never passes through the agent, so no gate can stand in its way. That isn't a gate failure. It is a difference that the setup must declare. Then the guarantee covers output that passes through the agent.
- **Guarantee 5 (R4).** The leak needs our own rule to send a late secret back as a tool result. Fixing that rule (A) removes the counterexample, so the guarantee holds.

## The changes

Lettered so they don't collide with round 1's numbers. Each names the rungs that found it.

### A. Separate the lifecycles of approvals, questions and tool calls (R2, R3, R4)

- An approval decides whether a call may run. Approving doesn't complete the call. A late approval only lets the call run.
- A question can stay answerable after its tool call has returned. Its answer can be delivered as a message, as Codex's async questions are, not only as a tool result.
- A secret goes only to the credential store, never to the Runtime or the model.
- One answer closes a request. Later answers are refused.
- A late "allow" is checked again against current authority, the current branch, and the call as it now stands.
- The person who answers must have authority within what the asker was allowed to pass on.
- Seeing a request is separate from being allowed to answer it.

### B. Separate moving the position from rewinding, and settle pending work (R1, R2, R3, R4)

- **Moving the current position** changes only which branch the view follows. No other part has to rewind.
- **Rewinding** also restores files, Provider state and other outside things. A part that can't rewind refuses before anything changes.
- On a move or rewind, open calls, input requests and jobs from the abandoned branch are settled. They are cancelled, or kept but never resumed into the new branch. Work already running is stopped before files move, or the rewind is refused.
- Say what a fork copies: the path to a point, or more.
- Say what a restart restores, including the position.

### C. One lifetime rule for exchanges and jobs (all four rungs)

- **An exchange means what was caused by one input.** Steering and restarts stay in the exchange. A job's later report starts a new exchange, linked to the job that caused it. That stops a week-old exchange from staying open, and lets a child take a second assignment.
- **Only one turn runs in a session at a time,** unless the Runtime declares otherwise. A report that arrives while a turn runs is input like any other.
- **Cancelling a turn doesn't cancel jobs.** Closing a session stops them, unless the agent declares otherwise. That matches ACP v2.
- **A job can be held or paused,** and releasing it doesn't by itself start work.
- **A subagent's session can outlive the job that created it.**
- **A remote task that is waiting,** such as an A2A task waiting for input, is a job with an open input request.

### D. Declarations describe the whole setup (R1, R2, R3, R4)

- The agent declares what the session, as set up, supports. Combining each part's declaration doesn't always give that, so the session's declaration is what a host reads.
- A fallback never quietly changes policy. Replacing a Provider tool with a local one, for example, needs the same approval.
- Add what was missing:
  - whether output can be held for a guardrail
  - whether media bypasses the agent
  - what cancelling a turn does to jobs and queued input
  - whether the agent starts work on its own, and whether a host can turn that off for a session
  - which hook points a live session offers
- A host can read the model catalog, the settings in effect and what the session offers before it starts.

### E. The record is intact; each recipient gets a view (R2, R4)

- Guarantee 6 becomes: **the record keeps everything intact. What each recipient receives is a view of it.** A view may leave out or redact content, or drop what the recipient's protocol can't carry.
- The output gate may hold live output until it can decide. An agent that holds output declares it.
- Plugins that follow events see the gated view unless they are allowed the raw one.
- Output that bypasses the agent, such as media streamed straight to a browser, is declared, and the gate doesn't cover it.

### F. Actors acting at once, and authority for the work they cause (R1, R3, R4)

- When two actors give input or answer at once, the first accepted wins, and the others are told.
- Work caused by an input, a proposal released by its owner, a host acting for its user, or a commission from a coordinator has the narrowest authority of everyone involved.
- A message from a peer or a child is not a command or an approval from the user. It records its sender.

### G. Provider sessions (R1, R4)

- A Provider's own session may live outside the history store and survive a restart. The Provider says when it may be reused.
- An interrupted answer may stay in the Provider's session. The Provider says so.
- A tool request the Provider refuses on its own is still recorded, if the Provider reports it. If it can't report it, it declares that.
- A replay from our history may drop parts the history still holds, such as earlier thinking.
- Prompt caches are a copy for erasure purposes.

### H. Durability as recorded completion (R2, R3, R4)

- Replace "carries on without repeating outside work" with: every outside effect ends as **completed**, **failed** or **uncertain**. An uncertain effect is repeated only if it is declared safe to repeat.
- A later receipt can settle an uncertain effect. It is added as a new entry, not a second result.
- Every interaction says what an unanswered request means. That includes the history store's "keep these entries", and a host's fork, cancel, answer and rewind.
- Erasure reaches progress records and deliveries not yet sent, such as queued webhook retries.

### I. Places to run, and missing plugin API operations (R1, R4)

- A tool source may have its own place to run, as computer-use runs on a remote Mac. Swapping the session's working environment doesn't move it.
- Say which tree skills and prompts read when the working environment isn't the project.
- Add these to the plugin API:
  - an Interface fetching a tool source's display resources (MCP Apps), without the embedded UI gaining the user's authority
  - an Interface running tools it owns
  - accepting a tool result from outside
  - holding output
  - a plugin the model loads during a session
- Give handover on reload, deliberate replacement, trust before loading, and withdrawing queued input actual rules, not just names. Cancelling hands queued input back.

### J. Make the documents agree (R1, R3, R4)

- A step ends after its tool calls have results.
- A turn whose Runtime stops answering ends with an outcome from the list (failed), not "unknown".
- The glossary's tool call isn't only a request from the model.
- A deletion record is either required or optional, the same everywhere.
- The architecture doesn't state as a requirement anything the open questions list as undecided.
- Scenario 11 matches the contract on who is told about a request.

### K. Reconnecting and repeated actions, for hosts (R3, R4)

- Reconnecting recovers the current state, not just history: open requests, running jobs, queued input, the running turn.
- Every action a host can take has a stable target and a key, and its outcome is either safe to repeat or explicitly uncertain.
- When two outside protocols share a session, such as ACP and AG-UI, they share one set of rules, and each protocol's retries map onto our keys.

## Decisions

Settled on 2026-11-16:

1. **Moving the current position is recorded,** so a restart reopens the session where it was. Pi doesn't do this, and is described as not keeping its position across restarts.
2. **The output gate may hold streamed output** until it can decide. Buffering streamed output for an operation is useful in general. An agent that holds output declares it.
3. **Exchanges are dropped.** Grouping turns for display is not a system concern, and not a durability one either. Every turn records what started it (an actor's input, a job's report, or a plugin), and Interfaces and hosts group turns from that. A job's report simply enters the session as input.
4. **Cancelling a turn leaves its jobs running. Closing the session stops them,** unless the agent declares otherwise. This matches ACP v2.

## Too much detail

Round 2 went one level deeper than round 1, into the lifecycle of every pending thing. Much of that is how a part works inside, not what passes between parts. To sort it, we used one test: if two implementations disagree on a point and that would break a plugin or a host when one is swapped for the other, the point belongs in the architecture. Otherwise it is an implementation concern.

## What was applied

**Applied to the architecture, contracts, glossary and scenarios:**
- From A: secrets go only to the credential store; one answer closes a request; a late "allow" is checked again; seeing a request is separate from answering it; an approval is not a tool result.
- From B: moving the position is separate from rewinding; pending work on the abandoned branch is cancelled.
- From C: decisions 3 and 4.
- From D: the agent declares what the session, as set up, supports, and a fallback never changes policy.
- From E: the record is intact and each recipient gets a view; the gate may hold output; observers see the gated view; output that bypasses the agent is declared.
- From F: work an action causes gets the narrowest authority involved; a peer's message is not a user command.
- From H: an outside effect with an unknown outcome is not repeated unless declared safe.
- J: the documents agree. A step ends after its tool calls' results; a turn whose process stops ends as failed; a tool call need not come from the model; an erasure record is always kept.

**Moved to [Implementation concerns](../../research/implementation-concerns.md):** the rest of A, C, G, H, I and K. That covers separate lifecycles, held jobs, Provider sessions, recording completion, per-tool places to run, MCP Apps resources, reconnecting and retry keys.

**Also trimmed:** the lifecycle diagrams in the contracts, the "unanswered" rule for every interaction (kept only for tool calls), and retry keys for host input.

## What to do next

1. ~~Settle the four decisions.~~ Done.
2. ~~Apply changes A–K.~~ Done, as described above.
3. If another round runs, give reviewers the swap test, and ask them to report only failures that would break a plugin or a host. The original plan was a narrower round 3, with two reviewers rather than four, aimed at the areas round 2 found weakest: pending-work lifecycles (A, B, C, H) and declarations and views (D, E). If round 3 finds no breaks, the description is ready to move from pressure testing to use.

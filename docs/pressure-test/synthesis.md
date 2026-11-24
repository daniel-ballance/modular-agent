# Pressure test: synthesis

**Date:** 2026-11-16. **Status:** complete. Changes 1–10 have been applied to [Architecture](../architecture.md), [Contracts](../contracts.md), the [glossary](../../GLOSSARY.md) and the [scenarios](../scenarios.md).

Four independent reviewers tested assumptions A1–A32 ([plan](README.md)) against four rungs. Two model families reviewed, neither of them the author's:

| Rung | Report | Reviewer | Findings |
|---|---|---|---|
| 1. Pi and pi-packages | [rung-1-pi.md](rung-1-pi.md) | GPT-6 Astra | 15 |
| 2. DeepSeek Harness, Pydantic AI | [rung-2-frameworks.md](rung-2-frameworks.md) | Grok 4.7 | 15 |
| 3. Several agents (T3 Code) | [rung-3-multi-agent.md](rung-3-multi-agent.md) | Grok 4.7 | 9 |
| 4. Everything at once, and a red team | [rung-4-maximal.md](rung-4-maximal.md) | GPT-6 Astra | 18, plus all 32 assumptions attacked |

Findings below are cited as R*n*: the rung, followed by the heading in that report.

## Headline

**The structure holds. The simplifications inside it don't.**

- Nobody broke the core: an agent is a Harness plus plugins, the Harness does three things, the Runtime asks for only two things, and credentials never reach it. A1, A2, A4, A11, A12, A19 and A32 held on every rung or nearly every rung.
- What broke are assumptions that quietly simplified the world: **one user**, **a stateless Provider that runs no tools**, **history that is never deleted**, **work that always fits inside a turn**, and **a fixed list of hook points**. Each failed on at least two rungs, with real systems as evidence. None of them needed an imagined example.
- Every rung found the plugin API incomplete (A3, A7). That is expected of a first draft, and the reports list the specific missing items.

## Verdicts by assumption

R1–R4 are the four reviewers' verdicts. "Synthesis" is the combined judgment: **holds**, **refine** (true, but the wording needs to change), or **false** (must change).

| ID | Assumption, in short | R1 | R2 | R3 | R4 | Synthesis |
|---|---|---|---|---|---|---|
| A1 | Agent = Harness + plugins | holds | holds | strained | holds | **holds** |
| A2 | Harness does three things | holds | holds | strained | holds | **holds** |
| A3 | Everything can be a plugin using only the API | gap | gap | strained | gap | **holds**, but the API needs the additions in [change 9](#9-complete-the-plugin-api) |
| A4 | A plugin provides a capability, adds behaviour, or both | holds | holds | holds | holds | **holds** |
| A5 | Six capabilities are enough | strained | gap | gap | strained | **false**: add the working environment ([change 8](#8-add-the-working-environment-and-let-plugins-define-capabilities)) |
| A6 | One Runtime, history store and credential store | gap | holds | strained | holds | **refine**: say how one plugin deliberately replaces another |
| A7 | The plugin API is complete | gap | gap | gap | gap | **false** ([change 9](#9-complete-the-plugin-api)) |
| A8 | The Runtime can't tell vendors apart | holds | strained | strained | strained | **refine**: names stay hidden, but differences in behaviour are declared ([change 10](#10-parts-declare-what-they-support)) |
| A9 | Work nests as session, turn, step | strained | strained | gap | gap | **false**: there is work outside and above turns ([change 3](#3-name-the-work-that-isnt-a-turn)) |
| A10 | A turn ends when it needs outside input; four outcomes | strained | gap | strained | broken | **false**: a turn can wait, and it returns a result ([change 4](#4-a-turn-returns-a-result-and-can-wait)) |
| A11 | The Runtime asks for only two things | holds | gap | holds | holds | **holds**. R2's case is about recording plugin work, covered by change 7. |
| A12 | The Runtime never chooses the model, holds credentials, runs tools or keeps history | holds | holds | strained | holds | **holds** |
| A13 | One fixed set of hook points | gap | gap | gap | gap | **false**: plugins define hook points too, and an output gate is missing ([change 9](#9-complete-the-plugin-api)) |
| A14 | What the model sees is decided before each step | broken | gap | holds | broken | **false**: a Provider can add to or keep context ([change 2](#2-a-provider-can-keep-state-and-run-tools)) |
| A15 | Repeating a model request has no outside effect | strained | broken | strained | broken | **false** ([change 2](#2-a-provider-can-keep-state-and-run-tools)) |
| A16 | A Provider runs no tools and keeps no state | broken | broken | holds | broken | **false** ([change 2](#2-a-provider-can-keep-state-and-run-tools)) |
| A17 | Every tool call goes through the Harness | strained | broken | holds | broken | **false** for tools the Provider runs ([change 2](#2-a-provider-can-keep-state-and-run-tools)) |
| A18 | Every tool call ends with exactly one result | holds | strained | holds | strained | **refine**: a call can stay open after its turn, but still ends with exactly one result |
| A19 | The outside world comes in through Interfaces | holds | holds | strained | holds | **holds** |
| A20 | There is one user | not tested | broken | broken | broken | **false** ([change 1](#1-there-are-several-actors-each-with-authority)) |
| A21 | Approval fails closed; the policy is per session | gap | strained | gap | gap | **refine**: fail closed holds; authority comes from more than the session ([change 1](#1-there-are-several-actors-each-with-authority)) |
| A22 | A late answer arrives as new input | not tested | broken | strained | strained | **false**: a late answer can be the open call's own result ([change 4](#4-a-turn-returns-a-result-and-can-wait)) |
| A23 | History only grows | broken | holds | broken | broken | **false** as an absolute ([change 5](#5-history-grows-in-normal-use-with-stated-exceptions)) |
| A24 | What the model sees is a view of history | broken | strained | strained | strained | **refine** ([change 2](#2-a-provider-can-keep-state-and-run-tools), [change 5](#5-history-grows-in-normal-use-with-stated-exceptions)) |
| A25 | Partial output is live only | holds | holds | not tested | strained | **refine**: live only by default; a record of what was delivered may be kept |
| A26 | Unknown content passes intact | not tested | holds | not tested | strained | **refine**: intact unless policy forbids passing it on ([change 6](#6-what-may-be-seen-and-kept)) |
| A27 | Another agent is a tool source or comes in through an Interface | strained | strained | gap | gap | **refine**: peers and long-running remote tasks need more ([change 3](#3-name-the-work-that-isnt-a-turn)) |
| A28 | Subagent rules: task only, permissions narrow, results as input, questions through the parent | strained | strained | strained | strained | **refine**: separate parentage, authority and routing ([change 1](#1-there-are-several-actors-each-with-authority)) |
| A29 | Fits one process or many services | gap | holds | gap | gap | **holds** for structure. The gaps are about cancellation and lost replies, covered by change 7. |
| A30 | Everything can be observed and recorded | holds | strained | strained | strained | **refine**: observable to whom, and kept for how long ([change 6](#6-what-may-be-seen-and-kept)) |
| A31 | Transient and durable Runtimes fit one description | not tested | gap | gap | gap | **refine**: true only if other parts make promises too ([change 7](#7-durability-is-a-promise-many-parts-make)) |
| A32 | Credentials never reach the Runtime | holds | holds | holds | holds | **holds** |

**Totals:** 9 hold, 11 need refining, and 12 are false.

## The changes

Ordered by how many rungs found the problem, and then by how much depends on it. Each change is stated as what, not how.

### 1. There are several actors, each with authority

**Found by:** R2 "One session can have more than one person", R3 "There is more than one person" and "Rights are a ladder", R4 F1, F2 and F16, R1 F9 and F11.

The docs assume one user. Real systems have several: an owner and viewers sharing a session (DeepSeek Harness LiveShare), guests who may only propose input, and outside agents signed in with their own access level (T3 Code). Multi-tenant products also need budgets that span sessions, and an administrator's limit that nobody can exceed.

**Change:**
- Introduce **actors**: users, agents and programs. Every input, answer, approval and command records which actor it came from.
- Each actor has **authority** within a session: what it may do, such as propose input, give input, approve, change settings or answer requests.
- Authority sits under limits that only narrow: administrator, then tenant, then session, then actor. When an agent starts or messages another, it can pass on no more authority than it has.
- An input request names who may answer it. That can be a user, an agent such as the parent, or a program.
- Approval still fails closed.
- Budgets can apply to a tenant, across sessions.

### 2. A Provider can keep state and run tools

**Found by:** R1 F1 and F2, R2 "Tools the provider already ran" and "A voice session is not a step", R4 F8, F9 and F10.

This is not hypothetical:
- claude-subscription keeps a Claude Agent SDK conversation between requests and across restarts.
- Providers run web search and other tools on their own side.
- Realtime voice holds a live, two-way session at the Provider.
- Batch requests outlive the turn that made them.

**Change:**
- A Provider **may keep conversation state** and **may run tools itself**, and it declares that it does ([change 10](#10-parts-declare-what-they-support)).
- Tool calls a Provider ran appear in its response, with their results, and are recorded like any other tool call. They do not pass through a tool source, so approval can't gate each one. Instead, a policy decides before the request whether such tools are enabled at all.
- What the model sees becomes **our view of the history, plus whatever the Provider holds or adds**. A Provider that keeps state says when that state must be discarded, for example after a fork, compaction or model change.
- Repeating a model request is harmless **only** when the Provider keeps no state and runs no tools.
- Model access covers three shapes: one request and its response; a live two-way session (voice); and a request whose answer arrives much later (batch).

The design aims for one Runtime that can't tell vendors apart. That holds for names, but these differences in behaviour have to be visible.

### 3. Name the work that isn't a turn

**Found by:** every rung. R1 F7 and F8, R2 "A model request can outlive the turn" and "Background work reports back as text", R3 "One person-facing cycle holds several agent turns" and "Work reaches other threads…", R4 F3 and F16.

The nesting of session, turn and step misses several kinds of work:
- **Work above a turn.** One message from a user can lead to several turns or retries before the user sees an answer: steering restarts, goals, retries. DeepSeek Harness calls this an exchange, and T3 Code a run.
- **Work beside a turn.** Background commands, watchers, persistent children, workflows, scheduled and webhook-started work, and remote tasks over A2A. All of these outlive the turn that started them.
- **Work with no model step.** A UI calling a tool directly, as MCP Apps allow.

**Change:**
- Add a session-owned unit of **background work**. Each item has an owner, states, a way to cancel it, a way to report back, and usage that counts toward the session.
- Name the cycle above a turn. Its name is to be decided; candidates include exchange and request.
- Distinguish **peers** from **children**. A peer is another agent this one can message, with no parent relationship.
- Say that a tool call can start outside any turn, and which checks still apply to it.

### 4. A turn returns a result, and can wait

**Found by:** R2 "A turn has no value for its caller" and "A tool call can still be open when the turn ends", R3 "A question has three ways to be answered", R4 F4.

**Change:**
- Redefine a turn as **the agent working until it has nothing more to do for now, or it stops**. Waiting for an answer is a state inside a turn, not its end. This removes the contradiction between our turn definition and our own waiting requirements.
- A turn returns a **result** to whoever started it. The result can be text, structured data, or the tool calls still waiting for an answer. A plugin can require the result to match a shape, and a result that fails the check sends the model back to try again inside the same turn. Pydantic AI's typed output works this way.
- A tool call can **stay open** past its turn. Its single result can arrive later, as that call's own result. This replaces A22: a late answer resumes the open call. It arrives as new input only when no call is waiting for it.
- An input request says how it can be answered: while something is still waiting for the answer, later as that call's result, or not at all.

### 5. History grows in normal use, with stated exceptions

**Found by:** R1 F4 and F5, R3 "Rollback changes a record…", R4 F12. R2 found that the assumption held.

**Change:** the guarantee becomes "history only grows in normal use", with three named exceptions:
- **Rollback and branching** add entries rather than deleting any. A new entry says which point the view returns to, and the session has a current position in its tree. Our view of the history then leaves out what was rolled back. A Runtime or Provider that cannot rewind must refuse before anything changes.
- **Erasure.** When the law or the user requires deletion, it reaches every copy: messages, summaries, forks, exports, and what a Provider holds. A record that the deletion happened may remain, without the deleted content.
- **Retention.** A session may keep no history at all (an ephemeral session), or keep it for a limited time.

### 6. What may be seen, and kept

**Found by:** R4 F11, F17 and F18, R2 "Some facts must stay out of history", R1 F14.

**Change:**
- Add an **output gate**: a hook point before output reaches a recipient, so a guardrail can redact it in time. A check after the fact is not enough.
- "Passed on intact" now holds unless policy forbids passing it on. Each recipient may see a different view.
- "Everything can be observed" now means observable to those allowed to see it, for as long as it is kept.
- Some facts are live only and are deliberately not recorded, such as a goal being armed. A restart must not turn them into new work.

### 7. Durability is a promise many parts make

**Found by:** R2 "A plugin must be able to name work a restart skips", R3 (the host must be told), R4 F7, R1 F2 and F7.

A durable Runtime can't keep its promise alone.

**Change:**
- Tools declare whether they are safe to repeat.
- Plugins name the outside work they do, so a restart doesn't repeat it.
- Resources such as sandboxes can be lost, and the description says what happens then.
- Every request between parts can go unanswered. The description says what each side assumes then: for a tool call, the outcome is unknown.
- Cancelling reaches the Provider and any background work.

### 8. Add the working environment, and let plugins define capabilities

**Found by:** R1 F12, R2 "Plugins need to define jobs and hook points", R3, R4 F13.

**Change:**
- Add a **working environment** capability: where files live and where commands run, whether local, remote or in a sandbox. It is separate from the project the user is working on.
- Allow plugins to define new capabilities and hook points for other plugins. Three rungs needed this, which settles the open question [Plugins building on plugins](../contracts.md#plugins-and-capabilities).

### 9. Complete the plugin API

**Found by:** every rung.

Add these to the plugin API:
- define capabilities and hook points
- offerings that last only while the plugin is active, or that belong to one agent only
- deliberately replace another plugin
- hand over when the agent reloads
- be trusted before loading
- withdraw input that is queued but not yet taken
- move to another point in a session's tree
- read who started a turn
- an output gate
- background work ([change 3](#3-name-the-work-that-isnt-a-turn))
- erasure ([change 5](#5-history-grows-in-normal-use-with-stated-exceptions))

Also say that the tools a plugin has registered are not necessarily the tools the model is told about (R1 F13).

### 10. Parts declare what they support

**Found by:** R3 "The host must be told what the agent can do", R2 and R4 on A8.

**Change:**
- Runtimes, Providers and the agent as a whole declare what they support:
  - steering a turn that is running
  - forking
  - rewinding
  - waiting through a restart
  - keeping state at the Provider
  - running tools at the Provider
  - live sessions
- For each feature a part lacks, the description states what happens instead.
- An agent being driven by a host does not start a turn the host didn't ask for, unless it has declared that it can.

## Where the synthesis narrows the reviewers

- **A layer above the agent (R3).** R3 concludes that a T3-like system can't be plugins on one Harness, because the conversation the user sees spans several whole agents. That is right, but it doesn't break our model. It means a coordinating layer is a different system, which drives our agents through Interfaces and uses them as tool sources. R3's part (b) found that our agent can be driven that way, given changes 4, 5 and 10. **Proposal:** keep "one agent" as the scope of this description. Describe a coordinating layer separately later, as a user of this one.
- **A29 (R1, R3, R4).** No reviewer found anything that needs shared memory. Their gaps are about cancellation and lost replies, which change 7 covers. The assumption holds.
- **A23 (R2 held, others broke it).** Rollback and branching can stay append-only with an added position. Only erasure and retention are true exceptions.
- **A11 (R2).** Recording a plugin's named operation is not a third kind of request from the Runtime. It is a promise about what gets recorded (change 7).

## Decisions

The test exposed four product decisions. They were settled on 2026-11-16:

1. **Several actors in one session are allowed, not required.** Every input, answer and approval records its actor, so a single-user agent has exactly one. An agent that supports several actors declares it. A durable Runtime may make shared sessions easier, as Pi Durable aims to, but nothing requires one.
2. **Keeping history is the history store's job.** Without one, a session is ephemeral. A store may limit how long it keeps history, and must be able to erase. Within a session, history still grows in normal use. Compaction changes what the model sees, not the record: it adds a summary and deletes nothing.
3. **Coordinating several whole agents is outside this system.** The agent must let a host such as T3 Code drive it fully from outside, through an Interface. Recorded as [ADR 0012](../adr/0012-one-agent-is-the-scope.md).
4. **Names:** the cycle above a turn is an **exchange** (dropped in [round 2](round-2/synthesis.md#decisions)), and session-owned background work is a **job**. "Run" was rejected because Pi and Pydantic AI use it for our turn, "request" because it is already used in "model request" and "input request", and "task" because A2A uses it for our turn.

## What to do next

1. ~~Settle the four decisions above.~~ Done.
2. ~~Rewrite [Architecture](../architecture.md), [Contracts](../contracts.md), the [glossary](../../GLOSSARY.md) and the [scenarios](../scenarios.md) with changes 1–10. Add scenarios for: two users in one session, a tool the Provider runs itself, a voice session, rollback, erasure and a background task.~~ Done: scenarios 11–17.
3. Run the test again on the revised docs, with fresh reviewers, against the same ladder.

# Round 2, rung 3: Several agents, driven from outside

## Sources read (versions, commits)

- Modular Agent: `ef6cafeb725c7ce94dc33d3f60d4d60cb732f9d3`. The working tree was clean when inspection started. Read the requested files in order: `README.md`, architecture, contracts, scenarios, glossary, open questions, ADR index, ADR 0012, round-1 synthesis, round-2 method, and the round-1 rung-3 report. Also read `docs/pressure-test/README.md`. The revised design was introduced in `94d9d21`.
- T3 Code: `/home/danballance/Code/_ref/t3code`, commit `222288b00f9ed392e1e7352ad929c9ae9ac10cef`, server version `0.1.9`. Its working tree was clean. References prefixed **T3** below are relative to this checkout.
  - Read `docs/orchestration-v2/README.md`, `provider-capability-system.md`, `provider-switching-and-context.md`, and `thread-lineage-and-context-transfer.md`. Read the relevant run, steering, question, checkpoint, injection, delegation, cancellation, and scheduling sections of `feature-lifecycles.md` and `orchestrator-mcp-server.md`.
  - Read `docs/internals/overview.md`, `glossary.md`, and `connection-runtime.md`; `docs/user/guest-links.md`, `outside-agents.md`, and `permission-modes.md`; and the permission-cap and launch-control section of `managed-policy.md`.
  - Inspected the relevant sections of `packages/provider-pi/src/server/adapter.ts` and `mcpInjection.ts`; `packages/contracts/src/orchestrationV2.ts`; `apps/server/src/mcp/McpInvocationContext.ts` and `delegatedTaskModes.ts`; and `apps/server/src/peer/RemoteDelegation.ts`.
  - Inspected `apps/server/src/orchestration-v2/` sections covering `Adapters/CodexAdapterV2.ts`, `Orchestrator.ts`, `ProviderRuntimeRecoveryService.ts`, `DelegatedTaskQuestionReactor.ts`, `ProviderContinuationService.ts`, `ProviderTurnStartService.ts`, `CheckpointRestoreSafety.ts`, `CheckpointRollbackService.ts`, `CommandPolicy.ts`, `GuestShareDecider.ts`, `EventSink.ts`, and `ProjectionMaintenance.ts`.
- Injected extension: `/home/danballance/.t3/caches/pi-t3-mcp-extension.ts`, modified `2026-11-14 21:27:54 -0500`, SHA-256 `eacf7888062637a975daf296521384c4d254b0158fc2ac321c1c7c00ee4d1041`. Read its service-tier, approval, tool-registration, discovery, and instruction-injection code. This is a local generated file, not a committed version.

This was a source review, not a live integration test. T3's orchestration design pages describe a target. Where they disagree with executable code, this report follows the code.

**Overall:** ADR 0012 is sound. T3's shared conversation, agent switching, handoff records, lazy forks, and remote coordination belong to the host. They need not be added inside our Harness. But scenario 17 does not yet establish its final claim: a host still needs knowledge and controls that the Interface and declaration do not describe.

A prompt, steering, abort, live extension question, basic fork, and saved-session reopen each have a plausible place. Model and thinking changes fit settings in principle. Service tier fits a plugin setting. MCP injection fits a tool-source and feature plugin internally. The missing part is how the host discovers and controls those choices without knowing the agent's launch setup or private commands. Reconnect, rollback, message-based questions, and stopping future work have further gaps below.

## Round 1 recheck

| Round-1 finding | Status | Reason |
|---|---|---|
| A person-facing conversation sits above the agents | resolved | ADR 0012 deliberately gives that record to the host; scenario 17.5 accepts the returning agent's handoff as input. Do not confuse T3's whole-agent “provider” with our model Provider. |
| Fork, switch and merge-back need a link that can wait | resolved | The lazy link and merge-back belong to the host under ADR 0012; our required contribution is fork-at-point and recorded external context, described in Architecture, “Being driven by a host.” |
| Rollback changes a record our history is not allowed to change | partly | Architecture, “History,” adds a current position and retention. The old claim that rollback itself requires deleting audit history was wrong; file scope, confirmation, and interrupted rollback remain missing (F5). |
| One person-facing cycle holds several agent turns | partly | Exchange now covers retries and goal turns, but input grouping and exchange completion remain unclear: Contracts, “Exchange”; scenario 4 (F6). |
| A question has three ways to be answered, and another agent may answer it | partly | Actors and parent answers are added, but “later as a tool result” does not cover T3's nonblocking, message-answered questions: Contracts, “Input request and answer” (F3). |
| There is more than one person | partly | Actors and optional sharing resolve the one-user assumption; proposal release and host-on-behalf-of-user authority are not contracted, and scenario 11 conflicts with request visibility (F4, F9). |
| Rights are a ladder, and a cap sits above every session | partly | Architecture, “Actors and authority,” adds the cap; the contract does not connect an actor's right to send input to the rights of the work that input starts (F4). |
| The host must be told what the agent can do, and the agent must not start a hidden turn | partly | Declarations and the host rule exist, but lack effective settings and a host work policy (F1, F8). The old report also missed Pi's native-wake adoption path, not just its rejection path. |
| Work reaches other threads, other machines, and times when no turn is running | partly | Actors, peers, keyed input, and jobs cover the structure. Targeted stopping, retries of other changes, and future wake disposal remain unspecified (F7, F8); remote coordination itself is outside ADR 0012. |

## Guarantees

| Guarantee | Verdict | Reason |
|---|---|---|
| 1. Everything can be identified | gap | Work has identities, but accepted inputs, continuing exchanges, and cancellation targets are not connected precisely enough for the host to control them (F6, F7). |
| 2. Everything can be observed | gap | Reconnect gives history then live events, without requiring recovery of current requests and work; request visibility also conflicts with scenario 11 (F2, F9). |
| 3. History grows in normal use | holds | A position change can hide old work without deleting it; retention and erasure are explicit exceptions. T3 does not disprove this design. |
| 4. Every tool call has exactly one result | strains | The rule is coherent for real open calls, but substituting a late tool result for every answer mode does not describe async questions or recovered questions (F3). |
| 5. Credentials stay out of the Runtime; it never chooses the model | holds | Model selection and the injected credential-owning tool bridge can remain outside the Runtime. No host probe requires changing this rule. |
| 6. Nothing is lost in passing, except by policy | holds | Typed content and recipient policy can carry host context and extension displays. No counterexample here requires discarding unknown content. |
| 7. Plugins stay within the plugin API | holds | The bridge's tools, approval hook, prompt additions, and request-setting changes have API roles; the host's missing setup contract is a separate issue (F1). |
| 8. Approval fails closed | holds | Refusal on missing authority or a lost approval waiter is stated. Message-based recovery must not silently turn an expired approval into permission (F3). |
| 9. Authority only narrows | gap | The ceiling is stated, but effective execution authority through a host or owner-released guest proposal is not defined (F4). |
| 10. Differences are declared | gap | The declaration omits several differences the host must act on, and does not say how the parts' promises become the session's effective promise (F1, F5, F8). |

## Changes

| Synthesis change | Verdict | Reason |
|---|---|---|
| 1. Several actors, each with authority | gap | Identity is present; represented users, proposal release, and execution ceilings are not yet connected (F4). |
| 2. A Provider can keep state and run tools | holds | This supports stateful model access. Switching between whole agents stays at the host and needs no additional Provider role. |
| 3. Name the work that is not a turn | gap | Jobs and exchanges help, but grouping, stopping a waiting exchange, and later reports on a changed branch remain undefined (F5–F8). |
| 4. A turn returns a result and can wait | gap | Live waiting and open-call results fit; a question answered by a message while work continues still has no answer mode (F3). |
| 5. History grows, with stated exceptions | gap | The record rule is fixed. Host-selectable conversation-only rewind and the state after a failed combined rewind are not described (F5). |
| 6. What may be seen and kept | strains | Output gating and out-of-reach copies are useful; request visibility contradicts scenario 11, and reconnect does not distinguish lost live output from recoverable control state (F2, F9). |
| 7. Durability is a promise many parts make | gap | Lost tool outcomes are covered; lost answers to fork, cancel, answer, and rewind still lack recovery meaning (F5, F7). |
| 8. Working environment and plugin-defined capabilities | holds | Files, shared environments, and bridge services now have a place. The missing restore policy is not a missing capability. |
| 9. Complete the plugin API | gap | The listed additions help, but the external control contract does not expose all the resulting choices; two definitions also still contradict the revised API (F1, F10). |
| 10. Parts declare support | gap | A list of supported features is not yet a usable session promise or permission for automatic work (F1, F8). |

## New findings

### F1. The host cannot discover and establish the agent it is supposed to drive

- **Feature or situation:** T3 selects a model and thinking level, applies a service tier, chooses a permission mode, and supplies its own tools and instructions before prompting Pi.
- **Described as:** Session settings, model selection, tool sources, commands, and plugin loading. The Interface can start a session with settings and list or run commands. The declaration lists broad behavior flags.
- **Verdict:** gap
- **Assumptions or guarantees affected:** A3, A7, A19; guarantees 7 and 10; changes 9 and 10; scenario 17.1.
- **Evidence:** T3 `packages/provider-pi/src/server/adapter.ts:2827` requests the model catalog; `:3074–3163` checks effective model state, changes model and thinking, and invokes an injected command for service tier. Its `:106–118` distinguishes live model changes from permission-mode changes that require a restart. `mcpInjection.ts:249–325` installs the extension and supplies session-specific bridge credentials and policy. The injected extension `:277–315`, `:338–354`, `:379–416`, and `:473–484` adds tier handling, approval, tools, and instructions. Our `docs/contracts.md:221–238,254–261` exposes neither the model/settings catalog nor a described way for the host to supply these session offerings. “Any setting a plugin adds” does not tell the host which settings exist, which values work, or whether a change requires reopening. A bespoke command could fill every omission, but its required behavior is not described.
- **Suggested change:** Describe the host-visible setup surface: available models and options, effective settings and policy, allowed session offerings, and when changes take effect or require reopening. Say which offerings may be supplied by a host and which must already be installed. The session's declaration must combine the selected parts' support and limits. No launch flags, wire format, or plugin-install mechanism is needed.

### F2. Following history does not recover the agent's current control state

- **Feature or situation:** The host disconnects while an approval opens, reconnects before the user answers, and must show the live request. Alternatively, it returns after a process restart and must show that the old request is no longer live.
- **Described as:** Open returns the session and history. Follow returns history from a point, then events as they happen. The request itself has an answerability field.
- **Verdict:** gap
- **Assumptions or guarantees affected:** A7, A19, A29–A31; guarantees 2 and 10; changes 6 and 7; scenario 17.3–4.
- **Evidence:** `docs/contracts.md:38–60` does not include current turns or input requests in the session state. `:184–195` reports their changes as events, but `:256–269` neither replays those events nor requires a current request list. `docs/open-questions.md`, “What history records,” leaves the retained facts open. T3's Pi adapter keeps pending live dialogs separately (`adapter.ts:1750–1890`). T3 recovery explicitly changes saved questions to message-answerable and other requests to not resumable (`ProviderRuntimeRecoveryService.ts:311–337,668–690`). T3 `docs/internals/overview.md`, “Durable intent and side effects,” distinguishes replay from a replacement snapshot after retention. A legal implementation of our listed history entries could omit an opened question, leaving the reconnecting host unaware of it.
- **Suggested change:** Require reconnect/open to recover the current position, active work, queued inputs, pending requests and their current answerability, and effective settings. Define what “from a point” means after branching, retention, and erasure, and how a host learns that some events are unavailable. Do not require replay of deliberately live-only text or audio. Do require enough current state to control the agent without guessing.

### F3. A late tool result is not the same as an answer sent as a message

- **Feature or situation:** Codex asks an async question and continues working. The answer steers it or queues a later message. A saved question may also become message-answerable after its callback has died. A child may ask its parent this way.
- **Described as:** An input request is answerable now while something waits, later as a tool call's result, or no longer. Its tool-call link is optional.
- **Verdict:** gap
- **Assumptions or guarantees affected:** A10, A18, A22, A28; guarantee 4; change 4.
- **Evidence:** T3 `Adapters/CodexAdapterV2.ts:5766–5780` creates a message-answerable request from an async agent message, not a waiting tool callback. `Orchestrator.ts:11069–11116` answers by dispatching a message, steering when possible. `ProviderRuntimeRecoveryService.ts:311–337,668–676` restores some lost live questions in that mode. Our `docs/contracts.md:209–212,405–411` has no matching mode; `docs/architecture.md:284–285` says new input is used only when nothing is waiting. Inventing an open tool call for this case gives a result to a call that never existed. T3's parent wake even says whether the child is blocked or still working (`DelegatedTaskQuestionReactor.ts:40–50`). Also, T3 routes questions to the parent agent but not approvals through those tools (`docs/orchestration-v2/orchestrator-mcp-server.md:510–524`); our blanket parent-routing rule does not distinguish delivery from authority to answer.
- **Suggested change:** Separate whether the agent is blocked from how an answer is delivered. Support a live answer, a genuine open-call result, an answer recorded as new input, and an unanswerable request. An answer and any resulting input must be one identifiable act on retry. State that routing a request to the parent does not itself authorize the parent to approve it. Losing an approval waiter must still fail closed.

### F4. An actor's right to send input does not yet bound the work it causes

- **Feature or situation:** A supervised outside agent messages a full-access session. A guest proposes text that an owner releases. A host sends an approval answer for a particular user.
- **Described as:** Every Interface request carries one actor. Actors may watch, propose, give input, answer, approve, or change settings. Authority narrows through administrator, tenant, session, and actor.
- **Verdict:** gap
- **Assumptions or guarantees affected:** A20, A21, A28; guarantees 8 and 9; change 1; scenarios 11 and 17.4.
- **Evidence:** `docs/contracts.md:29–36,246–263` describes permission to perform an Interface action but not the execution ceiling attached to the resulting turn. The Runtime's mid-turn input carries only content (`:281`). Scenario 11 says both proposer and accepting owner are recorded, but no proposal/release interaction or two-party attribution is defined. Scenario 17 says the host answers “for its user,” whereas the Answer contains only one actor (`:215–219`). T3 enforces both operation access and execution-mode ceilings (`apps/server/src/mcp/McpInvocationContext.ts:35–111`; `delegatedTaskModes.ts:31–85`; `docs/user/outside-agents.md`, “Approve a sign-in”). Owner-released guest input is explicitly labelled and cannot accidentally invoke a slash command (`GuestShareDecider.ts:194–218`). T3 also caps launch settings that could disable approval (`docs/user/managed-policy.md:188–212`).
- **Suggested change:** Distinguish the sender, anyone represented by that sender, the source of the content, and the actor authorizing execution. Define the effective limits of work started or steered by that act. Describe proposal, release, and dismissal without making proposed text executable. State that settings and plugin replacement cannot remove a higher-level cap. Authentication details and mode names can stay out of scope.

### F5. Rewind has no stated file scope or complete result

- **Feature or situation:** Two host threads share files. The host wants to rewind only one conversation. In an isolated checkout, it instead wants conversation and files restored together. One part can fail after another has moved.
- **Described as:** “Move to a point” carries a session and history entry and returns “moved” or “refused.” Files can be rewound with history. Parts declare rewind support.
- **Verdict:** gap
- **Assumptions or guarantees affected:** A7, A23, A24, A29, A31; guarantees 3 and 10; changes 5 and 7; scenario 14.
- **Evidence:** `docs/contracts.md:260,282,311–317` has no choice between conversation-only and file restore, no exposed saved file point, and no stated result when only part of a combined operation finishes. Scenario 14.2 restores files before the current position moves. T3 has an explicit `restoreFiles` choice, rejects unsafe shared-file restore, and rewinds the agent before restoring files (`CheckpointRollbackService.ts:228–240,302–345`; `CheckpointRestoreSafety.ts:9–12`). It requires a returned conversation snapshot (`CommandPolicy.ts:325–341`), and Pi returns its changed session/head after fork-based rewind (`adapter.ts:3730–3820`). A second concrete case: a job from an abandoned branch reports after rewind. Architecture allows its report to start a turn and assigns that turn to its original exchange, but never says whether that report may affect the new current branch.
- **Suggested change:** Define the selectable scope and affected state of rewind and fork: conversation, files, settings, and pending work. State when shared files prevent restore. Report the resulting position and any incomplete or unknown part after failure. Define what happens to jobs, questions, and queued inputs from the abandoned branch. Do not prescribe transactions or restore order; state what the host may safely assume.

### F6. An exchange is named, but the host cannot reliably group work into it

- **Feature or situation:** A host steers a running request, queues a separate user request, returns a child result, or supplies handoff context with the next prompt. These are different relationships even if all arrive while one turn is running.
- **Described as:** An exchange is the response to one input. It can contain restarted turns and job continuations. Input only says when to take it.
- **Verdict:** gap
- **Assumptions or guarantees affected:** A9, A10, A27; guarantee 1; change 3.
- **Evidence:** `docs/contracts.md:52–60,257,378–384` gives no choice of new exchange versus continuation. Scenario 4 says input taken after the running turn starts another turn in the same exchange. By contrast, T3 distinguishes queueing a new run from steering or restarting the active run (`docs/orchestration-v2/feature-lifecycles.md:62–104`; `orchestrator-mcp-server.md:429–446`). Codex goal turns really do stay in one owning run (`Adapters/CodexAdapterV2.ts:5096–5120`), so the exchange addition is useful. But unrelated follow-ups need not share that cycle. The host handoff is separate context accompanying the actual user message in T3 (`provider-switching-and-context.md`, “Switch Flow”); our scenario 17.5 calls it recorded input without saying whether it starts work by itself. A command handled before the model also need not create the one-or-more turns that Exchange requires.
- **Suggested change:** Define which inputs start an exchange, which amend or continue one, and how supplemental context accompanies an input without starting an extra turn. Give the host a stable association from accepted input to exchange. Define exchange completion independently from turn completion and from indefinitely running jobs. Do not add T3's entire run graph to this system.

### F7. Cancel and retry can affect different work from the work the host meant

- **Feature or situation:** The host cancels turn A. The reply is lost. Turn B starts. Retrying the same session-level cancel now cancels B. A fork or answer can also succeed without its reply reaching the host.
- **Described as:** Only “give input” has a repeat-safe key. Interface cancel targets the session. Answers return accepted or no longer answerable. A fork is a session start.
- **Verdict:** gap
- **Assumptions or guarantees affected:** A7, A18, A29, A31; guarantee 1; change 7; scenario 17.2.
- **Evidence:** `docs/contracts.md:255–264` provides neither a stable cancel target nor retry results for session creation, answering, commands, or rewind. The document's opening says each interaction specifies what an unanswered request means, but most of these rows do not. T3 can interrupt a selected run and return a terminal run unchanged (`docs/orchestration-v2/orchestrator-mcp-server.md:457–461`). Its general command receipts keep a retry from repeating a side effect even after replay history is pruned (`docs/internals/overview.md`, “Durable intent and side effects”). Pi Stop also clears queued input before abort because abort alone can leave later work ready to run (`adapter.ts:1716–1744`). Our cancellation open question acknowledges queued input and jobs, but does not cover a stale or repeated cancellation.
- **Suggested change:** State the target and retry meaning of every host action that changes state. Distinguish cancelling one turn, stopping an exchange including pending continuations, and closing a session. Say what happens to queued input and which result a repeated action returns. Bound the repeat-safe promise by session retention explicitly, rather than leaving its lifetime only under “Parked: how.” No identifier format or receipt mechanism is required.

### F8. Declaring automatic work is not a host work policy

- **Feature or situation:** A driven agent can wake on a job result, a child question, a goal, or an internal schedule. The host may want to allow that, hold it, or refuse it. A host-owned schedule is different: it simply sends normal input.
- **Described as:** The agent may start turns the host did not ask for if it declares that it can. Job reports start turns in their original exchange. Schedules and webhooks are actors.
- **Verdict:** gap
- **Assumptions or guarantees affected:** A9, A19, A27, A28; guarantees 1 and 10; changes 3 and 10; scenario 17.7.
- **Evidence:** `docs/architecture.md:295–301,355–365` describes ability but not agreement, origin, or a host choice to hold future work. `docs/contracts.md:235,341–342` adds no such control. In the inspected T3 version, Pi does not simply reject every unsolicited start, contrary to round 1: `adapter.ts:2186–2228` offers a buffered native wake for host adoption when the continuation service exists, otherwise stops it. `ProviderContinuationService.ts:134–166,240–297` can discard or dispatch that continuation; `adapter.ts:3276–3279,3401–3412` adopts it without sending a duplicate prompt. T3 task cancellation disposes automatic parent delivery and holds queued work (`orchestrator-mcp-server.md:308–323`). A mere feature flag cannot tell the host whether a turn it sees is authorized new work, a continuation it already owns, or an unasked duplicate.
- **Suggested change:** Separate ability to initiate work from the session policy allowing it. Every automatic start needs a cause, owning actor and exchange, and observable admission or refusal. Let the host suppress or hold future starts without erasing history or necessarily killing useful background work. State whether a wake is asking for work to start or reporting work already started. Host-owned schedules and remote delegation can remain outside the agent.

### F9. Watching a request and being allowed to answer it are conflated

- **Feature or situation:** A guest sees the owner's pending question or approval but cannot answer. A parent UI displays a child's approval without granting the parent agent approval authority.
- **Described as:** Per-recipient views and an output gate; request delivery only to Interfaces whose actor may answer.
- **Verdict:** strains
- **Assumptions or guarantees affected:** A20, A21, A30; guarantees 2 and 9; changes 1 and 6.
- **Evidence:** Scenario 11.3 explicitly says the colleague's web UI shows the approval but cannot answer. `docs/contracts.md:269` says only Interfaces acting for actors who may answer are told. The separate generic event route could carry a display-only view, but that exception is not described. T3 `docs/user/guest-links.md`, “What the guest sees,” permits questions to be visible while forbidding answers. T3 `docs/user/permission-modes.md` shows child approvals in the parent conversation; its MCP lifecycle separately says parent-agent question routing excludes approvals.
- **Suggested change:** Give seeing a request, routing it, and answering it separate meanings. Apply the output gate to display-only views as well as live requests. State that showing or forwarding a request conveys no answering authority, and align scenario 11 with the contract.

### F10. Two leftover definitions change what a host can report

- **Feature or situation:** A UI or plugin starts a tool call without a model. Separately, the Harness loses contact with a transient Runtime and must report how its turn ended.
- **Described as:** Tool calls from several origins; one of four turn outcomes; unknown tool outcomes after an interruption.
- **Verdict:** strains
- **Assumptions or guarantees affected:** A7, A10, A18, A29; guarantees 1 and 4; changes 3, 4, and 7.
- **Evidence:** `GLOSSARY.md:117–118` still defines a tool call as a request from the model, contradicting `docs/contracts.md`, “Tool call,” and Architecture, “Tool source,” which admit UI, plugin, and Provider calls. `docs/contracts.md:279` says an unanswered Runtime request ends the turn with an “unknown outcome,” but its Turn lifecycle at `:392` and the glossary's Outcome admit only completed, cancelled, failed, or stopped at a limit. Unknown is currently a tool-result status, not a turn outcome. A disconnected host cannot know whether to use a fifth outcome or a failed turn carrying uncertain tool results.
- **Suggested change:** Align Tool call with its permitted origins. Choose how interrupted turns are classified and keep uncertainty about outside effects separate from that classification. Use the same vocabulary in the glossary, contract, and recovery scenario.

## Top changes

1. Complete the host-visible setup contract: model and option catalogs, effective policy, session offerings, change boundaries, and the combined declaration.
2. Make reconnect recover current control state, not just history. Define unavailable replay and retained versus live-only facts.
3. Add message-based answers and distinguish blocking, delivery, visibility, and permission to answer. Preserve fail-closed approval.
4. Connect source, sender, represented user, and approving actor to the limits of the work they cause. Define proposal release.
5. Define rewind and fork scope, shared-file safety, partial failure, and the fate of work from abandoned branches.
6. Define exchange grouping and completion, then give all state-changing host actions stable targets and repeat-safe or explicitly uncertain outcomes.
7. Make automatic work a session policy the host can control, with observable causes and a clear stop boundary. Keep host coordination outside the Harness.

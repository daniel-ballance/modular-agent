# Rung 3: Several agents together

Two tests, using T3 Code as it runs, not only as its design docs wish.

**Can a T3-like system be built from our parts?** Not as plugins on one Harness. Codex and Claude are whole agents, not our Providers. A layer of agents, each built from our parts, covers a child that starts from a task and reports back. It does not cover the conversation the person sees, which sits above those agents and outlives each of them.

**Can T3 drive one of our agents the way it drives Pi?** The three roles fit: Interface, tool source, and a plugin that uses only the plugin API. It fails where the host must be told what this Runtime will do, where the agent starts a turn the host did not ask for, and where files and the agent's own conversation must be returned to the same point.

The `docs/orchestration-v2/` files call themselves a target design. Where they disagree with the code, this report follows the code.

## Sources read (versions, commits)

- This repo at `3970588` (2026-11-16): `README.md`, `docs/architecture.md`, `docs/contracts.md`, `docs/scenarios.md`, `GLOSSARY.md`, `docs/open-questions.md`, `docs/pressure-test/README.md`, `docs/research/t3-code-reference.md`. The research note was checked against the sources below, not taken as evidence.
- T3 Code at `222288b` (2026-11-16), server `0.1.9`, clone `~/Code/_ref/t3code`.
  - Docs: `docs/orchestration-v2/README.md`, `provider-capability-system.md`, `thread-lineage-and-context-transfer.md`, `provider-switching-and-context.md`, `feature-lifecycles.md`, `orchestrator-mcp-server.md`; `docs/internals/overview.md`, `glossary.md`, `connection-runtime.md`; `docs/user/permission-modes.md`, `managed-policy.md`, `outside-agents.md`, `guest-links.md`, `remote-access.md`.
  - Code: `packages/contracts/src/orchestrationV2.ts`, `auth.ts`, `guestShare.ts`, `managedPolicy.ts`, `orchestratorMcp.ts`; `apps/server/src/orchestration-v2/` (`CheckpointRollbackService.ts`, `CommandPolicy.ts`, `Orchestrator.ts`, `DelegatedTaskQuestionReactor.ts`, `ProviderRuntimeRecoveryService.ts`, `ProviderTurnStartService.ts`, `ProjectionMaintenance.ts`, `RunExecutionService.ts`, `CheckpointRestoreSafety.ts`, `Adapters/CodexAdapterV2.ts`); `apps/server/src/mcp/OrchestratorMcpService.ts`, `McpInvocationContext.ts`, `delegatedTaskModes.ts`; `apps/server/src/peer/RemoteDelegation.ts`; `packages/provider-pi/src/server/adapter.ts`.
- Injected Pi extension on this machine, `~/.t3/caches/pi-t3-mcp-extension.ts`, modified 2026-11-14, sha256 `eacf7888…4d1041`. Not a git commit. It matches the Pi V2 section of the MCP doc.

## Feature map (table: feature | described as | verdict | assumptions)

| Feature | Described as | Verdict | Assumptions |
|---|---|---|---|
| Switch agent mid-thread, then resume the old agent with only what it missed | Model selection changes the model. One history. Context management builds the next view. | gap | A2, A6, A12, A16, A24 |
| Fork now, choose the agent later, native fork or a summary | Start a session from a point. Lineage is optional. No waiting resolution. | gap | A7, A24, A27 |
| Bring a fork back into the source conversation | Not described. Could be stretched into new input. | strains | A7, A24 |
| Checkpoints of files and of the agent's conversation, then rollback | History only grows. A view hides older entries. No checkout. | breaks | A23, A24, A31 |
| Shared checkout: rewind the conversation, do not restore files | No working environment, so no shared checkout. | gap | A5, A23 |
| Question or approval is live, answerable by a later message, or no longer answerable | One flag, "can still be answered". A late answer is new input. | strains | A22 |
| Child question wakes the parent agent, which may answer it | Questions reach the user through the parent. Only an Interface answers. | gap | A20, A28 |
| Delegate: child session, task only, narrower rights, result as input, cancel the tree, safe retry | Scenario 8, plus a tool call. No retry key. No tree cancel. No other machine. | strains | A7, A18, A27, A28 |
| Message, wait on, or interrupt any other thread | A plugin may give another session input and cancel its turn. No caller's rights. | gap | A7, A20, A28 |
| Schedule or webhook with nobody in a turn | A scheduling plugin gives a session input. A webhook is an Interface. | strains | A9, A19, A20 |
| Linked machine: the child is a thread on another server, and the parent still wakes | Another agent is a tool source or an Interface. No caller rights on the call. | gap | A19, A27, A29 |
| Web, desktop and mobile on one environment at once | Any number of Interfaces follow one session. | fits | A6, A19 |
| Outside agent signs in and gets an access level | The outside world is one user, through Interfaces. | breaks | A19, A20, A21 |
| Guest link: a second person proposes messages the owner must release | Input is accepted or refused. There is one user. | breaks | A20, A21 |
| Permission ladder, plan mode, and an admin cap the session cannot raise | One approval policy per session, including "never ask". | gap | A21, A28 |
| Host chooses a fallback from what the agent declares | Every Runtime offers the same hook points. Nothing is declared. | gap | A7, A13, A31 |
| One person-facing cycle holds several agent turns (steer by restart, `/goal`) | A turn ends when the agent stops. Cancel ends the turn. | gap | A9, A10 |
| T3 drives Pi as Interface, tool source and plugin | Those are three uses of the plugin API. | fits | A3, A4, A19 |
| Driven agent must not start a turn the host did not ask for | A plugin may give input and start a turn on its own. | gap | A9, A19 |

## Findings (one ### per finding that is not "fits", with the fields from docs/pressure-test/README.md)

### A person-facing conversation sits above the agents

- **Feature or situation:** The person stays in one conversation while T3 switches from Codex to Claude and later back. Each agent keeps its own conversation. The app conversation is the one the person sees.
- **Described as:** One session, one history, one Runtime at a time. Changing model is a session setting. The Runtime never keeps history. A Provider keeps no conversation. Another agent is a tool source or an Interface.
- **Verdict:** gap
- **Assumptions:** A2, A6, A12, A16, A24, A27
- **Evidence:** T3's own glossary: a thread survives the agent process; a provider is the agent runtime T3 controls (`docs/internals/glossary.md`, "Thread" and "Provider"). A provider thread stores which runs it saw and which summaries it was given (`packages/contracts/src/orchestrationV2.ts:1128-1140`, `handoffIds`, `firstRunOrdinal`, `lastRunOrdinal`). A run can start a fresh agent conversation while earlier runs stay visible and never reach that agent (`orchestrationV2.ts:759-760`). The switch design resumes the old agent session and adds a summary of only the missed runs (`docs/orchestration-v2/provider-switching-and-context.md:9-18` and `:48-70`). Our Harness keeps the session history (`docs/architecture.md:61-76`). Our Provider "never decides which model is used" and is not a conversation (`docs/architecture.md:108-110`). Our session lineage is only "forked from" or "parent" (`docs/contracts.md:35`).
- **Suggested change:** A person-facing conversation can sit above several agent sessions. It is the record the person sees. Each agent session remembers which part it saw itself. Returning to an agent resumes that session and gives it a recorded summary of only what it missed. Do not model those agents as Providers.

### Fork, switch and merge-back need a link that can wait

- **Feature or situation:** Forking does not choose the agent yet. The first run either forks the agent's own session or builds a summary. Merging a fork back adds only what changed since the fork, into the source conversation.
- **Described as:** Start a session from another session and a point. The child history is not defined. There is no merge. A summary would be new input or a context-management view.
- **Verdict:** gap
- **Assumptions:** A7, A24, A27
- **Evidence:** The recorded link has a type `fork`, `provider_handoff`, `merge_back`, `subagent_spawn` or `subagent_result`, a source point, and a status that can stay `pending` until a run needs it (`packages/contracts/src/orchestrationV2.ts:179-186` and `:245-264`). The first run resolves a native fork when it can (`apps/server/src/orchestration-v2/ProviderTurnStartService.ts:1608-1634`). The design says fork creation must not start an agent session or build a summary (`docs/orchestration-v2/thread-lineage-and-context-transfer.md`, "Lazy Resolution"). Our Interface can fork at start (`docs/architecture.md:114-116`) and the session may record where it came from (`docs/contracts.md:35`). Nothing says the copy of history waits, or that a fork can be brought back.
- **Suggested change:** Record a link from a source point to a target: why it exists, and that it may stay unresolved until the next run. Resolving it either continues the source agent's own session or writes a summary the target can see. Merge-back is the same link, with a base point, into the source conversation.

### Rollback changes a record our history is not allowed to change

- **Feature or situation:** A checkpoint is a saved checkout. Rolling back must move the files and the agent's conversation to the same point. If the agent cannot rewind its conversation, the files must not change. A shared checkout cannot restore files at all.
- **Described as:** History only grows. Nothing recorded is changed or deleted. What the model sees is a view. Compaction adds a summary. There is no checkout.
- **Verdict:** breaks
- **Assumptions:** A5, A23, A24, A30, A31
- **Evidence:** Overview: a revert must coordinate the checkout with the agent conversation, and an agent that cannot rewind must reject the revert before any file change (`docs/internals/overview.md:89-92`). The code refuses rollback unless the agent can rewind and return a snapshot (`apps/server/src/orchestration-v2/CommandPolicy.ts:327-336`). After a successful rewind, later runs are rewritten to `rolled_back` (`CheckpointRollbackService.ts:327-328` and `:390-412`). The comment there says those turns remain in the audit record and no longer exist in the agent conversation. The event log is deleted after about a day, and the stored record cannot be rebuilt from it (`ProjectionMaintenance.ts:42-43`; `docs/internals/overview.md:61-64`). A shared checkout refuses file restore and tells the person to rewind the conversation only (`CheckpointRestoreSafety.ts:9-11`). The capability doc still says files may be restored and the agent marked divergent (`docs/orchestration-v2/provider-capability-system.md`, "Checkpoint Capabilities"). That is not what the code does. Our guarantee says nothing recorded is changed or deleted (`docs/architecture.md:264`; history store at `:121`).
- **Suggested change:** Keep the growing record. Rollback adds a point the view returns to. It does not delete or rewrite earlier entries. Separately, a driven agent must either make its active conversation end at that point, or refuse before files change. A checkout shared by two conversations cannot restore files. Say so. Do not treat a log that is thrown away after a day as the history.

### One person-facing cycle holds several agent turns

- **Feature or situation:** Steering that the agent cannot take in place interrupts the agent turn and starts another, inside the same person-facing cycle. Codex `/goal` starts a further agent turn when the previous one completes, still inside that cycle. Only the last one finishes the cycle.
- **Described as:** A turn is the agent working until it needs outside input or stops. Cancel ends the turn. A step is one model request. There is no unit between session and turn.
- **Verdict:** gap
- **Assumptions:** A9, A10, A15
- **Evidence:** A run has attempts, including reason `steering_restart` (`packages/contracts/src/orchestrationV2.ts:770-780`). The design says one run may hold several agent turns, and only the final attempt completes the run (`docs/orchestration-v2/feature-lifecycles.md:75-104`). Codex goals "can span multiple native turns within one attempt" (`orchestrationV2.ts:1246-1254`). The Codex driver, on `turn/started`, registers the next goal turn on the same run (`Adapters/CodexAdapterV2.ts:1024` and `:5096-5119`). Our turn ends when the agent stops (`docs/architecture.md:182-190`). Cancel ends it (`docs/contracts.md`, Interface "cancel").
- **Suggested change:** Put a person-facing cycle above the turn. It can hold several attempts and several agent turns. Cancelling an attempt does not by itself end the cycle. The cycle ends when the last attempt ends, or the person stops it. A goal is this cycle continuing without a new person message.

### A question has three ways to be answered, and another agent may answer it

- **Feature or situation:** Some questions still have a waiting callback. Some are answered by a new message, including after the agent exits or the server restarts. Some can no longer be answered. A child's question is delivered to the parent agent, which may answer it or ask the person.
- **Described as:** An input request has "whether it can still be answered". A late answer is new input and starts a new turn. Questions from a child reach the user through the parent. Only an Interface answers.
- **Verdict:** gap
- **Assumptions:** A20, A22, A28
- **Evidence:** Three answer modes: `live`, `message`, `not_resumable` (`packages/contracts/src/orchestrationV2.ts:1286-1294`). Codex sets `message` or `live` from the question (`Adapters/CodexAdapterV2.ts:4803-4806`). A `message` answer is the same command as a new user message, steered into the running turn when the agent allows it (`Orchestrator.ts:11069-11107`). A `not_resumable` request is refused (`Orchestrator.ts:10810-10814`). On restart, a saved user question becomes answerable by a message; other waiting requests become `not_resumable` (`ProviderRuntimeRecoveryService.ts:311-337` and `:673-687`). A child question wakes the parent with instructions to answer it when the task already implies the answer, otherwise to ask the person (`DelegatedTaskQuestionReactor.ts:35-55`). Our input request is something "only the user can give" (`docs/architecture.md:223-232`; `GLOSSARY.md`, "Input request"). The answer and a new message are two interactions (`docs/contracts.md`, "answer an input request" and "give input").
- **Suggested change:** Record how a request can be answered: a waiting callback, a later message, or not at all. Answering by message is one act with the follow-up message, so a retry cannot post it twice. Another agent may answer. A child's question wakes the parent agent, not only the user.

### There is more than one person

- **Feature or situation:** Web, desktop and mobile can follow one environment together. That part fits. A guest, with no account, watches one thread and proposes messages the owner must send or dismiss. An outside agent signs in with OAuth and is given an access level from read-only up to full access. A webhook with no signature can start a run.
- **Described as:** The outside world uses the agent only through Interfaces, and it is one agent. Input goes to "the user". Give input is accepted or refused.
- **Verdict:** breaks
- **Assumptions:** A19, A20, A21
- **Evidence:** Several clients of one environment share a connection owner (`docs/internals/connection-runtime.md:1-6`). That matches any number of Interfaces (`docs/architecture.md:80`). A guest share lets one unauthenticated browser propose messages the owner must send or dismiss (`packages/contracts/src/guestShare.ts:14-16`). The text the agent sees names the guest, so it is not mistaken for the owner and cannot start a command (`GuestShareDecider.ts:194-216`). The guest cannot answer the agent (`docs/user/guest-links.md`, "What the guest sees"). An outside agent chooses an access level; read-only cannot change anything; a thread it starts cannot run with more rights than that level (`docs/user/outside-agents.md`, "Approve a sign-in"; `packages/contracts/src/auth.ts:259-276`; `McpInvocationContext.ts:83-92`). A webhook without a signature can be triggered by anyone who has the URL (`docs/orchestration-v2/orchestrator-mcp-server.md:469-470`). Our glossary has one user: "The person using the agent" (`GLOSSARY.md:138`).
- **Suggested change:** Drop the one-user assumption. A caller has an identity and an access level. Some callers may follow and propose input, and must not run it or answer the agent. Proposed input is not session input until a caller who may run it releases it. Say who the words came from, so the agent does not treat a guest as the owner.

### Rights are a ladder, and a cap sits above every session

- **Feature or situation:** A thread has a permission mode and a separate plan-or-default mode. A child, a message to another thread, and a cancel may not use a broader mode than the caller. An administrator can cap every thread on the machine, including threads agents and schedules start, and can lock how each agent is launched so a wrapper cannot turn approvals off.
- **Described as:** One approval policy per session, including "never ask". Approval fails closed. Permissions only narrow when one agent starts another. A plugin may change session settings.
- **Verdict:** gap
- **Assumptions:** A7, A21, A28
- **Evidence:** Modes are a ladder, narrowest first (`apps/server/src/mcp/delegatedTaskModes.ts:12-50`). Plan mode is a second ladder and also cannot widen (`delegatedTaskModes.ts:74-84`). A send to another thread refuses a broader mode (`docs/orchestration-v2/orchestrator-mcp-server.md:443-444`). Cancel walks every child first and refuses if a user has since raised that thread above the parent (`OrchestratorMcpService.ts:2827-2836` and `:2933-2946`). `maxRuntimeMode` is the broadest mode any thread may be created in, switched to, or run (`packages/contracts/src/managedPolicy.ts:74-78`). With that cap, launch settings belong to the administrator, because a wrapper could disable approvals (`managedPolicy.ts:100-108`; `docs/user/managed-policy.md:200-212`). The cap is not a sandbox: each agent's own CLI still has its own config (`docs/user/managed-policy.md:288-292`). Auto mode uses the agent's own review (`docs/user/permission-modes.md:16-19`). Our policy is one session setting (`docs/architecture.md:230-232`; `GLOSSARY.md`, "Approval policy").
- **Suggested change:** Rights are a ladder, separate from how the agent approaches the task. A cap above every session cannot be raised by a plugin, a child, a schedule, or by changing how the agent is launched. Every call to another session carries the caller's cap and may only narrow. If the driven agent enforces its own reviews, the host still applies the cap, and the two can disagree.

### The host must be told what the agent can do, and the agent must not start a hidden turn

- **Feature or situation:** T3 does not branch on the agent's name. Each driver declares what that agent can do, and each gap has a fallback: steer in place or interrupt and restart, native fork or a summary, rewind or refuse. Pi's declaration is a constant in the driver. If Pi starts work while T3 has no turn open, T3 stops the session.
- **Described as:** Every Runtime offers the same hook points. A transient and a durable Runtime fit one description. A plugin may give a session input, including from a schedule or when a child finishes. The agent, from outside, offers sessions, input, cancel, commands, follow and answer. It does not say what it can do.
- **Verdict:** gap
- **Assumptions:** A7, A9, A13, A19, A31
- **Evidence:** Pi's flags are fixed in the driver, including active steering, live-only approvals, questions that do not survive restart, and conversation rewind (`packages/provider-pi/src/server/adapter.ts:106-186`). Rollback is refused when those flags are missing (`CommandPolicy.ts:327-336`). The capability doc lists a fallback for each gap (`docs/orchestration-v2/provider-capability-system.md`, "Degradation Policies"). Pi is stopped if it starts agent work outside an active T3 turn (`adapter.ts:100-101`; the stop is at `:2226` and `:2801`). Our open question already asks what happens if a Runtime cannot take input mid-turn (`docs/open-questions.md`, "Input during a turn"). It does not require the Runtime to say so. Our scheduling plugin and scenario 8 start turns with no Interface prompt (`docs/architecture.md:140`; `docs/scenarios.md`, scenarios 8 and 9).
- **Suggested change:** As seen from outside, the agent declares what this Runtime will do: steer, interrupt, fork, rewind the conversation, and whether a waiting question survives a restart. Each gap has a stated fallback. A driven agent does not start a turn, or run tools, unless the host asked for that turn. Work the agent wants started is offered to the host, which may start the turn.

### Work reaches other threads, other machines, and times when no turn is running

- **Feature or situation:** Any agent can message, wait on, or interrupt any thread in the environment, not only its children. A retry of the same request must not start the work twice. Cancel stops every task the child started, then the child. A schedule or webhook runs with no turn active. A linked machine is another server: the child is an ordinary thread there, and the parent here still wakes when it ends.
- **Described as:** A plugin can list sessions and give one input. A subagent's session belongs to the parent. The parent does not have to keep checking. A tool call ends once. Another machine would be another agent used as a tool source. Nothing says the call carries the caller's rights, or that a retry is the same work.
- **Verdict:** gap
- **Assumptions:** A7, A9, A18, A27, A28, A29
- **Evidence:** Send, wait and interrupt are environment-wide, and a send derives stable ids from `clientRequestId` so a retry replays the same receipt (`docs/orchestration-v2/orchestrator-mcp-server.md:429-456`). Cancel stops the child and every task under it before anything is stopped (`OrchestratorMcpService.ts:2827-2836`), then stops descendants and then the child (`Orchestrator.ts:16117-16154`; `orchestrator-mcp-server.md:308-320`). A schedule runs with no turn active; an unbound one starts a fresh thread (`orchestrator-mcp-server.md:463-474`). A linked-environment child is an ordinary thread there; the parent records the task without a local child thread and wakes as it would for a local child (`apps/server/src/peer/RemoteDelegation.ts:83-92`). A separate checkout is refused there (`docs/orchestration-v2/orchestrator-mcp-server.md:257`). Our plugin API can address sessions (`docs/architecture.md:154-158`). It has no caller cap, no retry key, and no other machine. Scenario 8 does not cancel the child when the parent stops, and does not span machines (`docs/scenarios.md`, scenario 8).
- **Suggested change:** Name work that is not inside a turn: a peer session, a schedule, a webhook, a thread on another machine. A call to another session carries the caller's rights and a retry key, so repeating it does not start a second piece of work. Stopping a session stops the work it started, including on another machine, before it stops itself. The parent still wakes when that work ends.

## Assumptions (table A1-A32: holds / strained / gap / broken / not tested, with a one-line reason)

| ID | Result | Reason |
|---|---|---|
| A1 | strained | Each driven agent is a Harness plus plugins; the coordinating system is not one of those agents. |
| A2 | strained | The Harness keeps one session's history; the conversation the person sees is a record above every agent's history. |
| A3 | strained | Pi's injected approval and tools use only the plugin API; coordinating agents needs more than that API. |
| A4 | holds | One plugin can provide a capability and add behaviour; T3 enters Pi as Interface, tool source and plugin. |
| A5 | gap | The six capabilities have no place for a checkout, a caller, a schedule, or a record above the agent. |
| A6 | strained | One Runtime at a time can switch between turns, but the old agent's conversation must stay resumable. |
| A7 | gap | The plugin API has no waiting link, caller, access level, cycle above a turn, or declaration of what the Runtime can do. |
| A8 | strained | Inside one agent the Runtime need not see vendors; the host must see what each driven agent can do. |
| A9 | gap | Work also lives in a person-facing cycle, in other threads, and when no turn is running. |
| A10 | strained | An agent turn can end while the person's cycle continues, as in a steering restart or a goal. |
| A11 | holds | During a turn the driven Runtime still asks for tool calls and hook points; the extra acts belong to the host. |
| A12 | strained | A driven agent keeps a conversation the host resumes later; our Runtime is not allowed to keep history. |
| A13 | gap | The same hook points are not enough; the host needs a declared list of what this Runtime will do. |
| A14 | holds | What the model sees can still be chosen before each step; a host summary is part of that view. |
| A15 | strained | A goal continues across several agent turns without a new person message, inside one cycle. |
| A16 | holds | A model Provider still keeps no conversation; T3's "provider" is a whole agent and must not use this slot. |
| A17 | holds | The model's tool calls still go through the agent's Harness; T3's tools are a tool source. |
| A18 | holds | A delegate call still ends once; the later result is new input, and cancel still gives each call one status. |
| A19 | strained | One driven agent is one agent from outside; the environment is not, and outside agents use it with their own access. |
| A20 | broken | Guests and signed-in outside agents are other people or programs, not "the user". |
| A21 | gap | One session policy cannot express a ladder, a machine-wide cap, or a caller's access level. |
| A22 | strained | A late answer as new input fits the message kind, but that answer is one act with closing the request, and a live request cannot use it. |
| A23 | broken | Rollback rewrites run status, the event log is deleted after a day, and the driven conversation loses later turns. |
| A24 | strained | A view can hide rolled-back and off-agent runs, but the docs never say a view may exclude history after a rollback or a switch. |
| A25 | not tested | Streaming text was not a probe; T3 does update stored messages while they are still streaming. |
| A26 | not tested | Content types were not a probe on this rung. |
| A27 | gap | A child needs a wake-up, question routing, a tree cancel and sometimes another machine, which the open question already leaves undecided. |
| A28 | strained | "Task only" and "only narrow" hold; questions do not only reach the user, and a remote child is not a session the parent owns. |
| A29 | gap | Two machines are two servers with forwarded calls and caller rights, not one agent split into services. |
| A30 | strained | Interactions are recorded, then the event log is pruned, so later observation cannot rebuild what happened. |
| A31 | gap | Transient and durable differ in ways the host must be told, and one Runtime description does not say that. |
| A32 | holds | Model credentials stay with the Provider; the host token is held by the injected tool bridge, not given to the Runtime as a model key. |

## Top changes (at most 7, stated at the level of what, not how)

1. A person-facing conversation can sit above several agent sessions. It is the record the person sees. Each agent session remembers which part it saw. Returning to an agent resumes that session and gives it a recorded summary of only what it missed.

2. A link from a source point to a target can wait until the next run. It covers a fork, an agent switch, a merge-back, and a child starting or finishing. Resolving it either continues the source agent's own session or writes a summary.

3. History still only grows. Rollback adds the point the view returns to. It does not delete or rewrite entries. A driven agent must rewind its active conversation to that point, or refuse before files change. A shared checkout cannot restore files.

4. A person-facing cycle sits above the turn. It can hold several attempts and several agent turns. Only the last one completes it. A goal is that cycle continuing without a new person message.

5. A request records how it can be answered: a waiting callback, a later message, or not at all. Answering by message is one act with the follow-up. Another agent may answer. A child's question wakes the parent agent.

6. There is not one user. A caller has an identity and an access level. Some callers may only propose input. A cap above every session cannot be raised, and every call to another session carries the caller's cap and may only narrow.

7. From outside, the agent declares what this Runtime will do, and does not start a turn the host did not ask for. Work that is not inside a turn is named: a peer session, a schedule, a webhook, a thread on another machine. A retry key makes starting that work safe to repeat, and stopping a session stops the work it started.

# Rung 2: Agent frameworks

This report asks whether DeepSeek Harness and Pydantic AI (including Pydantic AI Harness) can be described using only this project's parts, capabilities, plugin API, contracts, hook points, and guarantees.

"Fits" means the description uses those words without stretching them. "Strains" means it can be said, but only by stretching a definition. "Impossible" in the map means a finding of gap or breaks: the description is missing a part, or it contradicts a decision or guarantee.

A gap is a real miss, not a wish for the same internals. Findings cite the clone, not the research notes.

## Sources read (versions, commits)

DeepSeek Harness clone: `/home/danballance/Code/_ref/deepseek-harness`, commit `39163dd30f703a79079e2d2446545cff3c453738` (2026-11-13). Package version `0.2.2-rc.3`.

Pydantic AI clone: `/home/danballance/Code/_ref/pydantic-ai`, commit `c7586d79b64706f4605f15a29534118813df12a4` (2026-11-16), branch `main`. The clone has no release tag, and this checkout does not pin a version string. Pydantic AI Harness is the `docs/harness` tree in the same commit. Its index says Harness uses its own 0.x versioning, separate from core (`docs/harness/index.md`).

Project docs read: `README.md`, `docs/architecture.md`, `docs/contracts.md`, `docs/scenarios.md`, `GLOSSARY.md`, `docs/open-questions.md`, `docs/pressure-test/README.md`. Research notes were background only.

DeepSeek pages used for evidence: `docs/architecture.md`, `docs/glossary.md`, `docs/cordis-primer.md`, `docs/capability-seams.md`, `docs/tool-execution-pipeline.md`, `docs/subsystems/goal.md`, `docs/subsystems/session.md`, `docs/subsystems/tools.md`, `docs/subsystems/scope.md`, `docs/subsystems/liveshare.md`, `docs/subsystems/agent-team.md`, `docs/subsystems/core.md` (crash repair and turn close).

Pydantic pages used for evidence: `docs/output.md`, `docs/deferred-tools.md`, `docs/native-tools.md`, `docs/batch.md`, `docs/agent.md`, `docs/hooks.md`, `docs/durable_execution/overview.md`, `docs/capabilities/overview.md`, `docs/capabilities/on-demand.md`, `docs/capabilities/custom.md`, `docs/capabilities/model-fallback.md`, `docs/capabilities/select-model.md`, `docs/capabilities/web-search.md`, `docs/realtime/overview.md`, `docs/realtime/turns.md`, `docs/harness/index.md`, `docs/harness/peers.md`, `docs/harness/subagents.md`, `docs/harness/background-tools.md`, `docs/harness/capability-creation.md`.

## Feature map

| Feature | Described as | Verdict | Assumptions |
| --- | --- | --- | --- |
| DeepSeek: the product is a tree of plugins | The Harness hosts plugins. Each feature is a plugin. | fits | A1, A3 |
| DeepSeek: a plugin's additions disappear when it stops | Not in the plugin API. "Active plugins" does not say offerings unwind, including while other sessions keep running. | impossible | A7 |
| DeepSeek: files, shell, sandbox, jobs, goals, code-mode runtime, and subagent backends are swappable jobs | Forced into the six capabilities, or into unnamed plugin behaviour. | impossible | A5, A7 |
| DeepSeek: a tool or listener belongs to one agent and can hide a global one of the same name | The session lists active plugins. That does not say a same-named global tool is hidden, or that a child does not inherit the parent's extras. | strains | A7 |
| DeepSeek: a goal, a round, and an exchange | A plugin starts turns and stores the objective in history. A round is a label on a turn. An exchange is how an Interface groups turns for a person. | fits | A9, A10 |
| DeepSeek: a goal does not resume after a restart until a person turns it back on | A durable Runtime carries on from history. Nothing says "this fact must stay out of history, and must not start work after a restart." | impossible | A23, A31 |
| DeepSeek: a shared task board for a team | Plugin state in the root session, plus tools. One writer appends. Cancellation cannot undo an append. | fits | A23, A27 |
| DeepSeek: LiveShare owner and viewers on one session | One user. One approval policy for the session. | impossible | A20, A21, A28 |
| DeepSeek: code mode (`run_code` and ordered sub-calls) | Nested tool calls, which the contract already has. The program sees values the model never sees. | strains | A15, A17, A24 |
| DeepSeek: crash repair of an open tool call | A tool result of "unknown" or "not started". A missing turn outcome is repaired by a later outcome of failed or cancelled. | fits | A18, A31 |
| DeepSeek: the request header, rebuilt from history | A history entry the model does not see, written when the request setup changes. | fits | A24, A26 |
| DeepSeek: the system prompt is ordered sections from plugins | A system-prompt plugin. Plugins add model-visible history. | fits | A7, A23 |
| DeepSeek: plugin-owned history between turns | Plugins add history entries, including where no turn is open. | fits | A7, A23 |
| DeepSeek: approval fails closed, and a refusal wins | An approval plugin. Handler order is last-writer-wins, with an open question for "refusal wins". The behaviour fits. The order rule is not decided. | strains | A13, A21 |
| DeepSeek: a question that times out | Scenario 3. A late answer arrives as new input. | fits | A22 |
| DeepSeek: Ralph, a loop of fresh child sessions on one objective | A tool starts child sessions. Only the final report comes back as the tool result. Shared files are the working-environment gap below. | fits | A27, A28 |
| Pydantic: a turn returns a value to its caller | History is the only record of what happened. A turn has an outcome, not a value. | impossible | A7, A10 |
| Pydantic: a check on that value can send the model back inside the turn | A retry happens when a model request fails. A successful response that fails a check is not that case. | impossible | A14 |
| Pydantic: an output function ends the turn, and the model does not see the function's result | A tool result is "what the model will see". | impossible | A10, A18 |
| Pydantic: the model loads a bundle of tools, instructions, and hooks on demand | A skill plugin, plus tools that appear over time. Hooks and model settings in the same bundle stretch that. | strains | A4, A7 |
| Pydantic: durable engines that record model and tool calls | A durable Runtime. The application holds history. The two are different jobs, which this project already separates. | fits | A31 |
| Pydantic: a plugin names its own work so a restart does not repeat it | During a turn the Runtime only asks for tool calls and hook points. | impossible | A11, A31 |
| Pydantic: fallback, and a different model on the next step or the next attempt | The turn names one model access. The Runtime does not choose the model. Nothing says a plugin may replace that access between steps or attempts. | impossible | A12, A14 |
| Pydantic: new instructions are appended, not rewritten over the old ones | Plugins add model-visible history. History only grows. | fits | A23, A24 |
| Pydantic: approval handled inside the turn, then the same turn continues | The turn waits. The tool result comes back. The person is asked. | fits | A18, A21, A22 |
| Pydantic: the turn ends with unanswered tool calls, and a later run supplies those calls' results | A late answer arrives as new input. The six result statuses are endings, not "still waiting". | impossible | A18, A22 |
| Pydantic: a voice session | A turn made of steps. Each step is one model request. The provider keeps no conversation state. | impossible | A9, A15, A16 |
| Pydantic: a batch request outlives the turn | A step includes the model response. A turn's outcomes do not include "waiting on the provider". | impossible | A10, A15 |
| Pydantic: tools the provider runs (web search, code execution, provider-hosted connections) | Every tool call goes through the Harness to a tool source. Repeating a model request has no effect outside the system. | impossible | A15, A16, A17 |
| Pydantic: the same tool runs locally when the provider cannot run it | A tool source. The provider is not asked to run it. | fits | A16, A17 |
| Pydantic: a working environment (files, shell, sandbox) | Not one of the six capabilities. Already an open question. Both products need it as a swappable job. | impossible | A5 |
| Pydantic: a plugin publishes an event other plugins can block | Plugins observe events, and an event cannot change what happened. Plugins defining hook points is open. | impossible | A7, A13 |
| Pydantic: plugins declare order ("requires", "wraps") | Handler order is open. The behaviour can be described once that is decided. | strains | A7 |
| Pydantic: the caller holds history and passes it back in | A history-store plugin. The Harness keeps the session. | fits | A2, A6 |
| Pydantic: subagents | A tool starts a child session. The child does not see the parent history. The result comes back as the tool result. | fits | A27, A28 |
| Pydantic: peers message each other and do not control each other's runs | Another agent is a tool source, or uses this agent through an Interface. Peer messages are not tool results and are not the user. | strains | A20, A27 |
| Pydantic: a tool runs in the background and reports back later as user text | A tool result, then later input. The later text is framed as the tool's output, but it is not the tool result. | strains | A9, A18 |
| Pydantic: the model writes a plugin that applies on the next run, not this one | Active plugins can change between turns. Nothing says the model may add one, or that the current turn must not see it. | strains | A7 |
| Pydantic: memory across conversations | A plugin stores notes and adds them to what the model sees. | fits | A7, A23 |
| Pydantic: local MCP tools | A tool source. | fits | A17 |
| Pydantic: thinking, images, and other content | Typed parts. Unknown types are passed on and recorded. | fits | A26 |

## Findings

### A turn has no value for its caller

- **Feature or situation:** Pydantic AI's run returns a value: text, structured data, an image, or the result of an output function. A check on that value can reject it and send the model back inside the same run. With two special output types, the run can also end early so the caller can approve tools, or wait for a model request the provider is still processing, and resume later.
- **Described as:** History entries are the only record of what a turn produced. The turn's outcome is completed, cancelled, failed, or stopped at a limit.
- **Verdict:** gap
- **Assumptions:** A7, A10, A14
- **Evidence:** Pydantic `docs/output.md` lines 5 and 9: output is the final value returned from a run, and a run ends when the model responds with one of the output types, or early when the output type includes `DeferredToolRequests` or `PendingModelResponse`. Line 126: an output function ends the run, and the result is not passed back to the model. Line 721: each `ModelRetry` from an output validator consumes the run's output retry budget, which defaults to 1. This project's turn ends with one of four outcomes and has no value (`docs/contracts.md` line 271). A tool result's content is "what the model will see" (`docs/contracts.md` line 77), so an output function whose result the model must not see does not fit a tool result. A retry is specified when a model request fails, not when a successful response fails a check (`docs/pressure-test/README.md`, A14).
- **Suggested change:** A turn returns a value to its caller, separate from history. The value can be text, structured data, unanswered tool calls, or a model request still in flight. A plugin can require the value to match a shape. A failed check can send the model back inside the turn. That retry is not "the model request failed".

### Tools the provider already ran

- **Feature or situation:** Some tools are executed by the model provider, not by this system. The response comes back with the call and its result already filled in. Web search is provider-only unless a local fallback is added. Repeating the request can repeat work outside this system, such as another search or another code run. A local fallback for the same tool is a different case and fits a tool source.
- **Described as:** Every tool call goes through the Harness to a tool source. A Provider runs no tools. Repeating a model request has no effect outside the system.
- **Verdict:** breaks
- **Assumptions:** A8, A15, A16, A17
- **Evidence:** Pydantic `docs/native-tools.md` states that native tools are provided and executed by the LLM provider, on the provider's infrastructure, and that the call and its result appear in the model response. `docs/capabilities/web-search.md` documents a native-only default. This contradicts A15 (a repeated model request has no effect outside the system), A16 (a Provider runs no tools), and A17 (every tool call goes through the Harness to a tool source) in `docs/pressure-test/README.md`. It also contradicts the standardizing rule: the Runtime would be able to tell a vendor response that already contains tool results from an ordinary one (`docs/architecture.md` line 72).
- **Suggested change:** A model response may include tool calls the provider already ran, with their results. Those calls do not go through a tool source. Repeating that request can do work outside the system. Approval and recording still need a place, or the docs must say this case is exempt. A tool that runs locally when the provider cannot run it stays a normal tool source.

### The model can change between steps and between attempts

- **Feature or situation:** Pydantic can pick a different model before each model request in one run. On failure, or when a check rejects a successful response, it can try another model for that same attempt. The caller can also name a model for one run.
- **Described as:** The turn's input names one model access. The Runtime is given that access and never chooses the model. A retry repeats a failed model request.
- **Verdict:** gap
- **Assumptions:** A12, A14
- **Evidence:** `docs/capabilities/select-model.md` line 36: the selector is evaluated before each new logical model request. `docs/capabilities/model-fallback.md` line 9: fallback tries the next model when the request fails or when a successful response is rejected. This project's turn input has one model access (`docs/contracts.md` line 109). A14 allows a retry only when a model request fails, and says the retry sends the same step again. A12 correctly keeps the choice out of the Runtime, but no plugin API entry says a plugin may replace the model access between steps or attempts (`docs/architecture.md` lines 199 and 266).
- **Suggested change:** Say who may change the model between steps, and between attempts of one request. The Runtime is given the model for that attempt. It still does not choose.

### A tool call can still be open when the turn ends

- **Feature or situation:** Pydantic can end a run because a tool needs approval, an outside program, or a person's answer. The caller resumes later by passing the results for those same calls. The results are not a new user message. A resume handle continues that run. A handler inside the run is a different mode and does fit: the turn waits, the person answers, the tool result comes back.
- **Described as:** Every tool call ends with exactly one result. A question can outlast its turn, and a late answer arrives as new input.
- **Verdict:** breaks
- **Assumptions:** A22, A18
- **Evidence:** `docs/deferred-tools.md` describes two ways. One handles the wait inside the run. The other ends the run with `DeferredToolRequests` and resumes with `DeferredToolResults`, correlated to the same calls, with a new run id. `docs/output.md` line 9 includes this early end in the output type. A22 says a late answer arrives as new input (`docs/pressure-test/README.md`). Scenario 3 matches the DeepSeek timed-question shape, not this one. A18's six statuses are endings, not "still waiting". The call can still end with one result later, so A18 is strained rather than broken. A22 is the contradiction.
- **Suggested change:** A tool call can be unanswered when the turn ends. Its one result can arrive in a later turn as that call's result, not as new user input. The wait can be for a person, a program, or another system. The in-turn wait remains a valid second mode.

### A voice session is not a step

- **Feature or situation:** Pydantic's realtime API is a long-lived two-way session, not a run of model requests. The provider can detect turns and can interrupt the model when the person talks over it. There is no agent graph and no model-request hook. Reconnect can replay local history, or fork a session the provider stored. Unheard audio can be dropped.
- **Described as:** A turn made of steps. Each step is one model request and its response. The Provider keeps no conversation state. Partial output is live only.
- **Verdict:** breaks
- **Assumptions:** A9, A10, A15, A16
- **Evidence:** `docs/realtime/overview.md` line 223 introduces `Agent.realtime()` as the long-lived sibling of `run()`. Line 257: graph and model-request hooks do not run, because there is no agent graph. Line 155: one provider's reconnect replays local history, forks a stored session, or re-attaches a live connection. Line 212: some providers own turn-taking. `docs/realtime/turns.md` describes barge-in that drops audio the person did not hear. This project's step is one model request and its response, plus the tool calls that response asks for (`docs/architecture.md` line 189). A16 says the provider keeps no conversation state. Partial audio being dropped does fit A25. The session itself does not.
- **Suggested change:** A continuous session with a provider is its own kind of work, not a step. The provider may detect turns, interrupt, and hold session state. Say what is kept (final transcripts) and what is only live (audio the person never heard).

### A model request can outlive the turn

- **Feature or situation:** A batch request can take hours. Pydantic can end the run once the request is submitted, store the history, and collect the same request later. The later run continues if the result is ready, or ends again with the same waiting value.
- **Described as:** A step is one model request and its response, finished inside the turn. Outcomes are completed, cancelled, failed, or stopped at a limit.
- **Verdict:** gap
- **Assumptions:** A10, A15, A16
- **Evidence:** `docs/batch.md` lines 14 and 156. The history ends in a pending response that records the batch, and a later run checks that same batch. `docs/contracts.md` line 271 has no "waiting on the provider" outcome. This is not the provider keeping the conversation (A16). It is one request still open at the provider after the turn has ended.
- **Suggested change:** A turn may end because a model request is still in flight. A later turn can collect that same request. The waiting value is the turn's output (see the output finding), not a new request.

### A plugin must be able to name work a restart skips

- **Feature or situation:** Pydantic's durable engines record model calls and tool calls. A capability can also mark its own operations so a recovered run reuses the result instead of doing the work again. Peer sends are explicitly not safe under that regime, because inbox reads and sends are not recorded.
- **Described as:** A durable Runtime carries on with a turn after a restart. During a turn it only asks for tool calls and hook points.
- **Verdict:** gap
- **Assumptions:** A11, A31
- **Evidence:** `docs/durable_execution/overview.md`: durability records model and tool calls so they are not repeated; it is not the same as storing history. `docs/capabilities/custom.md` documents `@durable_operation` on a capability, keyed by the capability id plus the operation name. `docs/harness/peers.md` says peers raise an error under durable execution because sends and inbox reads are not recorded. `docs/architecture.md` line 199: during a turn the Runtime asks for only two things. Line 98: a durable Runtime carries on with a turn. That does not say a plugin can name a third kind of work to record.
- **Suggested change:** A plugin can name a piece of its own work that a durable Runtime records and does not repeat. A transient Runtime just does the work. The same description covers both.

### Plugins need to define jobs and hook points

- **Feature or situation:** DeepSeek plugins publish jobs other plugins call and replace: files, a sandbox, background jobs, a code-mode runtime, and others. Pydantic capabilities publish events other plugins can block, such as a file write. Both products also need a working environment as a swappable job. Pydantic capabilities bundle tools, hooks, instructions, and model settings, and can declare that one wraps another.
- **Described as:** Six capabilities. Plugins observe events but cannot change what happened. Whether plugins can define hook points is open. Whether a working environment is a capability is open.
- **Verdict:** gap
- **Assumptions:** A5, A7, A13
- **Evidence:** DeepSeek `docs/capability-seams.md` lines 762, 763, and 770: `ctx.ptcRuntime`, `ctx.fs`, and `ctx.jobs` are replaceable jobs with their own providers. Pydantic `docs/capabilities/overview.md` line 373: a write can be announced before it happens and a listener can veto it. `docs/hooks.md` line 308: an application callback can take part in those decision events. This project leaves plugin-defined hook points open (`docs/architecture.md` line 221) and the working environment open (line 85). The six rows in the capability table (`docs/architecture.md` lines 78–80) have no place for files, jobs, or a code-mode runtime.
- **Suggested change:** A plugin can define a job other plugins call, and hook points other plugins handle, including a hook that can stop the operation. The six built-in capabilities are not the whole list. A working environment is one such job. Order between plugins has to be decidable, including "a refusal wins".

### What a plugin adds must be able to disappear, and to belong to one agent

- **Feature or situation:** In DeepSeek, registrations are reversible effects. Stopping a plugin removes what it added. A registration can belong to one agent, hide a global tool of the same name, and not pass to child agents. LiveShare installs a confined tool set on one session and removes it when the share stops. Pydantic can also add a plugin that must not apply until the next run.
- **Described as:** A session has a set of active plugins. Plugins can change what they offer over time.
- **Verdict:** strains
- **Assumptions:** A7
- **Evidence:** DeepSeek `docs/cordis-primer.md` line 13: registrations are reversible effects, so reload and teardown unwind them. `docs/subsystems/scope.md`: a scope owns registrations and has a dispose path; listeners can be limited to one agent. `docs/subsystems/liveshare.md` line 39: confined replacements are installed for a shared session and disposed when the share stops, which restores the session's own tools. `docs/subsystems/tools.md` (the `parent` field on a tool execution): with the code-mode executor selected, a model-direct call of a native tool name is denied, so the scoped set is not just "added on top". Pydantic `docs/harness/capability-creation.md`: a plugin the model writes is validated now and activated on the next run, because the run's plugin set is fixed at the start. This project's plugin API lists "change what it offers over time" but not "offerings vanish when the plugin or the agent stops", "a same-named global tool is hidden", or "not in this turn, only the next one" (`docs/architecture.md` plugin API list).
- **Suggested change:** Say that a plugin's offerings last only while that plugin is active, and can be limited to one agent. A same-named offering from a wider scope is hidden, not duplicated. A child does not inherit them unless told to. A plugin added during a turn can be held for the next turn.

### Some facts must stay out of history

- **Feature or situation:** DeepSeek goal activation is the live permission to start another goal round. It is deliberately not in the durable record. After a restart or a fork, automatic work does not resume until a person turns the goal back on. LiveShare decides, in memory, whether the turn was started by a viewer. That answer is never written to the session log. A restart recomputes it from the next admitted step.
- **Described as:** History is the record. A durable Runtime carries on from it. What the model sees is a view of history.
- **Verdict:** gap
- **Assumptions:** A23, A30, A31
- **Evidence:** `docs/glossary.md` line 27: goal activation is process-local and deliberately absent from durable replay, so resume and fork need a later human-authorized mutation. `docs/subsystems/goal.md` lines 21 and 67: the durable phase records what happened to the objective; activation is never persisted. `docs/subsystems/liveshare.md` line 39: who started the turn is decided at admission, kept in host memory, and never written to the session log. A23 (history only grows) is not broken: these facts are absent, not deleted. The miss is that a durable Runtime which "carries on" (`docs/architecture.md` line 98) has no way to say "do not start work just because the log looks active".
- **Suggested change:** Some session facts are live only. They are not history, and a restart must not infer them from history. Goal continuation and "who started this turn" are two of them.

### One session can have more than one person

- **Feature or situation:** DeepSeek LiveShare lets an owner share a session with viewers. A viewer drives the same session with a smaller tool set. The owner keeps the full set. Which set applies depends on who started the turn, not on a single session policy. A viewer's stop can also end a turn the owner started.
- **Described as:** There is one user. Input requests go to the user. Approval policy is set for the session. Permissions only narrow for subagents.
- **Verdict:** gap
- **Assumptions:** A20, A21, A28
- **Evidence:** `docs/subsystems/liveshare.md` lines 5 and 39. The viewer is a different principal. The confined tools apply only to turns that principal starts. A20 in `docs/pressure-test/README.md` states the one-user assumption. A21 ties approval policy to the session. A28's narrowing is about child sessions, not about two people in one session.
- **Suggested change:** Say who sent each input. More than one person can use one session. Permissions can differ by sender, not only by session or by child agent.

### Peers are not subagents

- **Feature or situation:** Pydantic peers discover and message other sessions. They do not start those sessions, wait for them, or control them. A message can join a running turn, or wait until someone starts the next one. The sender is supplied by the host, not by the model. DeepSeek team members also message across branches rather than only up to a parent.
- **Described as:** Another agent is a tool source, or uses this agent through an Interface. Subagent results arrive as input. Questions go through the parent.
- **Verdict:** strains
- **Assumptions:** A20, A27, A28
- **Evidence:** `docs/harness/peers.md` line 6: peers discover and message other sessions without controlling their runs. The transport section frames the message as untrusted peer data, not as the user, and says it cannot grant approval. DeepSeek `docs/subsystems/agent-team.md` line 28: members exchange ordinary subagent messages and keep the real sender session id. A27 says another agent is a tool source or an Interface (`docs/architecture.md` line 248). Calling a peer an Interface stretches that: the message is not a tool result, and it is not the user (A20).
- **Suggested change:** Agents can message as peers, not only as parent and child. A peer message is input with a sender. It is not a tool result, and it is not the user.

### Code-mode sub-calls are tool calls the model does not see

- **Feature or situation:** DeepSeek code mode runs a program that calls tools. Those sub-calls go through the same tool pipeline as model-requested calls. They are logged. The program receives the full value. The model sees neither that value nor the log copy.
- **Described as:** A nested tool call, which the contract already allows. The tool result is what the model will see.
- **Verdict:** strains
- **Assumptions:** A15, A17, A24
- **Evidence:** `docs/tool-execution-pipeline.md` line 64: `run_code` and its ordered sub-calls go through the pipeline; sub-calls carry the parent token and are logged. `docs/subsystems/tools.md` line 855: only the logged copy is affected; the program already received the complete value, and the model sees neither. `docs/contracts.md` line 77 defines tool-result content as what the model will see. Nesting fits. "The model will see it" does not.
- **Suggested change:** A tool call can be made by a program rather than by the model. Its result can be for the program only. The log still records it. The model view does not have to include it.

### Background work reports back as text, not as the tool result

- **Feature or situation:** Pydantic can start a tool, tell the model it has started, keep the run going, and later deliver the result as a user-channel message tied to the original call. DeepSeek background jobs are a swappable job with the same shape: start work, then observe it later. The open question "work outside a turn" already names this.
- **Described as:** The tool returns a result, and later input arrives. Or the work is forced into a child session.
- **Verdict:** strains
- **Assumptions:** A9, A10, A18
- **Evidence:** `docs/harness/background-tools.md` around the "what happens during a run" section: the model first receives a started message with a task id; the completion arrives later as a user prompt part, framed as tool output, with metadata that is not sent to the model. DeepSeek `docs/capability-seams.md` line 770: producers register running work, and a model-facing tool reads, lists, and kills it. A18's one result can be the "started" message. The completion is then new input that only looks like a tool result. That is describable, and easy to get wrong.
- **Suggested change:** Say that work can outlive the turn that started it. A later notice can complete that work. It is not a second tool result, and it is not the user speaking. Leave the mechanism open.

### On-demand bundles only partly fit a skill

- **Feature or situation:** Pydantic can hide a bundle of tools, instructions, hooks, and model settings until the model loads it. The loaded fact is stored in history so a later run rebuilds it. A restart must not run the load tool again.
- **Described as:** A skill plugin, plus tools that appear over time, plus a history entry the model does not need to see as a tool result.
- **Verdict:** strains
- **Assumptions:** A4, A7, A31
- **Evidence:** `docs/capabilities/on-demand.md`: `defer_loading=True` hides the bundle until a load tool runs; instructions and tools then join the run; the loaded state is recovered from history. A skill covers instructions and tools. It does not cover hooks and model settings switching on as one bundle, which is the point of the feature. The durable-operation finding covers "do not run the load twice".
- **Suggested change:** No new part, if the seam finding lands. A bundle a plugin defines can be inactive until a tool loads it, and the loaded fact is a history entry. Until plugins can define jobs and hook points, this cannot be said without stretching "skill".

## Assumptions

| Id | Status | Reason |
| --- | --- | --- |
| A1 | holds | Both products can be described as a host plus plugins. Pydantic's "no harness" is the application playing the host. |
| A2 | holds | Hosting, the plugin API, and session/history still cover the host's job. Extra jobs belong in the seam finding, not in a larger host. |
| A3 | gap | Provider-run tools, turn output, and plugin-defined jobs need plugin API entries that are not there. |
| A4 | holds | Provide a capability, add behaviour, or both still covers bundles. On-demand stretches it but does not break it. |
| A5 | gap | Files, shell, sandbox, jobs, and a code-mode runtime are swappable jobs outside the six. |
| A6 | holds | One runtime, one history store, and many providers still holds. Fallback uses more than one provider, which the count already allows. |
| A7 | gap | The plugin API cannot say reversible offerings, per-agent shadowing, plugin-defined hook points, or a turn output. |
| A8 | strained | A response that already contains provider-run tool results is not a standard model response. Voice has no standard model request. |
| A9 | strained | Rounds fit as labels. Voice, background work, and a request that outlives the turn do not nest as session, turn, step. |
| A10 | gap | A turn needs a value, and outcomes need "waiting on tools" and "waiting on the provider". |
| A11 | gap | A durable plugin operation is a third thing the Runtime must be able to record, besides tool calls and hook points. |
| A12 | holds | The Runtime still must not choose the model. The gap is that a plugin has no defined way to change the access it is given. |
| A13 | gap | Both products have hook points a plugin defines, including ones that can stop the operation. One fixed list of six does not cover that. |
| A14 | gap | Output checks and fallback can reject a successful response. That is not "the model request failed". |
| A15 | broken | Provider-run tools do outside work inside a model request. A voice session is not a model request. |
| A16 | broken | The provider runs some tools, and a voice connection can hold session state at the provider. |
| A17 | broken | Provider-run tool calls do not go through a tool source. |
| A18 | strained | A deferred call can still end with one result later. The six statuses have no "still waiting", and the result is not required to arrive in the turn that made the call. |
| A19 | holds | The outside still uses the agent through Interfaces. LiveShare is another Interface, not a side door. |
| A20 | broken | LiveShare has an owner and viewers on one session. Peer messages are not the user. |
| A21 | strained | Fail-closed still holds. LiveShare's tool ceiling depends on who started the turn, not only on a session policy. |
| A22 | broken | Pydantic's deferred results are the tool calls' results, not new user input. DeepSeek's timed questions do match A22. |
| A23 | holds | Both products append. They tombstone or replace in a view, not by editing history. Live-only facts are absent, not deleted. |
| A24 | strained | The model view is worked out before each step. Code-mode values are logged and still not in that view. Dynamic instructions can also depend on live plugin code, not only on history. |
| A25 | holds | Streamed tokens and unheard voice audio are live only. Final text is what gets kept. |
| A26 | holds | Thinking, images, tool calls, and unknown parts fit typed content. Peer metadata must be kept so a message is not mistaken for the user. |
| A27 | strained | Subagents fit. Peers and team-mate messages are not "another agent as a tool" and not "through the parent". |
| A28 | strained | Parent/child narrowing fits subagents. It does not fit two people in one session, or peers who are not children. |
| A29 | holds | The what-level description still fits in-process and out-of-process. Object identity inside one process is a how. |
| A30 | strained | Goal activation and "who started this turn" are deliberately not recorded. Provider-run tool work may not pass between our parts. |
| A31 | gap | One description can fit both runtimes only if it says what is recorded, what a plugin may name, and what must not be replayed into new work. |
| A32 | holds | Credentials stay with the provider side in both products. The Runtime does not receive them. |

## Top changes

1. A turn returns a value to its caller, separate from history. The value can be text, structured data, unanswered tool calls, or a model request still in flight. A failed check on that value can send the model back inside the turn.

2. A model response may include tool calls the provider already ran, with their results. Those calls do not go through a tool source. Repeating that request can do work outside the system.

3. A plugin may change the model between steps, and between attempts of one request. The Runtime is given that model. It does not choose it.

4. A tool call can still be open when the turn ends. Its one result can arrive later as that call's result, not as new user input. The wait can be for a person, a program, or the provider.

5. A plugin can define a job other plugins replace, and hook points other plugins can stop. Offerings last only while the plugin or the agent scope is active. A working environment is one such job.

6. A durable Runtime records model requests, tool calls, and work a plugin names. Some facts stay live only, and a restart must not turn them into new work.

7. A voice session is its own kind of work, not a step. The provider may detect turns, interrupt, and hold session state. Separately, say who sent each input: one session can have more than one person, and agents can message as peers.

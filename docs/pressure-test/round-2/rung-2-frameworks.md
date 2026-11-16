# Round 2, rung 2: Agent frameworks

## Sources read (versions, commits)

Reviewed project commit `ef6cafeb725c7ce94dc33d3f60d4d60cb732f9d3`. The working tree was clean when the review began. Read the requested project documents in order, then `docs/pressure-test/README.md`. References below are to this checkout, not the old report's line numbers.

Primary sources:

- **DeepSeek Harness**, `/home/danballance/Code/_ref/deepseek-harness`, commit `39163dd30f703a79079e2d2446545cff3c453738`, dated 2026-11-13. Root package version: `0.2.2-rc.3`. Read `docs/architecture.md`, `docs/glossary.md`, `docs/agent-lifecycle.md`, and `docs/tool-execution-pipeline.md`; relevant sections of `docs/capability-seams.md`, `docs/event-producer-consumer.md`, and subsystems `goal.md`, `user-questions.md`, `agent-team.md`, `liveshare.md`, `scope.md`, `tools.md`, `jobs.md`, `workflow.md`, and `ptc-runtime.md`. Also read the architecture notes `2026-10-11-chat-group-tree-exchanges.md` and `2026-10-19-team-task-board-inbox.md`, and the Ralph package's usage and lifecycle sections.
- **Pydantic AI and Pydantic AI Harness**, `/home/danballance/Code/_ref/pydantic-ai`, commit `c7586d79b64706f4605f15a29534118813df12a4`, dated 2026-11-16. This is a commit review, not a claim about a released version. The root package declares a dynamic version; Harness documents separate 0.x versioning. Read relevant sections of `docs/output.md`, `deferred-tools.md`, `batch.md`, `persistence.md`, `hooks.md`, `agent.md`, `message-history.md`, `workspace.md`, `toolsets.md`, `multi-agent-applications.md`, and `native-tools.md`. Capability pages: `overview.md`, `custom.md`, `on-demand.md`, `model-fallback.md`, `select-model.md`, and `web-search.md`. Durability pages: `overview.md` and `backends.md`, plus the engine comparison in `workspace.md` and the engine-specific batch behavior in `batch.md`. Realtime pages: `overview.md`, `capabilities.md`, `turns.md`, and the deployment section on browser media. Harness pages: `index.md`, `peers.md`, `subagents.md`, `background-tools.md`, and `capability-creation.md`.

`DS` and `PA` below mean those two source roots. I did not run the frameworks or independently test all nine durable engines. Claims about those engines come from their checked-in documentation.

The basic parts still work. Toolsets and MCP clients map to tool sources. Files, shells and sandboxes map to the working environment. Instructions, compaction, memory, planning, telemetry and skills map to feature plugins. Provider-native tools now have an explicit place. A goal is plugin state plus permission to start further turns; its round counter belongs to that plugin. Ralph is a workflow capability used by a tool, with fresh child sessions and bounded handoffs. Agent Teams is a shared task-board capability plus ordinary child and peer controls. Programmatic handoffs and graphs spanning whole agents belong to the host under ADR 0012, not to a larger Harness.

The revision remains at the level of **what**, not wire formats or mechanisms. Most failures below are missing behavioral promises. Actor, authority, host, ephemeral session and erasure have useful definitions. Exchange membership, deferred-call state, model-access changes, live-session obligations and the effect of moving history are not yet precise enough to build independently.

## Round 1 recheck

| round-1 finding | resolved / partly / not resolved / rejected | one-line reason with doc reference |
|---|---|---|
| A turn has no value for its caller | partly | Results and rejection retries exist, but result transformation and output-function behavior do not; `docs/contracts.md:145–153,364`, F1. |
| Tools the provider already ran | resolved | Provider responses carry completed calls and results, with permission decided before the request; `docs/architecture.md`, Provider, and scenario 12. |
| The model can change between steps and between attempts | not resolved | It is now an explicit open question, but no interaction supplies replacement model access; `docs/open-questions.md`, Changing the model mid-turn, F8. |
| A tool call can still be open when the turn ends | partly | Open calls fit external results, but a late approval is not the call's result; `docs/contracts.md:201–219,394–412`, F2. |
| A voice session is not a step | partly | Live model access exists, but mandatory request/output hooks and delivery claims still fail; `docs/contracts.md:141,348–367`, F6–F7. |
| A model request can outlive the turn | partly | Waiting is a job, but collection of the existing request and continuation of its response are absent; `docs/contracts.md:142,295–302,337–344`, F5. |
| A plugin must be able to name work a restart skips | partly | The promise is stated, not contracted, and overstates what engines guarantee; `docs/architecture.md:323–328`, F4. The old claim that this needs a third Runtime request is rejected. |
| Plugins need to define jobs and hook points | resolved | Plugins may define capabilities and hook points, and the working environment is explicit; `docs/architecture.md`, Capabilities and What plugins can do. Handler ordering remains openly undecided. |
| What a plugin adds must be able to disappear, and to belong to one agent | partly | Scope and removal exist, but same-name replacement and activation boundaries remain unsettled; `docs/architecture.md:175–176`, `docs/open-questions.md`, Plugin scope, F11. |
| Some facts must stay out of history | resolved | Live-only goal activation is explicit; `docs/architecture.md`, History. The old report confused LiveShare's derived live restriction marker with the identity of admitted input. |
| One session can have more than one person | resolved | Actors, actor-specific authority and optional sharing describe owner/viewer sessions; `docs/architecture.md`, Actors and authority. F10 identifies a remaining information-flow gap. |
| Peers are not subagents | resolved | Peer input has an actor without parentage; `docs/architecture.md`, Working with other agents. PA's durable-peer incompatibility still needs declaration, F4. |
| Code-mode sub-calls are tool calls the model does not see | partly | A call can originate from another call, but result content is still defined as model-visible; `docs/contracts.md:96,106`, F10. |
| Background work reports back as text, not as the tool result | resolved | Jobs separate the started tool result from later work reports; `docs/architecture.md`, Jobs. Correction: PA BackgroundTools normally waits within the run and cancels unfinished work on an early stop; it is not evidence that every such task outlives its run. |
| On-demand bundles only partly fit a skill | resolved | No new part is needed: a plugin can change its offerings, settings, instructions and hooks and record its loaded state; `docs/architecture.md`, What plugins can do. Calling the bundle a skill is unnecessary. |

## Guarantees

Numbers refer to `docs/architecture.md`, Guarantees.

| guarantee 1-10 | holds / strains / gap / breaks | one-line reason |
|---|---|---|
| 1. Everything can be identified | gap | Exchange membership conflicts with queued input and late reports; suspended model work lacks a stated identity/continuation contract; F3, F5. |
| 2. Everything can be observed | holds | Events, history and plugin-defined events provide an observation surface; the promise correctly does not require permanent retention. |
| 3. History grows in normal use | strains | Append-only views fit both frameworks, but recovery after erasure or moving position is not defined; F12. |
| 4. Every tool call ends with exactly one result | gap | Deferred approval and deferred execution are collapsed, while a closed timed-question call may still have an answerable question; F2. |
| 5. Credentials never reach the Runtime; it never chooses the model | holds | Both frameworks can keep choice in a selection plugin and credentials in Providers; the missing model-change interaction does not require abandoning this rule. |
| 6. Nothing is lost in passing | holds | Typed content and policy exceptions suffice in principle; PA's foreign provider data can remain stored while a Provider applies a compatible model view. |
| 7. Plugins stay within the plugin API | gap | Durable plugin work lacks an explicit operation contract, and result processing lacks a stated answer that replaces the result; F1, F4. |
| 8. Approval fails closed | strains | The rule is sound, but late approvals and checks on calls without a running turn need an owner and complete states; F2, F10. |
| 9. Authority only narrows | gap | Origins are named, but steering carries only content and the controlling actor of mixed-input work is unspecified; F10. |
| 10. Differences are declared | breaks | Every Runtime must offer hooks that realtime lacks, while live support is declared only by Providers; unconditional local-tool fallback also overpromises; F6, F9. |

## Changes

Numbers refer to `docs/pressure-test/synthesis.md`.

| synthesis change 1-10 | holds / strains / gap / breaks | one-line reason |
|---|---|---|
| 1. Several actors, each with authority | gap | The vocabulary fits, but attribution through steering and authority for resulting work remain incomplete; F10. |
| 2. Provider state and Provider-run tools | strains | Ordinary native tools fit; live and late-answer shapes still lack necessary obligations; F5–F7. |
| 3. Work that is not a turn | gap | Jobs fit, but causal exchanges do not mean DeepSeek's display exchanges and conflict with scenario 4; F3. |
| 4. Turn result and waiting | gap | Shape rejection fits, but transformed output, deferred approval and still-answerable closed calls do not; F1–F2. |
| 5. History with stated exceptions | gap | The record/view distinction fits; pending work and durable recovery after a move or erasure are unspecified; F12. |
| 6. What may be seen and kept | breaks | A gate before every delivery cannot describe PA's direct provider-to-browser media path as documented; F7. |
| 7. Durability across parts | breaks | Named work and a repeat-safety hint do not prevent an effect being repeated after a lost completion; F4. |
| 8. Working environment and plugin-defined capabilities | holds | DeepSeek's extra services, Pydantic workspaces and plugin-defined veto points now fit without another built-in part. |
| 9. Complete plugin API | gap | Scoped replacement, result processing and tool checks outside turns remain incomplete; F1, F10–F11. |
| 10. Declared support | breaks | The description promises universal hooks and automatic substitutes that real compositions cannot provide; F6, F9. |

## New findings

These include remaining round-1 failures where the revised contracts expose a more specific problem.

### F1. Checking a result is not the same as producing the caller's result

- **Feature or situation:** Pydantic validates structured output, transforms it with an output function or validator, and returns the transformed value. An output function can query a database or hand off to another agent. Images can also be final output. Streaming validators can process partial values.
- **Described as:** A turn has a result and a required shape. At “the turn's result is ready”, a plugin accepts it or sends the model back. An output gate can redact delivery.
- **Verdict:** gap.
- **Assumptions or guarantees affected:** A3, A7, A10, A14; guarantee 7; changes 4 and 9.
- **Evidence:** PA `docs/output.md`, Output functions, Output modes, Handling partial output in output validators, and Image output; `docs/hooks.md:229–253`. Output functions return something the model does not receive. The project's `docs/contracts.md:364` permits only acceptance or retry, not a replacement value. Its turn result list at `149` does not explicitly use the richer Content definition at `15–27`. There is also no explicit output requirement in the model request at `125–132`; “other settings” leaves native structured-output support implicit.
- **Suggested change:** State that output processing may validate and transform a candidate, perform declared work, and return a caller-only value. Define how output requirements reach model access. Use the content vocabulary for non-text results. Keep partial delivery distinct from final acceptance, and state what happens when an output retry allowance is exhausted. None of this needs Python types or an output-tool wire format.

The ordinary case is fixed: a rejected candidate can cause another model request in the same turn. The gap is not a demand for Pydantic's exact hook names. It is that acceptance, transformation and presentation are different responsibilities.

### F2. A late approval is not a late tool result

- **Feature or situation:** A refund call is deferred for approval. Tomorrow an authorized person approves it. The refund must then execute, and only that execution produces its result. Separately, a DeepSeek timed question returns a pending notice immediately, lets independent work continue, and later accepts the answer as attributed input.
- **Described as:** An open tool call gets one result later. Every request is answerable now, later “as the tool call's result”, or no longer.
- **Verdict:** gap.
- **Assumptions or guarantees affected:** A18, A21, A22; guarantees 4 and 8; change 4.
- **Evidence:** PA `docs/deferred-tools.md:18–27,99–120,332–345` distinguishes approval from external execution and from a question. A resume token can preserve an in-turn wait; it need not become a new unit of work here. DS `docs/subsystems/user-questions.md`, Timed questions and late replies, explicitly says the call's own result already recorded the timeout and the later answer is a user message. The project's `docs/contracts.md:201–219,394–412` has no later-approval transition back to execution. Its open-past-turn path leaves only the running state, not waiting-for-approval. `docs/open-questions.md`, Waiting for an answer, acknowledges the approval question but does not resolve it.
- **Suggested change:** Separate approval decisions, question answers and external execution results. A deferred approval can authorize later execution; it cannot masquerade as that execution's result. Also allow an answerable question whose tool call has already returned a pending notice. State which request state survives a restart and how its final answer is attributed.

Do not “fix” this by allowing two tool results. DeepSeek already has one result; the later fact answers the question, not the closed call. The revised scenario 3 describes one valid pattern, not all timed questions.

### F3. An exchange has two incompatible meanings

- **Feature or situation:** Input A starts a job. The user then sends unrelated input B. After B completes, A's job reports back. A scheduler may also wake the session without any new human message.
- **Described as:** An exchange contains everything responding to one actor input. A job's continuation belongs to its original exchange. Scenario 4 also places queued follow-up input in the same exchange.
- **Verdict:** gap.
- **Assumptions or guarantees affected:** A9; guarantee 1; change 3.
- **Evidence:** `docs/architecture.md:221,228,298`; `docs/contracts.md:52–60,378–384`; `docs/scenarios.md:73`. DS `docs/glossary.md`, Loop hierarchy, defines an exchange as consecutive turns until the next human-opening turn. DS `.agents/notes/implemented/architecture/2026-10-11-chat-group-tree-exchanges.md`, Decision, confirms this is a display grouping: notices stay in the latest group, including scheduled notices. In the example, Modular Agent assigns the late report to A; DeepSeek displays it in B's group.
- **Suggested change:** Choose whether exchange means causal work or consecutive presentation. Keep the other as optional plugin-defined grouping. Specify whether fresh queued input opens an exchange, how steering joins one, and how delayed reports affect an exchange already marked done.

DeepSeek's rounds still fit as policy-owned counters. Its exchanges do not become our exchanges merely because both sit above turns. Keeping causal exchanges is reasonable, but the source mapping must say they differ.

### F4. Durability promises more than naming work can deliver

- **Feature or situation:** A tool commits a payment or a plugin sends a notification. The worker dies before recording completion. Recovery knows the operation's name but not whether the effect happened. Other plugins read changing external data that must be reused during replay even though reading it changes nothing outside the agent.
- **Described as:** A durable Runtime continues “without repeating outside work that already happened”. Tools declare repeat safety. Plugins name outside work so it is not repeated.
- **Verdict:** breaks.
- **Assumptions or guarantees affected:** A3, A7, A29, A31; guarantees 7 and 10; change 7.
- **Evidence:** `docs/architecture.md:323–328` makes the absolute promise; `docs/scenarios.md:116–118` says the shell tool's declaration and operation names suffice. Yet `docs/contracts.md:83` calls repeat safety a hint, not a promise, and there is no contract for named plugin operations. PA `docs/durable_execution/backends.md:233–260` explicitly warns that a unit may run twice after its effect but before its checkpoint. PA `docs/capabilities/custom.md:1140–1181` includes non-deterministic reads, stable operation identities, reuse of results and engine differences. PA `docs/harness/peers.md:74` rejects durable peers because sends and inbox reads are not recorded. PA `docs/batch.md`, Durable execution, documents different recovery behavior across the nine engines and additional integrations.
- **Suggested change:** Distinguish recorded completion from uncertain completion. State which operation results must survive and be reused, including reads and decisions. Require a meaningful repeat-safety promise where recovery depends on it; otherwise retain uncertainty or refuse unsafe continuation. Parts must declare incompatible durability combinations. Do not promise that naming an operation makes its external effect happen only once.

This does not require a third request from the Runtime. The synthesis was right about that. It requires a real promise for plugin work and an honest failure model.

### F5. A late model answer has a job but no continuation contract

- **Feature or situation:** A batch is submitted, the turn ends, and another process later collects that exact response. It may still be pending. A finished response may request tools. The original Provider must be used even if the session's preferred model has since changed.
- **Described as:** Model access returns “accepted”. Waiting is a job. A job report may start a turn.
- **Verdict:** gap.
- **Assumptions or guarantees affected:** A9, A10, A15, A29; guarantee 1; changes 2–4.
- **Evidence:** PA `docs/batch.md`, Submitting now and collecting later, requires a saved pending response, the submitting model and continued collection rather than a fresh request. Its Cancellation section explains that cancelling one request need not cancel a shared batch. In this project, `docs/contracts.md:142,149,299–302,337–344` provides no accepted-request identity, collection obligation, still-pending answer, or route for attaching the eventual response to the original model step. A turn's documented result does not name pending model work. A generic structured result could carry a handle, but its meaning is not contracted.
- **Suggested change:** Define who owns a submitted request, what identifies it across turns, and how its eventual answer completes the original work without resubmission. State how usage is attributed once and what cancellation promises when work is shared or cannot be stopped. Let the turn return its outstanding model work as explicitly as outstanding tool calls.

No polling mechanism or token format is needed. A Provider that pushes completion and one whose results are collected later should satisfy the same behavioral contract.

### F6. Live support cannot be declared only by the Provider

- **Feature or situation:** Pydantic realtime has no ordinary model-request or output-processing stage. Its supported tool and run hooks still work. Several other capability hooks warn because they cannot run.
- **Described as:** A Provider declares live sessions. Every Runtime offers the same standard hooks, including before each step and the result-ready hook, so plugins survive a Runtime swap.
- **Verdict:** breaks.
- **Assumptions or guarantees affected:** A8, A13, A14, A31; guarantee 10; changes 2 and 10.
- **Evidence:** PA `docs/realtime/capabilities.md:12–46` lists missing graph, request and output hooks and warns about them. `docs/realtime/overview.md:250–258` excludes typed output and validators. Project `docs/architecture.md:265–274` and `docs/contracts.md:348–367` require the common set. The declaration table at `docs/contracts.md:225–236` assigns live support only to the Provider and allows declarations of hooks beyond the standard set, not absent standard behavior.
- **Suggested change:** Declare which model-access shapes the Runtime can drive and which plugin promises hold for each shape. For unsupported checks or context control, say whether composition is refused or a stated alternative is used. Do not claim a meaningless hook preserves plugin behavior.

Naming each stretch a step does not create a chance to replace the Provider's context before it speaks. This is a missing behavior, not a missing event name.

### F7. Voice can bypass the output gate, and “heard” is not “generated”

- **Feature or situation:** In Pydantic's recommended browser voice deployment, audio travels between the Provider and browser while the backend handles tools and history. On interruption, most Providers do not report exactly which transcript words were heard.
- **Described as:** Every output passes the Harness-owned gate before any recipient receives it. Scenario 13 records what was actually heard, not what was planned.
- **Verdict:** breaks.
- **Assumptions or guarantees affected:** A19, A25, A29, A30; changes 2 and 6; the universal output-gate requirement.
- **Evidence:** PA `docs/realtime/deployment.md:7–33` says media never touches the backend in the sideband setup. PA `docs/realtime/turns.md:248–267` retains generated transcripts and an interruption position because most Providers do not identify heard words; some also cannot truncate their own stored copy. Project `docs/architecture.md`, Who sees what, promises a gate on every delivery. `docs/contracts.md:357` makes it Harness-owned. `docs/scenarios.md:188–190` promises a heard transcript, while `docs/open-questions.md`, Partial output, still asks whether delivered output must be recorded.
- **Suggested change:** Make pre-delivery control an explicit property of the output path. Refuse a path when required policy cannot be enforced there, or state its limitation. Distinguish generated output, delivered output and known playback position. Preserve uncertainty when exact hearing is unavailable. Align the scenario with that promise.

A separate Interface implementation could gate playback, but that is an additional requirement on that implementation. It is not a property the cited deployment already has.

### F8. Model fallback still has no owner-to-Runtime handoff

- **Feature or situation:** A model-selection plugin chooses a stronger model for the next step. A fallback plugin instead changes model within one step after a failed request or a successful but rejected response.
- **Described as:** A session model setting can change. A turn receives one model access. Before-step hooks return context and tools; the failure hook permits retry.
- **Verdict:** gap.
- **Assumptions or guarantees affected:** A7, A12, A14; change 9. Guarantee 5 should remain intact.
- **Evidence:** PA `docs/capabilities/select-model.md:32–38` distinguishes new logical steps from continuation of a suspended response. `docs/capabilities/model-fallback.md:7–46` describes candidate models within a step, including response rejection. DS `docs/architecture.md`, Turn flow, deliberately pins model selection across a step's retries. Project `docs/contracts.md:148–153,359–364` never returns replacement model access; `docs/open-questions.md`, Changing the model mid-turn, still leaves both cases open.
- **Suggested change:** State when a selection plugin may supply new model access, whether it applies to the next step or next attempt, and when a submitted request remains pinned. Record the model actually used and all attempt usage. Keep selection out of the Runtime and Provider.

Wrapping several vendors in one Provider is not a general answer: this project's Provider does not choose the model either.

### F9. A missing native tool does not imply a safe local substitute

- **Feature or situation:** Native web search is enabled without a local implementation. Or it is restricted to certain domains or cached content, and the local fallback cannot honor that restriction.
- **Described as:** Without Provider-run tools, “those tools are offered by a tool source instead”.
- **Verdict:** breaks.
- **Assumptions or guarantees affected:** A8, A16, A21; guarantee 10; changes 2 and 10.
- **Evidence:** `docs/architecture.md`, Declared support, gives that unconditional fallback. PA `docs/native-tools.md:25–32` rejects unsupported native tools unless a fallback was enabled. `docs/capabilities/web-search.md:7–22` defaults to native-only and refuses restrictions that cannot be enforced rather than silently running a local search. The normal Provider-run call path itself is now described correctly.
- **Suggested change:** A local substitute is used only if installed and able to meet the same required policy. Otherwise the feature is unavailable or the request is refused. Declare support for required constraints and combinations, not merely the name of a tool.

### F10. Non-model calls and mixed input still lack a complete shared contract

- **Feature or situation:** DeepSeek code mode calls a tool and gives the full result to its program, but not to the model. A UI can also call a tool while no turn runs. In LiveShare, an owner can steer a viewer-started turn without raising that turn's authority.
- **Described as:** Calls can be started by another call, a UI or a plugin. They receive the same checks. Tool-result content is what the model will see. The Runtime owns before/after-tool hooks. Steering passes content to the Runtime.
- **Verdict:** gap.
- **Assumptions or guarantees affected:** A7, A17, A20, A21, A24, A28; guarantees 8 and 9; changes 1 and 9.
- **Evidence:** DS `docs/subsystems/tools.md:855–867` explicitly distinguishes program return, logged copy and model visibility. DS `docs/subsystems/liveshare.md`, Constraining a shared Session, pins restrictions to the initiating turn even after owner steering. Project `docs/contracts.md:96,106,281,361–369` permits broader callers but does not name the owner of their checks when no turn exists, and the steering interaction carries no actor. `GLOSSARY.md`, Tool call, still defines it as a request from the model. Scenario 1 also invokes “after the step” before executing tools, although the Step definition includes those tools.
- **Suggested change:** Define a call independently of the model: origin, acting authority, result recipient and model visibility. Assign the common checks to an operation owner that exists outside turns. Preserve input attribution through steering and state how mixed input affects the authority of subsequent work. Align the glossary and step timing with those contracts.

A plugin can already keep an entry out of the model view. That helps, but it does not resolve a result contract that says the opposite, or make a Runtime-owned gate available when no Runtime turn is running.

### F11. Scoped offerings still do not say which offering wins

- **Feature or situation:** A session-local confined `read` tool hides a global `read` tool. It disappears when sharing stops. A child must not inherit that local registration accidentally. A Pydantic-authored capability is available on the next run while the current run retains its old version.
- **Described as:** Offerings may belong to one session and disappear with their plugin. A plugin can deliberately replace another plugin.
- **Verdict:** gap.
- **Assumptions or guarantees affected:** A3, A6, A7; change 9.
- **Evidence:** DS `docs/glossary.md`, Agent scope, states local shadowing and no child inheritance. `docs/subsystems/scope.md`, Owned registration context, ties visibility to lifetime. PA `docs/harness/capability-creation.md:67–101` gives the next-run boundary and preserves old instances. Project `docs/architecture.md:175–176` describes scope and whole-plugin replacement, not selection among same-named offerings. `docs/contracts.md:79` requires unique tool names but leaves clashes open. `docs/open-questions.md`, How many of each capability and Plugin scope, acknowledges the missing decisions.
- **Suggested change:** State whether scoped offerings replace wider offerings, which sessions inherit them, and which work keeps an earlier offering when a plugin changes or stops. Specify the allowed activation boundary for newly authored behavior. Whole-plugin replacement must not be the only way to replace one tool in one session.

### F12. Moving or erasing history does not settle the work attached to it

- **Feature or situation:** A batch or deferred approval belongs to history that the user rewinds past. Its answer then arrives. Alternatively, personal data is erased from session history while a durable turn has a saved operation result containing the same data. Recovery later reuses that result.
- **Described as:** Moving the current position changes the model view. Job reports start turns in their original exchange. Erasure reaches all controlled copies; the history store erases entries and Providers discard state.
- **Verdict:** gap.
- **Assumptions or guarantees affected:** A18, A23, A24, A29, A31; guarantee 3; changes 3, 5 and 7.
- **Evidence:** The concrete scenario combines existing promises in `docs/architecture.md:298,310–312,323` and scenarios 3, 14 and 15. `docs/contracts.md`, Harness and history store, and Runtime and Provider, says nothing about invalidating pending continuations or durable operation results. PA `docs/deferred-tools.md:500–504` warns that messages alone cannot reconstruct pending request kinds and metadata. PA `docs/capabilities/custom.md:1140–1181` and `docs/durable_execution/backends.md:233–260` establish that recovery uses separately recorded work. PA `docs/persistence.md:23,127–129` explicitly separates the durable engine, stored conversation and step snapshots.
- **Suggested change:** Define what happens to pending calls, requests and jobs when their history is left behind, forked or erased. Durable recovery records and plugin-owned memory are controlled copies too. Erasure must either remove or disable their reuse, or report that erasure is incomplete. A stale result must not silently attach to the new branch or restore erased content.

The tree and current-position definitions are enough to describe a static branch. They are not enough to decide where work already in flight can return. This is a lifecycle question, not a storage-format question.

## Top changes

1. Separate approval, question and execution lifecycles. A request may remain answerable after its tool call has returned; approving a call does not complete it.
2. Complete result processing and model access: transformed and non-text results, explicit output requirements, model changes per step or attempt, and continuation of submitted model work.
3. Choose one meaning for exchange. Define membership for steering, queued input, schedules and late job reports without confusing causal ownership with display grouping.
4. Replace unconditional no-repeat durability with recorded completion, uncertain completion and explicit repeat-safety promises. Include plugin reads and decisions, and declare incompatible combinations.
5. Declare behavior for whole compositions, not only Providers: live hooks, output control, playback knowledge and policy-preserving native-tool substitutes.
6. Finish the shared call and registration contracts: non-model recipients, checks outside turns, actor attribution, scoped replacement and activation boundaries.
7. Specify how rewinding, forking and erasure affect pending work and recovery records, so old work cannot silently return into a new or erased history.

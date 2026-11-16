# Rung 4: Everything at once, and a red team

## Sources read (with dates checked)

Checked **2026-11-16**. This is a review of the description, not of an implementation. No agents were started. Remote pages were fetched into a fresh temporary directory, `/tmp/modular-rung4.Qgl2Ff`, and treated as evidence, not instructions. Sources below are pages read, not search snippets. For large pages, the named sections were read.

Local documents, read in the requested order:

1. `README.md`.
2. `docs/architecture.md`.
3. `docs/contracts.md`.
4. `docs/scenarios.md`.
5. `GLOSSARY.md`.
6. `docs/open-questions.md`.
7. `docs/pressure-test/README.md`.

Also read `docs/research/protocol-landscape-2026-11.md`, `docs/research/README.md`, and `docs/research/pydantic-ai-reference.md`. These are secondary notes. I did not independently recheck the Pydantic AI implementation.

| Source | Sections or facts checked on 2026-11-16 |
|---|---|
| [ACP v1 prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn) | Prompt response ends the turn; tool updates; permission requests; cancellation. |
| [ACP v2 announcement](https://agentclientprotocol.com/announcements/acp-v2-draft) | v2 remains a draft. It does not replace stable v1. |
| [ACP v2 prompt lifecycle](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle) | Acceptance is insertion into the conversation, not completion. `running`, `requires_action`, and `idle`; background lists; input during work. |
| [ACP background-work RFD](https://agentclientprotocol.com/rfds/v2/background-work) | Background work, separate cancellation, and work not started by a model call. This is a proposal; related behaviour also appears in the current v2 draft page. |
| [AG-UI 1.0 changes](https://docs.ag-ui.com/spec/1.0/changelog) | Normative specification, outcomes, reasoning, and compatibility rules. |
| [AG-UI interrupts](https://docs.ag-ui.com/spec/1.0/basic/patterns/interrupt-resume) | An interrupt closes a run. A new run carries answers. |
| [AG-UI tools](https://docs.ag-ui.com/spec/1.0/events/tool-calls) | Frontend tools finish the run as success with calls still unanswered. Results arrive in the next input. |
| [AG-UI state](https://docs.ag-ui.com/spec/1.0/events/state) | Snapshots replace state; deltas amend it; state returns on the next run. |
| [AG-UI processing](https://docs.ag-ui.com/spec/1.0/basic/processing) | Unknown material survives translation, but enforcement drops or strips unknown material in closed shapes before application code. Open extension data survives. Also cross-checked through Context7 against the official repository. |
| [A2A 1.0 specification](https://a2a-protocol.org/latest/specification/) | Sections 3.4–3.5, 4.1, 4.3 and 4.4: task versus context, interrupted states, push notifications, Agent Card and security requirements. |
| [MCP 2026-07-28 changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog) | Stateless core, removal of initialization and session headers, per-request capabilities, explicit handles, and MRTR. |
| [MCP multi round-trip requests](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr) | `input_required`, `inputResponses`, opaque `requestState`, independent request IDs, and replay restrictions. |
| [MCP Apps overview](https://apps.extensions.modelcontextprotocol.io/api/) and its linked [2026-01-26 specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx) | UI resources, host-mediated tool calls, model/app visibility, resource reads, and sandbox rules. The specification was fetched from the official repository's raw file. |
| [OpenAI realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations) | Input and output audio, provider conversation items, interruption, playback duration and truncation. |
| [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search) | Hosted search can fetch live external content during a model request. |
| [OpenAI Batch](https://developers.openai.com/api/docs/guides/batch) | Submission, retrieval, separate cancellation, partial completion and expiry. |
| [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning) | Encrypted reasoning can be returned and replayed without being read. |
| [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) | Cache settings, prefix reuse and cached usage. Caching is not a guarantee of identical responses. |

Three corrections to the local research notes matter here:

- AG-UI does **not** promise to deliver every unknown field unchanged to application code. Its enforcement stage removes unknown material in closed shapes. Translation and open extension data are different cases.
- A2A requires at least one **delivery attempt** per configured webhook. It permits duplicates and retries. That is not a promise of successful delivery.
- MCP MRTR ends a protocol request, not necessarily our turn or logical tool call. An adapter may conduct several requests inside one call. MCP Apps also has its own UI initialization; the stateless core does not remove that separate lifecycle.

The assumption list sometimes makes stronger claims than the architecture. In particular, A16 explicitly forbids Provider conversation state, while the Provider paragraph does not. A17 calls Harness routing universal, while the architecture leaves direct tool access open. Verdicts below test the listed assumptions and identify where the prose is weaker.

## Feature map

“Fits” means a description can be told with the existing contracts. It does not mean production readiness. An open question is not an answer, but neither is it a concealed defect. Findings identify the missing decision without prescribing a transport or implementation.

| Feature | Described as | Verdict | Assumptions |
|---|---|---|---|
| ACP v1 foreground chat | ACP Interface gives input, follows events and answers input requests; Runtime runs a turn. | fits | A1, A4, A19 |
| ACP v2 prompt accepted versus work finished | `give input` returns accepted; turn events report later progress. Insertion timing needs a clear interpretation. | strains — F3 | A8, A9, A10 |
| ACP v2 `requires_action` and background work | Input requests plus plugin state and events; no shared background-work interaction or item cancellation. | gap — F3, F4 | A7, A9, A10, A22 |
| AG-UI interrupts | Interface can close a protocol run while an internal turn waits; mapping across a restart is undefined. | gap — F4 | A8, A10, A22, A31 |
| AG-UI frontend tools | One plugin supplies Interface and tool source roles; later input carries the tool result. No explicit external-result interaction exists. | gap — F5 | A7, A13, A17, A18 |
| AG-UI state snapshots and deltas | A feature plugin records its state in history and reports events; Interface translates them and passes incoming state to the plugin. | fits | A3, A4, A23, A26 |
| A2A tasks and interrupted states | Interface uses plugin state for task IDs; turns supply work. Task scope, continuation and cancellation lack a common contract. | gap — F3, F4 | A7, A9, A10, A27 |
| A2A push notifications and Agent Card | Interface publishes configured descriptions and sends events; secure delivery and live capability descriptions stretch its contracts. | strains — F15 | A7, A8, A19, A32 |
| ACP, AG-UI and A2A on one session | Multiple Interfaces are allowed. Their work, answer and audience scopes are not defined together. | gap — F1, F3, F4 | A7, A9, A20, A21 |
| Several users with different permissions | “Who answered” exists; authenticated actors and authorized audiences do not. | breaks — F1 | A20; also A7, A21 |
| Tenant budgets across sessions; administrator policy | Feature plugins can inspect usage and refuse tools. Shared spending authority and policy precedence are absent. | gap — F2 | A7, A13, A21 |
| Ordinary stateless MCP calls | Tool source adapts request metadata and explicit server handles. No MCP connection state is required in the Runtime. | fits | A8, A17, A29 |
| MCP MRTR within a live call | Tool source asks for input, uses Provider access for sampling if permitted, and retries the protocol request until one logical result. | fits | A11, A18, A26 |
| MCP MRTR across process loss or a days-long wait | Opaque continuation can be plugin state, but its durable ownership and answer routing are undefined. | gap — F4, F7 | A7, A22, A31 |
| MCP Apps UI carried with tool output | Content and display hints carry the UI description; host resource access and call visibility are not specified. | gap — F6 | A7, A8, A17, A26 |
| MCP Apps tools called without a model | Plugin API permits a call on a plugin's behalf, but Tool call requires a model step and checks belong to Runtime hooks. | gap — F5 | A7, A9, A13, A17 |
| Durable Runtime; approval waits for days | Durable Runtime and persistent input request are intended, but no agreed recovery boundary spans the other plugins. | gap — F4, F7 | A10, A22, A29, A31 |
| Remote sandbox shared by all working tools | Remote shell is a tool source; common environment access remains open. | gap — F13 | A3, A5, A7 |
| Work outlives turns | Scheduling and subagent plugins can return later input; general work identity and cancellation are missing. | gap — F3 | A7, A9, A27 |
| Bidirectional realtime voice and interruptions | Audio content is representable. Incremental input, playback acknowledgement and provider conversation changes are not. | breaks — F9 | A14, A16; also A7, A24 |
| Image generation as a normal call | Image-generation tool source returns image content or a file reference. | fits | A4, A18, A26 |
| Provider-native image generation or web search | Provider request settings and opaque output can carry it, but execution bypasses the stated tool boundary. | breaks — F8 | A15, A16, A17 |
| Prompt caching | Context management preserves useful prefixes; Provider settings request caching; usage reports cached tokens. | fits | A8, A12, A24 |
| Encrypted reasoning, same Provider | Opaque reasoning content stays in history and returns to its Provider. | fits | A26, A30, A32 |
| Encrypted reasoning after a Provider switch | Preserve the source record, but do not blindly send an unreadable provider item to another model. Compatibility rules are missing. | strains — F17 | A8, A24, A26 |
| Batch model requests | Provider can hide a wait, but submitted jobs, partial results and job cancellation have no contract. | gap — F10 | A7, A9, A15, A16 |
| Model loads plugins mid-run | Existing plugins can reveal tools; loading a new plugin and changing a running turn's dependencies are open. | gap — F14 | A3, A7, A13 |
| Input redaction | `input arrives` can change input before history and model use, as scenario 1 orders it. | fits | A3, A13 |
| Output redaction before anyone sees it | Provider stream hook is observe-only; after-step hook cannot replace output. | gap — F11 | A7, A13, A14, A30 |
| Lawful deletion of recorded personal data | History store forbids deletion; summaries and plugin state can also hold copies. | breaks — F12 | A23 |
| Human handoff to a support agent | Commands, input requests and another Interface can route messages; taking and returning control are undefined. | gap — F16 | A7, A20, A27, A28 |
| Replay or audit of interrupted live output | Telemetry can observe chunks, but the normal history excludes them and has no record of delivery. | strains — F18 | A25, A30 |

## Findings

### F1. A shared session has no shared account of who may do what

- **Feature or situation:** A finance manager and a contractor share a session. The manager requests a refund. Both web and editor Interfaces can answer approvals. The contractor presses “allow”, then opens the session history containing the manager's private attachment.
- **Described as:** Multiple Interfaces; session settings; `give input`, `open a session`, `follow a session`, and `answer an input request`; approval plugin.
- **Verdict:** **breaks** A20; **gap** in the supporting contracts. Knowing which Interface can display an approval is not knowing which person may authorize it. “Who answered” is attribution, not an authorization rule.
- **Assumptions:** A7, A20, A21, A28.
- **Evidence:** `docs/contracts.md:140–159` gives the request a session and agent, but no authorized answerer or audience. `docs/contracts.md:173–185` lists operations without actor or tenant scope. `docs/architecture.md:133` makes approval policy per session. This concrete scenario needs permissions for reading as well as acting.
- **Suggested change:** Give input, reads, actions and answers an authenticated actor, tenant and authority scope. Define who may receive each item and who may answer it. State how two competing answers are resolved. Separate authorization from consent, and preserve delegated restrictions.

### F2. Session limits do not express a tenant spending limit or administrator veto

- **Feature or situation:** Two sessions each see $8 left in the same tenant budget. Each starts a $6 request. A summarizer also spends money outside either Runtime's normal model step. Meanwhile, a session owner changes the approval setting despite an administrator's ban.
- **Described as:** Usage, session limits, model-selection and approval plugins; before-step, before-model and before-tool hooks.
- **Verdict:** **gap**. Shared plugin state can hold a number, but the description does not say what it means to admit spending against it. The Provider hook can change a request, not refuse it. A Runtime-only budget misses model requests made by other plugins. Refusal winning at a tool hook does not define policy precedence for settings or model use.
- **Assumptions:** A7, A13, A21.
- **Evidence:** `docs/contracts.md:161–163` totals usage by step, turn and session. `docs/contracts.md:243–259` has no universal spend gate. `docs/architecture.md:152–156` permits session setting changes. `docs/open-questions.md:84–86` leaves limits unresolved.
- **Suggested change:** Define tenant-wide spending authority, admission, unknown costs and settlement for all paid operations. Define how administrator, tenant, user and session policies combine, and who may change them. Require checks against the action that will actually run, after any permitted changes.

### F3. A session, a turn and a remote task are not interchangeable

- **Feature or situation:** An editor has an active request. A2A task T is waiting for authentication. A background report is still running. The web client wants to cancel only the report. Its completion may start foreground work later.
- **Described as:** One session; one Runtime; plugin state for remote task IDs; events; scheduling input; `cancel the session`.
- **Verdict:** **gap**. One Runtime can coordinate this; several Runtimes are not required. The problem is that the listed interaction cancels the session's running turn, not a named task or background item. Plugin commands could offer private controls, but the Interfaces have no agreed meaning for those controls. A2A tasks may span turns; an ACP acceptance is not a turn completion.
- **Assumptions:** A7, A8, A9, A10, A27.
- **Evidence:** `docs/contracts.md:102–110` defines only turn outcomes. `docs/contracts.md:175–180` scopes cancellation to the session. `docs/open-questions.md:94–98` explicitly leaves work outside turns open. [ACP v2 lifecycle](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle), “Foreground and Background Work”, separates these states. [A2A specification](https://a2a-protocol.org/latest/specification/), section 3.4, allows several tasks in one context.
- **Suggested change:** Describe persistent work with its own identity, owner, state, result and cancellation scope. Define its relationship to turns, accepted inputs and sessions. Allow background work and remote tasks to continue without pretending a foreground turn is still active.

### F4. Waiting has three meanings, and the contracts do not reconcile them

- **Feature or situation:** One approval is visible through ACP and AG-UI. A durable Runtime waits for days. AG-UI has already ended its protocol run with an interrupt. An A2A task remains `INPUT_REQUIRED`. A late answer arrives after a restart, while another turn is active.
- **Described as:** Input request; waiting turn; open requests in the turn outcome; late answer as new input; plugin state for protocol IDs. An MCP tool source can similarly retain the opaque state needed for MRTR.
- **Verdict:** **breaks** the literal A10 end-on-input rule; **gap** in continuation ownership. The docs themselves both end turns when outside input is needed and let turns wait. There is no need to force all three protocols to use our turn ID, but the answer must still reach the right pending action exactly once. A22 is useful for ordinary questions; it is not a universal approval-resume rule.
- **Assumptions:** A7, A8, A10, A22, A31.
- **Evidence:** `docs/architecture.md:189–191` defines the turn boundary; `docs/architecture.md:225–233` permits waiting and late input. `docs/contracts.md:263–291` leaves long waits open. [AG-UI interrupts](https://docs.ag-ui.com/spec/1.0/basic/patterns/interrupt-resume) closes the protocol run. [A2A task states](https://a2a-protocol.org/latest/specification/) distinguishes interrupted from terminal states. [MCP MRTR](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr) requires exact continuation state on a later protocol request.
- **Suggested change:** Distinguish waiting in a live turn, durable suspension, and ending with work pending. Define who owns a pending action, what survives restart, and whether a reply resumes it or starts new work. Tie approval to the exact action and authority still in force; a late “allow” must not authorize a changed action.

### F5. Tools without model steps and tools completed by a frontend have no complete path

- **Feature or situation:** An MCP App button invokes a tool while the Runtime is idle. Separately, an AG-UI frontend tool is executed in the browser after the protocol run ends. The next input contains its result.
- **Described as:** Interface plus tool source in one plugin; “have a tool call run on its behalf”; tool progress and result; approval hooks.
- **Verdict:** **gap**. The architecture allows the first case, but Tool call requires “the step that asked for it”, and the glossary calls it a request from the model. The only before/after-tool hooks belong to Runtime. The frontend case also lacks an interaction for accepting and validating an externally supplied result. Holding a tool-source operation open can work in a live process; that is not a complete recovery contract.
- **Assumptions:** A7, A9, A13, A17, A18.
- **Evidence:** `docs/architecture.md:166`; `docs/contracts.md:61–69`, `215–220`, `246–247`; `GLOSSARY.md:87`. [AG-UI frontend tools](https://docs.ag-ui.com/spec/1.0/events/tool-calls#frontend-tools) forbids the producer from fabricating the frontend's result. [MCP Apps](https://apps.extensions.modelcontextprotocol.io/api/) permits calls from the UI through the host.
- **Suggested change:** Allow a tool call to originate from a model, user, app or plugin, without a fake step. Define shared checks for every origin. Describe deferred external execution and result submission, including who is allowed to answer and what happens to duplicate or late results. Keep one logical final result.

### F6. MCP Apps needs more than display hints

- **Feature or situation:** A tool result opens a dashboard. Its refresh tool is app-only and must not be shown to the model. The dashboard tries to invoke a tool that is model-only, or to read a UI resource from another server.
- **Described as:** Tool-definition “how to show it”; typed content; Interface rendering; tool-source calls.
- **Verdict:** **gap**. Carrying the UI bytes is possible. The listed contract does not express who may invoke a tool or which source owns its UI resource. A tool source only lists and runs tools; an Interface has no stated way to fetch that source's resources. One combined plugin could hide all this internally, but independently swappable MCP sources and Interfaces cannot rely on that arrangement.
- **Assumptions:** A7, A8, A17, A26.
- **Evidence:** `docs/contracts.md:49–59`, `215–220`. The official [MCP Apps specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx), “Resource Discovery”, “Visibility” and “Sandbox”, requires resource retrieval, app/model visibility checks and constrained rendering.
- **Suggested change:** Describe source-owned presentation resources and who may fetch, render and act through them. Keep tool visibility, invocation authority and presentation data distinct. State that displaying a tool result does not grant its embedded app the user's full permissions.

### F7. Durable recovery needs cooperation beyond the Runtime

- **Feature or situation:** A remote payment succeeds, but its reply is lost. The Runtime and tool-source process restart. An approval plugin also sent an email before the crash. The old history writer may still be alive behind a network partition.
- **Described as:** Durable Runtime; tool source; plugin state in history; “kept safely”; one history writer; `outcome unknown`.
- **Verdict:** **gap**. A durable Runtime cannot infer whether an external payment happened. The six result statuses can express uncertainty, so they need not be replaced. What is missing is which operations support safe continuation, who records progress before it is lost, and which effects are covered. A safe system may have to stop and reconcile instead of promising to continue normally. Plugin side effects matter too, not just model-requested tools.
- **Assumptions:** A7, A18, A29, A31.
- **Evidence:** `docs/architecture.md:238–242` promises continuation without repeated effects. `docs/contracts.md:215–235` offers run, cancel and store interactions, but no recovery obligations for their participants. `docs/contracts.md:281` ends a process-interrupted call even though a durable owner may survive that process. `docs/research/pydantic-ai-reference.md:88–97` separately identifies durable plugin operations. This is a standard lost-reply scenario; it does not depend on a particular transport.
- **Suggested change:** Define the recovery promises each participating operation must make, including uncertain effects and later evidence. State what durable acknowledgement means and who may resume writing. Distinguish a worker stopping from a logical call ending. Weaken automatic continuation where the external system cannot support it.

### F8. A Provider request can execute tools and have outside effects

- **Feature or situation:** The model uses hosted web search on a confidential query. The Provider does the search and returns an answer. Repeating the model request repeats disclosure and paid work. A provider-hosted action could have stronger effects.
- **Described as:** Provider request settings and streamed response; Provider hooks; perhaps opaque tool activity in content.
- **Verdict:** **breaks** A15 and the blanket forms of A16 and A17. Provider-native execution does not call a Harness tool source before acting. Calling the Provider plugin a tool source too does not make an internal server action pass through the Harness. Search need not mutate a database to have an outside effect: sending a private query is enough.
- **Assumptions:** A8, A13, A15, A16, A17.
- **Evidence:** `docs/architecture.md:241` says model repetition changes nothing outside the system. `docs/contracts.md:207–220` separates model requests from Harness-run tools. [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search), “Live internet access”, describes hosted live fetches within a model request.
- **Suggested change:** Distinguish Harness-executed tools from Provider-executed operations. Describe which policy checks can happen before a Provider request and which actions can only be reported afterward. Give model requests an effect and retry classification. Do not claim per-action approval where the Provider cannot offer it.

### F9. Realtime voice is not a completed input followed by output chunks

- **Feature or situation:** The model is speaking while the user interrupts. The client has played 1.5 seconds, not the full generated answer. The Provider must stop generation, remove unheard content from its conversation, and accept more audio.
- **Described as:** Audio content; model-output events; input “in the running turn”; cancel turn; before-step context.
- **Verdict:** **breaks** A14's exclusive context boundary and A16's state-free Provider rule. There is also a **gap** in the interactions. “Take this input before the next request” is not bidirectional input into an active model exchange. Cancelling a whole turn is not the same as stopping speech and continuing the conversation. Modelling every audio packet as a new step does not describe the live Provider conversation.
- **Assumptions:** A7, A8, A14, A16, A24, A25.
- **Evidence:** `docs/contracts.md:90–100`, `194–196`, `207–213` describes one request with streamed output. [OpenAI realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations), “Handling interruptions”, requires playback-aware truncation; its input buffer and conversation items persist across events.
- **Suggested change:** Describe live model exchanges with input and output that can both continue, be interrupted and be acknowledged. State who owns Provider conversation state and how it relates to history. Record what was generated separately from what was delivered or heard. Keep vendor-specific details inside the Provider.

### F10. Batch jobs need a lifetime beyond a model response

- **Feature or situation:** A tenant submits 2,000 model requests. Some finish overnight, others expire. The submitter disconnects. Another authorized user retrieves the finished items and cancels the rest without cancelling an unrelated chat turn.
- **Described as:** Provider request; a long-running step; plugin state containing a job handle; usage.
- **Verdict:** **gap**. A Provider can hide one slow request behind the current interaction, but the caller cannot describe submission acceptance, item results, job retrieval and separate cancellation. A tool source could wrap a batch service, but that moves model access and selection into an ad hoc tool rather than satisfying the Provider contract.
- **Assumptions:** A7, A9, A15, A16.
- **Evidence:** `docs/contracts.md:90–110`, `207–213`. [OpenAI Batch](https://developers.openai.com/api/docs/guides/batch), checking status, retrieving results, cancellation and expiry, distinguishes the job from its individual model results.
- **Suggested change:** Describe asynchronous model work, including acceptance, ownership, per-item outcomes, partial completion and cancellation. Relate job usage to the tenant and originating requests without inventing one giant model step.

### F11. An output guardrail cannot stop output before disclosure

- **Feature or situation:** A model emits a private account number in several chunks. The web Interface and telemetry plugin see the chunks. After the step, a guardrail notices the number. On input, a later context plugin can also add text after an earlier scrubber ran.
- **Described as:** Input-arrives transformation; before-step context; Provider before-request hook; observe-only response hook; after-step continue/end decision.
- **Verdict:** **gap**. No standard hook can hold, replace or refuse model output before it reaches other parts. An Interface-local filter is insufficient when several Interfaces and telemetry observe the same stream. A Provider-local hard-coded filter loses the claim that the feature is independently swappable. A14's word “entirely” also conflicts with the already allowed Provider request rewrite.
- **Assumptions:** A7, A13, A14, A30.
- **Evidence:** `docs/contracts.md:244–254`: after-step cannot replace the response; Provider stream handling is observe-only; Provider before-request can change the request. `docs/contracts.md:132` exposes live chunks. `docs/open-questions.md:100–108` leaves hook order and partial-output consumers open.
- **Suggested change:** Define input and output policy gates at the actual disclosure boundaries, before model submission, display, history retention and external telemetry as applicable. Say which consumers may see raw content and which see redacted content. Record the effective context, not only the earlier proposed context. No particular buffering technique is required by this change.

### F12. Permanent history conflicts with a valid erasure requirement

- **Feature or situation:** Personal data appears in a message, a tool result, a summary and a fork. The product receives a valid deletion request with no applicable retention exception. Appending “deleted” leaves those copies accessible in the history store.
- **Described as:** History store; append-only history; context view; compaction; forked sessions; telemetry.
- **Verdict:** **breaks** A23. Hiding data from the model or the UI is not deleting it. This is not a claim that every GDPR request requires deleting every audit record; it is the narrower case where erasure is required.
- **Assumptions:** A23.
- **Evidence:** `docs/architecture.md:119–121` says the store never changes or deletes recorded data. Guarantee 3 at `docs/architecture.md:264` repeats it. `docs/contracts.md:222–229` has no deletion interaction. `docs/scenarios.md:86–95` keeps originals when adding summaries.
- **Suggested change:** Make history append-only during ordinary operation, subject to explicit retention and lawful-erasure rules. Define the scope of deletion across copies, summaries, forks, artifacts, Provider-held data and plugin exports. Keep permitted evidence of deletion without preserving the erased payload. State limits where an external recipient cannot be controlled.

### F13. A remote shell is not a common working environment

- **Feature or situation:** The shell runs in a remote sandbox, but the skills plugin reads local files and system-prompt construction loads a different `AGENTS.md`. After a long approval wait, the sandbox has expired and a replacement contains different files.
- **Described as:** Remote tool source; working-directory setting; plugins reading files and processes; durable Runtime.
- **Verdict:** **gap**. A self-contained remote shell fits. The product needs all relevant plugins to agree on the same environment and its lifetime. That agreement is not described. This does not prove there must be a seventh capability; it proves the common responsibility needs a contract somewhere.
- **Assumptions:** A3, A5, A7.
- **Evidence:** `docs/architecture.md:179–180`; `docs/open-questions.md:46–50`. The latter already recognizes that swapping an environment should affect every tool. The repo's Pydantic AI note, `docs/research/pydantic-ai-reference.md:63–66`, supplies a concrete comparable requirement.
- **Suggested change:** Define an environment's identity, scope, access and lifetime. Say which plugins use it and what loss or replacement means for pending work. Keep local versus remote execution an implementation choice.

### F14. Revealing installed tools is not loading a plugin

- **Feature or situation:** Mid-run, the model asks to load a new plugin that supplies tools and a policy handler. A tool call is already awaiting approval. The durable worker restarts with a newer version of the plugin.
- **Described as:** A plugin changes what it offers; session active-plugin list; before-step context; fixed turn tool list; Harness plugin hosting.
- **Verdict:** **gap**. A preloaded plugin can reveal its own tools. There is no listed operation for asking the Harness to activate another plugin, deciding its authority, or defining when its handlers and dependencies take effect. Restarting with changed plugin behaviour also changes the meaning of pending work.
- **Assumptions:** A3, A7, A13, A31.
- **Evidence:** `docs/architecture.md:148–150` allows changing offers; `docs/contracts.md:102–110` supplies tools at turn start. `docs/open-questions.md:34–44` leaves scope and lifecycle open. The Pydantic AI research note at lines 43–53 describes on-demand bundles, not just skill text.
- **Suggested change:** Describe activation, deactivation, dependencies and the authority required to change the plugin set. Define when changes become visible and what happens to in-flight or suspended work. Distinguish loading instructions, revealing an installed feature, and loading new executable behaviour.

### F15. A2A publication and secure push fit only by stretching the plugin roles

- **Feature or situation:** The A2A Interface advertises an Agent Card and sends an authenticated task update after a restart. A model-loaded plugin changes the skills offered. A webhook retry must not be treated as a second completed task.
- **Described as:** Interface settings, plugin state in history, custom events, outgoing notifications. A combined Interface/tool-source plugin could obtain credentials under the tool-source role.
- **Verdict:** **strains**. Static Agent Cards and live pushes fit an Interface. The APIs do not offer a clear read of the agent's current public abilities, and credential access names only Providers and tool sources. A fake extra role is an awkward way to authorize an Interface's legitimate push. Delivery bookkeeping can be plugin state; no new transport abstraction is required.
- **Assumptions:** A7, A8, A19, A32.
- **Evidence:** `docs/architecture.md:104–113`, `123–125`, `179`; `docs/contracts.md:231–235`. [A2A specification](https://a2a-protocol.org/latest/specification/), sections 4.3.3 and 4.4, defines authenticated push payloads and Agent Cards. It requires a delivery attempt, not guaranteed receipt.
- **Suggested change:** Describe the agent's public abilities and who may read or publish them. Permit explicitly authorized non-Runtime plugins to use credentials for their declared purpose. Distinguish producing a task update from delivering it, including duplicate delivery and recovery.

### F16. Human handoff and delegated work need control ownership, not just messages

- **Feature or situation:** A customer is handed to a human support worker. The human takes over the same session while a background refund agent still exists. The worker must stop automatic replies, receive only authorized context, and later return control. A specialist agent may ask an approver who is not the original customer's representative.
- **Described as:** Support Interface; commands; cancellation; approval requests; child sessions; results as parent input.
- **Verdict:** **gap**. Cancelling one turn does not prevent schedules or child results from starting another. A plugin could track a “human owns this” setting, but the listed before-turn hook cannot refuse a turn, and no rule makes other plugins honor that setting. Parent routing is convenient, not a complete authority or transfer model. A closed parent process alone is not a failure: the parent session can survive it.
- **Assumptions:** A7, A13, A20, A27, A28.
- **Evidence:** `docs/contracts.md:251–252` offers input handling and context additions, not control transfer. `docs/architecture.md:248–254` gives only parent/child rules. `docs/scenarios.md:118–121` sends completion as new input. F1's multiple-user case supplies the realistic authority conflict.
- **Suggested change:** Define who controls ongoing work, how control is handed over and returned, and what happens to queued and background work. Separate parentage, result delivery and authority. Allow authorized human or peer participation without requiring a new model turn for every message.

### F17. Preserving content is not permission to forward it everywhere

- **Feature or situation:** The session switches Providers while holding encrypted reasoning from the old one. An MCP result also includes UI-only data. A generic adapter forwards both to every model and Interface because “nothing is lost in passing”.
- **Described as:** Opaque reasoning and other content parts; context selection; plain-display fallback; Provider and Interface adaptation.
- **Verdict:** **strains**. The representation can preserve source data. The guarantee does not distinguish storage from delivery to a particular recipient. It must not demand disclosure to the wrong audience, nor claim that another Provider can use an unreadable reasoning value. AG-UI has explicit enforcement and downgrade rules, not universal passthrough.
- **Assumptions:** A8, A24, A26, A30.
- **Evidence:** `docs/contracts.md:13–25`; `docs/architecture.md:267`; scenario 10 at `docs/scenarios.md:135–143`. [AG-UI processing](https://docs.ag-ui.com/spec/1.0/basic/processing) removes unknown material after translation; [AG-UI tool content](https://docs.ag-ui.com/spec/1.0/events/tool-calls#result-content) permits documented lossy treatment. [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning) treats encrypted reasoning as material to replay to the Provider.
- **Suggested change:** Separate preserving the source record from selecting a recipient's view. Describe audience, origin and compatibility restrictions on content. Require explicit refusal, translation or reported omission when a recipient cannot safely use a part. Do not make every Runtime understand vendor formats.

### F18. Live output and the record of delivered output are different things

- **Feature or situation:** A voice client hears only half an answer. A web client reconnects after the Provider fails before a complete response. An audit must establish what was exposed, not what the model eventually finished generating.
- **Described as:** Live model-output events; telemetry; plugin history entries; `follow a session` from a history point.
- **Verdict:** **strains**. The plugin API permits observing events and recording plugin state, so a retention plugin is possible. But the standard history and replay contract does not promise to recover live-only output, and it has no delivery acknowledgement. A25's absolute “never kept” would forbid useful auditing; the narrower rule “not in normal history by default” can survive.
- **Assumptions:** A25, A30.
- **Evidence:** `docs/contracts.md:132` excludes partial output from history; `docs/contracts.md:180` resumes following from history. `docs/architecture.md:161`, `171` permits plugin records and events. [OpenAI interruption handling](https://developers.openai.com/api/docs/guides/realtime-conversations) explicitly distinguishes generated audio from played audio.
- **Suggested change:** State the default retention and replay promises separately from optional recording. Distinguish generated, released and acknowledged output. Permit a policy-controlled delivery record without requiring permanent storage of every chunk or secret.

## Red team

Each entry gives the strongest counterexample I found and then tests whether it really defeats the assumption. “Breaks” here maps to “broken” in the final table.

### A1

- **Counterexample:** Without a Runtime, an administrator uses the Harness to inspect session identities and installed plugins. That looks useful.
- **Verdict:** **fits**.
- **Why:** Inspecting internals is not the agent product doing work. The docs already allow inert hosting and session responsibilities. The maximal product still consists of a Harness and plugins. No extra architectural layer is forced by this example.

### A2

- **Counterexample:** Tenant policy, spending controls and erasure seem to demand new built-in services.
- **Verdict:** **fits**.
- **Why:** Policy can remain a plugin, with enforcement obligations expressed through the API and session ownership. Deletion changes the history contract, not necessarily the Harness's three responsibilities. Missing API items do not prove a fourth Harness job is needed.

### A3

- **Counterexample:** A hot-loading plugin, an output guardrail and a sandbox-aware skills plugin must reach controls the listed API does not expose.
- **Verdict:** **gap**.
- **Why:** F11, F13 and F14 show missing operations. These features can still be plugins after the API is expanded. There is no evidence that privileged implementation access is inherently required. “Every feature can be a plugin” remains plausible; “using this API as listed” is incomplete.

### A4

- **Counterexample:** An ACP or AG-UI plugin both accepts users and runs editor or browser tools. An MCP plugin also contributes UI behaviour.
- **Verdict:** **fits**.
- **Why:** The architecture explicitly permits a plugin to provide capabilities and add behaviour. Several roles in one plugin do not defeat the classification. Role boundaries still need the contracts in F5 and F6.

### A5

- **Counterexample:** A remote environment must serve shell tools, prompt construction, skills and file readers consistently.
- **Verdict:** **strains**.
- **Why:** F13 needs a shared environment contract. It could be another capability or an explicit service within an existing role. Six is not established as sufficient, but a seventh capability is not logically forced. The current list describes remote shell alone adequately.

### A6

- **Counterexample:** Voice, editor work and A2A tasks overlap in one session; tenants require separate storage and credentials.
- **Verdict:** **fits**.
- **Why:** One Runtime can coordinate multiple activities; one logical store can separate tenants and use several physical stores. Nothing requires one process or one database. F3 identifies missing work scopes, not a demonstrated need for several Runtime owners.

### A7

- **Counterexample:** A support worker accepts a frontend result, loads a plugin, cancels a background job and deletes a customer's retained data.
- **Verdict:** **gap**.
- **Why:** The listed API cannot describe all those actions. A command can name an operation but cannot create its missing cross-part meaning. F3, F5, F12, F14 and F16 identify concrete omissions.

### A8

- **Counterexample:** One Provider streams bidirectional audio, another only text; one tool runs in a browser; one Interface closes runs on interrupts.
- **Verdict:** **strains**.
- **Why:** The Runtime can remain ignorant of vendor names, but not of behavioural differences such as live input, external execution and resume support. Adapters can hide wire differences; they cannot invent missing semantics. F4–F6, F9 and F17 require standard descriptions of those differences.

### A9

- **Counterexample:** A UI starts a tool while no turn exists; a scheduled report spans three turns; an A2A task waits while another task uses the same session.
- **Verdict:** **gap**.
- **Why:** F3 and F5 cannot place all work under a model step. Keeping sessions under the Harness still works. The strict three-level work tree needs independent work and causal links, not fake turns or fake steps.

### A10

- **Counterexample:** A durable turn waits three days for approval and resumes, while its AG-UI run ended on day one.
- **Verdict:** **breaks**.
- **Why:** “Ends when it needs outside input” conflicts with the architecture's own waiting-turn requirement. Calling a pending action completed or failed also misstates its condition. F4 needs a precise distinction between the internal turn and each protocol's lifecycle.

### A11

- **Counterexample:** A durable, realtime Runtime must request model operations, save progress and resume external work, not just request tools and hooks.
- **Verdict:** **fits**, when read as the Runtime-to-Harness interaction described in Contracts.
- **Why:** Model access is already a separate Provider interaction. A durable Runtime may own its progress; other work can be performed through declared hooks and tools. F7 and F9 need fuller contracts, but do not prove a third Runtime-to-Harness request is mandatory. Read literally across all dependencies, A11 already overlooks the ordinary model request.

### A12

- **Counterexample:** A model asks a router to use a different model for one expensive step, and a durable engine keeps checkpoints.
- **Verdict:** **fits**.
- **Why:** A model-selection plugin can make the choice; changing mid-turn remains an open capability. Runtime progress is not session history. The Runtime need not hold credentials, execute tool code or own the history. No counterexample here requires violating the separation.

### A13

- **Counterexample:** An app calls a tool without a Runtime; an output filter must veto a chunk; a tenant gate must reject a summarizer's paid request.
- **Verdict:** **gap**.
- **Why:** The listed hooks cover neither all operation owners nor all necessary decisions. F2, F5 and F11 are concrete cases. A common minimum set remains useful; making every Runtime offer it does not make it sufficient.

### A14

- **Counterexample:** A Provider request hook inserts text after before-step processing. In realtime use, new audio and playback truncation alter model context during an exchange.
- **Verdict:** **breaks**.
- **Why:** The first case is already allowed by `docs/contracts.md:253`; the second is required by F9. Context selection can stay a plugin responsibility, but cannot be described as complete and final at only one hook.

### A15

- **Counterexample:** Retrying a request repeats hosted web search with private query text. A batch submission also creates a persistent external job.
- **Verdict:** **breaks**.
- **Why:** F8 defeats “no outside effect”, even without a destructive tool. One request plus tools is still a useful ordinary step. It is not a sufficient model of all Provider work, nor a basis for unconditional retry safety.

### A16

- **Counterexample:** Realtime Provider sessions retain conversation items; hosted search executes remotely during generation.
- **Verdict:** **breaks**.
- **Why:** F8 and F9 are documented Provider behaviours. The stronger no-state/no-tools claim is in the assumption list, not explicit in the Provider paragraph. Correct the assumption and state who owns that external state and those operations.

### A17

- **Counterexample:** A hosted model invokes web search internally without a Harness tool-call request.
- **Verdict:** **breaks** the universal form.
- **Why:** F8 cannot route the server's internal action through the Harness after the fact. Ordinary tools, including UI-started tools, can and should share Harness checks. The docs already leave direct access open; the required decision is the scope of the guarantee.

### A18

- **Counterexample:** A payment call ends as outcome unknown after a crash; a later receipt proves it succeeded. MRTR needs several protocol replies, and frontend calls stay unanswered between runs.
- **Verdict:** **strains**.
- **Why:** One logical final result can survive. MRTR interim responses are not final tool results. Later evidence can be a reconciliation record instead of a second final result. F5 and F7 need to define the pending state, logical lifetime and later evidence. No seventh final status is proved necessary.

### A19

- **Counterexample:** Another agent discovers an Agent Card, sends push configuration, and a human support worker takes over behind the same endpoint.
- **Verdict:** **fits**.
- **Why:** Interfaces can serve discovery and accept outside actors; they need not be human chat screens. One agent identity can conceal internal delegation and handoff. F15 and F16 concern missing behaviour, not a forced bypass of Interfaces.

### A20

- **Counterexample:** A contractor and manager share a session, while an auditor can read only selected records and an administrator sets policy.
- **Verdict:** **breaks**.
- **Why:** There is no single “the user” whose identity and authority can stand for all four. F1 requires actors and audiences, not another Interface name.

### A21

- **Counterexample:** A session owner sets “always allow”, despite a tenant ban. An intern answers a manager-only approval after the manager's authority was revoked.
- **Verdict:** **gap**.
- **Why:** Fail-closed is worth keeping, but explicit assent is not sufficient authorization. Per-session settings cannot alone define administrator, tenant and actor restrictions. F1 and F2 need policy scope, precedence and checks at execution time.

### A22

- **Counterexample:** A late answer to a durable approval should resume its exact pending payment, not become a fresh request that may create another payment.
- **Verdict:** **strains**.
- **Why:** New input can carry a reference to pending work, so it is not inherently wrong. The docs must say whether it resumes that work or requests new work. The ordinary late-question scenario fits; treating every late approval the same way does not. See F4.

### A23

- **Counterexample:** Required erasure covers raw messages and summaries in an old session and its fork.
- **Verdict:** **breaks**.
- **Why:** F12 is an explicit product requirement incompatible with never deleting recorded content. Adding a tombstone or changing the model view does not meet it.

### A24

- **Counterexample:** The realtime Provider retains unheard speech; after a Provider switch, encrypted reasoning cannot be interpreted by the new model.
- **Verdict:** **strains**.
- **Why:** History views remain useful if history records relevant context changes and Providers expose what their retained state means. The current before-step view alone is insufficient. Source preservation and recipient-specific views must be distinguished, as F9 and F17 explain.

### A25

- **Counterexample:** A failed speech response has no complete message, but the user already heard a safety instruction that must be audited.
- **Verdict:** **strains**.
- **Why:** F18 requires a retained delivery record. The literal “never kept” is too strong, but the architecture already permits telemetry and plugin records. Make live-only the default history policy, not a prohibition on authorized recording.

### A26

- **Counterexample:** A future content type crosses an AG-UI enforcement boundary; an unreadable Provider reasoning item crosses into another vendor; app-only data would leak through indiscriminate forwarding.
- **Verdict:** **strains**.
- **Why:** Typed lists and opaque preservation work inside the system. They do not promise useful or authorized delivery to every recipient. F17 needs a scope for preservation, declared omissions and recipient views. AG-UI's sanctioned extension containers allow preservation without inventing unknown protocol fields.

### A27

- **Counterexample:** A remote agent returns a task ID, then needs authentication, sends several artifacts, accepts a follow-up and can be cancelled independently.
- **Verdict:** **gap**.
- **Why:** Interface and tool source remain correct directions. A one-shot tool result can contain a task ID but does not define the later operations. F3 and F16 need task and participation contracts. New top-level agent parts are not proved necessary.

### A28

- **Counterexample:** A child's approval needs a tenant specialist; its parent has handed control to a human and lost permission to spend. The child still has work pending.
- **Verdict:** **strains**.
- **Why:** Parentage need not change, and permissions-only-narrow is sound. But inherited scope, later revocation, routing and control ownership are different matters. F1 and F16 need to separate them. A parent process stopping is not enough to break routing through a durable parent session.

### A29

- **Counterexample:** A service executes a side effect but its reply is lost; two history writers temporarily believe they own the session after a partition.
- **Verdict:** **gap**.
- **Why:** Nothing forces shared memory or function passing. The missing piece is common failure and recovery meaning across deployments. F7 shows why “asks and answers” plus a single-writer promise does not yet describe that meaning. No particular RPC protocol is required to fix it.

### A30

- **Counterexample:** Credential retrieval and raw model output must be inspectable, but the ordinary telemetry operator is not allowed to see either secret values or personal data.
- **Verdict:** **strains**.
- **Why:** An interaction can be observed without making its whole payload public. Encrypted reasoning can be recorded opaquely. F11, F17 and F18 need to separate privileged observation, redacted records and retention. “Observable” must not mean “every plugin can read everything forever”.

### A31

- **Counterexample:** The Runtime survives, but its approval plugin, MCP continuation holder and sandbox do not. A previously executed payment has no locally recorded reply.
- **Verdict:** **gap**.
- **Why:** The common description is a good goal. It lacks the supporting operation and resource promises needed to meet it. F4, F7, F13 and F14 show that adding a durable Runtime alone cannot make an arbitrary plugin set durable.

### A32

- **Counterexample:** A2A push requires a credential, and a tool needs the user's OAuth sign-in during a suspended turn. Someone proposes passing the token as a model-visible answer.
- **Verdict:** **fits**.
- **Why:** That proposal is unnecessary. Credential owners can receive the secret directly and tell the Runtime only whether the operation can proceed. F1 and F15 need scoped access and safe routing, but neither requires exposing a credential to the Runtime. This boundary should stay.

## Assumptions

| Assumption | Verdict | Reason |
|---|---|---|
| A1 | holds | The maximal product still fits Harness plus plugins. |
| A2 | holds | New contracts need not add a fourth Harness responsibility. |
| A3 | gap | Several proposed plugins need operations absent from the listed API. |
| A4 | holds | Multiple roles and added behaviour are already allowed in one plugin. |
| A5 | strained | A shared environment needs a contract, but not necessarily a seventh capability. |
| A6 | holds | One logical Runtime and stores can coordinate or separate many activities and tenants. |
| A7 | gap | Work control, external results, activation and erasure are incomplete. |
| A8 | strained | Vendor names can be hidden; meaningful behavioural differences cannot. |
| A9 | gap | UI calls and persistent work do not all nest under model steps. |
| A10 | broken | Waiting turns contradict the unconditional end-on-outside-input rule. |
| A11 | holds | The two Runtime-to-Harness requests can remain; Provider access is separate. |
| A12 | holds | Model choice, credentials, tool execution and history need not move into Runtime. |
| A13 | gap | Current hooks omit output gates and operations with no Runtime. |
| A14 | broken | Provider rewrites and live model input occur beyond before-step context selection. |
| A15 | broken | A model request can disclose data and execute outside work. |
| A16 | broken | Stateful realtime sessions and Provider-hosted tools are real counterexamples. |
| A17 | broken | Provider-native actions do not individually pass through the Harness. |
| A18 | strained | One final result works if pending calls and later reconciliation are distinguished. |
| A19 | holds | Discovery, users, agents and human support can all enter through Interfaces. |
| A20 | broken | One user cannot stand for several actors with different authority. |
| A21 | gap | Fail-closed remains valid; session policy alone is not sufficient authorization. |
| A22 | strained | Late input must distinguish resuming pending work from creating new work. |
| A23 | broken | Required erasure cannot coexist with a blanket ban on deletion. |
| A24 | strained | History views need to account for live input and Provider-held context. |
| A25 | strained | Live-only can be a default, not a ban on retained delivery evidence. |
| A26 | strained | Preserve source content without promising unsafe or unsupported forwarding. |
| A27 | gap | Remote tasks need continuation and control beyond one tool result. |
| A28 | strained | Parentage, authority, revocation and routing must be separate concepts. |
| A29 | gap | No shared-memory dependency is required, but lost replies lack common semantics. |
| A30 | strained | Observation needs access and retention rules, not universal plaintext exposure. |
| A31 | gap | Durable execution needs promises from tools, plugins and resources too. |
| A32 | holds | Even suspended authentication and push delivery can keep secrets out of Runtime. |

## Top changes

1. **Define actors and authority.** Add users, tenants, audiences and delegated authority. State policy precedence, approval validity and tenant-wide spending rules. Keep credentials out of the Runtime.
2. **Separate conversation from ongoing work.** Describe tasks, background activity, pending actions and handoff. Give each clear ownership, states, cancellation and resume rules. Do not equate protocol runs, accepted prompts and internal turns.
3. **Describe every action path.** Cover model-, UI- and plugin-started tools; frontend results; MCP App resources; and Provider-executed operations. State which checks apply and where an adapter cannot enforce them.
4. **Broaden model access beyond request-and-response.** Cover live bidirectional exchanges, Provider-held state and asynchronous batches. State retry effects, partial outcomes and the effective context actually used.
5. **Make durability a contract across participating parts.** Define pending work, safe recovery, uncertain effects, resource loss and later reconciliation. Do not promise ordinary continuation when a remote effect cannot be established safely.
6. **Define disclosure and retention boundaries.** Add pre-disclosure guardrails, permitted observation, recipient views and optional delivery records. Make lawful deletion an explicit exception to ordinary append-only history.
7. **Finish plugin and environment lifecycle contracts.** Define activation, dependencies, changes during work and one shared working environment. Say what survives suspension and what a changed plugin or environment invalidates.

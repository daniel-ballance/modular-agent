# Rung 1: Pi and pi-packages

## Sources read (versions, commits)

This is a source review, not a live integration test. No agents, model requests, desktop actions or package tests were started.

- Modular Agent: `39705881487117f8a72bbffcd6ac51394b5aab87`. Read `README.md`, `docs/architecture.md`, `docs/contracts.md`, `docs/scenarios.md`, `GLOSSARY.md`, `docs/open-questions.md` and `docs/pressure-test/README.md`, in that order.
- Pi documentation and examples: **1.5.2**, installed at `/home/danballance/.local/share/mise/installs/pi/1.5.2/pi`. Below, **P** means this directory. Read `docs/how-pi-works.md`, `sessions.md`, `session-format.md`, `rpc.md`, `rpc-extension-ui.md`, `sdk.md`, `skills.md`, `slash-commands.md` and `custom-provider.md`. Read relevant sections of `extensions.md`, `compaction.md`, `mcp.md`, `providers.md` and `rpc-commands.md`. Examples read: `extensions/reload-runtime.ts`, `extensions/event-bus.ts`, `extensions/dynamic-tools.ts` and `sdk/12-full-control.ts`.
- pi-packages: `8b0bd664e7de32cfaccc1196753f7b7451d12302`, at `/home/danballance/Code/pi-packages`. Below, **X** means this directory. Its pre-existing change to `global/settings.json` was not used or changed. Read the root and component READMEs, subagents' `PEER-MESSAGING.md`, `WORKFLOWS.md` and operating skills, plus the implementation excerpts cited below.
- Package versions: subagents **0.3.0**; p3stack, todo, claude-subscription, mcp-client, self-reload, computer-use and web-search **0.1.0**. These versions alone do not identify the source; use the commit above.
- Installed code under `X/node_modules/@earendil-works/`: `pi-agent-core` and `pi-coding-agent`, both **1.5.2**. Read the agent-core README's loop and queue contracts, and relevant compiled sections of `pi-agent-core/dist/agent-loop.js` and `pi-coding-agent/dist/core/agent-session.js`. The installed Claude Agent SDK is **0.3.323**. Its internals were not independently audited.
- Read `X/docs/t3-code-subagents-integration.md`. It is explicitly **retired**, based on older Pi and T3 revisions. It is historical evidence about ownership conflicts, not proof of a current integration bug. The current subagents README says native subagents stay inactive under T3.

Paths beginning `docs/` below refer to Modular Agent. P and X references identify local documentation pages or source files, not fetched web pages.

The map is about responsibilities, not matching entire Pi classes to parts. Pi's `turn` normally maps to our **step**. Its whole user-facing run is closer to our **turn**. Pi's `AgentSession` contains several of our responsibilities. Calling that whole class a Runtime would manufacture failures of A12 and A32. Conversely, calling every missing operation “plugin behaviour” does not supply its missing contract.

## Feature map

| Feature | Described as | Verdict | Assumptions |
|---|---|---|---|
| Ordinary model/tool loop | Runtime, Provider model access, tool source, history entries and standard hooks | fits | A1–A4, A8, A11, A12 |
| File, shell and web-search tools | Tool sources; cancellation, progress, one result and presentation hints | fits | A5, A17, A18 |
| Tool calls made by codemode or another tool | Plugin API tool invocation; parent tool-call identity; the same gates | fits | A7, A17, A18 |
| Parallel tools and ordered model results | Runtime scheduling plus per-tool parallelism hint | fits | A9, A18 |
| Skills, templates and context files | Feature plugins; commands, input changes and system-prompt contributions | fits | A3, A4, A7 |
| Model and thinking changes between turns | Model-selection plugin; session settings and history | fits | A12, A24, A32 |
| API keys, OAuth and external Claude login | Credential-store access backed by local or external credential owners | fits | A5, A6, A32 |
| TUI, print, JSON, RPC and embedded SDK | Different Interfaces over the same session and Runtime responsibilities | fits | A19, A29 |
| Standard dialogs and no-UI `ask_user` fallback | Choice/text input request; declined or unavailable answer; tool returns the stated default | fits | A19, A21 |
| p3stack mode and grant text | Branch-local plugin state, command and before-turn prompt contribution; not an enforcement gate | fits, subject to F4 and F11 | A7, A21, A24 |
| p3stack role resolution | Settings plus a policy-filtered catalog; nested catalog tool invocation can replace the local callback exchange | fits | A4, A7, A12, A29 |
| Normal compaction and context edits | Context-management plugin; append summary or edit entries; rebuild the model view | fits | A14, A23, A24 |
| Streamed text and tool progress | Live events; final responses and results are separate history entries | fits | A18, A25, A30 |
| Text, screenshots and structured tool values | Typed content plus optional structured result | fits for inspected examples; unknown-type round trips not tested | A26 |
| Claude subscription's persistent native conversation | Stateful Provider adapter, not merely a stateless model endpoint | breaks — F1 | A14–A17, A24 |
| Abort while the Provider is streaming | Turn cancellation needs a Provider cancellation interaction | gap — F2 | A7, A29 |
| `self_reload` and continuation after replacement | Hosting operation, cleanup, completion and a later input | gap — F3 | A3, A7, A13, A29 |
| mcp-client replacing built-in `/mcp` | Replacement of a group of commands, connections and tool registrations | gap — F4a | A6, A7 |
| `/tree`, `/fork`, `/clone`, todo and mode restoration | Session tree, active position and branch-relative plugin state | gap — F4 | A7, A9, A13, A24 |
| Ephemeral sessions and deleting saved sessions | History retention policy, not an immortal append-only record | breaks — F5 | A23 |
| Steering, follow-up and returning queued text to the editor | Input admission and queue control, separate from turn cancellation | gap — F6 | A7, A10, A29 |
| Retry, compaction recovery and final todo reminder | Distinguish an attempt ending from all automatic work settling | gap — F7 | A10, A13 |
| Persistent children and later assignments | Child sessions plus session-owned work and result receipt state | strains — F8 | A9, A27, A28 |
| Workflow validation, repair and improvement | Feature plugin owning tasks, checks, attempts, artifacts and limits | strains — F8 | A6, A9, A27, A29 |
| Human holds and explicit workflow recovery | Persistent control state distinct from cancellation and permission approval | strains — F8 | A21, A28, A29 |
| Peer links, message allowances and delivery receipts | Tool invocation into another agent's Interface, with attributed input | gap — F9 | A7, A21, A27–A29 |
| Project trust before loading project resources | Hosting admission gate, before session plugins run | gap — F10 | A3, A7, A13, A21 |
| Narrow child execution with broader delegation rights | Separate permission to use a tool from permission to commission its use | strains — F11 | A21, A28 |
| Remote computer-use over SSH | Tool-source-owned remote environment and connection lifetime | strains — F12 | A5, A7, A29 |
| Deferred, hidden and model-only tools | Distinct registered, declared and callable sets, refreshed for later requests | gap — F13 | A7, A14 |
| Stock footer decoration and custom inspectors | Interface-specific presentation and commands; cooperation between plugins | strains — F14 | A3, A7, A29 |
| Late answers surviving process loss; durable turns | No durable Runtime exercised; Pi dialogs alone do not establish these guarantees | not tested | A22, A31 |

## Findings

### F1. A Provider can own a second conversation

- **Feature or situation:** claude-subscription keeps a Claude Agent SDK process between Pi requests. It can also keep Claude's conversation on disk across Pi restarts.
- **Described as:** A Provider supplies the catalog and model access. Its adapter presents Pi tools to Claude and returns tool requests to the Runtime. Ordinary tool execution still goes through Pi.
- **Verdict:** **breaks** A16 and the claim that the before-step view completely determines effective model context. It **strains** A15's blanket replay claim.
- **Assumptions:** A14, A15, A16, A17, A24.
- **Evidence:** `X/packages/claude-subscription/README.md`, “Keeping sessions across restarts”, “Compared with the anthropic provider” and “How it works”. The comparison explicitly says an interrupted answer remains in Claude's context; SDK instructions are added; compaction, branching and provider changes can force a text replay without old thinking. `X/packages/claude-subscription/extensions/claude-subscription/src/session.ts:61–136,204–218,304–389` tracks native conversation state, outstanding tool results and interruption. `src/tools.ts:67–71,175–185` says the bridge does not execute Pi tools, but unknown or removed tool names are refused inside Claude and are not passed to Pi. Compare `docs/architecture.md`, “Provider” and “Surviving interruptions”, and `docs/contracts.md`, “Model request and response”. A16's explicit ban on conversation state is stronger than the architecture's Provider paragraph.
- **Suggested change:** Allow a Provider to retain conversation state. State which history is authoritative, when that state must be discarded, what context the Provider adds or cannot reproduce, and what retry means after uncertain acceptance. Define the boundary of model-visible tool requests, including refusals inside a Provider. Do not infer stateless replay safety from the word “model”.

This is not evidence that ordinary Provider requests secretly execute shell or file tools. The source disables Claude's built-in tools. Optional `claude_code` and web tools are separate tool sources and are not on the model-request path. A15 is strained by stateful acceptance and continuation, not by an invented hidden shell call.

### F2. Turn cancellation does not reach the Provider in the contract

- **Feature or situation:** Escape or RPC abort interrupts an answer while no tool is running.
- **Described as:** Interface cancels the turn; Harness asks the Runtime to cancel. The Runtime is waiting on model access.
- **Verdict:** **gap**.
- **Assumptions:** A7, A29.
- **Evidence:** `docs/contracts.md`, “Runtime and Provider”, lists only making a request. Unlike “Harness and tool source”, it provides no cancellation input. `docs/scenarios.md`, scenario 5, covers cancelling a shell call, not a model stream. P `docs/custom-provider.md`, “Implement custom streaming”, requires an abort signal and an aborted result. `X/packages/claude-subscription/extensions/claude-subscription/src/session.ts:252–258,371–389` distinguishes interrupting accepted input from cancelling before delivery and may retain the process.
- **Suggested change:** State how model access accepts cancellation, when the Runtime may declare the request finished, and whether Provider conversation state remains usable. Distinguish “stop waiting” from confirmed remote cessation. This is required behaviour, not a choice of transport.

### F3. Reload has no supported handover between plugin instances

- **Feature or situation:** self-reload ends the current run, replaces extensions and resources, then starts a continuation from the replacement instance.
- **Described as:** A tool and command request a hosting operation. The old plugins stop. The new plugins start. Completion becomes session input.
- **Verdict:** **gap**.
- **Assumptions:** A3, A7, A13, A29.
- **Evidence:** `docs/architecture.md`, “The Harness” and “What plugins can do”, provide starting and stopping plugins but no reload request or completion contract. `docs/contracts.md`, “Lifecycles”, has no plugin lifecycle. `X/packages/self-reload/README.md`, “How it works” and “Limits and recovery”, separates queued, reloaded and verified states. Its `extensions/self-reload/index.ts:9–20,31–65,93–111` uses a process-level event because the old plugin API is stale. P `docs/extensions.md`, “ctx.reload()”, explicitly warns that the old context is invalid and that tools cannot directly reload a running agent.
- **Suggested change:** Add a plugin replacement lifecycle. State who may request it, when work must stop, which session state survives, how completion or failure reaches the replacement instance, and what happens when the replacement never loads. Preserve the distinction between a reload request, successful replacement and verified behaviour. Do not require the process-local bridge used by this implementation.

### F4a. Many tool sources do not explain deliberate replacement

- **Feature or situation:** Optional mcp-client replaces Pi's built-in MCP feature rather than adding a second MCP connection owner.
- **Described as:** Two plugins each supply commands and tool sources. The session selects one owner for the overlapping feature.
- **Verdict:** **gap**.
- **Assumptions:** A6, A7.
- **Evidence:** P `docs/mcp.md`, “Replace the built-in MCP support”, says registering `/mcp` suppresses built-in session configuration reading and server connections. P `docs/sdk.md`, “Inline extension”, describes replaceable built-ins. `X/packages/mcp-client/README.md`, “Native Pi alignment and migration safety”, also explains why unloading a replacement can change configuration meaning. `docs/open-questions.md`, “How many of each capability”, acknowledges clashes but does not decide their outcome. The tool-name uniqueness rule in `docs/contracts.md` does not cover commands or ownership of connections.
- **Suggested change:** Define deliberate replacement separately from an accidental duplicate. State which contributions are replaced together, which plugin owns existing resources, and what becomes active when a replacement is removed. No seventh capability is required.

### F4. Forking a session cannot stand in for moving within its tree

- **Feature or situation:** `/tree` changes the active branch without changing session identity. Todo and p3stack mode rebuild their state from that branch. `/fork` and `/clone` instead create another session.
- **Described as:** Harness owns a session tree and current position. History stores immutable entries. Feature plugins read the selected branch and observe navigation.
- **Verdict:** **gap**, not a failure of append-only history.
- **Assumptions:** A7, A9, A13, A24.
- **Evidence:** P `docs/sessions.md`, “Choose how to branch”; P `docs/session-format.md`, “Entry Base”, “ContextEditEntry”, “Tree Structure” and “Context Building”. `X/packages/p3stack/todo/extensions/todo/index.ts:109–123` restores the last snapshot on `getBranch()` after `session_tree`. `X/packages/p3stack/extensions/p3stack/src/mode.ts:59–73` does the same for mode and grant. `docs/contracts.md`, “Session” and “History entry”, has neither entry ancestry nor current position. Its Interface interactions offer forks but no navigation. “Branching history” remains open.
- **Suggested change:** Define entry ancestry, active position, branch-relative settings and plugin state, and the difference between navigation and a new session. Add navigation outcomes and hooks. State which external resources are reset rather than rewound. Desktop actions and child work must not be undone merely because their history branch changed.

### F5. History retention is an unqualified promise that Pi does not make

- **Feature or situation:** Pi supports `--no-session`, an in-memory SDK manager, and explicit deletion of saved sessions.
- **Described as:** A history-store plugin implements the selected retention policy.
- **Verdict:** **breaks** the unconditional promises that nothing recorded is deleted and every session outlives a process.
- **Assumptions:** A23. This also limits the interruption promises used when discussing A31; it does not test a durable Runtime.
- **Evidence:** P `docs/sessions.md`, “Control session storage”; P `docs/session-format.md`, “Deleting Sessions”; P `docs/sdk.md`, “Session storage”; P `examples/sdk/12-full-control.ts`. Compare `docs/architecture.md`, “History store”, “Surviving interruptions” and guarantee 3.
- **Suggested change:** Separate append-only editing semantics from retention and persistence. State whether ephemeral sessions and explicit deletion are supported exceptions. If they are excluded, narrow the claim that all vanilla Pi behaviour fits. Compaction and todo updates are not evidence for deletion: both can remain append-only.

### F6. Accepted input is not necessarily conversation history

- **Feature or situation:** Steering and follow-up messages can be queued, handled by an extension, removed before use, or returned to the editor on Escape.
- **Described as:** Interface gives input with a timing choice. Harness records admission; Runtime consumes it at an allowed boundary.
- **Verdict:** **gap**.
- **Assumptions:** A7, A10, A29.
- **Evidence:** P `docs/rpc-commands.md`, “prompt”, “steer”, “follow_up”, “abort” and “clear_queue”, distinguishes started, queued and handled. It says the client must clear the queues before abort to reproduce Escape; abort alone can continue queued work. `X/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:2046–2086` separates clearing queues from aborting. `docs/contracts.md`, “Interface and Harness”, gives only accepted-with-history-entry or refused. Scenario 5 leaves queued input unresolved.
- **Suggested change:** Distinguish input admission, queueing, command handling and entry into model context. Add inspection and withdrawal of pending input, including ownership of returned content. Define cancellation's effect on both queues. A recorded admission must not itself mean the model saw that input.

### F7. “Turn ended” is not enough to mean “nothing will continue”

- **Feature or situation:** Pi may retry or compact after a low-level run ends. Todo may request one final bookkeeping response. Child notices and reload need a later point at which no automatic work remains.
- **Described as:** Runtime owns a user-facing turn across attempts and recovery. Plugins can ask for continuation before final settlement. Interfaces receive final settlement separately from intermediate outcomes.
- **Verdict:** **gap** in the hooks and their ordering; the turn definition also **strains** when a dialog waits for outside input without ending it.
- **Assumptions:** A10, A13.
- **Evidence:** P `docs/extensions.md`, “agent_start / agent_end / agent_before_settle / agent_settled” and “turn_start / turn_end”; P `docs/compaction.md`, “Overflow and Length Recovery Ordering”. `X/packages/p3stack/todo/extensions/todo/index.ts:149–180` uses tool results for a step reminder and `agent_before_settle` for the final reminder. `docs/contracts.md`, “Hook points”, supplies only the model response after a step and makes turn end observe-only. Its turn lifecycle waits for the user, while `docs/architecture.md`, “Units of work”, says needing outside input ends a turn. Scenario 1 also places “after the step” before its tool execution, despite the step definition including tool calls.
- **Suggested change:** Define the end of a step as after its tools finish. Distinguish an attempt ending, a proposed end that plugins can extend, and final settlement. Specify what each boundary knows about tool results, queued input, cancellation and recovery. Say that waiting for an answer can suspend a turn rather than necessarily end it.

### F8. Persistent collaborators and workflows outlive the call that starts them

- **Feature or situation:** A child remains alive after an assignment. A workflow can run while the parent is idle, validate artifacts, repair candidates, pause on a human check and require explicit recovery after reload.
- **Described as:** Subagents and workflow feature plugins expose tools and commands, create child sessions, keep state and send completion input. Workflow tasks and attempts are plugin state, not model steps. There is still only one model Runtime per child session.
- **Verdict:** **strains**. The basic parts fit. The ownership and lifetime promises are too thin to describe these features without adding unstated rules.
- **Assumptions:** A6, A9, A21, A27, A28, A29.
- **Evidence:** `X/packages/p3stack/subagents/README.md`, “Tools”, “Reports and UI”, “Bounded nesting” and “Persistence, reload, and migration”; its operating skill distinguishes process, assignment and result-review state. `WORKFLOWS.md`, “Getting started”, “Check”, “Loop” and “Monitoring, failure and recovery”, states that cancelling the start tool does not cancel an accepted run; holds survive reload; release does not resume work; attempts and deadlines do not reset. `docs/architecture.md`, “Units of work” and “Working with other agents”, plus scenario 8, give only the session/turn/step hierarchy and a later result. `docs/open-questions.md`, “Work outside a turn”, recognizes but does not settle the issue.
- **Suggested change:** State that plugins may own session-level work independent of an active turn. Define what starts, stops or survives parent cancellation, session close, reload and process loss. Separate accepted work, finished execution, validated output and result receipt. Preserve human holds independently of cancellation. Keep workflow graph rules inside the workflow plugin; do not turn its scheduler into a second model Runtime.

The same scope issue affects usage. P `docs/session-format.md`, “UsageEntry” and “CompactionEntry”, records cache warming and summarization outside ordinary assistant steps. `docs/contracts.md`, “Usage”, should allow session-level usage and separately attributed child usage, without counting the same cost twice.

### F9. Peer input needs origin and delivery guarantees

- **Feature or situation:** One child sends another a message. The parent grants a bounded link. A timeout may leave delivery uncertain. A peer must not impersonate the user or trigger a slash command.
- **Described as:** A child's tool sends input through the recipient's Interface. The coordinating plugin tracks links, allowances and receipts. This does not inherently need a new capability.
- **Verdict:** **gap** in shared input semantics, not in the choice of tools and Interfaces.
- **Assumptions:** A7, A21, A27, A28, A29.
- **Evidence:** `X/packages/p3stack/subagents/PEER-MESSAGING.md`, “Transport and delivery” and “Accounting and recovery”, binds sender identity to the caller, labels messages as untrusted work, prevents command dispatch, and distinguishes accepted, received, handled, unknown and interrupted. Unknown acceptance consumes allowance and is not replayed. `README.md`, “Reports and UI”, distinguishes reading a report from viewing status. `docs/contracts.md`, “Interface and Harness”, carries content and timing but no stated trusted origin or command-dispatch permission. “Input arrives” mentions origin without defining its guarantees. An input answer carries “who answered” but no rule for who may answer a human-only request.
- **Suggested change:** Carry trustworthy origin and input purpose through Interfaces and history. Distinguish user commands, plugin notices, peer work and human answers. Specify admission versus conversation receipt and how unknown delivery is reported. Do not let a model-produced identity or message body grant authority. Keep link limits and workflow approval policy in their plugins.

### F10. Project trust must happen before project plugins can participate

- **Feature or situation:** A trusted global extension can decide project trust. Project extensions and project policy must not run before that decision.
- **Described as:** A hosting admission gate uses a trusted feature plugin and an Interface. Other plugins query the resulting project trust decision before honoring local settings.
- **Verdict:** **gap**.
- **Assumptions:** A3, A7, A13, A21.
- **Evidence:** P `docs/extensions.md`, “project_trust”, restricts participation to already trusted user/global or explicit CLI extensions and supplies a limited context before project resources load. P `docs/how-pi-works.md`, “Trust and permissions”. `X/packages/p3stack/README.md`, “Resolve role models”, and `X/packages/p3stack/subagents/README.md`, “Allowlist”, ignore untrusted project policies. `docs/contracts.md`, “Hook points”, starts at session hooks and contains no pre-load gate. `docs/architecture.md`, “Its surroundings”, exposes project and directory but not trust state.
- **Suggested change:** Define a pre-load trust decision, who may participate, and what plugins may learn before admission. Make project trust available through the plugin API. Separate trusting executable plugin code from approving one model-requested tool call. A tool approval hook is too late to prevent untrusted extension startup.

### F11. “Permissions only narrow” does not identify which permissions

- **Feature or situation:** p3stack writes an autonomy grant into the prompt. Subagents separately enforce a tool/resource policy. Nested coordinators can commission work from the root manager's allowlist.
- **Described as:** Prompt guidance is plugin state. Enforced permission is a separate policy. Permission to delegate may differ from permission to execute a tool directly.
- **Verdict:** **strains**.
- **Assumptions:** A21, A28.
- **Evidence:** `X/packages/p3stack/extensions/p3stack/src/mode.ts:59–79` restores state and writes grant instructions; it does not install a tool gate. `X/packages/p3stack/subagents/README.md`, “Bounded nesting”, explicitly says grandchildren use the same root allowlist. `extensions/subagents/index.ts:182–214,365–389` checks descendant ownership and compiles a nested selection through root policy, rather than intersecting it with the coordinator's selected tools. Compare `docs/architecture.md`, “Working with other agents”, and scenario 8, which describe narrowing mostly through approval policy.
- **Suggested change:** Define execution rights, delegation rights, project trust and prompt guidance separately. Say which authority sets a child's ceiling and which limits must propagate. A coordinator with read tools and explicit authority to commission a writer is not necessarily an escalation; it cannot be assessed by comparing active tool names alone. Require human-only decisions to remain human-only through nesting.

### F12. One working directory is not one execution environment

- **Feature or situation:** Pi runs on Linux while computer-use controls a Mac over SSH. Local file tools, remote app paths, remote credentials, desktop state and connection consent have different owners.
- **Described as:** A tool source owns the remote connection and execution environment. The session still has its local project. Tool results carry screenshots and local result references.
- **Verdict:** **strains**. No seventh capability is proven necessary, but “reach files and processes” leaves important meanings unstated.
- **Assumptions:** A5, A7, A29.
- **Evidence:** `X/packages/computer-use/README.md`, “Remote mode”, “Use” and “Verification and limits”, distinguishes Mac paths from Linux paths. Reload, navigation and cancellation reset the connection, not the apps. A network partition cannot guarantee remote cleanup. Failed actions are not replayed. Other sessions can target the same Mac. Compare `docs/architecture.md`, “Its surroundings”, and scenario 5's categorical cancellation of the running shell call.
- **Suggested change:** Distinguish session project context from each tool source's execution target. State who owns credentials, paths, mutable state and cleanup for that target. Cancellation must not imply rollback or confirmed remote termination. The existing outcome-unknown status is useful here. A swappable environment capability remains a choice, not a prerequisite for describing this tool.

### F13. Available tools are not the same as declared tools

- **Feature or situation:** Tool search activates a tool for the next request. Codemode calls registered tools that are absent from the model's declarations. `ask_user` is model-only; hidden tools are unreachable.
- **Described as:** Tool sources publish definitions. A feature plugin selects what is declared and what other tools may call. The Runtime receives the current selection before the next request.
- **Verdict:** **gap**.
- **Assumptions:** A7, A14.
- **Evidence:** P `docs/extensions.md`, “Tool Exposure”, “Calling Other Tools” and the paragraph before “Tool Exposure”, distinguishes these sets and promises newly loaded tools on the immediately following request. P `docs/mcp.md`, “Control tool exposure”, says search activation is branch-local while codemode access does not depend on the active set. `X/packages/p3stack/extensions/p3stack/src/ask.ts:8–19` marks the question tool model-only. `docs/contracts.md`, “Tool definition” and “Turn input”, has one tools-available set. The before-step hook returns context but no explicit revised tool selection. Model access and reasoning are likewise supplied at turn start without defining when later setting changes take effect.
- **Suggested change:** Distinguish registered, declared, callable and forbidden tools. State who may change each set and when the next request sees it. Specify the effective boundary for model and thinking changes too; a setting-changed event is not proof that an in-flight request changed. Keep Runtime selection separate from the plugin that chooses it.

### F14. Interface-specific cooperation must not become an invisible escape hatch

- **Feature or situation:** Subagents adds counts to Pi's existing footer. p3stack supplies a custom footer and exchanges information with subagents. RPC clients cannot render all TUI components.
- **Described as:** Features publish status and commands; an Interface chooses a rich display or plain fallback. Plugins request information from each other through supported operations.
- **Verdict:** **strains** for exact existing UI behaviour. Ordinary status and command fallbacks fit.
- **Assumptions:** A3, A7, A29.
- **Evidence:** `X/packages/p3stack/subagents/extensions/subagents/src/footer.ts:34–59` explicitly calls its prototype modification an unofficial, process-wide compatibility hook. The subagents README, “Effective catalog and diagnostics”, describes callback-valued catalog and footer exchanges. `X/packages/p3stack/extensions/p3stack/src/roles.ts:115–120` uses such a synchronous reply. P `docs/rpc-extension-ui.md`, “Limitations”, lists unsupported TUI operations. `docs/architecture.md`, “The user”, permits presentation hints and fallback but does not say what Interface-specific cooperation may add.
- **Suggested change:** Make the scope explicit: either promise semantic status and controls with Interface-owned layout, or allow declared Interface-specific operations for richer composition. Information requests need answers, not callback values disguised as events. Existing tool invocation can cover the role catalog. The current local footer implementation is not proof that the architecture must require shared memory.

## Assumptions

“holds” means the inspected behaviour has a credible mapping, not that Pi's entire implementation already follows the proposed separation. “broken” identifies an actual conflicting claim. “not tested” is not a pass.

| ID | Status | Reason |
|---|---|---|
| A1 | holds | Pi's built-ins can be assigned to plugins; no additional always-present part was forced. |
| A2 | holds | Hosting, API access and session ownership remain a plausible Harness scope; missing rules can stay within those jobs. |
| A3 | gap | Reload and pre-load trust need API support; current local escape hatches are not supported operations (F3, F10, F14). |
| A4 | holds | Providers, tools and feature behaviour can coexist in one package without changing the classification. |
| A5 | strained | Remote environments need named responsibilities, though computer-use does not prove a seventh capability is necessary (F12). |
| A6 | gap | One Runtime per session fits children and workflows; replacement ownership for overlapping plugins is undefined (F4a). |
| A7 | gap | Reload, navigation, queue withdrawal, trusted input origin and tool exposure are missing or incomplete (F2–F6, F9–F13). |
| A8 | holds | Provider and tool adapters can hide vendor names and transports from the loop; the Claude bridge demonstrates this. |
| A9 | strained | Branch state and session-owned assignments, workflow attempts and off-turn usage exceed the simple work hierarchy (F4, F8). |
| A10 | strained | Waiting dialogs and post-run recovery need a clearer distinction between suspension, attempt end and settlement (F6, F7). |
| A11 | holds | Loop operations can use tool execution and hooks, with the separately documented model-access interaction. |
| A12 | holds | Selection, credentials and storage can remain outside the conceptual loop; Pi package/class boundaries are not the proposed boundaries. |
| A13 | gap | Pre-load trust, branch navigation, replacement and final settlement are not covered by the listed hooks (F3, F4, F7, F10). |
| A14 | broken | Claude's retained context and added instructions mean before-step context is not the whole effective request (F1); tool selection also needs a contract (F13). |
| A15 | strained | Stateful request acceptance is not a pure replay; no hidden execution of Pi shell/file tools was found (F1). |
| A16 | broken | claude-subscription keeps live and optionally persisted conversation state inside the Provider (F1). |
| A17 | strained | Normal and nested Pi calls use gates, but Claude can refuse unknown tool requests internally without reporting them to Pi (F1). |
| A18 | holds | One result with the six statuses can describe inspected calls, including uncertain remote outcomes; crash enforcement was not tested. |
| A19 | holds | Terminal, RPC, SDK and peer access can all be Interfaces, including optional richer presentation. |
| A20 | not tested | This rung exercises a single operator; it does not establish that one-user assumptions survive shared sessions. |
| A21 | gap | Fail-closed tool approval fits, but trust, human answer authority, prompt grants and delegation ceilings need separation (F9–F11). |
| A22 | not tested | Pi's timed dialogs close; they do not demonstrate durable late-answer delivery as new input. |
| A23 | broken | Branching and compaction preserve entries, but vanilla Pi also permits ephemeral history and explicit deletion (F5). |
| A24 | broken | Branch selection is missing, and a stateful Provider can retain context not reproduced by the selected Pi history (F1, F4). |
| A25 | holds | Stream deltas can remain live-only; a finalized aborted response is a different record, not a persisted delta stream. |
| A26 | not tested | Text, image and structured examples map; lossless unknown-type forwarding through every adapter was not established. |
| A27 | strained | Tool-source and Interface roles fit, but persistent work and peer delivery need stronger shared rules (F8, F9). |
| A28 | strained | Parentage and result input fit; nested delegation authority, holds and result receipt need explicit meanings (F8, F9, F11). |
| A29 | gap | No unavoidable shared-memory requirement was found, but cancellation, reload, queue and delivery contracts are incomplete. |
| A30 | holds | Standard and plugin events can expose these interactions; this is not a claim that Pi persists every observation. |
| A31 | not tested | No durable Runtime was inspected or run; workflow recovery is explicit restart, not continuation of a durable model turn. |
| A32 | holds | Credential handling can stay inside model access and credential-store adapters; the conceptual boundary need not follow pi-agent-core's class boundary. |

For A12 and A32, a literal drop-in of all pi-agent-core code as the Runtime would not hold: `X/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:264–283` resolves and passes an API key. The behavioural mapping puts that request/authentication adapter on the Provider side. This is an integration obligation, not evidence that Runtime credentials are necessary.

## Top changes

1. **Allow stateful Providers.** Define authoritative context, Provider additions, reset conditions, retry safety and cancellation. Do not equate a model request with a stateless call.
2. **Complete hosting rules.** Cover pre-load trust, deliberate replacement, reload, cleanup and continuation after replacement. Keep all of them within the plugin API.
3. **Define session trees and retention separately.** Add active position and branch-relative state. Decide whether ephemeral sessions and explicit deletion are supported.
4. **Define input state and authority.** Separate admission, queueing, handling, receipt and withdrawal. Preserve who supplied input and who may authorize human-only actions.
5. **Give session-owned work a lifecycle.** Cover reusable children, workflow attempts, holds, result receipt, recovery and off-turn usage without making every scheduler a Runtime.
6. **Make Runtime boundaries precise.** Put step end after tool results. Distinguish recovery from final settlement. Define when tools, models and reasoning changes take effect.
7. **State environment and Interface limits.** Separate local project context from remote execution targets. Specify cleanup uncertainty and rich-display fallback without relying on private process access.

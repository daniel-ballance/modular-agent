# Round 2, rung 1: Pi and pi-packages

Reviewed the docs at commit `ef6cafe`. The pressure-test changes are `94d9d21`. This is a source review. No agents, model requests, or package tests were started.

The docs still say what, not how. They do not agree with each other, and they are not yet precise enough to build Pi's session tree, a stateful Provider, or a persistent child.

## Sources read (versions, commits)

- Modular Agent: `ef6cafeb725c7ce94dc33d3f60d4d60cb732f9d3`. Read `README.md`, `docs/architecture.md`, `docs/contracts.md`, `docs/scenarios.md`, `GLOSSARY.md`, `docs/open-questions.md`, `docs/adr/README.md`, `docs/adr/0012-one-agent-is-the-scope.md`, `docs/pressure-test/synthesis.md`, `docs/pressure-test/round-2/README.md`, and round 1's `docs/pressure-test/rung-1-pi.md`, in that order. The applied changes are `94d9d21`.
- Pi documentation and installed code: **1.5.2**, at `/home/danballance/.local/share/mise/installs/pi/1.5.2/pi`. Below, **P** means this directory. Read `docs/sessions.md`, `docs/session-format.md`, `docs/slash-commands.md`, `docs/rpc-commands.md`, `docs/extensions.md` (lifecycle, trust, tree, settle), `docs/compaction.md` (branch summaries), `docs/mcp.md` (replacement), and `docs/virtual-models.md`. Checked the installed `pi-coding-agent` and `pi-agent-core` under `~/Code/pi-packages/node_modules/@earendil-works/`, both **1.5.2**.
- pi-packages: `8b0bd664e7de32cfaccc1196753f7b7451d12302`, at `/home/danballance/Code/pi-packages`. Below, **X** means this directory. Package versions match round 1: subagents **0.3.0**; p3stack, todo, claude-subscription, mcp-client, self-reload, computer-use and web-search **0.1.0**. Read the claude-subscription README and `src/tools.ts`, `src/session.ts`, `src/provider.ts`; subagents `README.md`, `PEER-MESSAGING.md` and `WORKFLOWS.md`; todo `extensions/todo/index.ts`; self-reload, mcp-client and computer-use READMEs.

Round 1's evidence still matches these commits. Its findings were not wrong. The revision fixed some of them and left the rest.

## Round 1 recheck

| Round-1 finding | Verdict | Reason |
|---|---|---|
| F1. A Provider can own a second conversation | partly | A Provider may keep state and say when to discard it (`docs/architecture.md` Provider, line 110). On-disk resume, an interrupted answer that stays in that state, and a tool refusal Pi never sees are not covered. See the new Provider finding. |
| F2. Cancellation does not reach the Provider | partly | Runtime-to-Provider cancel is now an interaction (`docs/contracts.md` Runtime and Provider). It answers only "cancelled" or "already finished". It does not say the partial answer can remain in Provider state, which claude-subscription does. |
| F3. Reload has no handover | partly | The plugin API names handover (`docs/architecture.md` line 210). What is handed over, and what must not resume, is still open (`docs/open-questions.md` Plugin lifecycle). |
| F4a. Deliberate replacement | partly | Replacement is named, with mcp-client as the example (`docs/architecture.md` line 176). Partial replacement and what returns when the replacement is removed are not. |
| F4. Forking is not moving inside the tree | partly | Current position, a tree, and fork versus move are now named. "Moving is recorded", and a missing rewind refuses the move (`docs/architecture.md` lines 310 and 376). That does not describe `/tree`. |
| F5. Ephemeral history and deletion | resolved | A session with no history store is ephemeral, and history may be kept for a limited time (`docs/architecture.md` History). The new "deletion is recorded" wording is a separate disagreement, below. |
| F6. Accepted input is not yet history | partly | Input can wait, and unsent input can be withdrawn (`docs/architecture.md` line 180; scenario 4). What cancel does to queued input is still open (`docs/open-questions.md` Cancellation). Pi's abort does not withdraw it. |
| F7. Turn end is not "nothing more will run" | partly | An exchange can hold retries, and the result hook can send the model back (`docs/contracts.md` hook points). "After each step" is still before the tool calls, which contradicts the step definition. |
| F8. Children and workflows outlive the starting call | partly | A job can outlive its turn (`docs/architecture.md` Jobs). A child that stays idle for a later assignment, a hold, and a paused workflow do not fit that job. |
| F9. Peer input needs origin and delivery | partly | Each message records its actor (`docs/architecture.md` Working with other agents). It does not say the message is not a command, or that an uncertain delivery is not sent again. |
| F10. Trust before project plugins load | partly | "Plugin about to load" can allow or refuse (`docs/contracts.md` line 352). Who may take part in that check is still open (`docs/open-questions.md` line 36). |
| F11. Narrowing does not say which right | partly | Authority only narrows (`docs/architecture.md` guarantee 9). The right to commission work and the right to do the work are still one idea. |
| F12. One directory is not one execution target | partly | The working environment is now a capability. "One per session" and "swapping it moves every tool" (`docs/architecture.md` lines 84 and 136) cannot describe local files plus a remote Mac. |
| F13. Registered tools are not the tools the model is told about | resolved | The plugin API separates tools offered, tools the model is told about, and tools a call may use. The before-step hook returns the model's set (`docs/contracts.md` line 360). |
| F14. Interface cooperation must not need shared memory | resolved | A plugin can show status, and an Interface that does not understand a hint falls back to plain text (`docs/architecture.md` What plugins can do). The unofficial footer hook is not required. |

No round-1 finding was rejected. Three are resolved: F5, F13 and F14. The rest are only partly fixed.

## Guarantees

| Guarantee | Verdict | Reason |
|---|---|---|
| 1. Everything can be identified | strains | A hidden tool refusal inside Claude has no identity in the session, and a later assignment is traced to the exchange that first started the child. |
| 2. Everything can be observed by those allowed, for as long as it is kept | strains | Pi is not told about that refusal, or about the system reminders Claude adds (`X/packages/claude-subscription/README.md` lines 155 and 175). |
| 3. History grows in normal use | breaks | Branching must add an entry (`docs/architecture.md` line 389). Pi's `/tree` can move the position and add nothing, and a restart does not restore that move. |
| 4. Every tool call ends with exactly one result | strains | True for calls the agent accepts. A call Claude refuses itself never becomes a recorded result (`X/packages/claude-subscription/README.md` line 175). |
| 5. Credentials never reach the Runtime, and it never chooses the model | holds | Claude's login stays in the Provider. Model choice can stay in the model-selection plugin. The installed loop's key handling is an adapter, not a reason the Runtime must see the key. |
| 6. Nothing is lost in passing | strains | After a branch, the replay is a text record without the earlier thinking (`X/packages/claude-subscription/README.md` line 168). The history still has that thinking. |
| 7. Plugins stay within the plugin API | holds | self-reload's process-local bridge is how today's code continues after reload. The feature itself can be handover plus later input. The API does not yet say when that input must be withheld. |
| 8. Approval fails closed | holds | A missing answer still refuses the call. p3stack's grant text is prompt guidance, not an allow. |
| 9. Authority only narrows | strains | A nested coordinator can commission a tool it is not allowed to run, from the root allowlist (`X/packages/p3stack/subagents/README.md` Bounded nesting). |
| 10. Differences are declared | strains | The list exists. Its rewind substitute is "refuse before anything changes" (`docs/architecture.md` line 376), which is the wrong substitute for Pi's `/tree`. |

## Changes

| Change | Verdict | Reason |
|---|---|---|
| 1. Several actors, each with authority | strains | One user, a host, and a scheduler fit. A peer message and a commissioned tool still have no separate rights. |
| 2. A Provider can keep state and run tools | strains | Discard on fork, branch, compaction and model change matches claude-subscription's replay. Interrupt-kept answers, on-disk resume, and hidden refusals do not. |
| 3. Name the work that isn't a turn | gap | A job and an exchange name the units. Tying every report to the exchange that started the job mis-describes a child that receives a second assignment. |
| 4. A turn returns a result, and can wait | holds | Pi waits in place, which is the waiting state. An open call is the other ending, and scenario 3 tells it. |
| 5. History grows in normal use, with stated exceptions | breaks | Ephemeral sessions and erasure are right. "Moving is recorded" is not what `/tree` does, and it predicts the wrong position after a restart. |
| 6. What may be seen, and kept | holds | The output gate and live-only facts are enough for streamed text and a footer. This rung has no guardrail that the gate cannot describe. |
| 7. Durability is a promise many parts make | strains | An unanswered tool call is "outcome unknown". An unanswered turn is also called that (`docs/contracts.md` line 279), but a turn has no such outcome. |
| 8. Working environment, and plugins define capabilities | strains | The capability fits Pi's local tools. One environment for every tool does not fit computer-use beside those tools. |
| 9. Complete the plugin API | strains | The missing names were added. Handover, replacement, trust and withdrawal are still names, not rules a builder can follow. |
| 10. Parts declare what they support | strains | Declaring support is the right idea. The rewind row cannot describe history-only navigation, and cancel-continues-the-queue is not on the list. |

## New findings

### A kept Provider session is more than state between requests

- **Feature or situation:** claude-subscription keeps a Claude Code conversation on disk across Pi restarts, keeps an interrupted answer in that conversation, and lets Claude refuse an unknown tool without telling Pi.
- **Described as:** A Provider that declares it keeps state, discards that state after a fork, a rewind, compaction or a model change, and records tools it ran itself.
- **Verdict:** gap.
- **Assumptions or guarantees affected:** Change 2. Guarantees 1, 2, 4 and 6.
- **Evidence:** `X/packages/claude-subscription/README.md` lines 143–155: with `resume` on, Claude writes the conversation under `~/.claude/projects/`, and a small record is kept under `~/.pi/agent/claude-subscription/sessions/`. Those files are removed by Claude after 30 days. The kept session is used only when it matches the start of Pi's transcript, the prompt, the tools and the working directory. Line 167: after a restart the kept session is resumed, or Pi falls back to a text record. Line 168: after compaction, a branch, an edited message, or a turn answered by another provider, the new process gets that text record without the earlier thinking. Line 170: an interrupted answer stays in the model's context. Line 175: a call to a tool that does not exist is answered by Claude itself, the turn carries on, and Pi shows nothing. `src/tools.ts` lines 175–185 says Pi is not asked to run that call. `src/session.ts` lines 252–258 and 371–380 distinguish stopping before delivery from an interrupt that leaves a usable session. `docs/architecture.md` line 110 only requires the Provider to say when state is discarded, with fork, rewind, compaction and model change as examples. Scenario 7 says that with no history store, nothing survives. A Provider file can survive that.
- **Suggested change:** Say that Provider state can live outside the history store and can outlive the process. The Provider says when a saved session may be reused, and when it must fall back to a text record that cannot carry every part, such as thinking. An interrupt can leave the partial answer in Provider state even though the turn was cancelled. A tool call the Provider answers itself is still a tool call: it is recorded, including a refusal, or the Provider declares that some calls never appear. Erasure and retention apply to those copies too.

### Moving the current position is not rewinding the world

- **Feature or situation:** Pi's `/tree` moves inside the same session. `/fork` and `/clone` start a new session. Todo and the selected model follow the active branch. Files and remote apps are not put back.
- **Described as:** The session has a current position. Moving it is recorded. Files can be rewound with it. A part that cannot rewind refuses before anything changes (`docs/architecture.md` lines 310 and 376; scenario 14; `GLOSSARY.md` line 138).
- **Verdict:** breaks.
- **Assumptions or guarantees affected:** Guarantee 3. Guarantee 10. Change 5. Change 10. Pi's out-of-the-box session commands.
- **Evidence:** P `docs/sessions.md` lines 36–46: `/tree` moves within the current session file and does not erase the branch left behind. `/fork` creates a new session from an earlier user message. `/clone` copies the active branch into a new session. Selecting a user message in `/tree` puts its text back in the editor. P `docs/slash-commands.md` lines 27–29 says the same. Installed `session-manager.js` line 1177: `branch()` sets the position and appends nothing. Lines 742–752: on load, the position becomes the last entry in the file, not a saved position. So a move with no new entry is lost on restart. `session-manager.d.ts` lines 366–372: a branched session file contains only the path to the chosen point, not the other branches. `agent-session-runtime.js` lines 186–220: `/clone` is that copy at the current point; `/fork` is that copy before the selected user message, and the message text is returned to the editor. P `docs/session-format.md` line 99: the selected model is the latest model-change entry on the branch. `X/packages/p3stack/todo/extensions/todo/index.ts` lines 109–123 rebuild the list from custom entries on `getBranch()` after `session_tree`. P `docs/compaction.md` lines 181–193: a branch summary is optional, and only then is an entry appended. `X/packages/computer-use/README.md` lines 148–154: branch navigation resets the connection and does not undo app actions. Scenario 14 says that if a part cannot rewind or discard, the move is refused. Pi's files cannot be restored, and `/tree` still moves.
- **Suggested change:** Separate three operations. Moving the current position need not add an entry, and a restart restores only a position that was saved. Forking copies either the path to a point or the whole tree, and can hand a past message back as unsent input. Rewinding files, Provider state, or a remote desktop is optional and separate. A part that cannot rewind does not block the history move. Effective settings and plugin state are whatever the current branch records, which is how todo and the model already work. Until that split exists, Pi's built-in `/tree` cannot be described as one of the plugins without contradicting the history rules. The rest of the built-in set (tools, skills, compaction, commands, model selection, MCP) can.

### A persistent child is not one job in the exchange that started it

- **Feature or situation:** A subagent stays alive after an assignment, takes a later assignment, and can message the parent before it finishes. A workflow can pause and must not resume by itself.
- **Described as:** A subagent is started by a job. Its result is the job's report, and that report starts a turn in the exchange that started the job (`docs/architecture.md` line 298; `GLOSSARY.md` lines 103–105 and 216–217).
- **Verdict:** gap.
- **Assumptions or guarantees affected:** Change 3. Guarantee 1. Scenario 8.
- **Evidence:** `X/packages/p3stack/subagents/README.md` lines 181–193: a completed child stays idle; `subagent_send` gives it another assignment; abort keeps the child alive; reading a result is not the same as the result being reviewed. Lines 224–242: `parent_send` delivers a message while the child is still working. If the parent is idle, that message starts work; it does not wait for the assignment to finish. `X/packages/p3stack/subagents/WORKFLOWS.md` lines 11 and 103–116: cancelling the start tool does not cancel an accepted run; reload stops active work and keeps a paused run; nothing restarts it; attempt counts do not reset; release does not start work. The job states in `docs/contracts.md` are started, running, completed, failed, cancelled, and outcome unknown. There is no idle, held, or paused. The exchange definition says a job's report belongs to the input that started the job. A second assignment is a new input. Its result would still be filed under the first exchange.
- **Suggested change:** A child session can outlive the job that created it. Each assignment is its own job, and its notices start turns in the exchange that sent that assignment, not the exchange that first created the child. A notice can start a turn before the job ends. Add held and paused. Release and resume start nothing by themselves. Cancelling the tool that started an accepted job does not cancel the job. Say that a workflow's attempts and artifacts stay inside the workflow plugin.

### A hold is not a cancellation or an approval

- **Feature or situation:** A person halts a child or a workflow. The child stays up, rejects new work, and does not continue when the hold is released.
- **Described as:** Cancel the turn or the job, or open an input request that an actor answers.
- **Verdict:** gap.
- **Assumptions or guarantees affected:** Change 3. Change 4. Guarantee 8 is not the problem: nothing is being approved.
- **Evidence:** `X/packages/p3stack/subagents/README.md` lines 185–191: Halt cancels active work and keeps the process; Kill stops the process; neither undoes edits. A hold is saved before the cancel request is sent. Held children reject prompts, peer messages and resumption. Holds survive reload. `subagent_release_hold` starts nothing. The human viewer cannot release it. `WORKFLOWS.md` lines 15 and 109: there is deliberately no model-callable human-approval operation; after a hold, resume is a separate explicit operation, and deadlines and attempt counts are unchanged.
- **Suggested change:** A hold is a session-owned barrier. It is not an input request and not a cancelled job. While it is in place, the held work accepts nothing new. Releasing it does not start work. It survives reload. A restart must not treat a saved hold as a new assignment.

### A peer message is not user input

- **Feature or situation:** One child sends another a message on a link the parent allowed. The sender cannot be taken from the text. A leading slash is not a command. An uncertain delivery is not sent again.
- **Described as:** A peer is another agent this one can message, with no parent relationship. Each message records its actor (`docs/architecture.md` Working with other agents; `GLOSSARY.md` lines 219–220). Giving input can say when it is taken, and can carry a key so a repeat has no further effect.
- **Verdict:** gap.
- **Assumptions or guarantees affected:** Change 1. Change 3. Guarantee 9.
- **Evidence:** `X/packages/p3stack/subagents/PEER-MESSAGING.md` "Transport and delivery" and "Accounting and recovery": the manager binds the sender to the child process, not the message text. The body is untrusted work, not a user instruction, a permission, or an approval. A leading slash cannot run a command. Unknown acceptance keeps the allowance and is not replayed. `handled` means an extension consumed the envelope; it is not a completed assignment. Abort, close and reload can drop a queued message; it is marked interrupted and is not delivered again. Links are not transitive. `README.md` lines 256–269 says the same. The host's repeat key does the opposite of this rule: an unanswered input may be repeated with the same key (`docs/contracts.md` Interface and Harness). Authority lists watch, propose, give input, answer, approve, change settings, and erase. It does not say that giving input excludes commands.
- **Suggested change:** A message from an agent actor is not a command and not an approval unless that actor has that separate right. The sender is the channel, not a name in the text. Record accepted, received, handled, unknown and interrupted. Unknown is not sent again, and the allowance stays spent. A parent-allowed link is not a parent relationship, and it is not transitive.

### A tool can have its own place to run

- **Feature or situation:** Pi runs on Linux. computer-use controls a Mac over SSH. Local file tools stay on Linux. Navigation and cancel reset the SSH connection and do not undo what the Mac already did.
- **Described as:** One working environment per session. Tools use it, so swapping it moves every tool (`docs/architecture.md` lines 84 and 136).
- **Verdict:** gap.
- **Assumptions or guarantees affected:** Change 8. Round-1 F12, which the new rule was meant to close.
- **Evidence:** `X/packages/computer-use/README.md` lines 66–81 and 104–110: `PI_COMPUTER_USE_SSH` selects the Mac; Linux paths and Mac paths are different; the Linux `CODEX_HOME` is not forwarded. Lines 148–154: reload, session change, branch navigation, cancellation and a dropped connection clear consent and stop the local SSH client. They cannot guarantee remote cleanup, and they do not undo app actions. A failed action is not replayed. Other sessions can target the same Mac. Pi's file tools still use the session directory.
- **Suggested change:** The session has one working environment for the tools that use it. A tool source may name its own target, with its own paths, credentials, consent and cleanup. Swapping the session environment does not move that tool. Losing the target, or failing to confirm cleanup, is "outcome unknown". It is not a rewind, and it is not a reason to refuse a history move.

### Cancel does not hand queued input back

- **Feature or situation:** Steering waits for the next model request. Follow-up waits until the turn has nothing left to do. Escape in the terminal gives that text back to the editor. RPC abort does not.
- **Described as:** Input is taken now, during the running turn, or after it. Unsent input can be withdrawn. What cancel does to queued input is open (`docs/open-questions.md` line 67).
- **Verdict:** gap.
- **Assumptions or guarantees affected:** Change 9. Change 10. Being driven by a host. Round-1 F6.
- **Evidence:** P `docs/rpc-commands.md` lines 46–72 and 107–128: `steer` is delivered after the current tool calls and before the next model request. `follow_up` is delivered only when the agent has no more tool calls or steering. `abort` continues queued messages if they are still there. To match Escape, the client must clear the queue first and put the returned text back in the editor. Installed `agent-session.js` line 2042 clears the queues and returns them. Line 2073 `abort()` does not. It aborts the run, retries, compaction and a branch summary, and waits until idle. A host that only calls cancel will start the queued follow-up. The declaration table does not say this (`docs/architecture.md` Declared support).
- **Suggested change:** Say that cancel does not withdraw queued input. Withdrawal is a separate request, and it returns the content. Also say how many waiting inputs are taken at the next boundary: all of them, or one. A host must be able to learn which, or Pi's RPC abort cannot be described as the host's cancel.

### Reload and replacement are still only names

- **Feature or situation:** self-reload ends the run, replaces the plugins, and only then continues. mcp-client replaces in-session MCP, not the shell command. Unloading it changes what the configuration means.
- **Described as:** Hand over state on reload. Replace another plugin deliberately, saying which one. Trust is checked before load.
- **Verdict:** gap.
- **Assumptions or guarantees affected:** Change 9. Round-1 F3, F4a and F10.
- **Evidence:** `X/packages/self-reload/README.md` lines 33–60: queued, reloaded and verified are separate. The tool never claims the new behaviour was verified. A failed reload must not run the continuation as if it had succeeded. A crash does not replay a pending continuation. Reload runs shutdown hooks; in this repository that stops subagent processes, and recovery is explicit. P `docs/extensions.md` lines 377–393: `/reload` shuts the old runtime down and loads a replacement; `project_trust` can run again before the replacement's project resources load. P `docs/mcp.md` lines 266–274: registering `/mcp` stops Pi from reading `mcp.json` in a session. Remove the extension and the built-in behaviour returns. Shell `pi mcp` always uses the built-in client. `X/packages/mcp-client/README.md` lines 9–18: unloading must not reinterpret a converted `mcp.json`; the user converts back first. `docs/open-questions.md` line 36 asks what is handed over and who decides trust. It does not say the continuation is withheld on failure, or that replacement can cover one Interface and not another.
- **Suggested change:** A reload request, a successful replacement, and a checked continuation are three different facts. The continuation is input to the new instance, and it is not delivered if replacement fails. Say which jobs stop, and that stopped work is not started again from the handover. Replacement names what it replaces. What it does not replace stays. Removing the replacement restores the replaced plugin, or the description says that the configuration now means something else.

### The docs do not agree on a step, a lost turn, or a deletion record

- **Feature or situation:** A builder following one page and not the others gets a different agent.
- **Described as:** The architecture, the contracts, the scenarios and the glossary are one description.
- **Verdict:** gap.
- **Assumptions or guarantees affected:** Change 4. Change 5. Change 7. Guarantees 3 and 4. The requirement that the docs agree.
- **Evidence:** `GLOSSARY.md` lines 91–93: a step includes the tool calls it asks for. `docs/contracts.md` line 360: "after each step" is given the model response, including tools the Provider ran, and can end the turn before the separate "before a tool call" hook. Scenario 1 does the same: "After the step" is step 7, and the tool call is step 8. Pi's own picture is the other way: a turn ends after its tools (`P/docs/extensions.md` lines 340–345). `docs/contracts.md` line 279: an unanswered turn ends with an unknown outcome. `GLOSSARY.md` lines 95–96 and `docs/contracts.md` line 149 list only completed, cancelled, failed, and stopped at a limit. Scenario 7 says the interrupted turn is "recorded as ended" and does not pick one. Guarantee 3 says deletion is recorded. `docs/architecture.md` line 312 says a record "may" remain. Scenario 15 says deletion is itself recorded. `GLOSSARY.md` line 118 says a tool call is a request from the model. The architecture also allows a UI, a plugin, or the Provider to start one. Scenario 14 refuses the move if any part cannot rewind or discard. The history section names only the Runtime and the Provider for that refusal.
- **Suggested change:** Pick one step end: after the tool calls that belong to that model response. Give a lost turn an outcome that is in the list, or add "outcome unknown" to the list. Say whether a deletion record is required. Make the glossary's tool call match every starter. Make the refuse-before-change rule name the same parts in every page.

### Commissioning work is not the same as authority to do it

- **Feature or situation:** A child coordinator has a narrow tool set and may still ask the root manager to start a grandchild that uses a broader allowlist.
- **Described as:** An agent passes on no more authority than it has. A subagent has no more authority than its parent (`docs/architecture.md` Actors and authority; guarantee 9).
- **Verdict:** strains.
- **Assumptions or guarantees affected:** Change 1. Guarantee 9. Round-1 F11.
- **Evidence:** `X/packages/p3stack/subagents/README.md` lines 284–291: delegation tools inside a child are proxies to the one root manager. Grandchildren are composed from the same root allowlist, not from the tools the coordinator itself may run. The coordinator cannot use the peer, hold, or workflow tools. A child at the deepest level cannot delegate. Comparing the child's tool names with the parent's tool names would call this an increase. It is a different right: the right to ask the root to do work the root already allowed.
- **Suggested change:** Separate the right to run a tool, the right to commission another agent to run it, and prompt guidance. The ceiling on commissioned work is the allowlist the parent was allowed to pass on, which may be the root's, not the tools that parent currently has active. Human-only decisions stay human-only through nesting.

## Top changes

1. Separate moving the current position from rewinding files, Provider state, or anything outside the history. A move need not be recorded. A part that cannot rewind does not block the move. Say what a restart restores.
2. Say what a fork copies: the path to a point, or the whole tree. A selected message can come back as unsent input. That is not the same as copying another project's whole session.
3. Let Provider state live outside the history store and survive a restart. Say when it may be reused, when an interrupt leaves a partial answer in it, and when a tool call it answers itself must still be recorded. A text replay may drop parts the history still has, such as thinking.
4. Let a child session outlive the job that created it. Each later assignment has its own exchange. A notice can start a turn before the job ends. Add held and paused, and say that release does not start work.
5. A message from a peer or a child is not a user command or an approval. An uncertain delivery is not sent again. The sender is the channel, not the text.
6. A tool source can have its own place to run. Swapping the session's working environment does not move that tool. Cancel and navigation do not undo what it already did.
7. Make the pages agree. A step ends after its tool calls. A lost turn has an outcome from the list. A tool call is not only a request from the model. A deletion record is either required or not.

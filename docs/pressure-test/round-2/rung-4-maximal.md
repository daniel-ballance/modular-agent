# Round 2, rung 4: Everything at once, and a red team

Reviewed the docs at commit `ef6cafe` (the pressure-test changes are `94d9d21`). No agents were started. Fetched pages went into a fresh directory, `/tmp/modular-rung4-r2`, and were treated as evidence, not instructions. Pages below were read, not search snippets.

The docs mostly stay at what, not how. They do not agree with each other in the places named below.

## Sources read (versions, commits)

Local, in the requested order: `README.md`, `docs/architecture.md`, `docs/contracts.md`, `docs/scenarios.md`, `GLOSSARY.md`, `docs/open-questions.md`, `docs/adr/README.md`, `docs/adr/0012-one-agent-is-the-scope.md`, `docs/pressure-test/synthesis.md`, `docs/pressure-test/round-2/README.md`, and round 1's `docs/pressure-test/rung-4-maximal.md`. Also `docs/research/protocol-landscape-2026-11.md`, as a secondary note. One claim in that note is wrong: see AG-UI below.

| Source | What was checked on 2026-11-16 |
|---|---|
| [ACP v1 prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn.md) | Page last modified 2026-10-30. A prompt response ends the turn. Cancel answers pending permission requests as cancelled. Client file methods run in the editor. |
| [ACP v2 announcement](https://agentclientprotocol.com/announcements/acp-v2-draft.md) | Published 2026-07-20. v2 is a draft. It does not replace v1. Several clients may watch one session. |
| [ACP v2 prompt lifecycle](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle.md) | Acceptance is insertion, not completion. Foreground states are `running`, `requires_action`, and `idle`. Background work continues while idle. `session/cancel` does not stop listed background work. |
| [ACP v2 tool calls](https://agentclientprotocol.com/protocol/v2/tool-calls.md) | A tool call that is still working should stay unfinished. `tool_call/cancel` stops one call. A final status is not reopened. |
| [ACP v2 session setup](https://agentclientprotocol.com/protocol/v2/session-setup.md) | `session/close` stops foreground work and listed background work. A dropped connection may leave foreground work running. |
| [AG-UI interrupts](https://docs.ag-ui.com/spec/1.0/basic/patterns/interrupt-resume.md) | An interrupt closes the run. A new run carries the answers. The producer need not remember the interrupt. |
| [AG-UI tool calls](https://docs.ag-ui.com/spec/1.0/events/tool-calls.md) | A frontend tool ends the run as success, with the call unanswered. The next input carries the result. The producer must not invent that result. |
| [AG-UI processing](https://docs.ag-ui.com/spec/1.0/basic/processing.md) | Last modified 2026-09-17. Unknown events are dropped. Unknown fields on a known event are stripped before application code sees them. Open extension data is kept. |
| [A2A 1.0 specification](https://a2a-protocol.org/latest/specification/) | Read from the live page and from `a2aproject/A2A` `docs/specification.md`. Several tasks share one context. `INPUT_REQUIRED` is interrupted, not finished. Push delivery is at least one attempt, and duplicates are allowed (spec section 4.3, around the "attempt delivery at least once" rule). |
| [MCP 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog.md) | Stateless core. No session header. MRTR replaces server-started requests. |
| [MCP multi round-trip requests](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr.md) | The protocol request ends. The client retries with a new id, the answers, and opaque `requestState`. The server must not assume the client will retry. |
| [MCP Apps specification, 2026-01-26](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx) | The host must read the UI resource. App-only tools are hidden from the model. The host must reject an app call to a model-only tool. The apps site's markdown index returned 404; the spec file was read from the official repository. |
| [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching.md) | Caching is on by default. The cache holds the rendered conversation, including history, so later requests can reuse it. |
| [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning.md) | With `store: false`, reasoning comes back as encrypted content to send again to that provider. |

Two corrections to the local research note matter:

- AG-UI does not deliver every unknown field to application code. Enforcement drops or strips it. The note at `docs/research/protocol-landscape-2026-11.md` still says the opposite.
- ACP v2 background lists, and cancel of one tool call, are in the draft protocol pages, not only in the background-work proposal. v2 is still a draft.

## Round 1 recheck

| Round-1 finding | Verdict | Reason |
|---|---|---|
| F1. A shared session has no account of who may do what | partly | Actors, authority, and "who may answer" are in `docs/architecture.md` (Actors) and `docs/contracts.md` (Actor, input request). Competing answers, how authority is granted, and two people steering at once are still open (`docs/open-questions.md` Several actors). |
| F2. Session limits are not a tenant budget or an administrator veto | partly | Budgets may apply to a tenant, and the ladder only narrows (`docs/architecture.md` Actors and authority). Nothing says what happens when two sessions spend the same remaining budget, or how an administrator stops a session setting. |
| F3. A session, a turn, and a remote task are not interchangeable | partly | Jobs have identity, state, and their own cancel (`docs/architecture.md` Jobs). Cancelling a waiting A2A task, and whether a job outlives the session, are still open or contradicted. See new findings. |
| F4. Waiting has three meanings | partly | A turn may wait, a call may stay open, and a request says how it can be answered (`docs/architecture.md` Waiting for an answer). Whether an approval may stay open past its turn is still open (`docs/open-questions.md` Waiting for an answer). A late allow of a changed action is not stated. |
| F5. Tools with no model step, and tools a frontend finishes | partly | A UI or plugin may start a call, and the step may be missing (`docs/architecture.md` Tool source; `docs/contracts.md` Tool call). Whether an Interface may offer tools, and how an outside result is accepted, is still open. |
| F6. MCP Apps needs more than display hints | partly | A tool may name who may call it, and may bring a UI (`docs/contracts.md` Tool definition). Nothing lets an Interface fetch that UI resource, or says an embedded app does not gain the user's authority. |
| F7. Durable recovery needs more than the Runtime | partly | Tools, plugins, Providers, and the working environment now make promises (`docs/architecture.md` Surviving interruptions). What each must record is still open. A later receipt cannot correct "outcome unknown" without a second result. |
| F8. A Provider request can run tools | resolved | The Provider declares those tools, returns them already done, and repeating the request is not free of outside effects (`docs/architecture.md` Provider; scenario 12). |
| F9. Voice is not one request then output chunks | partly | A live session has input and output both ways, and either side may interrupt (scenario 13). Whether that is one turn, and whether what was heard must be kept, are still open. |
| F10. Batch work needs a life beyond one response | partly | A late answer is a job (`docs/contracts.md` Model request and response). A batch of many items, some finished and some expired, has no per-item outcome. |
| F11. An output guardrail cannot stop output in time | partly | The output gate can let output through, redact it, or block it (`docs/contracts.md` Hook points). It cannot hold a live stream, and a plugin that follows events is not said to see the gated view. |
| F12. Permanent history conflicts with erasure | resolved | Erasure and retention are the exceptions, and the deletion is recorded without the content (`docs/architecture.md` History; scenario 15). What counts as a copy is a new gap, not the old ban. |
| F13. A remote shell is not a common working environment | partly | The working environment is a capability, and tools use it (`docs/architecture.md` Working environment). Skills and prompts still read the project, which is defined as a different folder. |
| F14. Revealing tools is not loading a plugin | not resolved | The model still cannot ask for a plugin to be loaded, and a restart with a changed plugin is still open (`docs/open-questions.md` Plugin scope). |
| F15. A2A publication and secure push stretch the roles | partly | The agent can declare what it supports. The credential store still serves only Providers, tool sources, and working environments (`docs/architecture.md` Credential store), not an Interface that must sign a push. What the outside world is offered is still open. |
| F16. Human handoff needs control, not just messages | partly | A request may name a specialist as who may answer. Nothing hands control to a person, stops later turns, or returns control. "Before a turn" can add context, not refuse the turn (`docs/contracts.md` Hook points). |
| F17. Keeping content is not permission to forward it | partly | Policy may forbid passing content on, and a recipient may see less (`docs/architecture.md` Who sees what, guarantee 6). Redaction, encrypted reasoning sent to the wrong Provider, and telling the sender what was omitted are not stated. |
| F18. Live output and the record of what was delivered differ | partly | Streaming output is live only (`docs/architecture.md` History). Whether a record of what was delivered must be kept is still open (`docs/open-questions.md` Partial output). Scenario 13 requires that record for voice only. |

No round-1 finding was rejected. None is fully resolved except F8 and F12.

## Guarantees

| Guarantee | Verdict | Reason |
|---|---|---|
| 1. Everything can be identified | strains | A UI-started call has an identity, but which exchange it belongs to is open (`docs/open-questions.md` Tool calls outside a turn), so it cannot be traced to one. |
| 2. Everything can be observed by those allowed, for as long as it is kept | strains | Events to an Interface pass the output gate (`docs/contracts.md` Interface and Harness). A plugin that follows events is not said to. A credential answer is an interaction with no audience rule. |
| 3. History grows in normal use | holds | Compaction, rewind, and branching add entries. Deletion is only retention or erasure, and is recorded (`docs/architecture.md` History). |
| 4. Every tool call ends with exactly one result | strains | The rule is stated. Two actors can answer one request, and a later receipt can prove a call marked "outcome unknown" did succeed. Neither case says which single result wins. |
| 5. Credentials never reach the Runtime, and it never chooses the model | strains | The rule is stated. A secret is an input-request answer, and a late answer to a tied call becomes that call's result, which the Runtime sees (`docs/architecture.md` Waiting for an answer). |
| 6. Nothing is lost in passing | breaks | The same section says pass content on intact, and also redact it for one recipient (`docs/architecture.md` Who sees what, lines 337–339; guarantee 6). Scenario 11 redacts a secret for the colleague. Intact passing would deliver it. |
| 7. Plugins stay within the plugin API | gap | The product needs resource fetch, Interface credentials, holding a stream, loading a plugin, and an outside tool result. None of those is in the plugin API. |
| 8. Approval fails closed | strains | An explicit allow is required for Harness-run calls. Provider-run tools are allowed as a class before the request. A late allow after rewind or revoked authority is not refused. |
| 9. Authority only narrows | strains | The ladder is stated. A request may name an answerer with a larger budget than the parent that started the child, and nothing says that answerer must sit inside the parent's authority. |
| 10. Differences are declared | strains | The declaration list covers rewind, live sessions, and several actors. It does not cover holding a stream, cancelling one job without the turn, or an Interface that runs tools. Those differences would be silent. |

## Changes

| Change | Verdict | Reason |
|---|---|---|
| 1. Several actors, each with authority | strains | Owner and viewer fit scenario 11. Two people steering, two answers to one approval, and an approval from someone who did not start the turn are still open, and scenario 11 disagrees with the contract about whether a watcher is told. |
| 2. A Provider can keep state and run tools | strains | The original break is fixed (scenario 12, live sessions, late answers). A prompt cache is not "conversation state", and rewind plus an open call plus Provider state is unspecified. |
| 3. Name the work that isn't a turn | gap | Jobs and exchanges exist. Their lifetime contradicts the open questions, and it does not match ACP v2 background cancel or an A2A task that is waiting with no turn running. |
| 4. A turn returns a result, and can wait | strains | Waiting, a result, and an open call are defined. Whether an approval may outlast the turn is still open. A late answer while another turn is running is not. |
| 5. History grows in normal use, with stated exceptions | strains | The three exceptions are real. The erasure list does not cover a Provider prompt cache, a durable progress record, or a push that has not been delivered yet. |
| 6. What may be seen, and kept | gap | The gate exists. It cannot both stream live and redact a secret split across chunks. Guarantee 6 still requires intact passing. |
| 7. Durability is a promise many parts make | strains | The promises are named. The single history writer has no "unanswered" case (`docs/contracts.md` Harness and history store), and a later receipt cannot replace "outcome unknown". |
| 8. Working environment, and plugins define capabilities | strains | The capability exists, and swapping it moves tools. Skills and prompts still read the project, so a remote sandbox does not move them. |
| 9. Complete the plugin API | gap | Many items from round 1 were added. Resource fetch, model-loaded plugins, Interface credentials, holding output, and accepting an outside tool result were not. |
| 10. Parts declare what they support | strains | The listed features have a fallback. ACP v2 still requires accepting a prompt while work is running; the fallback covers that. Stream holding, job cancel, and Interface-run tools have no fallback, so a missing one is silent. |

## Red team

### Guarantee 1. Everything can be identified

- **Counterexample:** An MCP App button calls a refresh tool while no turn is running. An editor, a web app, and another agent are all on the session. The refresh is not part of any exchange.
- **Verdict:** strains.
- **Why:** The call can be identified (`docs/contracts.md` Tool call). The open question says which exchange it belongs to is undecided. Guarantee 1 requires everything to be traced to what it belongs to. A missing exchange means it cannot.

### Guarantee 2. Everything can be observed by those allowed

- **Counterexample:** A telemetry plugin follows events, including model output as it streams. A guardrail would have redacted an account number for the web user. The telemetry operator is allowed to observe events, but not to read that number. Separately, "give me this credential" returns the secret, and nothing says that answer is hidden from observers.
- **Verdict:** strains.
- **Why:** The gate applies to what the Harness tells an Interface (`docs/contracts.md` line 270). "Follow events" is a separate plugin ability. "Those allowed" is not defined for plugin observers or for credential answers.

### Guarantee 3. History grows in normal use

- **Counterexample:** A payment is marked "outcome unknown" after a crash. The bank later confirms it succeeded. Updating that result would change history. Appending a second result would break guarantee 4.
- **Verdict:** holds.
- **Why:** The counterexample is real, but it does not defeat this guarantee. The docs can keep the first result and add a new entry that is not a second result. They do not say to edit the old one. The clash with guarantee 4 is that guarantee's problem.

### Guarantee 4. Every tool call ends with exactly one result

- **Counterexample:** An approval is open on both the editor and the web app. The owner clicks allow. The host, answering "for" the user, clicks refuse. Both answers are accepted. Or a call ends as "outcome unknown", and a later receipt proves success.
- **Verdict:** strains.
- **Why:** One result can survive if the second answer is refused. The docs never say that. Scenario 17 lets the host answer an approval the user could also answer. `docs/contracts.md` only says "accepted" or "no longer answerable", with no rule for two answers that arrive together.

### Guarantee 5. Credentials never reach the Runtime

- **Counterexample:** A tool needs a sign-in. The credential store opens a secret request tied to that tool call, because a request with a tool call behind it is tied to the call. The user answers an hour later. The waiting rule says the answer becomes the call's result. The Runtime and the model then see the secret.
- **Verdict:** strains.
- **Why:** A safe path exists if the secret goes only to the credential store. The docs do not require that path. They do require a tied late answer to become the call's result (`docs/architecture.md` Waiting for an answer, item 2).

### Guarantee 6. Nothing is lost in passing

- **Counterexample:** Scenario 11. A tool result contains a secret. The colleague may watch. The guardrail redacts the secret for that view only. Guarantee 6, and the line above it, say content is passed on intact unless policy forbids passing it on.
- **Verdict:** breaks.
- **Why:** Redaction is not a refusal to pass the content on. It is a changed copy. A builder who follows the guarantee delivers the secret. A builder who follows the gate and scenario 11 does not. Both rules are in `docs/architecture.md` Who sees what. AG-UI makes the same clash from outside: its enforcement strips unknown fields before application code sees them ([processing model](https://docs.ag-ui.com/spec/1.0/basic/processing.md)). That loss is required, and the guarantee does not say a recipient protocol may drop what it cannot carry, except by a stretch of "policy forbids".

### Guarantee 7. Plugins stay within the plugin API

- **Counterexample:** An A2A Interface must sign a webhook. An MCP App UI must be fetched from its tool source. A guardrail must hold a stream. The model asks to load a plugin. None of these is something the plugin API lets a plugin do.
- **Verdict:** gap.
- **Why:** The guarantee can be kept only by not building those features. The rung requires them. Staying inside an incomplete API is not a pass.

### Guarantee 8. Approval fails closed

- **Counterexample:** A payment call waits for days on a durable Runtime. The owner's authority is revoked. The owner had already pressed allow, or presses it after the revoke. Or the user rewinds, and the late allow still runs the payment on the old branch. Or the Provider runs a tool the class policy did not name, and the system can only record it after the fact.
- **Verdict:** strains.
- **Why:** Fail closed holds for a missing answer and for "never ask". It does not say a late allow is checked again against current authority, the current branch, and the call as it now stands. Provider-run tools are allowed as a class, so one unexpected call cannot fail closed.

### Guarantee 9. Authority only narrows

- **Counterexample:** A child agent may not spend. Its parent has handed the session to a human and also cannot spend. The child's payment request names a tenant specialist who can spend. The specialist allows it. The payment runs in the child's session.
- **Verdict:** strains.
- **Why:** The child's own authority did not grow. The effect is a spend the parent could not approve. "Who may answer" can name that specialist (`docs/contracts.md` Input request). Nothing says the named answerer must be inside the authority the parent was allowed to pass on.

### Guarantee 10. Differences are declared

- **Counterexample:** One Interface streams every chunk as it arrives. Another holds output until a guardrail can see a whole account number. Neither difference is in the declaration table. A host cannot learn which it will get. A third agent cancels a turn and assumes jobs keep running, because that is still open, so the difference is silent.
- **Verdict:** strains.
- **Why:** The table covers the features it lists, and each has a fallback (`docs/architecture.md` Declared support). The rung's remaining differences are not on the list, so guarantee 10 does not catch them.

### Actor

- **Counterexample:** The editor user and the web user both type a steering message while a turn is running. A scheduler, as a third actor, delivers the morning check at the same moment.
- **Verdict:** gap.
- **Why:** Each input can record its actor. Nothing says which one is taken, whether both start exchanges, or what the scheduler does if a person is already steering. Scenario 11 leaves two actors steering at once open.

### Authority

- **Counterexample:** A session owner sets approval to "always allow". An administrator has banned that. The ladder says the administrator's limit wins. Nothing says the setting change is refused, or what the running turn does if it was already changed.
- **Verdict:** strains.
- **Why:** The narrowing rule is stated (`docs/architecture.md` Actors and authority). How it is checked is open. A builder can store the session setting and never compare it with the administrator's ban.

### Exchange

- **Counterexample:** The user asks for a summary. That exchange starts a dev server job and then ends its turn. The server runs for a week. The user sends three more messages, each a new exchange. The server then crashes. Its report must start a turn in the first exchange, while a later exchange's turn is running.
- **Verdict:** gap.
- **Why:** A job's report starts a turn in the exchange that started the job (`docs/architecture.md` Jobs). An indefinite job keeps that exchange waiting (`docs/contracts.md` Exchange lifecycle). One Runtime at a time per session is only proposed. AG-UI would have closed its run at the interrupt or at the frontend tool. Our exchange is still open. The two end points are not related.

### Job

- **Counterexample:** An editor uses ACP v2. The user cancels the foreground prompt. The spec says listed background work keeps running (`session/cancel` does not cover it). Closing the session does stop it. Our docs say closing a session stops jobs, and leave turn-cancel open. A remote A2A task, mapped as a job, is cancelled when the session closes, even if the user wanted that other agent to keep working.
- **Verdict:** gap.
- **Why:** `docs/architecture.md` line 299 and `docs/open-questions.md` Work outside a turn disagree on whether a job can outlive the session. ACP v2 needs a fixed answer: turn cancel leaves background work, session close stops it. A2A tasks are cancelled on their own and can sit in `INPUT_REQUIRED` with no foreground turn. Our cancel targets the running turn (`docs/contracts.md` Interface and Harness). If no turn is running, cancel has no stated effect.

### Declaration

- **Counterexample:** A host reads the declaration and drives the agent as it drives Pi. The agent streams secrets before the gate can see them, and cancels jobs when a turn is cancelled. Neither behaviour was declared, and neither has a stated fallback.
- **Verdict:** strains.
- **Why:** The declaration is precise for the features it lists. It is not a complete list of the differences this product has. Guarantee 10 then fails for anything left off the list.

### Output gate

- **Counterexample:** The model streams an account number as separate chunks: "ACCT", "4491", "8821". Each chunk is an event, "model output arriving". The gate's answers are let through, redact, or block. No chunk is the secret by itself, so each is let through. The web app shows the number. The gate then sees the finished text and redacts it, too late.
- **Verdict:** gap.
- **Why:** The gate is the right place (`docs/contracts.md` Hook points). Its answers do not include holding output until a decision is possible. The architecture also says Interfaces show work as it happens. Both cannot be met for a split secret unless holding is allowed. AG-UI already refuses to act on tool arguments until the call closes, which is a hold. Our gate has no such rule.

### Open tool call

- **Counterexample:** A durable Runtime has waited three days for approval of a payment. The user rewinds to before that call. The working environment restores the files. The Provider is told to discard state, because it cannot rewind. The approval then arrives. Guarantee 4 still needs exactly one result. Nothing says the call is cancelled, the result is ignored, or the payment must not run.
- **Verdict:** gap.
- **Why:** An open call is defined (`GLOSSARY.md` Open tool call). Rewind talks about the Runtime, the Provider, and files (scenario 14). It does not mention open calls, jobs, or input requests. MCP MRTR makes this sharper: the tool source may hold opaque `requestState` that must be echoed exactly on retry. Discarding or rewinding without that state leaves the call with no way to finish, and no stated result.

### Live session

- **Counterexample:** The user is in a voice session. The Provider is speaking. The user interrupts after 1.5 seconds. An editor on the same session sends a steering prompt. ACP v2 says the agent must not reject that prompt only because work is running. Voice interruption and editor steering are different, and both hit one live session.
- **Verdict:** strains.
- **Why:** A live session can carry both directions and an interruption (scenario 13). It does not say whether an editor's input is an interruption, steering, or a second turn. The open question on live sessions asks whether the voice session is one turn. Until that is answered, two Interfaces on one live session cannot be built without guessing.

### Current position

- **Counterexample:** The session is rewound. An in-flight shell command, started on the old branch, then writes files into the restored tree. The current position says the session is at the earlier point. The files are not.
- **Verdict:** gap.
- **Why:** Current position is a recorded move, and the view leaves out the other branch (`docs/architecture.md` History). File rewind is optional and can be refused. Nothing stops work that already started from writing after the files move. The position and the working environment then disagree.

### Erasure

- **Counterexample:** A user's name is in history, in a summary, in a Provider prompt cache, in a durable Runtime's progress record, and in an A2A webhook payload that failed and will be retried. Erasure removes the history copies and asks the Provider to discard conversation state. The Provider keeps no conversation state, so it answers "I keep none". The cache still holds the rendered conversation. The retry then POSTs the old payload.
- **Verdict:** gap.
- **Why:** `docs/architecture.md` History lists entries, summaries, forks, exports, and Provider conversation state. OpenAI's prompt cache stores the rendered conversation, including history, and is on by default. It is not conversation state. A2A requires at least one delivery attempt and allows duplicates, so a retry is still in reach. The erasure list does not name it. Scenario 15 covers a push already sent, not one still queued.

### Ephemeral session

- **Counterexample:** A voice session has no history store, so it is ephemeral. The user asks for erasure of what was said. The process is still running, so the Harness still holds the history. Erasure is defined on the history store. There is no store.
- **Verdict:** strains.
- **Why:** "Gone when the process stops" is clear (`GLOSSARY.md` Ephemeral session). Erasure while the process is still up is not. A product that must delete on request cannot wait for the process to stop, and cannot ask a store that is not there.

### Host

- **Counterexample:** T3 Code drives this agent over ACP v2, while a web app on the same session uses AG-UI. The host gives input with a key. ACP v2 says a lost prompt response leaves the outcome uncertain, and a retry can insert another message. The host's key is our rule, not ACP's. The web app then answers an approval the host is also showing.
- **Verdict:** strains.
- **Why:** The host rules fit a host that speaks our Interface (`docs/architecture.md` Being driven by a host; scenario 17). They do not say how two outside protocols share one session, or that an ACP retry must use the same key. The host can still drive one Interface. It cannot, from these docs, share the session with AG-UI without a second set of rules.

## New findings

### A redacted view contradicts intact passing

- **Feature or situation:** A colleague may watch a session. A tool result contains a secret. The colleague must not see it. The owner must. The record must keep it until erasure.
- **Described as:** Output gate; "different recipients may see different views"; guarantee 6; scenario 11.
- **Verdict:** breaks.
- **Assumptions or guarantees affected:** Guarantee 6. Change 6. A26.
- **Evidence:** `docs/architecture.md` lines 337–339 and guarantee 6. Scenario 11 step 4 redacts for the colleague only. The gate's answers include redact (`docs/contracts.md` Hook points). "Passed on intact unless policy forbids passing it on" does not describe a changed copy. AG-UI's processing model also requires stripping unknown fields before application code sees them, so an AG-UI Interface cannot pass every part on intact.
- **Suggested change:** Say the record keeps content unless erasure or retention removes it. A recipient's view may omit or redact, and that is not a loss of the record. When a recipient cannot carry a part, say so rather than pretending it was passed on.

### The output gate cannot redact a live stream in time

- **Feature or situation:** A model streams an account number in small chunks to a web app, an editor, and a telemetry plugin. A guardrail must stop the number before anyone who should not see it receives it. Users still expect to see ordinary text as it is produced.
- **Described as:** Event "model output arriving"; output gate answers let through, redact, or block; plugins follow events; Interfaces show work as it happens.
- **Verdict:** gap.
- **Assumptions or guarantees affected:** Guarantee 2. Guarantee 6. Change 6. A25. A30.
- **Evidence:** `docs/contracts.md` Hook points gives the gate three answers, and none is hold. The same document says model output arrives as it is produced, and only Interface events are said to pass the gate. `docs/architecture.md` History says streaming output is live only. AG-UI will not let a consumer act on tool-call arguments until the call closes, which is the missing hold.
- **Suggested change:** Say the gate may hold live output until it can decide, and that every observer who is not allowed to see the raw stream sees the gated view. Say whether a record of what was actually delivered is required.

### Two actors can steer and answer at once

- **Feature or situation:** An owner in an editor and a colleague on the web both send steering input during a turn. An approval is open. The host answers it for the user, and the owner answers it too. One allow and one refuse arrive together. The colleague's UI is or is not told, depending on which document you read.
- **Described as:** Several actors; give input during a turn; input request "who may answer"; scenario 11; scenario 17.
- **Verdict:** gap.
- **Assumptions or guarantees affected:** Guarantee 4. Guarantee 8. Change 1. A20. A21.
- **Evidence:** `docs/open-questions.md` Several actors leaves two steerers, and approval by someone who did not start the turn, open. Scenario 17 has the host answer for the user. Scenario 11 shows the approval on the colleague's UI. `docs/contracts.md` line 269 says only Interfaces for actors who may answer are told. ACP v2 allows prompts while work is running and does not reject them for that reason alone. It does not pick a winner between two clients.
- **Suggested change:** Say what happens when two actors give input at once. One answer closes a request. Any other answer is refused. Say whether the answerer must be the actor who started the turn, or any actor the request names who still has the authority. A watcher may see that an approval exists without being able to answer it.

### Erasure misses caches, progress records, and queued pushes

- **Feature or situation:** A valid deletion request covers a name that appears in history, a summary, a Provider prompt cache, a durable Runtime's own progress record, and an A2A webhook body that will be retried after a failed delivery.
- **Described as:** Erasure of entries, summaries, forks, and exports; discard Provider conversation state; report copies already sent.
- **Verdict:** gap.
- **Assumptions or guarantees affected:** Guarantee 3. Change 5. A23.
- **Evidence:** `docs/architecture.md` History, the erasure bullet, lists those copies and stops. `docs/contracts.md` discard state may answer "I keep none". OpenAI prompt caching stores the rendered conversation, including history, and is on by default, even when the Provider keeps no conversation state. A2A section 4.3 requires at least one delivery attempt and tells clients to expect duplicates. A retry has not yet been sent, so it is not "already sent", and it is not in the erasure list. `docs/open-questions.md` Erasure scope asks what counts as a copy and does not name caches, progress records, or queued pushes.
- **Suggested change:** Name those copies. A Provider that caches prompts is asked to drop the cached copy, not only conversation state. A durable progress record is a copy the agent controls. A delivery not yet accepted is cancelled or replaced, not reported as out of reach.

### Rewind, an open call, a durable Runtime, and a stateful Provider

- **Feature or situation:** A payment has been waiting for approval for days. The user rewinds to before that call, files included. The Provider keeps conversation state and cannot rewind it, so it is told to discard state. The approval then arrives. An in-flight command writes into the restored files.
- **Described as:** Move to a point; discard Provider state; open tool call; durable Runtime; working environment save and return.
- **Verdict:** gap.
- **Assumptions or guarantees affected:** Guarantee 4. Guarantee 8. Change 2. Change 7. A31.
- **Evidence:** Scenario 14 rewinds the Runtime, the Provider, and files, and refuses only when a part cannot rewind or discard. It does not mention open calls or jobs. `docs/architecture.md` History says files can be rewound with the position. Nothing stops work that already started. MCP MRTR needs the same opaque `requestState` on the retry. Discarding Provider or plugin state can make that retry impossible, and the call then has no stated result.
- **Suggested change:** Before a rewind changes anything, open calls and jobs are cancelled, left on the old branch, or the rewind is refused. A late answer does not run the action on the new branch. In-flight work in the working environment is stopped or the rewind waits for it.

### Jobs, exchanges, and outside protocols do not share a lifetime

- **Feature or situation:** One session serves an editor over ACP v2, a web app over AG-UI, and another agent over A2A. A dev server outlives the prompt. An A2A task sits in `INPUT_REQUIRED` after its turn has ended. The user cancels only the foreground work. Later they close the session. A job report then tries to start a turn in an exchange that other work has moved past.
- **Described as:** Jobs; exchange waiting; cancel the running turn; close the session, which stops jobs; a job report starts a turn in the exchange that started the job.
- **Verdict:** gap.
- **Assumptions or guarantees affected:** Guarantee 1. Change 3. Change 4. A9. A10. A27.
- **Evidence:** `docs/architecture.md` line 299 says closing a session stops jobs. `docs/open-questions.md` Work outside a turn asks whether a job can outlive the session, and whether turn cancel stops jobs. ACP v2 prompt lifecycle: `session/cancel` does not stop listed background work; `session/close` does. ACP v2 tool calls: work that continues should keep the tool call unfinished, and a final status is not reopened. Scenario 16 ends the tool call with "job started" while the server keeps running. A2A: many tasks share one context, and `INPUT_REQUIRED` is not a finished task. Our cancel answers "the turn ends as cancelled", which says nothing if no turn is running. AG-UI closes the run on an interrupt and continues in a new run.
- **Suggested change:** Pick one rule and delete the other. State that cancelling a turn does not cancel jobs, and closing a session does, or declare the difference. Say when an exchange ends if its job runs on. A job report starts a turn only when no turn is running, or the description must allow two. An outside task that is waiting is an exchange or a job with its own cancel, not "cancel the running turn". An Interface may show a job as a still-open tool call without that being a second result.

### The glossary disagrees with the architecture

- **Feature or situation:** A builder implements a tool call from the glossary, and a credential hand-off from the glossary, while another builder follows the architecture.
- **Described as:** Glossary definitions of tool call and credential store; architecture tool source and credential store; contracts intro on unanswered requests.
- **Verdict:** breaks.
- **Assumptions or guarantees affected:** Guarantee 1. Guarantee 7. A17. A18.
- **Evidence:** `GLOSSARY.md` Tool call says it is a request from the model. `docs/architecture.md` Tool source says a UI or a plugin may start it. `GLOSSARY.md` Credential store names Providers and tool sources. `docs/architecture.md` Credential store also names working environments, and still omits Interfaces. `docs/contracts.md` line 9 says every interaction states what the asker assumes if there is no answer. "Open a session for writing" does not. After a network split, two writers can each believe they own the session.
- **Suggested change:** Make the glossary match the architecture. State the unanswered case for the single writer: if the answer does not arrive, do not write. Say whether an Interface may receive credentials for a declared purpose.

### MCP Apps still cannot be fetched or kept inside the user's authority

- **Feature or situation:** A tool result opens a dashboard. The dashboard's refresh tool is app-only and must not be shown to the model. The dashboard tries to call a model-only tool, or to read a UI resource from another server.
- **Described as:** Tool definition "how to show it" and "who may call it"; content type "other"; tool source lists tools and runs calls.
- **Verdict:** gap.
- **Assumptions or guarantees affected:** Guarantee 7. Guarantee 9. Change 9. A7. A26.
- **Evidence:** `docs/contracts.md` Harness and tool source has list and run, not fetch a resource. The MCP Apps spec, "Resource Discovery" and "Visibility", says the host must read the `ui://` resource, must hide app-only tools from the model, and must reject an app call to a tool the app may not call. Our docs never say that showing a result does not give the embedded UI the user's authority.
- **Suggested change:** Let an Interface fetch a tool source's presentation resources. Keep who may call a tool, who may see it, and who may render it as separate facts. An embedded UI acts only with the authority the session gave that call, not with the user's full authority.

### A tenant budget can be spent twice, and a person cannot take over

- **Feature or situation:** Two sessions each see the same remaining tenant budget and both start work that costs more than what is left. A summarizer also spends money from a Provider, outside the Runtime's step. Separately, a customer is handed to a human. The human must stop automatic replies, including a job report and a morning schedule, then hand control back.
- **Described as:** Usage totalled for a tenant; authority ladder; scheduling as an actor; job report starts a turn; "before a turn" adds context only.
- **Verdict:** gap.
- **Assumptions or guarantees affected:** Guarantee 9. Change 1. A21. A28.
- **Evidence:** `docs/contracts.md` Usage totals tenant spend after the fact. Nothing reserves budget before the spend. `docs/open-questions.md` Turn limits leaves tenant budgets against session limits open. `docs/contracts.md` Hook points: "before a turn" cannot refuse the turn. A schedule is an actor that gives input (`docs/architecture.md` Jobs). Nothing stops that input while a human holds the session.
- **Suggested change:** Say that a budget is checked before the spend, against the work that will actually run, including a summarizer's model request. Say who holds control of a session, and that while a human holds it the agent starts no turn from a job, a schedule, or a child unless the human asked.

### Skills read a different tree from the tools

- **Feature or situation:** The shell runs in a remote sandbox. The sandbox expires during a long approval. A replacement sandbox has different files. The skills plugin and the system prompt still read `AGENTS.md` from the local project folder.
- **Described as:** Working environment for tools; project for context files, skills, and prompt templates; environment loss marks work unknown.
- **Verdict:** gap.
- **Assumptions or guarantees affected:** Change 8. A5. A7.
- **Evidence:** `docs/architecture.md` Working environment says tools use it, and that it is separate from the project, which skills and prompts read. `GLOSSARY.md` Project repeats that split. Loss is described for work that depended on the environment, not for which tree a skill reads. The original counterexample in round 1 F13 still happens by following the new definitions.
- **Suggested change:** Say which tree skills, prompts, and context files read when the working environment is not the project. If they must follow the tools, say so. If the environment is lost, pending work fails or is marked unknown, including a call that was waiting on approval.

## Top changes

1. Say the record stays intact, and a recipient's view may omit or redact. The output gate may hold live output until it can decide. Observers who must not see the raw stream see the gated view.
2. Say what happens when two actors steer or answer at once. One answer closes a request. A late allow does not authorize a changed, rewound, or revoked action. Say whether the answerer must be the actor who started the turn.
3. Say which copies erasure reaches: Provider prompt caches, durable progress records, and deliveries not yet accepted. A queued retry must not send erased content. A copy already delivered is out of reach.
4. Say what rewind does to open tool calls, jobs, input requests, and Provider state. Stop in-flight work before files move, or refuse the rewind. A late result does not become new work on the new branch.
5. Make job and exchange lifetime one rule. Say whether a job can outlive its exchange and its session. Cancelling a turn does not cancel jobs unless the agent declares that it does. Closing a session stops them, or the agent declares otherwise. A job report must not start a second turn while one is running, unless the description allows it.
6. Let an Interface fetch a tool source's presentation resources, run tools it owns, and use credentials for a declared purpose. An embedded UI does not gain the user's authority. Say which tree skills and prompts read when the working environment is not the project.
7. Make the documents agree. A tool call need not come from the model. The credential store's users match across the glossary and the architecture. If an open question is still open, the architecture must not state the opposite as a requirement. The single history writer does not write if the answer does not arrive.

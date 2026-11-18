# Shared data: `modular-agent-data/1`

The JSON shapes for the [information in Contracts](../contracts.md#information), for every binding that carries it between builds: the [plugin binding](plugin.md) above all. A build keeps whatever shapes it likes inside, and translates at the wire.

## General rules

- **Field names are camelCase.** A field marked *(optional)* may be left out; `null` means the same as leaving it out.
- **Unknown fields are kept.** A receiver passes on, and returns, fields it doesn't know, so a newer sender loses nothing through an older build.
- **Identities are strings,** unique in their scope. Times are milliseconds since 1970, as numbers.
- **Text is UTF-8.** Where a length is counted, it is in Unicode code points.

## Content

Content is an array of parts. Every part has a `type`.

| `type` | Fields |
|---|---|
| `text` | `text` |
| `image` | `data` (base64), `mimeType` |
| `reasoning` | `text` *(optional; only when it is readable)*, `providerData` *(optional; opaque, for the Provider that wrote it)* |
| `toolCall` | `id`, `name`, `arguments` (an object) |
| anything else | its own fields, kept as they arrived |

A receiver that doesn't understand a part keeps it, and never shows `providerData` as text.

## Messages

| `role` | Fields |
|---|---|
| `user` | `content` |
| `assistant` | `content`; `stop`; `usage` *(optional)*; `model` *(optional)*, as `{ provider, id }`; `error` *(optional)*; `providerData` *(optional)* |
| `toolResult` | `toolCallId`, `toolName`, `content`, `isError` |

- `stop` is `finished`, `toolUse`, `length`, `refused`, `failed` or `aborted`.
- `error` is `{ kind, message }`, where `kind` is `temporary`, `contextTooLarge`, `credentials`, `refused` or `other`.
- **Usage** is `{ input, output, cacheRead, cacheWrite, cost }`: plain numbers that add up. Cost is in US dollars, and 0 when unknown.

## Models

**ModelInfo:** `provider`, `id`, `name` *(optional)*, `contextWindow`, `maxOutput`, `input` (an array such as `["text", "image"]`), `reasoning` (boolean), `thinking` *(optional; the levels it accepts, from `off`, `minimal`, `low`, `medium`, `high`, `xhigh`)*.

**ModelRequest:** `systemPrompt`, `messages`, `tools` (ToolDefinitions), `settings`. `settings` is `{ reasoning?, maxOutput? }`, plus any fields of the build's own.

**A stream event** is `{ type: "text" | "reasoning" | "toolInput", delta }`. A stream ends when the request it belongs to is answered; there is no end event.

## Tools

**ToolDefinition:**
- `name`, `description`, `parameters` (JSON Schema);
- `returns` *(optional; JSON Schema)*;
- `hints` *(optional)*: `{ readOnly?, destructive?, openWorld?, safeToRepeat? }`. A missing hint is read cautiously (see [MCP servers](../contracts.md#mcp-servers)). `safeToRepeat` is a promise, not a hint ([Recovery](../contracts.md#recovery-and-repeating-work)).
- `parallel` *(optional)*: `true` when the tool may run alongside other calls;
- `callers` *(optional)*: who may call it, from `model`, `ui` and `plugin`. Left out, anyone may; an empty array, no one. A call started by a `provider` counts as `model`, and one started by a `tool` as `plugin`.

**ToolCall:** `id`, `name`, `input` (an object), `startedBy` (`model`, `provider`, `ui`, `plugin` or `tool`), `actorId` *(optional)*, `stepId` *(optional)*.

**ToolResult:** `callId`, `status`, `content`, `value` *(optional; structured data)*. `status` is `completed`, `failed`, `refused`, `cancelled`, `notStarted` or `outcomeUnknown`.

**A call left open** answers `{ pending: "<why>" }` instead of a ToolResult.

## Questions

**InputRequestDraft**, what an asker sends:
- `kind`: `approval`, `choice`, `text`, `link` or `secret`;
- `question`;
- `details`, `options`, `timeLimitMs`, `key` *(all optional)*;
- `whenTimeLimit` *(optional)*: `decline` or `leaveOpen`;
- `credential` *(optional; secrets only)*.

**InputRequest** adds `id`, `sessionId`, `toolCallId` *(optional)* and `answerable`.

**Answer:**
- `requestId`, `actorId`;
- `value` *(optional)*, `declined` *(optional)*, `reason` *(optional)*;
- `pending` *(optional)*: the question was left open past its turn;
- `stored` *(optional)*: for a secret, the name it was kept under.

## Working environment

**ExecResult:** `exitCode` (a number, or `null` when killed), `output`, `timedOut`.

## Actors

**An Actor** is `{ id, kind, rights }`. `kind` is `user`, `host`, `agent` or `plugin`. `rights` is an array of these names ([Authority](../contracts.md#authority)):

| Right | Lets the actor |
|---|---|
| `watch` | see the session and follow its events |
| `propose` | give input that waits for another actor to release it |
| `input` | give input that starts or steers a turn |
| `answer` | answer questions |
| `approve` | answer approvals |
| `tools` | have tools run for it: the model's calls in turns it started, and calls it starts from a UI |
| `cancel` | cancel turns and jobs |
| `settings` | change the session's settings |
| `erase` | erase entries |
| `grant` | give other actors rights it has |
| `jobs` | start jobs |
| `delegate` | start subagents |
| `administer` | set the session's limit ([Limits and tenants](#limits-and-tenants)) |

A receiver keeps a right it doesn't know, and grants nothing for it.

**An actor's effective rights** are its own rights, narrowed by the session's limit and by its tenant's limit, if either is set. Every check uses the effective rights, at the moment of the action.

## Limits and tenants

**A session's limit** is a ceiling on the rights of every actor in it. It is a `limit` entry, and only an actor with `administer` may write one, never giving a right outside its own effective rights. A new `limit` replaces the old one; with no `limit`, there is no ceiling. Lowering the limit takes effect at once, including for a running turn's next action.

**A tenant** is a group of sessions under one administration, such as one customer of a hosted agent. A session's tenant is chosen when the session is created, recorded as a `tenant` entry first in the session, and never changes. Each tenant has:
- `rights`: a ceiling on every actor in every session of the tenant;
- `tokens` *(optional)*: a budget of input plus output tokens across all the tenant's sessions, counted from the usage every turn records.

Tenants are defined in the agent's own configuration, outside any project, so a project can't change them. A build that supports them reads the environment variable `MODULAR_AGENT_TENANTS`, a JSON object from tenant name to `{ rights, tokens? }`, as well as any way of its own. A session created in a tenant the agent doesn't know is refused.

**The budget:** a turn starts only while the tenant's used tokens are below its budget. Otherwise it ends at once, without a model request, with outcome `{ kind: "limit", limit: "tenantTokens" }`. A turn running when the budget is reached ends after the step that reached it, with the same outcome. Reopening a session in another build counts what the history records.

Limits, tenants and grants are records of authority: they can't be erased.

## Output events

What the output gate is given ([plugin binding](plugin.md#the-host-asks-a-hook-handler), `output`), and what a gate may give back. Each event is `{ type, data }`:

| `type` | `data` |
|---|---|
| `text` | `{ delta, stepId? }`: model text |
| `reasoning` | `{ delta, stepId? }`: readable reasoning |
| `toolCall` | `{ call }`: a ToolCall, as it starts |
| `toolOutput` | `{ toolCallId, chunk }`: a tool's streamed output |
| `toolResult` | `{ toolCallId, status, content }` |
| `entry` | `{ entry }`: a history entry, as sent to a recipient, such as in a replay or a page of history |
| `turnEnded` | `{ turnId, outcome, result }`: as on a `turnEnd` entry |
| `reply` | `{ method, result }`: the answer to a recipient's own request |
| a build's own, containing a dot | its own |

- **One stream** is the `text` and `reasoning` events of one model response, or the `toolOutput` events of one call. The gate gets the whole stream at once, so text split across pieces can be checked as one.
- **A gate passes on what it doesn't understand.** It may redact strings anywhere in an event's `data`, and must leave everything else, and every event type it doesn't know, unchanged. A gate that fails blocks.
- **Mapping is the host's job.** A host translates its own events to these shapes before a remote gate sees them, and translates the gate's answer back. A host that can't map a changed event back blocks it, failing closed.

## Credentials

**A Credential** is an object with a `type`:
- `apiKey`: `key`;
- `oauth`: `accessToken`, `refreshToken` *(optional)*, `expires` *(optional; a time)*;
- anything else: its own fields, kept as they arrived.

A credential store that holds a bare string gives it as `{ "type": "apiKey", "key": "<the string>" }`.

## History entries

**Every entry has:**
- `id`, `parentId` (or `null`), `sessionId`, `kind`, `time`;
- `writer`: which part or plugin wrote it;
- `modelVisible` (boolean);
- *(where they apply)* `turnId`, `stepId`, `toolCallId`, `jobId`, `actorId`;
- *(where they apply)* `message`, `data`, and `sources` (the ids of entries it copies).

**These kinds have fixed meanings and `data`:**

| `kind` | Carries |
|---|---|
| `inputAccepted` | `actorId`; `data.inputId`; `data.key` *(when keyed)*; `data.when` (`now`, `steer`, `after` or `propose`); `data.releasedBy` *(for proposed input, once released)*; `data.content`. Written when input is admitted, before any turn takes it: the receipt. |
| `inputHandedBack` | `data.inputIds`: accepted input no turn will take, handed back to the Interface, for example by a cancel |
| `input` | `message` (user); `turnId`; `actorId`; `data.inputId`, and `data.key` when keyed. It is written when the input is taken, by a turn or as steering. An `inputAccepted` with the same `inputId` comes before it, except for a job's report. |
| `turnStart` | `data.startedBy`: `{ kind: "actor" | "job" | "plugin" | "answer", id }`. Also what the turn started with ([Settings](../contracts.md#settings)): `data.model` (`{ provider, id }`), `data.system` (the system prompt, with what "before a turn" added to it), `data.context` *(optional; content "before a turn" added to the context)*, `data.tools` (the ToolDefinitions offered) and `data.settings` (`{ maxSteps?, reasoning?, maxOutput? }`). "Before a turn" runs before it is written. `data.point` *(optional)*: the working environment's saved point from just before the turn ran, for [rewinding](#rewinding). |
| `modelRequest` | `stepId`; `data.model` (`{ provider, id }`); `data.safeToRepeat`: `true` only if the Provider keeps no state and runs no tools, or promises its requests are safe to repeat. Written before a step's request is sent, so a crash between it and its `response` means the request may have reached the Provider. |
| `response` | `message` (assistant); `stepId` |
| `toolStarted` | `toolCallId`; `stepId` *(where it applies)*; `data.call` (a ToolCall); `data.safeToRepeat`: `true` only if the tool's definition and the working environment both promised it when the call started. `data.point` *(optional)*: for a call outside a turn, such as one an Interface starts, the saved point from just before it ran. |
| `toolResult` | `message` (toolResult); `toolCallId`; `data.status` |
| `inputRequest` | `toolCallId` *(where it applies)*; `data.request` (an InputRequest) |
| `inputAnswer` | `toolCallId` *(where it applies)*; `data` is the Answer. A question closed without an actor's answer has `declined: true` and `data.reason`: `timeLimit`, `cancelled` (its turn or call was cancelled), `noLongerAnswerable` (no actor who may answer is left, or the process that asked stopped and nothing can ask again) or `refused` (an approval refused with nobody present). |
| `turnEnd` | `data.outcome`: `{ kind: "completed" | "failed" | "cancelled" | "limit", error?, limit? }`; `data.result`: `{ text?, value?, openToolCalls }`, where `openToolCalls` lists call ids; `data.usage` |
| `summary` | `data.summary` (text); `sources` |
| `setting` | `data.key`, `data.value`. The key `settings` sets several at once: its value is an object of them. |
| `actorJoined` | `data.actor`: `{ id, kind, rights }`. Joining again replaces the actor's rights. |
| `actorLeft` | `data.actorId` |
| `limit` | `actorId` (the administrator); `data.rights`: the session's new ceiling, or `null` for none |
| `tenant` | `data.tenant`: the tenant's name. The first entry of a session created in a tenant. |
| `jobStarted` | `jobId`; `toolCallId` *(where a call started it)*; `actorId`; `data.rights`: the effective rights the job acts with, the rights every actor behind the work shared when it started; `writer` is the plugin that owns the job, by its registered name; `data.kind` (the plugin's word for it, such as `subagent`); `data.key` *(optional)*; `data.detail` (the plugin's own, kept as it is) |
| `jobEnded` | `jobId`; `data.outcome`: `{ kind: "completed" | "failed" | "cancelled", error? }`; `data.result` *(optional; content)*; `data.report` (boolean): whether the result is reported as input |
| `plugins` | `data.active`: `[{ name, origin? }]`, the plugins active when the session was opened or reopened. Written when the set differs from the last `plugins` entry. |
| `position` | `data.to` (an entry id, or `null`) |
| `erasure` | `data.entryIds` |

Other kinds are the build's own. A receiver keeps them and needn't understand them. A build's own kinds should contain a dot, such as `go.snapshot`, so a later standard kind never collides with one.

An erased entry keeps only `id`, `parentId`, `kind` and `erased: true`, plus whichever of `turnId`, `stepId`, `toolCallId` and `jobId` it had. Those identities aren't content: they let a reader see that an erased result still settled its call.

**A question's key** when the asker gives none, for a question a tool call asks, is `call:<toolCallId>:<n>`, where `n` counts the questions that call asked, from 1, in the order it asked them. So a call run again finds its earlier answers in any build.

**A job's report** is an `input` entry with `data.key` `job:<jobId>`, kept after its `jobEnded`. Its content is the job's `result`, exactly as the job ended with it: the host adds no framing, so the model sees the same report whichever build takes it. The turn it starts has `startedBy` `{ kind: "job", id: <jobId> }`.

**Setting keys** with fixed meanings: `model` (`{ provider, id }`), `reasoning`, `maxSteps`, `maxOutput`, and `approval`: `off`, `ask`, `all` or `never`, as the [ACP binding's](acp.md#configuration-options) approval option. A receiver ignores other keys it doesn't know. A build that reopens a session with no `approval` setting, or one whose value it doesn't offer, uses `all`, asking before every call, until an actor with `settings` chooses: it never runs tools with less checking than the session's owner chose. Approval fails closed, so with nobody present to answer, a call is refused.

## Portable sessions

A build that declares `portableSessions` can reopen a session that another such build wrote, in any language, through a shared history store ([history service](history-http.md)). It can replay the session, run new turns in it, answer its open questions and recover its interrupted turn.

**What a build that declares it does:**
- **It writes every entry in the shapes above,** to whatever history store it uses: `sessionId`, not a name of its own; times as numbers; ids as strings.
- **It records each meaning above with its standard kind,** and needs nothing else to reopen a session. It may also write kinds of its own, but only as caches: reopening without them must give the same session. Another build keeps them and ignores them.
- **It reads a session the same way as every other build:**
  - **The current branch.** Each entry becomes the head when it is kept, except a `position` entry, which moves the head to its `data.to` and isn't on any branch itself. The branch is the head and its ancestors, through `parentId`.
  - **Settings and actors** are the session's, not the branch's: the latest `setting` for each key, and the latest `actorJoined` for each actor not since `actorLeft`, in the order the entries were kept.
  - **Keys:** every `inputAccepted` or `input` with a `data.key`, on any branch, until it is erased. A key whose input was handed back is still known, and still gives its first receipt.
  - **Queued input:** an `inputAccepted` with no `input` and no `inputHandedBack` naming it. The latest `inputAccepted` for an `inputId` says its state: proposed input waits for a release. After a restart it is run or handed back, as the reopening build declares (`queuedInputAfterRestart`).
  - **The model context** is the branch's model-visible messages, after the latest `summary` on the branch in place of the entries it names.
  - **A model request in flight:** a `modelRequest` with no `response` for its step. It is repeated only if its `safeToRepeat` is `true`. Otherwise the turn can't carry on from that step, and ends as failed.
  - **An interrupted turn** is a `turnStart` on the branch with no `turnEnd`. Its calls without a `toolResult` are pending: started if there is a `toolStarted`, not started if they appear only in a `response`. Each started call may run again only if its `toolStarted` says `safeToRepeat`, and its tool and the working environment promise it now. A started call that doesn't run again gets `outcomeUnknown`, whatever anyone's authority is now: its result says what happened, not whether it may happen. So does one whose repeat is refused, or fails before it reaches the tool: nothing in that result is about the first attempt. A call that runs, again or for the first time, goes through every check, authority included.
  - **An open question** is an `inputRequest` with no `inputAnswer`. A call left open past its turn is in that turn's `turnEnd` `openToolCalls`, with no `toolResult`. Any actor in the session with the right to answer it may, not only the one it was first put to.
  - **Limits and tenants:** the latest `limit`, and the session's `tenant`, if it has one. A build that reopens a session whose tenant it doesn't know refuses to open it.
  - **A job's rights** are its `jobStarted` `data.rights`, narrowed by every limit now in force. A `jobStarted` without them gives the job no rights beyond `watch`.
  - **The model and settings.** If the session's `model` isn't one the reopening build offers, the session still opens, and every turn fails with the error kind `other` until an actor with `settings` chooses one: a build never substitutes a model silently. A standard setting the session never recorded takes the reopening build's default, except `approval`, below. A `reasoning` level the chosen model doesn't accept is lowered to the nearest level it does, never raised.
- **Order within a turn:** `turnStart`, then the input it took; then for each step a `response`, then a `toolStarted` before each call runs, and a `toolResult` when it ends; any `inputRequest` and `inputAnswer` as they happen; and `turnEnd` last. Steering input is an `input` with the running turn's id, kept before the next `response`.

**Jobs, plugins and erasure** are part of the promise too:
- **Jobs** are in the standard kinds. A job left unfinished by a stopped process stays unfinished: the reopening build never ends it by itself. Its plugin, if loaded, finds it with `host/jobs/unfinished` ([plugin binding](plugin.md#jobs)) and takes it up or ends it. A job belongs to its plugin by name, so the same plugin program loaded in another build owns it there too.
- **The plugins a session had** are in `plugins` entries. A build reopening another's session uses its own plugins, and records them.
- **Erasure** is: the `erasure` entry names what was erased, and any build honours it.

## Rewinding

A build that declares `rewinding` can move a session and restore the working environment as it was ([ACP binding](acp.md#extension-methods), `move` with `rewind`). Its working environment saves a point before each turn, and before each tool call outside a turn, and the point is recorded on that `turnStart` or `toolStarted` as `data.point`.

Rewinding to an entry restores the earliest point recorded after it on the current branch. If there is no such point, nothing outside changed since the entry, and nothing is restored. If an entry after it records work outside the working environment, such as a job, or a point the environment no longer has, the move is refused before anything changes. A point belongs to the working environment that saved it, and no other environment can restore it. So in a session reopened in another build, a rewind that needs a point saved by the first build's environment is refused.

**Rewinding is done in this order,** so a failure part way never leaves files and history disagreeing:
1. The build checks the point exists, and saves a new point of the files as they are now.
2. It restores the point.
3. It records the move. If recording fails, for example because the history lease was lost, it restores the point it saved in step 1, and the move is refused.

Rewinding is only to an entry on the current branch. A move with `rewind` to another branch is refused. A point lasts at least while its session is open; after that, it lasts as long as the working environment keeps it, and a point it no longer has refuses the move. Restoring changes the project's files, not effects outside it: a call past the point whose tool has `openWorld: true` isn't undone, and the move reports it as out of reach.

## Changes

- **2026-11-18, round six.** Limits and tenants (`limit`, `tenant`, the `administer` right, `MODULAR_AGENT_TENANTS`, the `tenantTokens` limit). Output events: a shared vocabulary for what the output gate is given (Rust R5-05, Go B30, Elixir R5-3). A job's rights on `jobStarted` (Go B29, Elixir R5-5). The order of a rewind, its branch and the life of a point (Rust R5-04, Python G78, Go B32, Elixir R5-6). A reasoning level the new model doesn't accept (Rust R5-03).
- **2026-11-18, after the round-five matrices.** A job's report is its result, unchanged. The Python agent framed the report of a job it took up in another build's session ("Job <id> reported ..."), so the model saw different text depending on which build took the job up.
- **2026-11-18, round five.** Jobs and plugins become portable: `jobStarted`, `jobEnded`, a job's report, and `plugins`. Rewinding: `data.point` on `turnStart` and `toolStarted`. Before this, jobs and plugins were each build's own kinds, and no build could rewind. From the gaps the builders logged in round four:
  - `inputAccepted` and `inputHandedBack`, so queued input and its keys survive a reopening in another build (Python G67, Go B19, Elixir M1-2);
  - `modelRequest`, so a crash during a model request can be told apart from one before it (Python G68, Go B23, Rust R4-02);
  - `turnStart` carries `data.context` (Go B23, Python G71);
  - why a question closed without an answer (Rust R4-04); the key of a question a call asks without one (Python G69, Elixir M3-3); who may answer an open question after a reopening (Go B20);
  - a recorded model the reopening build doesn't offer (Go B22, Rust R4-03);
  - a repeat that is refused gives `outcomeUnknown` (Python G77);
  - an erased entry keeps its identities (Go B21).
- **2026-11-18, after the real-model runs.** `approval` is a standard setting key. The Rust agent kept the approval policy under a key of its own, so the Elixir agent reopening its session fell back to its own default and refused a call the user had allowed. The other way round, a reopening agent whose default is `off` would have run tools the user wanted to approve.
- **2026-11-18, after the first portable-session swaps.** The names of rights, and what a started call that doesn't run again gets. TypeScript's actor had no `tools` right, because no names were defined, so the Rust agent reopening its session refused the interrupted call. The three clean-room builds had each chosen the same extra names (`tools`, `cancel`, `grant`, `jobs`, `delegate`); those are now the standard. Rust also recorded that started call as `refused`, though it had run.
- **2026-11-18, round four.** Portable sessions; Credentials; the kinds `toolStarted`, `inputRequest`, `inputAnswer`, `actorJoined` and `actorLeft`; what a `turnStart` carries; standard setting keys, and `settings` for several at once. From the round-three gaps: Rust B-09, Python G53 and Go B8 found three different credential shapes (`apiKey`, `value` and `key`); Python G54 and Go B10 both chose `settings` for a change of several settings.
- **2026-11-17.** First version. It collects the shapes the [ACP binding](acp.md) already used for entries and requests, and adds the rest.

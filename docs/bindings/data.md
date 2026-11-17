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

A receiver keeps a right it doesn't know, and grants nothing for it.

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
| `input` | `message` (user); `turnId`; `actorId`; `data.inputId`, and `data.key` when keyed. It is written when the input is taken, by a turn or as steering. |
| `turnStart` | `data.startedBy`: `{ kind: "actor" | "job" | "plugin" | "answer", id }`. Also what the turn started with ([Settings](../contracts.md#settings)): `data.model` (`{ provider, id }`), `data.system` (the system prompt), `data.tools` (the ToolDefinitions offered) and `data.settings` (`{ maxSteps?, reasoning?, maxOutput? }`). |
| `response` | `message` (assistant); `stepId` |
| `toolStarted` | `toolCallId`; `stepId` *(where it applies)*; `data.call` (a ToolCall); `data.safeToRepeat`: `true` only if the tool's definition and the working environment both promised it when the call started |
| `toolResult` | `message` (toolResult); `toolCallId`; `data.status` |
| `inputRequest` | `toolCallId` *(where it applies)*; `data.request` (an InputRequest) |
| `inputAnswer` | `toolCallId` *(where it applies)*; `data` is the Answer |
| `turnEnd` | `data.outcome`: `{ kind: "completed" | "failed" | "cancelled" | "limit", error?, limit? }`; `data.result`: `{ text?, value?, openToolCalls }`, where `openToolCalls` lists call ids; `data.usage` |
| `summary` | `data.summary` (text); `sources` |
| `setting` | `data.key`, `data.value`. The key `settings` sets several at once: its value is an object of them. |
| `actorJoined` | `data.actor`: `{ id, kind, rights }`. Joining again replaces the actor's rights. |
| `actorLeft` | `data.actorId` |
| `position` | `data.to` (an entry id, or `null`) |
| `erasure` | `data.entryIds` |

Other kinds are the build's own. A receiver keeps them and needn't understand them. A build's own kinds should contain a dot, such as `go.snapshot`, so a later standard kind never collides with one.

An erased entry keeps only `id`, `parentId`, `kind` and `erased: true`.

**Setting keys** with fixed meanings: `model` (`{ provider, id }`), `reasoning`, `maxSteps` and `maxOutput`. A receiver ignores keys it doesn't know.

## Portable sessions

A build that declares `portableSessions` can reopen a session that another such build wrote, in any language, through a shared history store ([history service](history-http.md)). It can replay the session, run new turns in it, answer its open questions and recover its interrupted turn.

**What a build that declares it does:**
- **It writes every entry in the shapes above,** to whatever history store it uses: `sessionId`, not a name of its own; times as numbers; ids as strings.
- **It records each meaning above with its standard kind,** and needs nothing else to reopen a session. It may also write kinds of its own, but only as caches: reopening without them must give the same session. Another build keeps them and ignores them.
- **It reads a session the same way as every other build:**
  - **The current branch.** Each entry becomes the head when it is kept, except a `position` entry, which moves the head to its `data.to` and isn't on any branch itself. The branch is the head and its ancestors, through `parentId`.
  - **Settings and actors** are the session's, not the branch's: the latest `setting` for each key, and the latest `actorJoined` for each actor not since `actorLeft`, in the order the entries were kept.
  - **Keys:** every `input` with a `data.key`, on any branch, until it is erased.
  - **The model context** is the branch's model-visible messages, after the latest `summary` on the branch in place of the entries it names.
  - **An interrupted turn** is a `turnStart` on the branch with no `turnEnd`. Its calls without a `toolResult` are pending: started if there is a `toolStarted`, not started if they appear only in a `response`. Each started call may run again only if its `toolStarted` says `safeToRepeat`, and its tool and the working environment promise it now. A started call that doesn't run again gets `outcomeUnknown`, whatever anyone's authority is now: its result says what happened, not whether it may happen. A call that runs, again or for the first time, goes through every check, authority included.
  - **An open question** is an `inputRequest` with no `inputAnswer`. A call left open past its turn is in that turn's `turnEnd` `openToolCalls`, with no `toolResult`.
- **Order within a turn:** `turnStart`, then the input it took; then for each step a `response`, then a `toolStarted` before each call runs, and a `toolResult` when it ends; any `inputRequest` and `inputAnswer` as they happen; and `turnEnd` last. Steering input is an `input` with the running turn's id, kept before the next `response`.

Erasure, jobs and plugins are outside this promise in `/1`:
- **Erasure** is: the `erasure` entry names what was erased, and any build honours it.
- **Jobs** are recorded in their plugin's own kinds. A session with an unfinished job reopens fully only in a build with a plugin that reads them.
- **The plugins a session had** are recorded however the build likes. A build reopening another's session uses its own plugins.

## Changes

- **2026-11-18, after the first portable-session swaps.** The names of rights, and what a started call that doesn't run again gets. TypeScript's actor had no `tools` right, because no names were defined, so the Rust agent reopening its session refused the interrupted call. The three clean-room builds had each chosen the same extra names (`tools`, `cancel`, `grant`, `jobs`, `delegate`); those are now the standard. Rust also recorded that started call as `refused`, though it had run.
- **2026-11-18, round four.** Portable sessions; Credentials; the kinds `toolStarted`, `inputRequest`, `inputAnswer`, `actorJoined` and `actorLeft`; what a `turnStart` carries; standard setting keys, and `settings` for several at once. From the round-three gaps: Rust B-09, Python G53 and Go B8 found three different credential shapes (`apiKey`, `value` and `key`); Python G54 and Go B10 both chose `settings` for a change of several settings.
- **2026-11-17.** First version. It collects the shapes the [ACP binding](acp.md) already used for entries and requests, and adds the rest.

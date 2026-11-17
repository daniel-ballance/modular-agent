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

**A stream event** is `{ type: "text" | "reasoning" | "toolInput", delta }`.

## Tools

**ToolDefinition:**
- `name`, `description`, `parameters` (JSON Schema);
- `returns` *(optional; JSON Schema)*;
- `hints` *(optional)*: `{ readOnly?, destructive?, openWorld?, safeToRepeat? }`. A missing hint is read cautiously (see [MCP servers](../contracts.md#mcp-servers)). `safeToRepeat` is a promise, not a hint ([Recovery](../contracts.md#recovery-and-repeating-work)).
- `parallel` *(optional)*: `true` when the tool may run alongside other calls;
- `callers` *(optional)*: who may call it, from `model`, `ui` and `plugin`.

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
| `input` | `message` (user); `data.inputId`, and `data.key` when keyed |
| `response` | `message` (assistant) |
| `toolResult` | `message` (toolResult); `data.status` |
| `turnStart` | `data.startedBy`: `{ kind: "actor" | "job" | "plugin" | "answer", id }` |
| `turnEnd` | `data.outcome`: `{ kind: "completed" | "failed" | "cancelled" | "limit", error?, limit? }`; `data.result`: `{ text?, value?, openToolCalls }` |
| `summary` | `data.summary` (text); `sources` |
| `setting` | `data.key`, `data.value` |
| `position` | `data.to` (an entry id) |
| `erasure` | `data.entryIds` |

Other kinds are the build's own. A receiver keeps them and needn't understand them.

An erased entry keeps only `id`, `parentId`, `kind` and `erased: true`.

## Changes

- **2026-11-17.** First version. It collects the shapes the [ACP binding](acp.md) already used for entries and requests, and adds the rest.

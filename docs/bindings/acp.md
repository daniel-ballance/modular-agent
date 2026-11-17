# ACP host binding: `modular-agent-acp/1`

How a host drives a Modular Agent over the [Agent Client Protocol](https://agentclientprotocol.com) v1. ACP covers sessions, prompts, streamed updates, permissions and cancelling. This binding fixes everything else a host relies on across builds:
- where the declaration and the input key go;
- how approvals and questions map onto ACP;
- the extension methods for what ACP has no method for;
- a conformance mode for testing.

Everything here is in addition to ACP v1. Where ACP already says how something works, this binding doesn't repeat it.

## Names

- All binding data in `_meta` lives under the key `"modular-agent"`.
- Extension methods are named `_modular-agent/<name>`. ACP reserves names that start with an underscore for extensions.

## Starting

The agent speaks ACP v1 over its stdin and stdout, one JSON-RPC message per line.

If the environment variable `MODULAR_AGENT_DATA_DIR` is set, the agent keeps all its state under that folder: history, settings, trust and anything else. Otherwise it uses its usual place. The conformance kit depends on this, so it can run each agent in a fresh, empty folder.

## `initialize`

The response's `agentCapabilities` say what ACP features the agent offers, as ACP defines:
- `loadSession`;
- `sessionCapabilities`: list, resume and close;
- `mcpCapabilities`;
- `promptCapabilities`.

Its `_meta["modular-agent"]` holds:

| Field | Value |
|---|---|
| `binding` | `"modular-agent-acp/1"` |
| `declaration` | the agent's [declaration](#the-declaration) |
| `extensions` | the names of the extension methods offered, without the prefix, for example `["history", "input", "requests", "answer"]` |
| `actor` | the actor the connection acts for: `{ "id": "...", "kind": "host" }` |

The connection acts for one actor. Whatever the client sends about itself, it can't choose another actor or widen this one's authority.

## The declaration

The declaration is an object with these keys. A build may add keys of its own, but must give every key listed, so a host never has to guess.

| Key | Type | Meaning |
|---|---|---|
| `inputDuringTurn` | boolean | Input can steer a running turn. |
| `waitingThroughRestart` | boolean | A turn waiting for an answer survives a restart. |
| `continuesAfterRestart` | boolean | An interrupted turn carries on after a restart. |
| `rewinding` | boolean | Moving can also restore outside state. |
| `forking` | boolean | Sessions can be forked. |
| `keepsStateAtProvider` | boolean | The session's Provider keeps conversation state. |
| `runsToolsAtProvider` | boolean | The Provider runs tools itself. |
| `liveSessions` | boolean | Voice or other live sessions. |
| `severalActors` | boolean | A session can have several actors. |
| `holdsOutput` | boolean | The output gate may hold streamed output. |
| `outputBypassesAgent` | boolean | Some output reaches recipients without passing the gate. |
| `cancellingTurnCancelsJobs` | boolean | Cancelling a turn also cancels its jobs. |
| `pluginsDuringSession` | boolean | Plugins can be added while a session is open. |
| `erasure` | boolean | Entries can be erased. |
| `inputKeys` | boolean | Input with a key is taken once. |
| `questionsOutlastTurns` | boolean | A question can stay open past its turn. |
| `startsTurnsUnasked` | `"never"` or `"jobReports"` | When the agent starts a turn nobody asked for. |
| `queuedInputAfterRestart` | `"handedBack"` or `"run"` | What a restart does with input that was queued but not taken. |
| `movingWithUnfinishedWork` | `"cancels"` or `"refused"` | What moving away from open calls, questions or jobs does. |
| `mixedActorInput` | `"shared"` or `"refused"` | A turn with input from several actors acts with their shared rights, or such input is refused. |
| `settingsDuringTurn` | `"nextTurn"` or `"refused"` | A settings change while a turn runs applies from the next turn, or is refused. |
| `erasureDuringTurn` | `"allowed"` or `"refused"` | Whether erasure is allowed while a turn runs. |
| `commandContainment` | `"strong"`, `"processGroup"` or `"none"` | How strongly the working environment keeps "nothing outlives the agent": against anything, against the command's process group only, or not at all. |

The response to `session/new`, `session/load` and `session/resume` also carries `_meta["modular-agent"].declaration`: the declaration for that session, which may differ from the agent's, for example because of the session's Provider.

## Sessions

- **`session/new`** creates a session in the given `cwd`. A session that is created and closed without being used is not listed afterwards, and leaves nothing behind.
- **`session/load`** sends the session's current branch as `session/update` notifications, then answers. Everything sent passes the output gate. **`session/resume`** answers without replaying.
- **`session/close`** cancels the running turn and the session's jobs, closes MCP servers the host gave it, and waits for both before answering.
- **`session/list`** lists kept sessions. With a `cwd`, it lists only that project's.

## Configuration options

Each session offers these as ACP `select` configuration options, with these ids:

| Id | Values |
|---|---|
| `model` | `"provider/model"` for each model the agent can use |
| `thinking` | the reasoning levels the current model supports, from `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `approval` | `off`; `ask` (ask unless the tool is read-only); `all` (ask always); `never` (refuse without asking) |

A change applies from the next turn. If the declaration says `settingsDuringTurn: "refused"`, a change while a turn runs is refused instead.

## Prompts

`session/prompt` may carry `_meta["modular-agent"] = { "key": "..." }`.

The response carries `_meta["modular-agent"]`:

| Field | Value |
|---|---|
| `inputId` | the identity of the input this prompt admitted |
| `duplicate` | `true` when the key was already known. No turn was started, and the response describes the turn the first prompt started. |
| `outcome` | `{ "kind": "completed" | "failed" | "cancelled" | "limit", "error"?: string, "limit"?: string }` |
| `openToolCalls` | the identities of calls left open past the turn, if any |
| `handedBack` | on a cancelled turn: the input that was queued and not taken, as `[{ "inputId", "content" }]` |

Stop reasons map as follows:

| Outcome | `stopReason` |
|---|---|
| completed, including with open calls | `end_turn` |
| cancelled | `cancelled` |
| a step limit | `max_turn_requests` |
| an output limit | `max_tokens` |
| failed | `refusal`, with the reason in `outcome.error` |

## Updates

The agent streams the turn as standard `session/update` notifications. Every update passes the output gate.
- **Model text** is sent as `agent_message_chunk`, and **reasoning** as `agent_thought_chunk`.
- **Each tool call** is a `tool_call`, then `tool_call_update` notifications. The `toolCallId` is the call's identity in the session, `title` is the tool's name, and `rawInput` its input. The final status is `completed` or `failed`. A call left open past the turn ends the turn with status `pending`.

## Approvals

An approval is a `session/request_permission` with exactly two options:

```json
[
  { "optionId": "allow", "kind": "allow_once", "name": "Allow" },
  { "optionId": "refuse", "kind": "reject_once", "name": "Refuse" }
]
```

Only the outcome `selected` with `optionId: "allow"` allows the call. Every other answer refuses it: `refuse`, `cancelled`, an error, or a closed connection. An "always allow" option is never offered.

## Questions

- **Free text or a choice** is asked with ACP form elicitation, and only if the client declared it supports forms. The form has one field, `answer`. Its schema is a string for free text, or an enum of the options for a choice.
- **Without form support,** or for a question left open past its turn, the host uses the `requests` and `answer` extensions.
- **A secret is never asked through a form,** because ACP forbids it. It is declined, unless the agent has another way to collect it.
- **Only a declared present actor counts as an answerer.** The ACP connection is present while it is open.

## Cancelling

`session/cancel` ends the running turn as cancelled. The pending prompt's response then carries `handedBack`. Permission requests still waiting are refused. Jobs keep running, unless `cancellingTurnCancelsJobs` is true.

## Extension methods

Each extension is a JSON-RPC request with a `sessionId` in its params. These four are required:

| Method | Params | Result |
|---|---|---|
| `_modular-agent/history` | `sessionId`; `after` (an entry identity, optional); `all` (boolean, optional) | `{ "entries": [Entry] }`: the current branch, or with `all` every entry, after `after` if given, through the output gate. An unknown `after` is refused with error code `-32602`. |
| `_modular-agent/input` | `sessionId`; `content` (a string or ACP content blocks); `when` (`"now"`, `"steer"` or `"after"`); `key` (optional) | `{ "inputId", "taken": "now" | "inTurn" | "after", "duplicate"?: true }`. Answers once the input is admitted, without waiting for the turn. |
| `_modular-agent/requests` | `sessionId` | `{ "requests": [Request] }`: open questions, including those waiting past their turn |
| `_modular-agent/answer` | `sessionId`; `requestId`; `value` (optional); `declined` (optional) | `{ "accepted": boolean, "reason"?: string }` |

These are optional. If offered, they use these names and shapes, and appear in `extensions`:

| Method | Params | Result |
|---|---|---|
| `_modular-agent/fork` | `sessionId`; `entryId` | `{ "sessionId" }`. Refused while the session has unfinished work. |
| `_modular-agent/move` | `sessionId`; `entryId` | `{}`. Follows `movingWithUnfinishedWork`. |
| `_modular-agent/erase` | `sessionId`; `entryIds` | `{ "erased": [id], "pending": [id], "outOfReach": [string] }` |
| `_modular-agent/jobs` | `sessionId` | `{ "jobs": [{ "id", "kind", "state" }] }` |
| `_modular-agent/cancel-job` | `sessionId`; `jobId` | `{}` |

### Entry

A history entry, as the `history` extension returns it, has at least:
- `id`;
- `parentId`, or null;
- `kind`;
- `time`, in milliseconds since 1970;
- `turnId`, `toolCallId` and `actorId`, where they apply;
- `message`, where the entry carries one, as `{ "role": "user" | "assistant" | "toolResult", "content": [blocks] }`.

These kinds have fixed names: `input`, `response`, `toolResult`, `turnStart` and `turnEnd`. A `turnEnd` entry's `data.outcome` is the turn's outcome. Other kinds are the build's own.

### Request

An open question, as the `requests` extension returns it, has at least:
- `id`;
- `kind`: `approval`, `choice`, `text`, `link` or `secret`;
- `question`;
- `options`, for a choice;
- `toolCallId`, where it applies;
- `answerable`: whether it can still be answered.

## Conformance mode

When the environment variable `MODULAR_AGENT_CONFORMANCE=1` is set, the agent offers one extra model, `conformance/echo`. It needs no network and no credentials, and it behaves exactly as follows. It reads the text of the latest input, ignoring tool results:
- **Text that starts with `tool:`** has the form `tool:<name> <json>`. On a step with no tool result yet in this turn, the model calls tool `<name>` with `<json>` as its input. On the step after the result, it replies with the text `done: ` followed by the first 200 characters of the result's text.
- **Any other text** gets the reply `echo: <text>`.

Usage is reported as zero. In conformance mode, the agent also offers the tools `bash`, taking `{ "command": string }`, and `read`, taking `{ "path": string }`.

The [conformance kit](../../conformance/acp/README.md) uses this mode.

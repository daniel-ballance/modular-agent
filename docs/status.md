# Status: the description against the code

**Checked:** 2026-11-16, against the first implementation in `packages/` ([build notes](build-notes.md)).

Each row is a claim from [Architecture](architecture.md) or [Contracts](contracts.md). The status says how far the code backs it:
- **proven:** the code does it, and a test or a run with a real model shows it
- **built:** the code does it, but nothing tests it yet
- **partly:** some of it is built
- **paper:** described, not built
- **changed:** building it changed the description

When the code and the description disagree, this page says so. Update it when either changes.

## The Harness and plugins

| Claim | Status | Notes |
|---|---|---|
| An agent is the Harness plus plugins | proven | The `ma` command runs about 15 plugins on one Harness, plus any named in settings. |
| The Harness hosts plugins, offers the plugin API, keeps sessions | proven | |
| A plugin provides a capability, adds behaviour, or both | proven | `model-selection` adds behaviour; `tools-files` provides a capability. |
| Plugins can define capabilities and hook points for each other | built | `defineHook` and `provide` exist. No plugin defines a new hook point for others yet. |
| A plugin replaces another deliberately | proven | `runtime-durable` replaces `runtime-transient`. |
| A plugin is checked before it loads | proven | `project-trust` refuses a project's plugins until the project is trusted. |
| Plugins loaded from settings | proven | `load` in global or project `settings.json`. |
| A plugin makes several changes together, all kept or none | partly | Entries in one transaction are kept together. Input given in the same transaction is taken after. |
| Plugins stay within the plugin API | paper | A convention: plugins run in the same process and could reach around the API. |
| Plugins added during a session | paper | Declared unsupported. |
| Configuration is a capability | proven | `config-files`. |

## Capabilities

| Claim | Status | Notes |
|---|---|---|
| Runtime: transient and durable fit one description | proven | The swap test, and a real crash recovered by the durable Runtime. |
| Recovering an interrupted turn is the Runtime's job | changed, proven | Was the Harness's job in the first version. |
| Provider keeps no state and runs no tools | proven | `provider-pi-ai` declares both false. |
| Provider keeps state, runs tools itself, live sessions, late answers | paper | Declared false; no Provider does them. |
| Interface: terminal | proven | Full-screen TUI, line-based, print and JSON modes. |
| Interface: over a wire, driven by a host | proven | `interface-acp` speaks ACP v1 over stdio. T3 Code drove it as a provider and showed its tool calls as native cards. |
| The agent declares what it supports, to a host | proven | In `initialize`, under `_meta`. |
| Each session has its own project (`cwd`) | changed, proven | The Harness's project was per process. ACP gives each session its own `cwd`, so tools, context files and the session list now follow the session's. |
| Tool source | proven | `tools-files`, `tools-question`. |
| Tool calls started by a UI or plugin, with the same checks | partly | `callTool` exists. Only a refusal is tested. |
| Working environment, separate from the project | proven | `env-local`, moved to each session's `cwd`. |
| History store, with erasure | proven | `history-jsonl`. |
| Credential store | proven | `credentials-file`, sharing Pi's `auth.json`. |

## Turns, actors and questions

| Claim | Status | Notes |
|---|---|---|
| A turn ends with an outcome and a result | proven | |
| A plugin checks a turn's result and sends the model back | built | The `turn.result` hook point exists. No test. |
| Input during a turn (steering), and after it | proven | |
| Input with a key is taken once | proven | |
| Cancelling hands queued input back and leaves jobs running | proven | |
| Every input, answer and approval records its actor | proven | |
| Several actors; authority only narrows when granted | partly | `join` refuses to grant more than the granter has. No tenant or administrator limits. |
| One answer closes a request; seeing is not answering | proven | |
| Approval fails closed; "never ask" | proven | `approval` plugin. |
| A late allow is checked again | proven | A recorded allow from someone who may no longer answer is not reused. |
| Questions are recorded and survive a restart | proven | With a durable Runtime, and past their turn with either. |
| A tool call stays open past its turn | proven | Left open by an approval check or by the tool itself. |
| A secret goes only to the credential store | partly | A secret's value is never recorded. Nothing routes it to the credential store yet. |

## Jobs, history and output

| Claim | Status | Notes |
|---|---|---|
| A job's report enters the session as input and may start a turn | proven | |
| Jobs survive a restart | proven | Jobs are recorded. After a restart, their plugin ends them as outcome unknown or takes them up again. |
| Subagents, transient and durable; nested questions; follow-ups | proven | A real `kill -9` mid-subagent: the durable variant carries on and reports the real result. |
| History grows in normal use; compaction adds a summary | proven | |
| Moving the current position is recorded | proven | |
| Rewinding outside state | paper | Declared unsupported. |
| Erasure reaches every copy | partly | Entries are erased in the store. Summaries that copied the data are not. |
| The record is intact; each recipient gets a gated view | proven | A secret split across streamed pieces is held and redacted. |
| Every tool call ends with exactly one result | proven | Including interrupted, refused, cancelled and late results. |

## Tools

| Claim | Status | Notes |
|---|---|---|
| Several calls in one step may run together; results in the order asked | proven | Only when every tool in the step allows it. |
| Nothing the working environment starts outlives the agent | proven | `env-local`: a watcher, plus a sweep at start. Tested with SIGKILL. |

## Hook points

| Hook point | Status |
|---|---|
| plugin about to load, session start and end, input arrives, before a turn | built |
| before output reaches a recipient | proven |
| turn start and end, before and after each step, before and after a tool call | proven |
| a model request failed | proven (compaction retries on overflow) |
| the turn's result is ready | built |
| Provider: before a request, as the response arrives | built |

## Gaps the code found in the description

- **Declared support** gained rows the description lacked: `continuesAfterRestart`, `questionsOutlastTurns`, `inputKeys`. They are now in [Architecture](architecture.md#declared-support).
- **Joining a session** was in the plugin API only as "join". It is now `join(session, actor, grantedBy)`, which refuses to grant more authority than the granter has.

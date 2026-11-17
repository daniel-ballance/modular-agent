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
| Plugins can define capabilities and hook points for each other | proven | A test plugin defines a hook point that two others answer. Only its owner may run it. |
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
| Tools from MCP servers, global and per session | proven | Settings, and servers an ACP client passes. |
| Parts as services: history store, working environment, model gateway | proven | Separate processes over HTTP, with leases, safe retries and cancelling. |
| The agent served over HTTP | proven | Server-sent events, resumable from the last entry seen. |
| A plugin can run in another process | proven | The whole suite passes with the Runtimes, tools, environment and MCP plugin out of process. |
| Interface: terminal | proven | Full-screen TUI, line-based, print and JSON modes. |
| Interface: over a wire, driven by a host | proven | `interface-acp` speaks ACP v1 over stdio. T3 Code drove it as a provider and showed its tool calls as native cards. |
| The agent declares what it supports, to a host | proven | In `initialize`, under `_meta`. |
| Each session has its own project (`cwd`) | changed, proven | The Harness's project was per process. ACP gives each session its own `cwd`, so tools, context files and the session list now follow the session's. |
| Tool source | proven | `tools-files`, `tools-question`. |
| Tool calls started by a UI or plugin, with the same checks | proven | Checked by "before a tool call", and recorded with who started it, refused or not. |
| Working environment, separate from the project | proven | `env-local`, moved to each session's `cwd`. |
| History store, with erasure | proven | `history-jsonl`. |
| Credential store | proven | `credentials-file`, sharing Pi's `auth.json`. |

## Turns, actors and questions

| Claim | Status | Notes |
|---|---|---|
| A turn ends with an outcome and a result | proven | |
| A plugin checks a turn's result and sends the model back | proven | The model is told why, within the same turn. |
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
| A secret goes only to the credential store | proven | The Harness writes it to the store; the asker, history and events see only its name. Typing it in a terminal still shows it on screen. |

## Jobs, history and output

| Claim | Status | Notes |
|---|---|---|
| A job's report enters the session as input and may start a turn | proven | |
| Jobs survive a restart | proven | Jobs are recorded. After a restart, their plugin ends them as outcome unknown or takes them up again. |
| Subagents, transient and durable; nested questions; follow-ups | proven | A real `kill -9` mid-subagent: the durable variant carries on and reports the real result. |
| History grows in normal use; compaction adds a summary | proven | |
| Moving the current position is recorded | proven | |
| Rewinding outside state | paper | Declared unsupported. |
| Erasure reaches every copy | partly | Entries, and summaries that copied them, are erased in the store. Forks made earlier keep their copy. |
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
| plugin about to load | proven (project trust) |
| session start and end, input arrives, before a turn | built |
| before output reaches a recipient | proven |
| turn start and end, before and after each step, before and after a tool call | proven |
| a model request failed | proven (compaction retries on overflow) |
| the turn's result is ready | proven |
| Provider: before a request, as the response arrives | built |

## Gaps the code found in the description

- **Declared support** gained rows the description lacked: `continuesAfterRestart`, `questionsOutlastTurns`, `inputKeys`. They are now in [Architecture](architecture.md#declared-support).
- **Joining a session** was in the plugin API only as "join". It is now `join(session, actor, grantedBy)`, which refuses to grant more authority than the granter has.

## The rules from the clean-room builds

[Contracts](contracts.md#rules-every-implementation-follows) gained rules from three independent builds ([ADR 0016](adr/0016-rules-from-three-clean-room-builds.md)). This build follows most of them already. Where it didn't, the cheap fixes were made at once; the rest are listed here.

| Rule | Status | Notes |
|---|---|---|
| Handler order: first group, normal, last group, load order within each | proven | Already so. |
| A failing transform, first-answer or collect handler fails its operation | changed, proven | Was reported and skipped. |
| A handler may run again after a restart | built | The durable Runtime reruns checks; no handler here has an unkeyed outside effect. |
| Tool names are never silently shadowed | changed, built | A later tool with a taken name is refused and reported. Providers and commands were already unique. |
| Subagents default to a depth of three | changed | Was two. |
| Forking at unfinished work is refused | changed, built | A running turn, a job or a waiting call refuses the fork. |
| A job's report is keyed by its job | changed, built | |
| Steering joins after the current tool round | proven | |
| Keys last for the session, and return the first receipt | proven | |
| Settings belong to the session; a change applies from the next turn | built | Moving keeps settings; model access is fixed per turn. |
| A summary names its sources; erasure follows copies | proven | |
| What counts as a copy: responses, results, turn results, forks, jobs | partly | Summaries only. Responses don't yet name the requests they copied. |
| Erasure refused while another writer holds an affected session | paper | Not checked across sessions. |
| Records of authority can't be erased | paper | |
| "Safe to repeat" is a promise from both the tool and the working environment | partly | The durable Runtime uses the tool's promise; `env-local` keeps its promise but doesn't declare it. |
| An interrupted model request is repeated only on the Provider's promise | proven | Never repeated. |
| Background processes outlive a cancelled turn, stop with the session or agent | partly | They stop with the agent; closing a session doesn't stop them. |
| Presence is declared; approval with nobody present is refused | proven | |
| A key binds the whole question | partly | The key alone is matched. |
| A job's end is recorded before its report | proven | |
| A child's job isn't finished while it has calls open | proven | |
| Trust is given and kept outside the project | proven | |
| Host MCP servers serve one session and aren't recorded | proven | |
| A lost part fails its waiting calls and is reported | proven | Plugins over RPC. |
| A Provider that keeps state starts again after a move or erasure | paper | No Provider here keeps state. |
| Following resumes from an entry; unknown entries are refused | partly | HTTP resumes by count, not by entry identity. |

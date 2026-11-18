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
| Follows the ACP host bindings `modular-agent-acp/1` and `/2` | proven | `/2` is opt-in. It reports a failed turn as an RPC error; `/1` keeps the refusal response. Both keep the turn in history. |
| Follows the plugin binding `modular-agent-plugin/1` | proven | Plugin kit 110/110, the probe plugin's host checks, and the jobs plugin ([ADR 0017](adr/0017-plugins-in-any-language.md)). Across TypeScript, Rust, Python, Go and Elixir: every host with every build's Provider, hooks (the output gate included), tools and working environment (25/25), and with every build's Runtime through a real `kill -9` (25/25 durable, 25/25 transient). |
| Portable sessions (`portableSessions`) | proven | Every entry in the [shared shapes](bindings/data.md#portable-sessions) ([ADR 0018](adr/0018-portable-sessions.md)), jobs and queued input included. Each of the five builds' agents reopens, continues and recovers after `kill -9` a session each of the others wrote, and takes up a job the killed agent left: 25/25 durable, 25/25 transient. |
| Follows the history service binding `modular-agent-history/1` | proven | History kit 34/34 for this build's service and client. Swapped with Go's service both ways. Reopening after a crash waits for the old lease (`retryAfterMs`). |
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
| Several actors; authority only narrows when granted | proven | ACP hosts can join and remove actors, act for them with shared rights, and release input proposed by an actor. Joining again can take rights away. |
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
| Jobs survive a restart, including over the plugin binding | proven | The Harness records job starts, ends and keyed reports. During `session.start` on reopening, a plugin finds its own unfinished jobs by name. It can resume or end them. The Harness asks the plugin to cancel a job before marking it cancelled. |
| Subagents, transient and durable; nested questions; follow-ups | proven | A real `kill -9` mid-subagent: the durable variant carries on and reports the real result. |
| History grows in normal use; compaction adds a summary | proven | |
| Moving the current position is recorded | proven | |
| Rewinding project files | proven | The local working environment saves project files before turns and calls outside turns, including when served as a plugin. A move is refused if it crosses a job, work is still open, or the required point is missing. Saved points belong to the environment process that made them. |
| Erasure reaches every copy | partly | Entries, and summaries that copied them, are erased in the store. Forks made earlier keep their copy. |
| The record is intact; each recipient gets a gated view | proven | Remote output gates see one complete model or tool stream at a time. If a gate fails, delivery is blocked. The conformance plugin redacts a test secret, including when it spans pieces. |
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

[Contracts](contracts.md#rules-every-implementation-follows) gained rules from three independent builds ([ADR 0016](adr/0016-rules-from-three-clean-room-builds.md)). The table records what this build follows and what it does not support.

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
| What counts as a copy: responses, results, turn results, forks, jobs, input taken | built, tested | Responses name the visible sources of their request. Erasure follows those links, tool calls, turn results, summaries, forks and job reports, including child results. |
| Erasure refused while another writer holds an affected session | built, tested | The Harness checks affected sessions and takes their write leases before deleting anything. Erasure during affected work is refused. |
| Records of authority can't be erased | built, tested | Joining, granting new rights and leaving are protected. |
| "Safe to repeat" is a promise from both the tool and the working environment | built, tested | `env-local` declares the promise on Linux. Started calls are retried only with the recorded promise and both current promises. |
| An interrupted model request is repeated only on the Provider's promise | built | Recovery does not repeat a request if the Provider may keep state or run tools, unless it explicitly promises safe repetition. |
| Cancelling a command stops what it started, even outside its process group | changed, proven | Found by the plugin kit: `setsid` escapees survived a cancel until the agent died. Each command now carries its own marker. |
| Background processes outlive a cancelled turn, stop with the session or agent | built, tested | Closing a session stops its processes without stopping another session's. The plugin binding sends `env/sessionEnded`. |
| Presence is declared; approval with nobody present is refused | proven | |
| A key binds the whole question | built, tested | A change of kind, text, options, credential name or tool call requires a new answer. |
| Input keys survive a restart | changed, proven | Found by the ACP conformance kit; keys are now recorded with the input. |
| A secret is never asked over a protocol that forbids it in forms | changed, built | Found by the round-two review of the ACP binding. |
| A job's end is recorded before its report | proven | |
| A child's job isn't finished while it has calls open | proven | |
| Trust is given and kept outside the project | proven | |
| Host MCP servers serve one session and aren't recorded | proven | |
| A lost part fails its waiting calls and is reported | proven | Plugins over RPC. |
| A Provider that keeps state starts again after a move or erasure | built | Built-in Providers do not keep state. A stateful external Provider gets `provider/discard`, with `erase: true` for erasure. |
| Mixed input acts with only the rights its actors share | built, tested | Each input taken into the turn narrows its authority, including steering input and after recovery. |
| Following resumes from an entry; unknown entries are refused | built, tested | The ACP `history` extension and HTTP event stream use entry ids. HTTP returns 404 for an unknown id. |

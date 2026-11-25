# Status: the description against the code

## Production gaps

[ADR 0021](adr/0021-production-edition.md) listed four gaps. [Secret staging and recovery](contracts.md#secrets) shipped first. [ADR 0029](adr/0029-sdk-decisions-after-four-builds.md) settled ACP service token scope and rights ceilings, and [ADR 0030](adr/0030-production-gaps.md) set the rules for the other three. All four SDKs and `ma` now implement them, checked on 2026-11-21 by the opt-in kit checks that `scripts/check.sh` runs through `scripts/production-kits.sh` and `scripts/erasure-matrix.sh`:

| Gap | Rules | Checked |
|---|---|---|
| Per-connection isolation | [Authority](contracts.md#authority), [ACP authorization](bindings/acp.md#authorization), [plugin service isolation](bindings/websocket.md#a-plugin-service), [raw history isolation](bindings/history-http.md#the-basics) | ACP `--isolation-checks` on each `ma` and base agent, stdio and WebSocket; plugin isolation across separate listeners; history isolation across two services |
| Resource reservations | [Resource reservations](contracts.md#resource-reservations), [Security](security.md#resource-limits-and-denial-of-service) | ACP `--capacity-checks`: races for the last slot, `busy` with no admission, settlement of questions and jobs while full, `capacity` inside a turn |
| Cross-session erasure coordination | [Cross-session coordination](contracts.md#cross-session-coordination), [pending-erasure registry profile](bindings/history-http.md#pending-erasure-registry-profile-pendingerasure-1) | ACP `--erasure-checks`, including crash cutoffs and the next writer completing; the history kit's registry checks across a restart in all four services; each language's agents on every language's history service, 16 pairings |

**What the checks do not establish.** Byte limits are counted logically: they do not reserve physical disk, and the operator provides the extra space an atomic replacement needs. Scope is rechecked when a queued reply leaves its queue, but not every transport proves it at the last socket handoff. A deletion is not held until every external effect already in flight has finished, and restoring a backup still needs separate proof that it is current. Each SDK's README lists its own remaining items. Full production readiness is not claimed.

## 0.3.0

Recorded on 2026-11-24 for the commit tagged `v0.3.0`, from `scripts/check.sh` on Linux (Fedora, x86-64; 61 steps, all passed) and `scripts/macos-check.sh` on macOS (Apple silicon; 34 steps, all passed).

| Check | Rust | TypeScript | Go | Python |
|---|---|---|---|---|
| Shared SDK scenarios (45, including 28 for approvals that wait), every placement | pass | 405/405 | pass | 405/405 |
| Reference checks against `ma` | 28/28 | 28/28 | 28/28 | 28/28 |
| ACP kit against `ma`: core, covered approvals, approvals that wait | 190, 2, 50 | 190, 2, 50 | 190, 2, 50 | 190, 2, 50 |
| Over WebSocket: plugin kit, listener isolation, named callers, ACP kit | 157, 14, 29, 195 | 157, 14, 29, 195 | 157, 14, 31, 195 | 157, 14, 29, 195 |
| [AG-UI kit](../conformance/agui/README.md) against `ma` and an SDK fixture | 49/49 | 49/49 | 49/49 | 49/49 |
| [Telemetry check](../conformance/telemetry/README.md), as host: in process and with each other language's plugins | 16, 6 | 16, 6 | 16, 6 | 16, 6 |
| [ADR 0030](adr/0030-production-gaps.md) kits | pass | pass | pass | pass |
| Own suites | 494 tests | 652 in each of two layouts | 39 packages; race on 7 | 844 in each of four configurations |

Rust and Go's scenario runners report pass or fail, not a count. Go's named-callers transcript has two more checks because its fixture also saves points. The telemetry peer cases fell from 18 to 6 when the plugin trace handshake was removed. Each language's agents passed the erasure checks on every other language's history service: 12 of 12 pairings. The [project notes demo](../demos/project-notes/README.md) passed with its crash run, and the [ops desk](../demos/ops-desk/README.md) passed its eight scripted checks. Every result above used scripted models.

## 0.2.0

Recorded on 2026-11-23 for the commit tagged `v0.2.0`, from `scripts/check.sh` on Linux (Fedora, x86-64; 53 steps, all passed) and `scripts/macos-check.sh` on macOS (Apple silicon; 20 steps, all passed).

| Check | Rust | TypeScript | Go | Python |
|---|---|---|---|---|
| Shared SDK scenarios, every placement | 153/153 | 153/153 | 153/153 | 153/153 |
| Reference checks against `ma` | 27/27 | 27/27 | 27/27 | 27/27 |
| ACP kit against `ma`, crash, probe and job checks | 190/190 | 190/190 | 190/190 | 190/190 |
| Over WebSocket: plugin kit, listener isolation, ACP kit | 153, 14, 195 | 153, 14, 195 | 153, 14, 195 | 153, 14, 195 |
| [AG-UI kit](../conformance/agui/README.md) against `ma` and an SDK fixture | 26/26 | 26/26 | 26/26 | 26/26 |
| [Telemetry check](../conformance/telemetry/README.md), as host: in process and with each other language's plugins | 8, 18 | 8, 18 | 8, 18 | 8, 18 |
| [ADR 0030](adr/0030-production-gaps.md) kits | pass | pass | pass | pass |
| Own suites | 467 tests | 492 in each of two layouts | 38 packages; race on 7 | 726 in each of four configurations |

Each language's agents passed the erasure checks on every other language's history service: 12 of 12 pairings. The [project notes demo](../demos/project-notes/README.md) passed with its crash run, and the [ops desk](../demos/ops-desk/README.md) passed its six scripted checks. Every result above used scripted models. With real models, the ops desk ran three times on the owner's subscriptions (Grok triage, Claude coder, ChatGPT verifier), and each run fixed its bug on the first try.

[ADR 0034](adr/0034-approvals-that-wait.md) is accepted but not implemented; no result above covers it.

## 0.1.0

Recorded on 2026-11-22 for the commit tagged `v0.1.0`, from `scripts/check.sh` on Linux (Fedora, x86-64) and `scripts/macos-check.sh` on macOS (Apple silicon). [ADR 0027](adr/0027-sdk-0-1-and-edition-4.md) explains what these results establish.

| Check | Rust | TypeScript | Go | Python |
|---|---|---|---|---|
| Shared SDK scenarios: 17 in 9 placements, in process, in another process and as a service | 153/153 | 153/153 | 153/153 | 153/153 |
| Reference checks against `ma` (27 in the current suite) | 25/25 at tag | 25/25 at tag | 25/25 at tag | 25/25 at tag |
| ACP kit against `ma`, crash, probe and job checks | 188/188 | 188/188 | 188/188 | 188/188 |
| Over WebSocket: plugin kit, listener isolation, ACP kit | 153, 14, 193 | 153, 14, 193 | 153, 14, 193 | 153, 14, 193 |
| [ADR 0030](adr/0030-production-gaps.md) kits: isolation, capacity, erasure, history registry | pass | pass | pass | pass |
| Own suites | 429 tests | 536 in each of two layouts, 5 live skipped | 38 packages; race on 7 | 637 in each of four configurations, 5 live skipped |

Each language's agents passed the erasure checks on every other language's history service: 12 of 12 pairings. The [project notes demo](../demos/project-notes/README.md) passed, including its crash run. On macOS all 20 steps passed: every suite, the reference checks and the ACP kit for all four languages. Every result above used scripted models. Real requests through ChatGPT, Grok and Claude succeeded in all four `ma` builds, and the live checks against OpenAI and Anthropic pass in all four SDKs.

## Production edition 3

The final round-seven run finished on 2026-11-19 at 02:02. All five builds passed their suites and applicable kits. The last specification change was `cf663a5`; the final kit check was `dde3458`. See [ADR 0021](adr/0021-production-edition.md) for what these results establish.

| Build | Suite | Plugin kit | ACP local | ACP portable (durable / transient) |
|---|---|---|---|---|
| TypeScript | 100/100 in both runs | 139 | 207 in three layouts | 152 / 152 |
| Rust | 233 to 234 in four runs | 139 | 207 | 152 / 152 |
| Python | 298 in four runs | 139 | 207 in three layouts | 153 / 152 |
| Go | 29/29 packages, also with `-race` | 139 | 207 | 153 / 153 |
| Elixir | 50/50 in both runs | 138 | 201 in two layouts | 152 / 152 |

Kit counts are checks passed, not a common count for each build. The TypeScript and Go history services each passed 42/42, including restart with a shorter TTL.

Each matrix ran every ordered pair of the five builds, including self-swaps. The plugin and Runtime matrices pair a host with a plugin set; the portable matrices pair a session writer with a reopener.

| Matrix | First pass | Second pass | Final rerun |
|---|---:|---:|---:|
| Provider, hooks, tools and working environment | 23/25 | 25/25 | 25/25 |
| Durable Runtime through `kill -9` | 15/25 | 23/25 | 25/25 |
| Transient Runtime through `kill -9` | 20/25 | 23/25 | 25/25 |
| Portable sessions with jobs, durable layout | 13/25 | 25/25 | 25/25 |
| Portable sessions with jobs, transient layout | 13/25 | 25/25 | 25/25 |
| **Total** | | | **125/125** |

The portable crash checks use the reopener's declaration. The Elixir launcher used for the portable matrices did not declare continuation in either layout. Its durable Runtime did carry on in the Runtime matrix and in the separate real-model check.

**Real model:** Rust to Elixir and Elixir to Rust both passed after Rust fixed its translation of shared reasoning `off` to the OpenAI API's `none`. With `gpt-6-luna`, a shared history service and the same configured actor, both reruns completed the interrupted turn, recorded the command as `outcomeUnknown` with one start, and answered a follow-up from history.

## Production edition 3: TypeScript

This is the TypeScript checkpoint before the final run above.

Verified against specification `9fffc23` and kits `dde3458`, on Linux with Node.js 26.13.1. The earlier swap results below used kits `5f5bfc9`.

The wire Runtime uses the committed tool result on a tool refusal. A failed turn still lists the calls it left pending, including when a host rejects `step.after`. The TypeScript host uses committed dispositions even if the Runtime reply is lost. It restores the last answered step and its `step.after` decision, and settles ineligible calls before handoff. The build also uses the configured ACP principal for portable retries, refuses startup on a failed configured plugin, and treats extra `provider.response` members as inert.

| Self check | Result |
|---|---|
| Build and tests, local and with `MA_REMOTE=provider-pi-ai,runtime-transient,tools-files,env-local` | 100/100 each |
| History HTTP kit with decreased TTL on restart | 42/42 |
| Served plugin kit | 139/139 |
| ACP with crash, plugin, probe and job checks | 207/207 each for `provider,hooks`; plus `durable-runtime`; plus `tools,environment` |
| Portable ACP with crash and job checks | 152/152 each for transient and durable |

| Swap cell | Result |
|---|---|
| A and A-crash: Go host with the TypeScript durable Runtime | 189/189 |
| A: Python host with the TypeScript durable Runtime | 187/189; the targeted refusal and recovery checks pass, but two late-question checks fail |
| B: TypeScript host with the Go durable Runtime | 189/189 |
| D: TypeScript host with the Elixir plugin | 189/189, including negative startup cases |
| E: TypeScript host with the Rust or Python durable Runtime | 189/189 each |
| F4: TypeScript reopens Go sessions through the supplied history service | 152/152 |

In the Python cell, the wire tap showed a `runToolCall` pending reply followed by rejection of `step.after` for unsettled calls. A committed pending call should satisfy that gate boundary. The focused TypeScript wire test reproduces the rejection and checks that both Runtime tiers still report the call. The other peer cells had not yet been rerun at this checkpoint. The gap log is `/tmp/ma-tools/r7/ts-gaps.md`.

## Production edition 2: TypeScript

Verified against specification `74aa4af` and kits `f59d2a8`, on Linux with Node.js 26.13.1.

| Run | Result |
|---|---|
| `npx tsc -b && npm test`, normal and with `MA_REMOTE=provider-pi-ai,runtime-transient,tools-files,env-local` | 90/90 tests in each |
| History HTTP kit with decreased TTL on restart | 42/42 |
| Served plugin kit, including both Runtime tiers | 139/139 |
| Local ACP, with crash, plugin, probe and job checks | 199/199 in each layout: `provider,hooks`; plus `durable-runtime`; plus `tools,environment` |
| Portable ACP, with crash and job checks against the supplied history service | 150/150 transient and 150/150 durable |
| Portable ACP, with the extra probes against the repository's edition 2 history service | 244/244 transient and 244/244 durable |

The supplied service's `UPDATED` marker still identified `f161432` when tested. The additional portable runs used the repository's updated service. They include a retryable reopen hold, rejection of a late renewal, and Provider checkpoint and recovery probes. No real-model run was repeated.

The tested layouts declare both ACP versions and the supported full fixture profile: portable sessions, several actors, rewind when the environment can verify points, fork, erasure, limits, tenants, input during a turn, and late question answers. Runtime continuation after restart depends on the selected Runtime. These are fixture results, not a claim of production security or complete conformance. Outstanding work includes operator isolation and representation, secret staging, exact opaque numeric relaying outside the history service, full shaped-result validation, auxiliary attempt accounting, and cross-session erasure coordination. The edition 2 gap log is `/tmp/ma-tools/r7/ts-gaps.md`.

The history client uses `/proc/uptime` on Linux where available. On platforms without a suspension-aware clock, configure a positive `MODULAR_AGENT_HISTORY_LEASE_MARGIN_MS` (or `leaseMarginMs` for an embedded client). The margin is subtracted from the renewal and loss deadlines.

## Production edition: TypeScript, round seven

**Checked against:** production specification `388cd90`, implementer's guide `1569f84`, conformance kits `1ad258f`, on Linux with Node.js 26.13.1. This records fixture results, not a full production conformance claim or an independent cross-build swap.

| Role and binding | Fixture coverage | Result |
|---|---|---|
| Local build | Normal and `MA_REMOTE=provider-pi-ai,runtime-transient,tools-files,env-local` | 88/88 tests in each |
| History service, `modular-agent-history/1` | Authenticated reads, durable mutations, page caps, exact tombstones and changed-TTL restart exclusion | 39/39 |
| Served plugin, `modular-agent-plugin/1` | Baseline parts and both Runtime tiers | 133/133 |
| Agent and plugin host, `modular-agent-acp/1` and `/2` with `modular-agent-plugin/1` | Crash, plugin, probe and job checks; `provider,hooks`, then with the durable Runtime, then also tools and environment | 192/192 in each layout |
| History client and portable agent | Two fresh TypeScript processes, shared service, crash and job checks | 145/145 transient; 145/145 durable |
| History client + remote recovery probes | Portable transient run with probes, including seeded interrupted remote model attempts and the post-intent limit | 225/225 |

The portable runs declare `queuedInputAfterRestart: handedBack`; the kit skips the receipt check for the alternative `run` policy. The tests used scripted models and disposable processes and stores. The service uses a local SQLite store (`node:sqlite`), a single exclusive writer process, and a persisted TTL upper bound. Use only a fresh service directory or one written by this implementation; old JSONL service directories lack a verifiable lease bound. Plain HTTP is loopback only and assumes trusted local accounts.

**Outstanding production work at this checkpoint.** In particular, the matrix does not establish full project and tenant isolation or configured ACP representation, secret staging and recovery, durable coordination for pending cross-session erasure, comprehensive portable-record validation, or all dispatch, metering and cancellation rules under failure. Full production readiness is not claimed. The round-seven handoff records the specific gaps in `/tmp/ma-tools/r7/ts-gaps.md`.

## Historical evidence before the production edition

The rest of this page records pre-edition observations, including the previous independent-build matrix. Those results do not establish interoperability against the production revision.

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
| Follows the plugin binding `modular-agent-plugin/1` | proven | Plugin kit 111/111, the probe plugin's host checks (output event shapes, one plugin per name), and the jobs plugin ([ADR 0017](adr/0017-plugins-in-any-language.md)). Across TypeScript, Rust, Python, Go and Elixir: every host with every build's Provider, hooks (the output gate included), tools and working environment (25/25), and with every build's Runtime through a real `kill -9` (25/25 durable, 25/25 transient). |
| Portable sessions (`portableSessions`) | proven | Every entry in the [shared shapes](bindings/data.md#portable-sessions) ([ADR 0018](adr/0018-portable-sessions.md)), jobs, queued input, limits and tenants included. Each of the five builds' agents reopens, continues and recovers after `kill -9` a session each of the others wrote, and takes up a job the killed agent left: 25/25 durable, 25/25 transient. |
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
| Records of authority can't be erased | proven | Joining, granting new rights, leaving, session limits and tenant assignments are protected. |
| "Safe to repeat" is a promise from both the tool and the working environment | built, tested | `env-local` declares the promise on Linux. Started calls are retried only with the recorded promise and both current promises. |
| An interrupted model request is repeated only on the Provider's promise | built | Recovery does not repeat a request if the Provider may keep state or run tools, unless it explicitly promises safe repetition. |
| Cancelling a command stops what it started, even outside its process group | changed, proven | Found by the plugin kit: `setsid` escapees survived a cancel until the agent died. Each command now carries its own marker. |
| Background processes outlive a cancelled turn, stop with the session or agent | built, tested | Closing a session stops its processes without stopping another session's. The plugin binding sends `env/sessionEnded`. |
| Presence is declared; approval with nobody present is refused | proven | |
| A key binds the whole question | built, tested | A change of kind, text, options, credential name or tool call requires a new answer. |
| Input keys survive a restart | changed, proven | Found by the ACP conformance kit; keys are now recorded with the input. |
| A secret is never asked over a protocol that forbids it in forms | changed, built | Found by the round-two review of the ACP binding. |
| A job's end is recorded before its report | proven | `host/jobs/end` waits for the report's keyed `inputAccepted` entry, not for the turn. A reopened session runs a report that was accepted but not taken. |
| A child's job isn't finished while it has calls open | proven | |
| Trust is given and kept outside the project | proven | |
| Host MCP servers serve one session and aren't recorded | proven | |
| A lost part fails its waiting calls and is reported | proven | Plugins over RPC. |
| A Provider that keeps state starts again after a move or erasure | built | Built-in Providers do not keep state. A stateful external Provider gets `provider/discard`, with `erase: true` for erasure. |
| Mixed input acts with only the rights its actors share | built, tested | Each input taken into the turn narrows its authority, including steering input and after recovery. |
| Following resumes from an entry; unknown entries are refused | built, tested | The ACP `history` extension and HTTP event stream use entry ids. HTTP returns 404 for an unknown id. |

## Round six binding checks

| Item | Status | Evidence |
|---|---|---|
| Limits and tenants | proven | ACP declares `sessionLimits` and `tenants`. The `administer` right controls `limit`. The tenant is recorded before all other entries. Rights narrow immediately, and `tenantTokens` counts usage across sessions and reopenings. The ACP kit and offline tests cover both ceilings and token budgets. |
| Shared output events | proven | The plugin wire host maps streams and single events to the shared shapes and back. The conformance gate redacts a test secret across text pieces and in build-specific events. The probe checks host event shapes. |
| One plugin of each name | proven | The probe's second registration receives `plugin/shutdown` with `reason: refused`. TypeScript's served part sets have distinct names. |
| Proposals and presence | proven | The ACP kit and offline tests cover listing and withdrawing proposals, `handedBack` on a declined release, and choosing whether a joined actor is present. |
| Job rights and report admission | proven | `jobStarted` records the rights shared by the work behind it. Reports use those rights, subject to current ceilings, and reach the model unchanged. |
| Rewinding | proven | The ACP kit checks file restoration. Offline tests also cover refusing another branch or a missing point, rolling files back after a failed history write, and reporting open-world calls as out of reach. |
| Withheld replies | proven | A blocked or failing gate answers ACP extensions with `-32000` and `data.code: withheld` without undoing the request. |
| Reasoning and cancellation | proven | The next turn uses a reasoning level the chosen model accepts without raising it. A cancelled turn does not become failed because a Runtime callback failed. |
| History page minimum | proven | A first entry that fits by itself is sent even when adding the cursor takes the page over 4 MiB. |

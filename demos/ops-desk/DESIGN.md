# Ops desk: design

Status: accepted by the owner, 2026-11-23. Steps 1–4 ran with scripted models and with three subscription Providers.

## Purpose

Find out what the framework must give an application that drives several whole agents. The application, called the **host** here, is outside the specification ([ADR 0012](../../docs/adr/0012-one-agent-is-the-scope.md)). It builds, at small scale, the layer that [Agent platform 2027](../../docs/research/agent-platform-2027.md) describes: one conversation, one inbox and one listener across several agents. Anything the host cannot build cleanly from the bindings and the declaration is a framework gap found in practice. Each one is recorded in [Findings](#findings) as it is met.

## The scenario

An ops desk for a small sample repository:

1. An event arrives at the host's webhook: a failing build or a new issue.
2. The **triage** agent reads it, posts a summary to the conversation, and hands the fix to the coder.
3. The **coder** agent makes the change in its own checkout. It asks for approval before writing; the approval appears in the inbox.
4. The coder posts what it changed and hands the result to the verifier.
5. The **verifier** agent runs the tests in a separate checkout of the coder's commit and posts a verdict. If the tests fail, the host hands the failure back to the coder, at most twice.

| Agent | Built with | Tools |
|---|---|---|
| Triage | Python SDK app | `post`, `hand_off` |
| Coder | Rust `ma` | `ma`'s `codemode` and file tools, `post`, `hand_off` |
| Verifier | Go SDK app | read-only file tools, `exec` (to run the tests), `post` |

## Parts

```text
  phone / browser ── HTTP ──▶  host (TypeScript)  ◀── webhook ── scripts/send-event.mjs
                                │  SQLite: conversation, inbox, routes, listener cursor
                                │  serves the `desk` tool plugin over WebSocket
             ┌──────────────────┼──────────────────┐
           AG-UI              AG-UI              AG-UI
             │                  │                  │
     triage (Python)     coder (Rust ma)    verifier (Go)
             └───── each loads the `desk` plugin via MODULAR_AGENT_PLUGINS ─────┘
                    each exports OpenTelemetry to Phoenix
```

- **The host** is a TypeScript program in `demos/ops-desk/host/`. It owns everything that spans agents: the conversation, the inbox, the routing between agents, the listener and its cursor, and starting agent processes. It drives each agent as an authenticated AG-UI client. A local station holds that client's presence stream for the life of the agent, so restarting the host does not detach the answer route.
- **The `desk` tool plugin** is served by the station over the [WebSocket transport](../../docs/bindings/websocket.md), one token per agent. Its tools:
  - `post(text, kind)`: adds a post to the conversation, with a link to the agent's session as the debug view. `kind` is `summary`, `change` or `verdict`.
  - `hand_off(to, task)`: asks the host to give work to another agent. The host's routing rules decide whether to accept it. The call returns once the host has queued it; it does not wait for the other agent.

  A tool result from the host is data, never authority. The host checks each call against which agent may hand to which.
- **Each agent** runs as its own process with durable history in its own data directory, serving AG-UI on a loopback port the host picks. The host starts each agent to check for open work, and starts it again when work arrives. It stops idle agents. That exercises reopening sessions after a restart.

### Why posts are plugin tools, not Interface-run tools

[Interface-run tools](../../docs/contracts.md#interface-run-tools) suit an action the client performs, such as a browser picking a colour. A handed-off call ends the run, and its result starts a continuation turn. Using one for every `post` would split each agent's work into a turn per post. A tool the host serves keeps the work in one turn. This is itself a finding: there is no lightweight way for an Interface to receive a structured post during a turn.

## The conversation and the inbox

- **The conversation** holds posts from all three agents in order, plus the events that started them. It never shows raw sessions; each post links to the AG-UI snapshot of the turn that made it.
- **The inbox** lists open questions and approvals from all three agents, merged by deadline. Each item keeps its source agent, session and question ID; the answer goes back to that agent over its presence route. The host rechecks that a question is still answerable before showing the answer button.
- **Approvals** have deadlines of a few minutes (decision 2(a)). An approval not answered in time is refused by the agent, and the refusal appears in the inbox and the conversation.

## The listener

- `POST /events` on the host, with a bearer token, takes `{ id, kind, payload }`. `kind` is `build-failed` or `issue-opened`.
- The host stores each event with its ID before acknowledging. A repeated ID is acknowledged and ignored.
- A cursor records the last event delivered to triage. Delivery uses the event ID as the AG-UI run's input key, so a host crash between delivery and recording the cursor cannot start the work twice.
- `scripts/send-event.mjs` sends the sample events. A real source, such as GitHub webhooks over the tailnet, can come later.

## The interface

A plain page in `host/public/`, served by the host on the tailnet: the conversation, the inbox with answer buttons, and each agent's state (stopped, idle, working). It refreshes over server-sent events. It works on a phone.

## Traces

All three agents can export to Phoenix (`scripts/phoenix.sh`). The host saves the `desk.event` span context with the event. Each route uses it for AG-UI requests, including approval answers. All three agents trust the desk token for work requests. Startup discovery has no event parent.

## Checks

`demos/ops-desk/run.py`, run by `scripts/check.sh` in the shared phase, with scripted models for all three agents:

1. **Happy path:** an event, triage's post and hand-off, the coder's approval answered from the inbox, the change, the verifier's pass verdict. The conversation has the posts in order; the inbox is empty at the end. A loopback OTLP receiver checks that all three agents exported `invoke_agent` in the `desk.event` trace.
2. **Refusal:** the coder's approval passes its deadline. The refusal reaches the inbox and the conversation, and no file changes.
3. **Failing verification:** the verifier's first verdict fails; the coder gets one more try; the second verdict passes.
4. **Restart:** the coder's process is killed with `SIGKILL` during its turn. The host restarts it, reopens the session, and the work completes or settles as the recovery rules say. No hand-off is delivered twice.
5. **Duplicate event:** the same event ID twice starts one piece of work.
6. **Host restart:** kill the HTTP host with `SIGKILL` during approval. Delete its inbox rows and the coder route's thread link. The replacement finds the same question in the listing, answers it and finishes the route once.

With real models (`--live`) the same flow runs against your sign-ins; it is not part of `check.sh`.

## Findings

Expected findings (checked against the scripted desk):

- **Approvals cannot wait past a turn — confirmed.** The [interrupt rules](../../docs/bindings/agui.md#interrupts-and-frontend-tools) require an existing presence and forbid extending an approval past its turn. In the deadline check the question disappeared from `waiting.questions`, the change tool was refused, and the file and commit stayed unchanged. A stored inbox row did not make a late answer valid. The desk keeps a presence stream and uses three-minute deadlines; someone reading it hours later finds a refusal. [ADR 0034](../../docs/adr/0034-approvals-that-wait.md), accepted for 0.3.0, specifies parking the model call at its approval gate before the change tool starts. The desk would need to move its check there; the demo still exercises the live-only rule.
- **Finding and waking open work — resolved for a running desk.** At start-up and at each agent launch the host pages [the thread listing](../../docs/bindings/agui.md#listing-threads), then reads the gated snapshots of open work. SQLite still owns events, routes and debug links; it is not an index of agent waits. The coder starts with [`--resume-open`](../../docs/reference/standard-configuration.md#resuming-at-start-up). Triage uses the Python server's `resume_open` option. The Go verifier calls `ResumeInterrupted` on unfinished sessions before it accepts clients.
- **Someone still has to start the processes and keep the answer route alive.** The local agent station owns the three processes, their tool listeners and the original presence streams. Killing the HTTP host does not move an approval to a new presence. If the station or agent dies, that approval cannot be restored; ordinary recovery settles the turn. A listed Interface call without a received handoff cannot be executed from its snapshot. Listing is not a wake-up signal for a stopped service.
- **Posts during a turn — confirmed for Interface tools.** A frontend handoff ends the exchange; it cannot acknowledge a post and continue that step. A server tool can. A plugin can also emit a gated custom event, but that is a live notification, not a committed, acknowledged post. The desk authenticates each tool service separately and stores posts by session and call ID.
- **One trace across agents — resolved.** The coder's [policy entry](../../docs/reference/standard-configuration.md#connection-policy-and-limits) sets `traceTrusted: true` for the desk. The receiver sees triage, coder and verifier in the event's trace. The host still carries the parent across the queue. [Telemetry v1](../../docs/telemetry.md#what-later-versions-add) does not add a span link from a receiving turn to the previous agent's `hand_off` call.

Additional findings:

- **Stock `ma` cannot switch on write approval.** The [standard configuration](../../docs/reference/standard-configuration.md#the-program) omits the approval feature. A remote `tool.before` gate [cannot ask](../../docs/bindings/plugin.md#from-core-hooks-to-wire-hooks). A separate coder tool therefore asks inside its own `tools/call`, then invokes `edit` on the approved arguments. The gate refuses other edits, writes and shell commands.
- **Rust tool-originated approval needed an extra field — fixed.** Rust checked an approval answer against the draft's `options` as for a choice, so `{allow:true}` was refused unless the tool listed `allow`. It now accepts `allow` as [the data binding](../../docs/bindings/data.md#questions) says, and the coder's approval lists no options.
- **A closed run has no closure feed.** [Presence](../../docs/bindings/agui.md#listener-and-authentication) carries comments, not events. A snapshot lists only still-answerable questions, not the reason a former question disappeared. The host checks a fresh snapshot before showing or sending answers. It can label a deadline refusal here because it controls the sole answer route. It also observes the desk plugin's `turn.end` hook so it does not stop a coder that is still finishing after expiry.
- **Recovery gives a thread snapshot, not a run receipt or terminal outcome.** After `SIGKILL`, GET reopened the coder session. Its snapshot showed the interrupted tool's effects as unknown and the recovered assistant reply. There is no AG-UI operation to reattach to the lost run stream or fetch its terminal event. The host records “reopened,” not a synthetic `RUN_FINISHED`. It saves the thread ID before sending input, uses one thread per routed task, and never replays a tool from a snapshot. A 404 for a saved provisional thread cannot distinguish loss before first input from an inaccessible session; the host does not silently start over on a new thread.
- **Identifying callers of the desk service takes three listeners.** The public [plugin service API](../../docs/sdk/placement.md#services) takes one `tokenFile`, not a token-to-principal map. `tools/call` has a session and a call, not an authenticated agent name. Each listener closes over the identity whose token it accepts. Neither model text nor plugin initialization config selects that identity.

All three real AG-UI adapters ran. The binding and SDK placement pages that said no build implemented AG-UI were corrected.

### Two live events

On 2026-11-23, `run.py --live --approve auto` sent the same build failure to two fresh desks. Both posted an event, a summary that `percentage(37)` returned zero, a change and `PASS: 2 percentage checks passed`. Each needed one approval and one verifier checkout. No turn failed or needed a second fix.

| Run | Approved replacement for `0` in `limits.py` | Commit tested | Event to last agent finish |
|---|---|---|---:|
| 1 | `min(100, max(0, value))` | `d12db232` | 17.4 s |
| 2 | `max(0, min(100, value))` | `13203281` | 19.0 s |

- Grok called `post` and `hand_off` in one model step; the script uses separate steps. Both live approvals named the literal `0`, not the whole `return` line. The page client used the interrupt ID and exact prompt rather than matching the scripted edit text.
- Claude read files in one `codemode` call before proposing the edit. In run 1 it grouped the edit, post and hand-off in the next call. In run 2 it waited for the commit result and made another model request before posting. The host routed the committed revision in both cases. The runner checked the verdict against the verifier's `exec` result in the snapshot, not against an expected sentence from the model.

Phoenix reported the following usage on the `chat` spans, selected by the three thread IDs of each run. Input includes cached tokens; these are token counts, not prices.

| Agent and model | Run 1 requests | Input / output | Run 2 requests | Input / output |
|---|---:|---:|---:|---:|
| Triage · `grok/grok-4.7` | 2 | 5,609 / 189 | 2 | 6,007 / 218 |
| Coder · `claude/claude-sonnet-5-5` | 3 | 11,421 / 394 | 4 | 15,696 / 506 |
| Verifier · `chatgpt/gpt-6.1-sol` | 4 | 1,444 / 73 | 4 | 1,504 / 73 |
| **Total** | **9** | **18,474 / 656** | **10** | **23,207 / 797** |

Triage and the verifier shared the event trace in both runs. Both runs predate the coder's trace trust policy. Their event traces omit the coder turn.

## Where the findings went

| Finding | Outcome |
|---|---|
| Approvals cannot wait past a turn | [ADR 0034](../../docs/adr/0034-approvals-that-wait.md), accepted; implemented in 0.3.0 |
| Finding and waking open work | Resolved: [thread listing](../../docs/bindings/agui.md#listing-threads), `sessionSummary` in every SDK, [`ma --resume-open`](../../docs/reference/standard-configuration.md#resuming-at-start-up) |
| Someone must start the processes | Deployment's job, by design ([ADR 0012](../../docs/adr/0012-one-agent-is-the-scope.md)) |
| Posts during a turn | Kept as plugin tools; Interface-run tools suit client actions |
| One trace across agents | Resolved: `traceTrusted` in `ma`'s policy; a span link to the `hand_off` call waits for a later [telemetry version](../../docs/telemetry.md#what-later-versions-add) |
| Approval in stock `ma` | [Open questions](../../docs/open-questions.md#a-host-driving-several-agents) |
| Closure feed; run receipt; one token per service | [ADR 0035](../../docs/adr/0035-host-limits-from-the-ops-desk.md), accepted for 0.3.0; the desk still uses the workarounds above |
| Rust approval answers | Fixed |
| AG-UI status text | Fixed |

## Plan

1. Host skeleton: store, webhook and listener, the `desk` plugin, the page. TypeScript.
2. The three agents, with scripted models: triage (Python), verifier (Go), coder (`ma` with the `desk` plugin and a scripted model).
3. `run.py` with the scripted checks, and its `check.sh` step.
4. Traces end to end, and a `--live` run.
5. Write up the findings, with each one in [docs/status.md](../../docs/status.md) or an open question.

# Ops desk: design

The original desk ran with scripted models and with three subscription Providers. The changes for 0.3.0 were checked with scripted models only.

## Purpose

Find out what the framework must give an application that drives several whole agents. The application, called the **host** here, is outside the specification ([ADR 0012](../../docs/adr/0012-one-agent-is-the-scope.md)). It builds, at small scale, the layer that [Agent platform 2027](../../docs/research/agent-platform-2027.md) describes: one conversation, one inbox and one listener across several agents. Anything the host cannot build cleanly from the bindings and the declaration is a framework gap found in practice. Each one is recorded in [Desk observations](#findings) as it is met.

## The scenario

An ops desk for a small sample repository:

1. An event arrives at the host's webhook: a failing build or a new issue.
2. The **triage** agent reads it, posts a summary to the conversation, and hands the fix to the coder.
3. The **coder** agent proposes a script in its own checkout. The inbox shows the whole script before it can start.
4. The coder posts what it changed and hands the result to the verifier.
5. The **verifier** agent runs the tests in a separate checkout of the coder's commit and posts a verdict. If the tests fail, the host hands the failure back to the coder, at most twice.

| Agent | Built with | Tools |
|---|---|---|
| Triage | TypeScript SDK app | `post`, `hand_off` |
| Coder | Rust `ma` | `ma`'s `codemode` and file tools, `post`, `hand_off` |
| Verifier | TypeScript SDK app | read-only file tools, `exec` (to run the tests), `post` |

## Parts

```text
  phone / browser ── HTTP ──▶  host (TypeScript)  ◀── webhook ── scripts/send-event.mjs
                                │  SQLite: posts, inbox, routes, run IDs, cursors
                                │  local station: one WebSocket plugin listener
             ┌──────────────────┼──────────────────┐
           AG-UI              AG-UI              AG-UI
             │                  │                  │
   triage (TypeScript)   coder (Rust ma)   verifier (TypeScript)
             └───── each loads the `desk` plugin via MODULAR_AGENT_PLUGINS ─────┘
                    each exports OpenTelemetry to Phoenix
```

- **The host** is a TypeScript program in `demos/ops-desk/host/`. It owns everything that spans agents: the conversation, the inbox, the routing between agents, the listener and its cursor, and starting agent processes. It drives each agent as an authenticated AG-UI client. The HTTP host holds presence on each active thread. The local station owns the processes. A new host opens a new presence; it cannot reuse the old host's delivery.
- **The `desk` tool plugin** is served by the station over the [WebSocket transport](../../docs/bindings/websocket.md), with [named callers](../../docs/bindings/websocket.md#named-callers). All agents use the same address. Their token files are different. The per-connection factory selects the agent from the authenticated caller ID. Its tools:
  - `post(text, kind)`: adds a post to the conversation, with a link to the agent's session as the debug view. `kind` is `summary`, `change` or `verdict`.
  - `hand_off(to, task)`: asks the host to give work to another agent. The host's routing rules decide whether to accept it. The call returns once the host has queued it; it does not wait for the other agent.

  A tool result from the host is data, never authority. The host checks each call against which agent may hand to which.
- **Each agent** has its own process and durable history. Each serves AG-UI on a loopback port the OS assigns. The host starts agents to check for open work and stops them when idle. When work arrives, it starts them again, which exercises session recovery.

Triage and verifier share TypeScript SDK setup for AG-UI and traces. The verifier's sample tools run in process. Rust `ma` stays the coder so the host can drive the standard approval gate over AG-UI. The coder also calls the TypeScript desk plugin over WebSocket.

### Why posts are plugin tools, not Interface-run tools

[Interface-run tools](../../docs/contracts.md#interface-run-tools) suit an action the client performs, such as a browser picking a colour. A handed-off call ends the run, and its result starts a continuation turn. Using one for every `post` would split each agent's work into a turn per post. A tool the host serves keeps the work in one turn. This is itself a finding: there is no lightweight way for an Interface to receive a structured post during a turn.

## The conversation and the inbox

- **The conversation** holds posts from all three agents in order, plus the events that started them. It never shows raw sessions; each post links to the AG-UI snapshot of the turn that made it.
- **The inbox** lists open questions and approvals from all three agents, merged by deadline. Each item keeps its source agent, session and question ID; the answer goes back to that agent over its presence route. The host reads the gated snapshot before showing an answer button and again before posting the answer. Neither an inbox row nor a closure notice is an answerable delivery.
- **Approvals** use [`ma --approval ask`](../../docs/reference/standard-configuration.md#approval). The caller sees the unchanged interrupt, call ID and deadline. The coverage flag says the allow also covers this dispatch's nested file writes, commands and desk calls. Other gates still apply. With `approval_wait: "untilDeadline"` and the operator's `approvalWaitMaxMs`, the origin turn ends before the script starts. A timely allow starts a continuation; expiry leaves the checkout untouched.
- **Closed items** come from the [wait-closure feed](../../docs/bindings/agui.md#wait-closures). A saved cursor belongs to an agent and thread. The desk also keeps the outstanding request IDs separately from cached prompts, so it does not stop an idle agent before catching up. SQLite removes the ID and commits the notice and its cursor together. A restart uses the saved cursor before following live. On `409 cursor_expired` the host replaces open waits from a new snapshot without assigning reasons to missing rows.
- **Run receipts** describe one exchange, not the last turn in the thread. The host saves both input and answer run IDs before sending. On reconnect it reads [each receipt](../../docs/bindings/agui.md#run-receipts) as the original client. A release marker is not proof of delivery. A 404 is not proof the POST failed.

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

1. **Happy path:** an event, triage's post and hand-off, the coder's approval answered from the inbox, the change, the verifier's pass verdict. The parent approval covers both file changes and the git command. The conversation has the posts in order; the inbox records the answer. A loopback OTLP receiver checks the three input turns in the event trace and the new coder turn's link to the first.
2. **Refusal:** the coder's approval passes its deadline. The refusal reaches the inbox and the conversation, and no file changes.
3. **Failing verification:** the verifier's first verdict fails; the coder gets one more try; the second verdict passes.
4. **Restart:** the coder's process is killed with `SIGKILL` during its turn. The host reads the input and answer receipts after recovery. The input released an interrupt; the answer stream was lost but its work completed. No hand-off is delivered twice.
5. **Duplicate event:** the same event ID twice starts one piece of work.
6. **Host restart:** kill the HTTP host with `SIGKILL` during approval. Delete its inbox rows, cached receipt statuses and coder route's thread link. Give the host an invalid wait cursor to exercise the snapshot reset. The replacement checks the parked input's receipt. It lists the thread, delivers the question on a fresh presence and answers once. The two run IDs have different receipts.
7. **Host down at the decision:** decline directly on the coder while the HTTP host is dead. Delete the cached prompt. The replacement reads the committed decline, not a guessed expiry.
8. **Named callers:** the shared listener rejects a wrong token with HTTP 401. All three token files work there. Claims in the handshake and tool call cannot turn the verifier into the coder.

With real models (`--live`) the same flow runs against your sign-ins; it is not part of `check.sh`.

<a id="findings"></a>

## Desk observations

- **Approval in stock `ma` and approvals that wait — used.** The desk used to ask inside a custom editing tool and refuse every other edit or command. The [built-in gate](../../docs/contracts.md#approvals-that-cover-nested-calls) now asks before `codemode`. On allow, `tools.edit`, `tools.write` and the fixed commit command run without another approval. The sample scope gate does not ask or grant permission. [ADR 0034](../../docs/adr/0034-approvals-that-wait.md) lets the desk park this exact call until its original deadline. The station no longer keeps a presence alive for a dead host.
- **How a wait closed — used.** The host records `answered`, `declined`, `expired` and `revoked` only from the gated feed. The local clock can disable a button, not decide a question. A lost presence alone produces no closure. The desk also watches the plugin's `turn.end` notification: a parked origin has an open call, and closing its question is not the end of the continuation.
- **What happened to the run — used.** A receipt supplies `terminal` and `work` independently. After killing the coder during hand-off, the input receipt is `interrupt/completed`; the answer receipt is `unknown/completed`. A missing receipt is shown as unavailable. Neither an EOF nor a snapshot makes it safe to dispatch again.
- **Identifying plugin callers — used.** One listener loads the operator's caller table. The matched ID and the session ID select the active route together. The ID also selects the checkout for a hand-off. Initialization paths, claimed names and call arguments grant no access to another route.
- **Finding and waking work — deployment still starts processes.** At startup the host pages the [thread listing](../../docs/bindings/agui.md#listing-threads). The Rust coder uses [`--resume-open`](../../docs/reference/standard-configuration.md#resuming-at-start-up), and both TypeScript agents use the SDK's `resumeOpen` option. Listing alone does not wake a stopped service. A snapshot cannot authorize a missed Interface hand-off.
- **Posts during a turn — kept as plugin tools.** A frontend hand-off ends the exchange. A custom event is not a committed, acknowledged post. The desk stores plugin posts by route and call ID.
- **Tracing — used.** All three work tokens trust the desk's trace parent. The host carries it across the queue. The approval continuation has its own turn span linked to the origin. [Telemetry v1](../../docs/telemetry.md#what-later-versions-add) does not link the receiving turn to another agent's `hand_off` call.
- **Earlier fixes.** Rust accepts the approval schema without choice options. All three AG-UI adapters run; their status text was corrected.

### Resolved: displaying the script as code

The page always shows the unchanged approval message. When the [AG-UI interrupt](../../docs/bindings/agui.md#interrupts-and-frontend-tools) includes `metadata["modular-agent.approvalCall"]` for `codemode`, the page also shows `input.code` with its original line breaks. Without that field it does not try to recover the script from the prompt or history. Allow and refuse still answer the request ID.

### Two live events

These measurements are from the earlier editing tool, not the new script approval. On 2026-11-23, `run.py --live --approve auto` sent the same build failure to two fresh desks. Both posted an event, a summary that `percentage(37)` returned zero, a change and `PASS: 2 percentage checks passed`. Each needed one approval and one verifier checkout. No turn failed or needed a second fix.

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

<a id="where-the-findings-went"></a>

## How the desk handles each case

| Finding | Outcome |
|---|---|
| Approvals outlasting a turn | The desk sets the operator maximum and the session wait mode; a returning approver opens a fresh presence ([ADR 0034](../../docs/adr/0034-approvals-that-wait.md)). |
| Approval in stock `ma` | The coder uses `--approval ask` and covered approvals, not a tool that asks inside its call. |
| Closure feed | The host follows and checkpoints the per-thread cursor ([ADR 0035](../../docs/adr/0035-host-limits-from-the-ops-desk.md)). |
| Run receipt | The host saves every run ID and reports exchange release separately from work settlement. |
| One token per service | The station uses one named-caller listener with three token files. |
| Finding and waking open work | The host lists threads; the station starts the processes ([ADR 0012](../../docs/adr/0012-one-agent-is-the-scope.md)). |
| Posts during a turn | Server tools acknowledge committed posts without ending the turn. |
| One trace across agents | `traceTrusted` and a queued trace parent for inputs; a span link for the approval continuation. |
| Rust approval answers; AG-UI status text | Fixed in the framework. |
| Rendering the unchanged approval as code | [Resolved](#resolved-displaying-the-script-as-code): the page reads the gated call from interrupt metadata. |

## Plan

1. Host skeleton: store, webhook and listener, the `desk` plugin, the page. TypeScript.
2. The three agents, with scripted models: triage (TypeScript), verifier (TypeScript), coder (`ma` with the `desk` plugin and a scripted model).
3. `run.py` with the scripted checks, and its `check.sh` step.
4. Traces end to end, and a `--live` run.
5. Write up the findings, with each one in [docs/status.md](../../docs/status.md) or an open question.

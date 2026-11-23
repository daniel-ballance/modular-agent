# Ops desk: design

Status: proposed, 2026-11-23. No code yet.

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

- **The host** is a TypeScript program in `demos/ops-desk/host/`. It owns everything that spans agents: the conversation, the inbox, the routing between agents, the listener and its cursor, and starting agent processes. It drives each agent as an authenticated AG-UI client and keeps the optional presence stream open, so approvals can be answered.
- **The `desk` tool plugin** is served by the host over the [WebSocket transport](../../docs/bindings/websocket.md), one token per agent. Its tools:
  - `post(text, kind)`: adds a post to the conversation, with a link to the agent's session as the debug view. `kind` is `summary`, `change` or `verdict`.
  - `hand_off(to, task)`: asks the host to give work to another agent. The host's routing rules decide whether to accept it. The call returns once the host has queued it; it does not wait for the other agent.

  A tool result from the host is data, never authority. The host checks each call against which agent may hand to which.
- **Each agent** runs as its own process with durable history in its own data directory, serving AG-UI on a loopback port the host picks. The host starts an agent when work arrives for it and stops it after it has been idle for a set time. That exercises reopening sessions after a restart.

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

All three agents export to Phoenix (`scripts/phoenix.sh`). The host starts a span for each event and passes `traceparent` on each AG-UI request, from a trusted peer, so one event can be followed from the webhook through all three agents.

## Checks

`demos/ops-desk/run.py`, run by `scripts/check.sh` in the shared phase, with scripted models for all three agents:

1. **Happy path:** an event, triage's post and hand-off, the coder's approval answered from the inbox, the change, the verifier's pass verdict. The conversation has the posts in order; the inbox is empty at the end.
2. **Refusal:** the coder's approval passes its deadline. The refusal reaches the inbox and the conversation, and no file changes.
3. **Failing verification:** the verifier's first verdict fails; the coder gets one more try; the second verdict passes.
4. **Restart:** the coder's process is killed with `SIGKILL` during its turn. The host restarts it, reopens the session, and the work completes or settles as the recovery rules say. No hand-off is delivered twice.
5. **Duplicate event:** the same event ID twice starts one piece of work.

With real models (`--live`) the same flow runs against your sign-ins; it is not part of `check.sh`.

## Findings

Expected before building, to confirm or reject:

- **Approvals cannot wait past a turn.** An inbox read hours later needs approvals that wait durably. This demo uses short deadlines; a later ADR can decide.
- **Waking an agent.** The host starts processes and reopens sessions itself. Whether the framework should help (a wake contract, or a declared way to find an agent's open work) is a candidate gap.
- **Posts during a turn.** See [above](#why-posts-are-plugin-tools-not-interface-run-tools).
- **Traces across agents.** Telemetry version 1 has no links between a hand-off and the work it starts in another agent.

## Plan

1. Host skeleton: store, webhook and listener, the `desk` plugin, the page. TypeScript.
2. The three agents, with scripted models: triage (Python), verifier (Go), coder (`ma` with the `desk` plugin and a scripted model).
3. `run.py` with the five checks, and its `check.sh` step.
4. Traces end to end, and a `--live` run.
5. Write up the findings, with each one in [docs/status.md](../../docs/status.md) or an open question.

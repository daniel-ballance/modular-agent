# Ops desk

Send a build failure to a webhook. The TypeScript triage agent posts a summary. The Rust `ma` asks permission to run a script that edits `limits.py` and commits it. The TypeScript verifier runs the tests on that commit. The host shows the conversation and the approval in one page. The default checks use scripted models and need no sign-in. `--live` runs one event on your subscriptions.

## Build and check

From the repository root on Linux, use `git`, `setpriv` (util-linux), `mise`, Python 3 (for the runner and sample tests) and Node with `node:sqlite` (22.13 or newer):

```sh
demos/ops-desk/build.sh
python3 demos/ops-desk/run.py
```

The eight checks use disposable data directories, tokens, loopback ports and scripted models. Use `--only NAME` for one:

| Case | What it checks |
|---|---|
| `happy` | Approve one complete script. It edits `limits.py`, writes `change.txt`, commits both and hands off to the verifier. Check the tests and trace links. |
| `refusal` | The approval expires without starting the script. No file or commit changes. |
| `verification` | An extra upper-bound test fails the first fix. A second approved fix passes. |
| `restart` | Kill the coder after it queues the verifier but before its tool returns. Its answer receipt says terminal `unknown`, work `completed` after recovery. One hand-off reaches the verifier. |
| `duplicate` | Sending the same event ID twice starts one triage input. |
| `host-restart` | Kill the HTTP host with a parked approval. Drop its cached inbox, receipt statuses and route's thread link, and supply an invalid wait cursor. On a fresh presence, answer the same question before its original deadline. Check both run receipts. |
| `host-decline` | While the host is down, decline directly over AG-UI. Drop its cached inbox. The new host reads `declined` from its saved wait cursor. |
| `callers` | Try the same plugin listener with a wrong token and each agent's token. A verifier claiming to be the coder cannot post to its thread. |

## Run one live event

Build as above. Sign in first through `ma login grok`, `ma login chatgpt` and `ma login claude` if needed. The TypeScript [subscription Providers](../../docs/sdk/subscription-providers.md) use `auth.json` in [ma's configuration folder](../../docs/reference/standard-configuration.md#files), including its normal refresh lock. The Rust coder uses Claude Code's sign-in (`CLAUDE_CONFIG_DIR` or `~/.claude`). No API key or copy of either sign-in is needed.

```sh
# Optional: collect the three agents' traces.
scripts/phoenix.sh start
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:6006

python3 demos/ops-desk/run.py --live
```

The command sends one sample build failure and prints the loopback page address. Open it, sign in as `desk` with the password in the indicated `page.token` file, and allow or refuse the whole script in the inbox. An allow covers its nested writes and commands for this dispatch only. This is `--approve manual`, the default. To let an orchestrator allow each script without a browser, use this command **instead**:

```sh
python3 demos/ops-desk/run.py --live --approve auto
```

Auto prints each approval before answering through the same HTTP API as the page. It does not turn approval off. Each run uses the model subscriptions; do not run it in a check loop.

| Agent | Default model | Override (full `provider/id` on the same Provider) |
|---|---|---|
| Triage, TypeScript | `grok/grok-4.7` | `DESK_TRIAGE_MODEL` |
| Coder, Rust `ma` | `claude/claude-sonnet-5-5` | `DESK_CODER_MODEL` |
| Verifier, TypeScript | `chatgpt/gpt-6.1-sol` | `DESK_VERIFIER_MODEL` |

Each invocation uses a fresh, private `ops-desk-live-*` directory. The runner chooses it. It prints the posts and exits after the routes settle. Success requires an answered approval, a changed commit checked out by the verifier, and a passing verdict backed by its test tool. The page stops; the logs, database and checkouts stay in that directory until you remove it. Match the printed thread IDs to `gen_ai.conversation.id` in Phoenix. See [the two measured runs](DESIGN.md#two-live-events) for latency and token counts.

## Try the scripted page

```sh
python3 demos/ops-desk/run.py --serve
```

Open `http://127.0.0.1:8080`. In the browser login, use **desk** as the username. Get the password on the host with `cat demos/ops-desk/.desk/page.token`. In another terminal at the repository root, send an event:

```sh
node demos/ops-desk/scripts/send-event.mjs build-17 build-failed
```

Read the script, its call ID, coverage and deadline. Choose **Allow** to run it once. **Run receipts** shows the terminal class and the work disposition for each input and answer. Follow its post and the verifier's verdict. Each post has a snapshot link. To see a refusal, send a new event and let its approval expire. Sending `build-17` again acknowledges it without starting work. Leave off the arguments to send a sample failure with a fresh ID. `issue-opened` is the other event kind.

The coder uses `--approval ask`. Its operator policy sets `approvalWaitMaxMs` from `DESK_APPROVAL_MS` (default 180000); its global settings set `approval_wait: "untilDeadline"`. The turn ends with the script unstarted. An approval can survive a lost presence or a process restart, but neither extends its deadline. Approval does not grant arbitrary shell access: the desk plugin still limits the coder to the sample files, numeric edit and fixed commit command.

The station starts and stops agents and serves their plugin on one loopback listener. Each agent has a separate token. The HTTP host owns its AG-UI presence. At startup it lists the agents, reads the receipts for its saved runs and reconnects to open work. A new host delivers the parked question from a fresh snapshot. It follows wait closures from its saved cursor, not from a browser clock. If the agent no longer recognizes the cursor, a snapshot restores current waits but cannot recover the missed reasons.

Idle agents stop after one minute (`DESK_IDLE_MS=60000`). A snapshot link can wake one. Ctrl-C stops the desk and its children. Starting it again with the same `DESK_DATA` reuses its SQLite store, tokens, sample repository, worktrees and agent histories. The default is `demos/ops-desk/.desk/`. Use a fresh private directory for a clean start; a pre-upgrade desk has no saved answer run IDs. Do not point the desk at a real project or run two hosts against one store.

### Tailnet

Keep the desk on loopback and let Tailscale forward the port. A firewall that admits only SSH from the tailnet, as Fedora Server's default does, blocks a direct bind to the Tailscale address. Raw TCP forwarding needs no MagicDNS:

```sh
python3 demos/ops-desk/run.py --serve        # page on 127.0.0.1:8080
tailscale serve --bg --tcp=8080 tcp://127.0.0.1:8080
```

Open `http://TAILSCALE-IP:8080` on your phone (`tailscale ip -4` gives the address). `tailscale serve --tcp=8080 off` stops the forwarding. The agents and the plugin service listen only on loopback. The page login can read every post and approve writes. The separate `events.token` can only submit events. Both are generated under `DESK_DATA`. Keep that directory private. The page and webhook use plain HTTP; Tailscale encrypts the tailnet hop, but do not expose the port on a public network.

### Phoenix

```sh
scripts/phoenix.sh start
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:6006
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
python3 demos/ops-desk/run.py --serve
```

Send an event, then open `http://127.0.0.1:6006`. The desk and all three agents export metadata, not the file or the event payload. Open the `desk.event` trace for the three input turns. The coder's approval continuation has its own turn span with a link to the originating coder span. Match each `invoke_agent` span's `gen_ai.conversation.id` to the agent's `threadId`. The coder trusts the desk token because its policy sets `traceTrusted: true`. Other tokens do not inherit that trust. Stop the host, then run `scripts/phoenix.sh stop`. The scripted happy-path check checks the three input turns' trace IDs and the continuation's link at a disposable loopback OTLP receiver. It does not need Phoenix.

## Where to look

- [Host](host/desk.ts), [SQLite store](host/store.ts), [AG-UI client](host/agui.ts), [agent station](host/station.ts) and [page](host/public/index.html).
- [Triage](host/triage.ts), [coder script](coder/model.json), [live coder instructions](coder/instructions.md), [coder file and command limits](host/coder-scope.ts), [verifier](host/verifier.ts) and [sample](sample/limits.py).
- [Design and findings](DESIGN.md).

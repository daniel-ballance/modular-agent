# Ops desk

Send a build failure to a webhook. The Python agent posts a summary, the Rust `ma` asks permission to edit `limits.py`, and the Go agent runs the tests on the resulting commit. The host shows the conversation and the approval in one page. The default checks use scripted models and need no sign-in. `--live` runs one event on your subscriptions.

## Build and check

From the repository root on Linux, use `git`, `setpriv` (util-linux), `mise`, `uv`, Python 3 and Node with `node:sqlite` (22.13 or newer):

```sh
export TMPDIR="$HOME/.cache/ma-std-tmp" CARGO_INCREMENTAL=0
mkdir -p "$TMPDIR"
demos/ops-desk/build.sh
python3 demos/ops-desk/run.py
```

The six checks use disposable data directories and loopback ports. Each checks the real AG-UI agents, not a simulated host. Use `--only happy`, `refusal`, `verification`, `restart`, `duplicate` or `host-restart` to run one. The verification check adds an upper-bound test to the sample: the first fix fails it, the second passes. The restart check kills `ma` **after** the verifier route is on disk and **before** the hand-off tool returns. It checks recovery in the same thread and exactly one verifier input. The host-restart check kills the HTTP host while an approval is open and deletes the cached inbox and route's thread link. The replacement lists the agents, reads the same approval and answers it before its original deadline.

## Run one live event

Build as above. Sign in first through `ma login grok`, `ma login chatgpt` and `ma login claude` if needed. The Python and Go [subscription Providers](../../docs/sdk/subscription-providers.md) use `auth.json` in [ma's configuration folder](../../docs/reference/standard-configuration.md#files), including its normal refresh lock. The Rust coder uses Claude Code's sign-in (`CLAUDE_CONFIG_DIR` or `~/.claude`). No API key or copy of either sign-in is needed.

```sh
# Optional: collect the three agents' traces.
scripts/phoenix.sh start
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:6006

python3 demos/ops-desk/run.py --live
```

The command sends one sample build failure and prints the loopback page address. Open it, sign in as `desk` with the password in the indicated `page.token` file, and allow or refuse the exact edit in the inbox. This is `--approve manual`, the default. To let an orchestrator allow the edit without a browser, use this command **instead**:

```sh
python3 demos/ops-desk/run.py --live --approve auto
```

Auto prints each approval before answering through the same HTTP API as the page. It does not turn approval off. Each run uses the model subscriptions; do not run it in a check loop.

| Agent | Default model | Override (full `provider/id` on the same Provider) |
|---|---|---|
| Triage, Python | `grok/grok-4.7` | `DESK_TRIAGE_MODEL` |
| Coder, Rust `ma` | `claude/claude-sonnet-5-5` | `DESK_CODER_MODEL` |
| Verifier, Go | `chatgpt/gpt-6.1-sol` | `DESK_VERIFIER_MODEL` |

Each invocation uses a fresh, private `ops-desk-live-*` directory under `TMPDIR`. It prints the posts and exits after the routes settle. Success requires an answered edit, a changed commit checked out by the verifier, and a passing verdict backed by its test tool. The page stops; the logs, database and checkouts stay in that directory until you remove it. Match the printed thread IDs to `gen_ai.conversation.id` in Phoenix. See [the two measured runs](DESIGN.md#two-live-events) for latency and token counts.

## Try the scripted page

```sh
python3 demos/ops-desk/run.py --serve
```

Open `http://127.0.0.1:8080`. In the browser login, use **desk** as the username. Get the password on the host with `cat demos/ops-desk/.desk/page.token`. In another terminal at the repository root, send an event:

```sh
node demos/ops-desk/scripts/send-event.mjs build-17 build-failed
```

Choose **Allow** on the coder's exact edit. Follow its post and the verifier's verdict. Each post has a snapshot link. To see a refusal, send a new event and let its approval expire. Sending `build-17` again acknowledges it without starting work. Leave off the arguments to send a sample failure with a fresh ID. `issue-opened` is the other event kind.

The default approval deadline is three minutes (`DESK_APPROVAL_MS=180000`). Agents stop after one minute without work (`DESK_IDLE_MS=60000`). At start-up the host lists all three agents. A snapshot link can also wake a stopped agent. The local station holds the agent processes and the original presence streams. The scripted launcher restarts a killed HTTP host without replacing the station. Stopping the whole desk detaches those streams; a new stream cannot inherit an approval. Ctrl-C stops the desk and its children. Starting it again with the same `DESK_DATA` reuses the SQLite store, tokens, sample repository, worktrees and agent histories. The default directory is `demos/ops-desk/.desk/`. Use a different, private directory for a clean start. Do not point the desk at a real project or run two hosts against one store.

### Tailnet

Keep the desk on loopback and let Tailscale forward the port. A firewall that admits only SSH from the tailnet, as Fedora Server's default does, blocks a direct bind to the Tailscale address. Raw TCP forwarding needs no MagicDNS:

```sh
python3 demos/ops-desk/run.py --serve        # page on 127.0.0.1:8080
tailscale serve --bg --tcp=8080 tcp://127.0.0.1:8080
```

Open `http://TAILSCALE-IP:8080` on your phone (`tailscale ip -4` gives the address). `tailscale serve --tcp=8080 off` stops the forwarding. The agents and their tool services listen only on loopback. The page login can read every post and approve writes. The separate `events.token` can only submit events. Both are generated under `DESK_DATA`. Keep that directory private. The page and webhook use plain HTTP; Tailscale encrypts the tailnet hop, but do not expose the port on a public network.

### Phoenix

```sh
scripts/phoenix.sh start
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:6006
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
python3 demos/ops-desk/run.py --serve
```

Send an event, then open `http://127.0.0.1:6006`. The desk and all three agents export metadata, not the file or the event payload. The triage and verifier turns share the desk event's trace. Stock Rust `ma` exports the coder turn on a separate trace; match `gen_ai.conversation.id` to the coder snapshot's `threadId`. [Findings](DESIGN.md#findings) explains why. Stop the host, then run `scripts/phoenix.sh stop`. Phoenix is not needed for the checks.

## Where to look

- [Host](host/desk.ts), [SQLite store](host/store.ts), [AG-UI client](host/agui.ts) [agent station](host/station.ts) and [page](host/public/index.html).
- [Triage](triage/main.py), [coder script](coder/model.json), [live coder instructions](coder/instructions.md), [approval tool](coder/change.py), [verifier](verifier/main.go) and [sample](sample/limits.py).
- [Design and findings](DESIGN.md).

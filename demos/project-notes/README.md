# Project notes

One agent adds a line to `notes.txt`, searches for it, and reports the match. Its four parts run on the same machine and use only public SDK APIs and bindings.

```text
                     Go agent
                 (durable Runtime,
                 scripted Provider)
                   /      |       \
              stdio    WebSocket    HTTP history binding
                /         |          \
      Python tools   TypeScript       Rust
                     working env.     history service
                          |            |
                      notes.txt     file history
```

Tool file requests go back to the Go agent over stdio. The agent forwards them to the working environment over WebSocket. Both processes see the same absolute project path.

| Part | Code |
|---|---|
| [Agent (Go)](agent/main.go) | Composes the parts, prompts once or reopens a session, and reports the settled turn. |
| [Tools (Python)](tools/notes.py) | Appends a line and searches for matching lines. Both tools use the SDK's tool context for all file access. |
| [Working environment (TypeScript)](environment/service.ts) | Serves the SDK's local working environment as a WebSocket plugin. |
| [History service (Rust)](history/src/main.rs) | Serves the SDK's file-backed history over HTTP. |

## Build and run

From the repository root, on Linux with `mise`, Node.js 22 or later, `uv`, and `python3`:

```sh
demos/project-notes/build.sh
demos/project-notes/run.py
```

Each case gets a fresh temporary project and two owner-only random tokens. The services bind to loopback on OS-assigned ports. Run this only on a machine where you trust the other local accounts: the listeners use plain HTTP and WebSocket, and moving a plugin to another process does not sandbox it.

The first check compares the file, tool results and final answer with the transcript read from the history service. The second check (also available with `--crash`) kills the agent and its stdio plugin after the line appears in the file but before the tool returns. A fresh agent with an empty local state directory reopens the same session over HTTP, without another prompt. The durable Runtime reports the unfinished write as `outcomeUnknown`, does not repeat it, and completes the turn after searching the file. Both checks stop their processes and delete their temporary directories.

## Run with a real model

For a Claude subscription, sign in with `ma login claude` or `claude auth login`. Build the existing [Claude Provider](../../typescript/packages/claude/README.md) and run the same task:

```sh
(cd typescript && npm ci && npm run build --workspace @modular-agent/claude)
demos/project-notes/run.py --real claude/claude-haiku-5-5
```

The Go SDK loads the Provider as a stdio plugin. Claude Code finds the login under `HOME` (or `CLAUDE_CONFIG_DIR` if set); the demo does not open the credential file. To use an OpenAI API key instead, set `OPENAI_API_KEY` in your environment and run `demos/project-notes/run.py --real openai/gpt-5.2`. Only the Go process receives the key for its in-process Provider.

## Discovering the history listener address

[Placement](../../docs/sdk/placement.md#services) did not say how to learn a history listener's bound address. It now does: `serveHistory` with port `0` returns a server with `url` and `close()`. The demo uses Rust's `listen_history`, which already behaves that way.

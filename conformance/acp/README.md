# ACP binding conformance kit

Checks that an agent follows the [ACP host binding](../../docs/bindings/acp.md), `modular-agent-acp/1`. It starts the agent in conformance mode, with a fresh data folder (`MODULAR_AGENT_DATA_DIR`) and an empty project folder. Then it drives the agent with the official ACP client library. It needs no network and no model: the agent's `conformance/echo` model answers.

```sh
cd conformance/acp && npm install
node run.mjs -- <agent command> [args...]
node run.mjs --verbose -- <agent command> [args...]   # shows the agent's stderr and passing details
```

The agent command must start the agent serving ACP on stdin and stdout. The exit code is 0 when every check passes.

What it checks:
- **`initialize`:** the binding, every declaration key, the required extensions, and a host actor.
- **`session/new`:** the `model`, `thinking` and `approval` options, `conformance/echo`, and the session's declaration.
- **A prompt:** the streamed echo, `inputId`, and the outcome.
- **A keyed prompt sent twice:** reported as a duplicate, with no new entries and no new message.
- **The `history` extension:** the fixed entry kinds and the turn's outcome. `after` works, and an unknown entry is refused.
- **Approval:** exactly two options, a refused call doesn't run, and an allowed call does.
- **Cancelling** a `bash` call: the prompt ends as `cancelled` within 5 seconds.
- **The `input` extension:** a receipt, a resent key is a duplicate, and the input runs once.
- **The `requests` and `answer` extensions.**
- **An unused session** isn't listed after it is closed.
- **`session/load` in a new process:** replays the session, keeps its history, and remembers its keys.

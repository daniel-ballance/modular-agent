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

These options add checks:
- **`--plugin-checks`:** the conformance plugin's hooks are in force (see the [plugin binding](../../docs/bindings/plugin.md)).
- **`--crash-checks`:** the agent is killed with SIGKILL during a `bash` call and the session is reopened in a new process. The interrupted call must have exactly one result, with an unknown outcome, and must not run again. The turn must carry on to completion if the agent declares `continuesAfterRestart`, and end as failed if not- **`--probe-checks`:** the kit also loads the probe plugin, `../plugin/probe.mjs`, which checks the host side of the [plugin binding](../../docs/bindings/plugin.md): paging history, which requests need a live parent, an unknown host method, a request cancelled before it started, and refusing a registration the host can't accept.
- **`--portable-checks`:** with `MODULAR_AGENT_HISTORY_URL` and `MODULAR_AGENT_HISTORY_TOKEN_FILE` set, every entry the agents kept in that history service must be in the [shared shapes](../../docs/bindings/data.md#portable-sessions).

**Reopening with another agent.** After the agent's command, `--then <second command>` gives a second agent. Every reopening in a new process uses it: `session/load` with its replay and keys, and with `--crash-checks`, recovering the killed agent's turn. Point both agents at one history service, and the second agent reopens, continues and recovers a session the first one wrote. The second agent's declaration decides how the recovered turn must end.

```sh
node ../../packages/services/dist/src/serve.js history '{"dir":"/tmp/h","token":"a-token-of-16-chars-or-more"}'   # prints {"url": ...}
MODULAR_AGENT_HISTORY_URL=<url> MODULAR_AGENT_HISTORY_TOKEN_FILE=<file> \
  node run.mjs --crash-checks --portable-checks -- <agent A> --then <agent B>
```
.

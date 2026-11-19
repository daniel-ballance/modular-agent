# Milestone 4: hosts and the wider world

**Complete. Stop here.** All required items are implemented and proven. The optional
full-screen terminal UI is skipped. Milestone 5 has not started. The frozen
`docs/` are unchanged. No helper subagents were used, no other implementation was
read, and no T3 Code settings were changed.

## Built and how to run it

Two new independently installable packages, `ma-acp` and `ma-mcp`, bring the uv
workspace to 24 part packages plus the root composition package.

```sh
uv sync --python 3.13
uv run modular-agent --mode acp --project /absolute/path/to/project
uv run modular-agent --mode acp --runtime durable --project /absolute/path/to/project

uv run --offline pytest -q --runtime transient
uv run --offline pytest -q --runtime durable
uv run ruff check .
uv run ruff format --check .
uv build --all-packages
```

ACP mode reserves stdout for protocol messages. A host launches the command with
stdin/stdout pipes, then uses the official Python library's `connect_to_agent`.
`tests/acp_fixture.py` is a complete runnable client example. Initialize with
protocol version 1, call `new_session`, then `prompt`. No API key is used. Real
inference is only `claude-haiku-5-5` through Claude Code's existing subscription
login and `claude-agent-sdk==0.2.183`.

### ACP contract

The adapter uses `agent-client-protocol==1.0.0`. It advertises load, list, resume,
close, text prompts, stdio MCP and Streamable HTTP MCP. Model, thinking and approval
are select configuration options. Invalid values fail before settings change.
Approvals offer allow-once and reject-once permission requests. Text and choice
questions use negotiated form elicitation. Secrets never use forms; ACP secret
intake is not advertised and those questions are declined. Terminal secret intake
continues to use the credential store directly.

Load replays the gated current branch before recovery starts. Resume restores
without replay. Close is idempotent and cancels session work and jobs. EOF instead
interrupts the process: an unanswered question is not silently answered or declined.
The transient Runtime settles an interrupted turn; the durable Runtime continues.
A session already active in this Interface must be closed before load or resume.

The stdio owner is a single local host acting as the enrolled `user` actor. This
is not a network-authenticated multi-user service. Client metadata cannot choose
another actor or widen authority. Forks preserve the initiating actor's narrowed
authority. Commands preserve that actor through feature-plugin dispatch.

ACP does not name every operation in the description. The initialization response
advertises these extension requests, each returning `{"value": ...}`:

| Method after `_modular-agent/` | Parameters besides `session` |
|---|---|
| `declaration` | none |
| `follow` | optional `after` entry ID; returns entries and question answerability |
| `submit` | typed `content`, optional `key`, `when`: now, steer or after |
| `withdraw` | input receipt ID as `input` |
| `command` | slash command as `text` |
| `move` | `point`, optional `rewind`; unsupported rewind refuses before effects |
| `fork` | optional current-branch `point` |
| `erase` | entry IDs as `entries` |
| `jobs`, `job_cancel` | none, or `job` |
| `questions`, `answer` | none, or `request` and `value` |
| `tool` | `name` and `input`; uses the same checked Runtime path as model calls |

Set client capabilities `_meta.modular-agent.events` to true to receive
`_modular-agent/event` notifications. The complete session declaration is also in
new/load/resume metadata. Standard prompt metadata may supply
`_meta.modular-agent.key` and `when`. Only one standard prompt waits per session;
the asynchronous submit extension admits steering and follow-ups during work.
Missed live pieces are not replayed; their durable entries are available through
follow. Every outward stream, snapshot and return value passes the output gate.

### Settings, plugins and trust

Global settings live at `--home/settings.json`, normally
`~/.local/state/modular-agent-py/settings.json`. Project settings live at
`.modular-agent/settings.json`. For example, in either file:

```json
{
  "model": "claude-haiku-5-5",
  "thinking": "off",
  "plugins": [
    {"factory": "installed_package:Plugin", "options": {"enabled": true}}
  ],
  "plugin_settings": {
    "installed_package:Plugin": {"enabled": false},
    "mcp": {
      "servers": [
        {"name": "local", "command": "/absolute/path/to/server", "args": [], "env": []},
        {"name": "remote", "type": "http", "url": "https://your-server.example/mcp", "headers": []}
      ]
    }
  }
}
```

The factory names an installed Python callable returning a plugin. Options are
JSON constructor arguments. `plugin_settings` merges options by factory name,
one level deep; `mcp` names the built-in adapter. An optional `replaces` explicitly
names an installed plugin to replace. The Harness load gate runs before import.
Failures stop the partial composition. Plugins have the agent's full permissions.

Global executable settings apply at startup. Project plugins and plugin settings
apply only after explicit local trust:

```sh
uv run modular-agent --project /path/to/project --trust-project
uv run modular-agent --project /path/to/project --untrust-project
```

The canonical path is kept in the data directory, not in the project. A project
cannot grant itself trust. Revocation takes effect at next startup. Session
defaults, including model and thinking, apply even before trust. Do not put secrets
in settings, scripts, repository files or command arguments.

Composition is fixed at startup and bound to one project, with many sessions.
Starting a session for another project refuses before work. Reopen without
`--project` selects the saved session's project before loading executable settings.
Trusted embedding without a bound project loads only global plugin configuration.
There is no hot loading.

### MCP contract

The official `mcp==2.3.0` library supplies stdio and Streamable HTTP transports.
Settings servers connect once and serve every session. Servers supplied by an ACP
client connect before recovery, serve only that session, and close with it. Their
env and headers are ephemeral, not session settings or history. A reconnect must
supply them again. Subagents do not inherit host-only servers. Duplicate names
and shadowing a settings server refuse rather than silently replace it.

Definitions retain the exact input schema and original MCP metadata. Agent tool
names include a readable shortened tool name and a stable hash of server and
original name, so they are unique and fit Provider limits. Read-only, destructive,
idempotent and open-world annotations become hints, with conservative defaults.
They do not bypass approval or authority. MCP does not specify a concurrency hint,
so these tools do not run in parallel.

Tool enumeration is paginated and refreshed before steps and calls. Changes and
connection failures are reported. Content blocks, structured output and MCP
metadata survive adaptation. A returned tool error is failed. A failure before
dispatch is failed; losing a server after dispatch produces an unknown outcome,
with an explicit instruction to check external state. Cancellation uses the SDK's
cancellation notification. The connection-owning task closes its own SDK scopes.

Sampling, server elicitation, resources, prompts and legacy HTTP+SSE are not
advertised. Stdio teardown is tested, but these external servers do not claim the
working environment's cgroup-based SIGKILL containment. That difference is declared.

## Acceptance evidence

All tests are offline with a fake Provider, except the deliberately invoked real
run below. Transport tests use actual official SDK clients and servers, not mock
protocol encodings. HTTP tests use the official ASGI server with sockets disabled,
covering JSON and SSE responses on Streamable HTTP.

| Item | Offline evidence |
|---|---|
| 1. ACP Interface | `test_acp.py`: official client over subprocess stdio, declarations, config changes, streaming, keyed deduplication, permission choices and refusal, text/choice elicitation, create/load/resume/list/close, cross-process continuation, cancellation, follow and session-only MCP. `test_acp_edges.py`: gating, erasure, move/fork, narrowed authority, command attribution, EOF recovery and replay ordering. |
| 2. MCP tools | `test_mcp.py`: actual stdio servers, global/session isolation, annotations, structured output, official HTTP server, tool errors, cancellation and PID cleanup. `test_mcp_edges.py`: pagination, live definitions, default hints, invalid configuration, partial startup cleanup, approval gates and death during a call producing exactly one unknown result. |
| 3. Settings-loaded plugins | `test_plugin_loading.py`: global and trusted project factories, constructor options, override options, a gate refusing before import, and startup cleanup. The offline live-driver tests also load a request-audit plugin from settings in a separate agent process. |
| 4. Project trust | Untrusted project code and executable plugin options never run, while session defaults apply. Canonical trust, revocation, project binding and project MCP refusal are tested. `test_terminal.py` also proves saved-project discovery before configured plugin loading. |
| 5. Full-screen UI | Optional, skipped. Line, print and JSON modes remain. |
| Real ACP run | The driver is first proven offline by `test_milestone4_live_driver.py`, including negative validator cases. The deliberate Haiku run below passed. |

**190 tests pass with each Runtime, no skips.** Normal and single-CPU release runs
both passed for each Runtime: 760 passing executions, zero failures. The original
144 milestone 3 tests remain. There are 46 new cases: 4 plugin loading, 14 MCP,
23 ACP/audit, 4 live-driver and 1 CLI reopening regression.

Lint, formatting, diff checks and all 25 workspace source/wheel builds pass.
Logs: `/tmp/ma-m4-release/`. Tests and real runs leave no agent, command or MCP
server processes or command cgroups running. No inference was used for the final
audit refinements.

## Real model run

One deliberate invocation on 2026-11-17 UTC, first attempt. Only
`claude-haiku-5-5`, using the official Claude Agent SDK through the local Claude
Code subscription login. No API key, native Claude Code tools or helper agents.

- Durable Runtime session: `40c8e7cc7b9248b2b5f167652762b3e9`.
- Two model requests, thinking off, recorded by a settings-loaded audit plugin.
- The host selected model, thinking and approval through ACP configuration.
- The host passed a session-only official stdio MCP proof server through ACP.
- One ACP permission request was explicitly allowed.
- The model made exactly one MCP call, through the agent's Runtime and gates.
- The marker was in the server-side file, not in the input prompt.
- The answer was:

> The MCP server returned the exact marker M4-ACP-MCP-83109.

The driver then verified resume without replay, load with replay, session-server
PID termination, and clean agent exit. Evidence, streamed events, complete history,
request metadata, permissions and validated summary are saved at
`/tmp/modular-agent-py-m4-live/`. No credentials are logged. The saved evidence
revalidates offline:

```sh
uv run python scripts/milestone4_live.py --verify-only \
  --output /tmp/modular-agent-py-m4-live
# Exercise the complete driver without inference in a new directory:
uv run python scripts/milestone4_live.py --offline --output /tmp/ma-m4-offline-new
# Deliberate new inference only if needed, in a new directory:
uv run python scripts/milestone4_live.py --confirm-live --output /tmp/ma-m4-new
```

## Gaps logged and boundaries

Every new decision is sourced and has a swap test in `GAPS.md`:

- G32: configured factory names, options and persistent project trust.
- G33: fixed startup composition and one-project process scope.
- G34: MCP tool identity, hint defaults and unsupported optional server features.
- G35: global versus host-session MCP lifetime and ephemeral connection data.
- G36: ACP v1 mapping, local actor binding, extension methods and outcome mapping.
- G37: elicitation negotiation, secret refusal and the SDK's stale unstable label.
- G38: replay-before-recovery, EOF liveness and partial-open cleanup.

The required milestone is complete. The optional full-screen UI is skipped to keep
the delivered surface focused on the proven host and protocol paths. The complete
multi-process plugin binding is milestone 5, not this work. Nothing here claims to
implement it.

## Official sources

Read alongside the installed official SDK source and its generated types:

- https://agentclientprotocol.com/protocol/v1/initialization
- https://agentclientprotocol.com/protocol/v1/session-setup
- https://agentclientprotocol.com/protocol/v1/session-config-options
- https://agentclientprotocol.com/protocol/v1/prompt-turn
- https://agentclientprotocol.com/protocol/v1/elicitation
- https://agentclientprotocol.com/protocol/v1/extensibility
- https://github.com/agentclientprotocol/python-sdk
- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- https://github.com/modelcontextprotocol/python-sdk/blob/v2.3.0/docs/client/transports.md
- https://github.com/modelcontextprotocol/python-sdk/blob/v2.3.0/docs/migration.md

Published ACP v1 elicitation is stable. SDK 1.0.0 still tags its routing as unstable,
so this adapter enables that SDK switch without changing to ACP v2. MCP 2.3.0 uses
snake-case Python fields and two-stream transport tuples; v1 SDK examples are not
used as implementation signatures.

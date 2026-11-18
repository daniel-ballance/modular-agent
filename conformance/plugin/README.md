# Plugin binding conformance kit

Checks that a build's conformance plugin follows the [plugin binding](../../docs/bindings/plugin.md), `modular-agent-plugin/1`. The kit plays the host: it starts the plugin and serves the `host/*` callbacks from a temporary folder. It needs no network and no model.

```sh
node run.mjs -- <the command that serves the build's conformance plugin> [args...]   # use absolute paths: the plugin starts in a temporary folder
node run.mjs --verbose -- ...
```

What it checks:
- **The handshake:** the version, the registration, `replaces`, and that an unknown version gets `not_supported`.
- **The Provider:** `conformance/echo` streaming, asking for a tool call, and `done:` counted in code points. "As the response arrives" runs once, through `host/hook`, with the complete message. An unknown provider is `invalid_request`, JSON-RPC -32602.
- **The tools:** `read` and `bash` reach the environment only through `host/env/*`, linked by `parentRequestId` and carrying the `sessionId`; progress; cancelling within 5 seconds; and an answer to a request cancelled before it started.
- **The working environment:** reading, writing, `exists` and `exec`, with streamed output and cancelling. With `strong` containment, a `setsid` escapee must die. A background process outlives its call, and `env/sessionEnded` stops it, but not another session's. With `points: true`, `env/save` and `env/restore` put files back, and an unknown point is `not_found`.
- **The hooks:** the `tool.before` gate, the `turn.before` contribution, the `output` gate redacting `conformance-secret` across a stream's events, and `unknown_handler`.
- **The Runtime,** served as `runtime` and as `durable-runtime`, with the kit as the host and a scripted model:
  - plain turns, tool rounds and refused calls. The Runtime records no `turnStart` or `turnEnd`, and `turn.end` is its last request;
  - a failed model request retried, with the step prepared again;
  - cancelling, step limits and parallel calls. A parallel result is recorded as soon as it is ready;
  - `resumeTurn` in a new process, with history another build wrote, in the standard kinds only. The transient Runtime must end the turn as failed. The durable one must run the call that never started, run again the started call that is safe to repeat, and carry on. Neither may repeat a started call that isn't.

  Use `--no-runtime` for a build that serves no Runtime.
- **`MODULAR_AGENT_PLUGIN_PARTS`,** ping, an unknown method, shutdown, and exiting when stdin closes.

To check a host, run the [ACP kit](../acp/README.md) against it with `MODULAR_AGENT_PLUGINS` naming conformance plugins, and `--plugin-checks`. The plugins may come from any build. For example:

```sh
MODULAR_AGENT_PLUGINS='[{"command":["<rust plugin command>"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"provider,hooks"}},
                        {"command":["<python plugin command>"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"tools,environment"}}]' \
  node ../acp/run.mjs --plugin-checks -- <go agent command>
```

The host side of the binding is checked from inside a host, by the probe plugin, `probe.mjs`. The [ACP kit](../acp/README.md) loads it with `--probe-checks`.

The jobs plugin, `jobs.mjs`, checks the host side of jobs. The ACP kit loads it with `--job-checks`.

# Plugin binding conformance kit

Checks that a build's conformance plugin follows the [plugin binding](../../docs/bindings/plugin.md), `modular-agent-plugin/1`. The kit plays the host: it starts the plugin and serves the `host/*` callbacks from a temporary folder. It needs no network and no model.

```sh
node run.mjs -- <the command that serves the build's conformance plugin> [args...]
node run.mjs --verbose -- ...
```

What it checks:
- **The handshake:** the version, the registration, `replaces`, and that an unknown version gets `not_supported`.
- **The Provider:** `conformance/echo` streaming, asking for a tool call, and `done:` counted in code points.
- **The tools:** `read` and `bash` reach the environment only through `host/env/*`, linked by `parentRequestId`; progress; and cancelling within 5 seconds.
- **The working environment:** reading, writing, `exists` and `exec`, with streamed output and cancelling. With `strong` containment, a `setsid` escapee must die.
- **The hooks:** the `tool.before` gate, the `turn.before` contribution, and `unknown_handler`.
- **The Runtime,** served as `runtime` and as `durable-runtime`, with the kit as the host and a scripted model:
  - plain turns, tool rounds and refused calls;
  - cancelling, step limits and parallel calls;
  - `resumeTurn` after a restart. The transient Runtime must end the turn as failed; the durable one must run the call that never started and carry on. Neither may repeat a call that started.

  Use `--no-runtime` for a build that serves no Runtime.
- **`MODULAR_AGENT_PLUGIN_PARTS`,** ping, an unknown method, shutdown, and exiting when stdin closes.

To check a host, run the [ACP kit](../acp/README.md) against it with `MODULAR_AGENT_PLUGINS` naming conformance plugins, and `--plugin-checks`. The plugins may come from any build. For example:

```sh
MODULAR_AGENT_PLUGINS='[{"command":["<rust plugin command>"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"provider,hooks"}},
                        {"command":["<python plugin command>"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"tools,environment"}}]' \
  node ../acp/run.mjs --plugin-checks -- <go agent command>
```

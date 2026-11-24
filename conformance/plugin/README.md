# Plugin binding conformance kit

Checks a build's conformance plugin against the [plugin binding](../../docs/bindings/plugin.md), `modular-agent-plugin/1`. The kit is the host. It uses a temporary project and home, a scripted Provider and an environment that accepts only fixture callbacks. There is no external model or network dependency.

Run in a disposable environment with Node.js, Bash and core utilities. A fixture that declares strong containment on the current platform needs `setsid`. A fixture that declares process-group containment is checked with a child that stays in its process group. Use absolute paths in the command and its arguments. The kit sets a fresh `HOME`; the launcher cannot depend on per-user tool lookup. The project directory is not a sandbox. Only run trusted test programs with no ambient credentials or production configuration.

```sh
node conformance/plugin/run.mjs -- <plugin command> [args...]
```

For the TypeScript build, run `npm ci && npm run build` in `typescript/`, then from there use `node conformance/plugin/run.mjs -- node "$PWD/packages/plugin-wire/dist/src/serve-cli.js"`.

Use `--verbose` before `--` for stderr and passing details. Use `--no-runtime` for the baseline roles alone. The default run also exercises the Runtime tiers; use `--no-runtime` if neither tier is offered. Exit code 0 means all checks run passed.

## Over WebSocket

To check a plugin served over the [WebSocket transport](../../docs/bindings/websocket.md), give the kit the service's address and a file holding its bearer token instead of a command:

```sh
npm ci --prefix conformance/tools
node conformance/plugin/run.mjs --connect ws://127.0.0.1:PORT/ --token-file FILE \
  [--runtime-url URL] [--durable-runtime-url URL]
```

The kit runs every check that applies to a connection, plus these transport checks: an upgrade with no token or a wrong token is refused with HTTP 401, an upgrade without the subprotocol is refused, a binary message closes with 1003, two connections are independent plugin instances, closing a connection stops a running `env/exec` within the declared containment, and `plugin/shutdown` closes with 1000 while the service keeps accepting connections. It skips the oversized-message check (a real 64 MiB transfer) and the `MODULAR_AGENT_PLUGIN_PARTS=tools` check, because a service chooses its parts when it starts. For the same reason the Runtime tiers need their own services: name them with `--runtime-url` and `--durable-runtime-url`; the kit uses the same token for them.

### Plugin service isolation

[ADR 0030](../../docs/adr/0030-production-gaps.md#isolation-decisions) chose separate listeners for stateful plugin services. Run two copies of the conformance plugin, each with `--listen ADDR --token-file FILE`. For each copy set `MODULAR_AGENT_PLUGIN_PROJECT` to its granted project directory and `MODULAR_AGENT_PLUGIN_STATE_DIR` to its private state directory. Use distinct tokens, disjoint projects and disjoint state directories. Use absolute paths and keep the state directories outside both projects.

```sh
node conformance/plugin/run.mjs --connect URL_A --token-file TOKEN_A \
  --second-connect URL_B --isolation-checks TOKEN_B PROJECT_A PROJECT_B HOME
```

This runs the isolation checks instead of the default transcript. Supply two disposable projects and a directory for the shared host-supplied home name. The listeners choose their state directories before handling that name. Each token must fail upgrade on the other listener. On each listener, two connections with the same credential overlap calls with identical IDs. The kit also overlaps calls with different credentials. It checks callback routing and that cancellation and loss of one connection leave the other call running. Each host must be unable to read the other project or look up or restore its saved point. The kit checks that the point exists on its owner's live connection and that each host can still read its own file after reconnect. The kit may leave fixture files in the projects. This is not a command sandbox test.

For builds that provision several isolated hosts on one listener, omit `--second-connect` and use the same `--isolation-checks TOKEN_B PROJECT_A PROJECT_B HOME` arguments. The kit then uses both tokens on the first URL and does not check cross-listener upgrades.

### Named callers on one listener

[ADR 0035](../../docs/adr/0035-host-limits-from-the-ops-desk.md) adds a managed mode to the isolation checks. Ordinary runs skip it with a reason. To opt in, supply a launcher that serves the SDK's per-connection factory with a token table:

```sh
node conformance/plugin/run.mjs --named-callers -- /absolute/path/to/named-caller-fixture [args...]
```

The kit creates two owner-only token files, two disjoint projects and two private state directories. It starts the same command with valid and invalid configurations. The process receives a fresh `HOME`, `TMPDIR`, `PATH`, `LANG` and `MA_PLUGIN_FIXTURE`. The last is a path to JSON with these fields:

| Field | Use |
|---|---|
| `listen`, `callers`, optional `tokenFile` | Pass the listener address and **unchanged** SDK options to `serve(factory, …)`. The SDK, not the launcher, must reject ambiguous options. `callers` has entries `{callerId,tokenFile}`. There are no token values in the command or config. |
| `scopes` | Operator entries `{callerId,project,stateDir}`. In the factory select the matching entry using only the SDK's authenticated `callerId`. Never derive this scope from initialization, session or tool input. |
| `auditFile` | Append one JSON line `{event:"factory",callerId}` on actual factory entry, and `{event:"setup",callerId}` on actual plugin setup, before returning. No token, host path, call input or request ID belongs here. |

On success print one stdout line `{"url":"ws://127.0.0.1:PORT/"}` when the listener is ready. On the SDK's startup refusal print `{"error":"invalid_composition"}` and exit nonzero without listening. A crash or missing executable does not count as a refusal. Keep the launcher and any descendants in the kit's process group. Invalid tables have duplicate IDs, identical token values in different files, or both `tokenFile` and `callers`. On the valid table a wrong or missing token must get 401 before the factory or setup runs.

Register the ordinary `bash` conformance tool (delegate to `host/env/exec` on this connection) and working environment. Enforce the authenticated project's bounds on every request. Also register **`caller_probe`**, a fixture-only tool. It takes `{callerId,write?}`. Ignore `input.callerId` and `config.callerId` for identity. Read one marker from the factory's selected state directory (`null` if absent), optionally replace it with the string `write`, and return a completed ToolResult whose `value` is `{callerId,previous}`. Use the ID captured by the factory. This is test data in a tool's value, not a caller field in a plugin message.

The two hosts claim the same `home`, reuse request, call and session IDs, and claim each other's names. The kit checks both the factory's ID and the retained marker. Changing the tool claim on a live connection or the setup claim on reconnect must not change the state. While both `bash` calls are held in callbacks the kit cancels and closes the left connection. The right result must carry the right Harness's marker. It runs that check with distinct credentials and with each credential on two sockets. It rechecks the retained file and refused project reads on reconnect. Separate-listener tests still apply to plugins that need separate confinement.

The named-caller transcript has 29 checks, or 31 if both environments offer saved points. Run `npm ci --prefix conformance/plugin` and `npm test --prefix conformance/plugin` for its 19 fake-service self-tests. The fake never executes a command.

To serve a stdio plugin over WebSocket for the kit, use the bridge, `conformance/tools/ws-bridge.mjs`. It is a disposable, loopback-only test adapter that starts one plugin process per connection; it is not a service host.

```sh
P="rust/target/debug/modular-agent --serve-plugin"
node conformance/tools/ws-bridge.mjs --binding plugin --listen ws://127.0.0.1:39191/ --token-file FILE -- $P &
MODULAR_AGENT_PLUGIN_PARTS=runtime node conformance/tools/ws-bridge.mjs --binding plugin --listen ws://127.0.0.1:39192/ --token-file FILE -- $P &
MODULAR_AGENT_PLUGIN_PARTS=durable-runtime node conformance/tools/ws-bridge.mjs --binding plugin --listen ws://127.0.0.1:39193/ --token-file FILE -- $P &
node conformance/plugin/run.mjs --connect ws://127.0.0.1:39191/ --token-file FILE \
  --runtime-url ws://127.0.0.1:39192/ --durable-runtime-url ws://127.0.0.1:39193/
```

Each SDK's conformance plugin serves itself with `--listen ADDR --token-file FILE`. [`scripts/websocket-kits.sh`](../../scripts/websocket-kits.sh) runs the normal transcript and the separate-listener isolation checks against these services without the bridge.

What it checks:
- Handshake, supported version, selected parts, registration, replacement names, ping, framing, JSON nesting at 64 and 65 levels, error envelopes, shutdown and natural EOF exit.
- The fixture Provider: stream order, inference using the `provider.request` hook's answer, the complete-response hook, a valid and an unoffered tool directive, and exact truncation to 200 Unicode code points from the first result after the latest user message.
- Tool calls through `host/env/*`, parent and session scope, fixture progress and exit text, and cancellation. The early-arrival cancel probe does not prove that dispatch had not started.
- Environment files, output, deadlines and background process ownership. Platform claims use the binding's spellings for standard systems. Descendant tests use the advertised containment only for an exact platform match. With `points: true`, it checks non-mutating point lookup, in-place restore and `not_found` for unknown points and a point saved by a separate environment.
- [Edition 4](../../docs/adr/0023-edition-4-draft.md), only where the plugin offers it. If the `tools` part registers `nest`: one `host/tools/call` under its own `tools/call`, the nested result passed on unchanged, including a refusal, and a protocol error turned into a failed result. `env/list` returns named entries with kinds, `not_found` for a missing directory and `invalid_request` for a file; an environment without it must say `not_supported` or `method_not_found`.
- Hook replies for a refusal, a system contribution, and lossless redaction across text events within a stream segment and within one standalone custom event.
- Scripted Runtime turns: exact dispatch order, refused calls, host-recorded model intent and result, normal and failed attempt order, fresh attempt ids on retry, preparation after context overflow with a scripted host compaction, cancellation and step limits. The Runtime reports only step usage and does not call `step.after` for the scripted auxiliary attempt. It simulates `turn_limit` before preparation or dispatch, and after the host has written a model intent and its bookkeeping abort. The Runtime reports the limit without submitting a response for the undispatched attempt. When steering is advertised, the Runtime makes its final check at the turn boundary. Serial and overlapping scheduling are both allowed for parallel-capable calls.
- `resumeTurn` against synthetic standard history. An unsafe started call is not repeated. A transient Runtime fails and does not dispatch; a durable one runs the calls it can recover. Neither resubmits a result already settled before resume. This is not an independent second build's history.

The [ACP kit](../acp/README.md) checks the host side:
- `--probe-checks`: out-of-phase Runtime callbacks leave no records, exact-call dispatch and its recorded registration, an already-dispatched tool's environment callback, refusal of a call not offered in the attempt, a refused call's committed result, acceptance of an unknown `provider.response` member, the steering cutoff, output validation, and preservation of a completed result when its catalog refresh fails. With tenant support, the host signals a latched limit at the next `prepareStep`. With tenant support and a history service, the kit also checks the host's aborted response after a post-intent limit.
- `--probe-checks --crash-checks`: separate crashes before and after `step.after` check settlement before Runtime handoff and reuse of a committed gate decision. See [The host asks the Runtime](../../docs/bindings/plugin.md#the-host-asks-the-runtime).
- `--probe-checks --portable-checks`: remote Runtime recovery and Provider commit checks, including abort and replay in [Model attempt sequences](../../docs/bindings/plugin.md#model-attempt-sequences). A normal `--portable-checks` run does not cover remote Runtime recovery.
- `--job-checks --crash-checks`: job recovery refuses a second resume on the same plugin connection.

Use the ACP kit's `--plugin-checks` with the `hooks` part from another build for an interoperability run. The probe, recovery and jobs programs are test fixtures, not production plugins.

The kit tests selected transcripts, not arbitrary schemas, credential handling, credential-bearing Providers, tenant separation, or reliable cleanup of unconfirmed external effects. Use separate acceptance tests for these. A pass is not proof of [conformance](../../docs/conformance.md#what-conforms).

## Findings

In [Named callers](../../docs/bindings/websocket.md#named-callers), “No ID or token is added to plugin messages” can be read as a ban on application data such as the desk's tool result. Replace that sentence with:

> The binding adds no caller ID or token field to `plugin/initialize`, `tools/call` or callbacks. A caller name in configuration or tool input is application data, not the listener's authenticated identity.

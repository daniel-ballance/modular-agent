# Shared telemetry check

This Node kit checks the [shared SDK telemetry cases](../../docs/sdk/testing.md#shared-telemetry-check) against the
[metadata-only profile](../../docs/telemetry.md). It uses a fresh loopback receiver for each case.
It does not need a live Provider or collector.

```sh
export TMPDIR="$HOME/.cache/ma-std-tmp"
mkdir -p "$TMPDIR"
npm ci
npm test
node run.mjs rust --list
node run.mjs rust -- /absolute/path/to/built/adapter
```

The command takes a built SDK adapter. This kit does not build or wire the four adapters.
Run it once per host SDK: 26 cases for each host, 104 in all. A missing fixture is a failure,
not a skip. The commands and build hints come from the [fixture registry](../sdk/fixtures/).
A failed case leaves its workspace and runner log on disk and prints their location.
The kit never retries a case. The library entry points are `startReceiver` in
`receiver.mjs`, `compareTrace` in `compare.mjs`, and `caseMatrix` and
`runCase` in `runner.mjs`.

## Adapter contract

The adapter runs one case. It gets a clean temporary home and no inherited OpenTelemetry
or Provider variables. Build dependencies before launching the check. Use only the
scripted Provider and generated fixture data. Never read real credentials or use a real model.

- Read `MODULAR_AGENT_TELEMETRY_RUN`, the absolute path to a JSON request with
  `host`, `scenario`, `placement`, `sdk` (boolean), `agentName`, `scenarioPath`,
  `workDir`, `reportPath`, `fixtures`, `values` and, for process cases, `handshake`.
  Run the scenario from `scenarioPath` with its existing outcome, effect and history
  assertions. Use `workDir` for the scratch data and counter. Set the SDK agent name
  to `agentName`.
- `MODULAR_AGENT_TELEMETRY_OTLP` is the full URL, including `/v1/traces`, on numeric
  loopback. When `sdk` is true, install the language's OpenTelemetry SDK with an
  always-on sampler and its official OTLP/HTTP trace exporter using **http/protobuf**,
  pointed explicitly at that URL. Do this in each process that runs the Harness
  or a participating fixture. Do not send credentials or baggage. When `sdk` is false,
  start a fresh runner without an OpenTelemetry SDK, even though the receiver is available.
- Pass the endpoint explicitly to each child. For crash children preserve it in the
  spawn environment. For stdio fixtures use the supplied `fixtures` entries:
  `{name, command, env, build, wire}`. Each command is complete (including its fixture
  name); set the process plugin's explicit `env` to the supplied values. The Node prefix
  records both directions before forwarding each frame. Keep stdout reserved for binding
  messages. Do not log reconstructed messages in place of the wire capture.
- In `agreed` mode both sides support propagation. For `no-offer` suppress the host's
  offer, and for `no-acceptance` suppress only the fixture's acceptance. The fixture sees
  the mode in `MODULAR_AGENT_TELEMETRY_HANDSHAKE`. Change the actual peer behavior,
  not the captured messages. Work and callbacks must still settle.
- The scenario copy includes distinct synthetic content values. Keep the existing
  fixture behavior except that the `confirm` fixture for `question-answered` uses
  `values.answer` in place of the `yes` choice value (keep the other choice).
  The script and expected result already use the replacement. The case includes a
  fake secret in the prompt and uses the gate's fixed diagnostic as a sentinel.
- On normal exit, stop work and flush each exporter. Wait for the official exporter's
  successful HTTP responses, including fixture exports, before returning success.
  Arrange the fixture's normal shutdown so it can flush before the host reaps it.
  Do not wait for a flush from a process group killed with SIGKILL. The kit reads
  one receiver snapshot after this barrier so it can detect extra spans as well as missing ones.

Rust uses `sdk_scenarios::run` and `scenario-agent`; TypeScript uses `runScenario`
and `scenario-agent`; Go uses the shared scenario test runner and its crash child;
Python uses `modular_agent._scenarios.run_scenario` and its crash child. Add the hook
at those entry points and where they build process plugin options. Ordinary shared
scenarios still use their current fixture commands and environments. This telemetry
matrix does not add service placements.

## Evidence report

Write JSON to `reportPath` only after the original scenario assertions pass. Use
observations from the scenario, fixture and store, never derive this report from OTLP.

- All cases: `{scenario, placement, passed: true, sessionId, turnId, outcome, historyKinds}`.
  `historyKinds` includes every committed kind observed by the fixture, not just the
  expected subsequence. For `first-turn` include the actual `declarations: {agent, session}`.
- With the SDK: `steps: [{id, model, beforeCrash?}]` identifies actual attempts by
  Harness step ID and final request model ID; for crash cases mark the killed
  segment's attempt `beforeCrash: true`. Include
  `calls: [{id, name, stepId, status, parentCallId?, providerCallId?}]` from
  associated tool work, including refusals. Set the optional Provider call ID
  only if supplied by the model or Provider.
- `first-turn` with the SDK: `commits: [{count, status, turnId?, stepId?, parent}]`
  records independently observed history batches. `parent` is the writer's
  operation name without a display suffix and its work IDs:
  `{name, turnId?, stepId?, callId?}`. Repeated batches with identical fields
  are compared by multiplicity, not order.
- `question-answered`: `question: {id, kind}` from the recorded input request.
- Crash cases: `crash: {signal, countBefore, countAfter, turnStart, afterRestart}`.
  Take `countBefore` at the existing counter barrier. Save the committed turnStart
  (including its session ID, turn ID and context) outside the agent's group before
  killing that group with SIGKILL. Reap the group as in the shared scenario, then
  reopen over the same data. In `afterRestart` record committed checkpoint entries
  in observed order, and put `{kind: "effect"}` at the first actual resumed effect
  boundary (such as Provider dispatch). Obtain this order from an independent store
  and fixture observation, not from span timestamps or eventual history. Include the
  checkpoint envelope and `data.traceContext` as committed. The kept case has no
  resumed checkpoint. The kill may lose the old invocation and other pre-crash spans.

The receiver accepts JSON and protobuf and responds in the encoding used by the
exporter. The protobuf schema is [vendored](proto/README.md). A caller can use
`receiver.waitFor(predicate, {timeoutMs})` to wait for acknowledged spans when
testing an exporter directly. This is not a replacement for the adapter's flush.

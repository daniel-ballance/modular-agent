# Shared telemetry check

This Node kit checks the [shared SDK telemetry cases](../../docs/sdk/testing.md#shared-telemetry-check) against the
[metadata-only profile](../../docs/telemetry.md). It uses a fresh loopback receiver for each case.
It does not need a live Provider or collector.

```sh
npm ci
npm test
node run.mjs rust --list
node run.mjs rust -- /absolute/path/to/built/adapter
```

The command takes a built SDK adapter. This kit does not build or wire the four adapters.
Run it once per host SDK: 26 unconditional and up to eight waiting cases per host. A missing fixture for an applicable case is a failure,
not a skip. The commands and build hints come from the [fixture registry](../sdk/fixtures/).
A failed case leaves its workspace and runner log on disk and prints their location.
The kit never retries a case. The library entry points are `startReceiver` in
`receiver.mjs`, `compareTrace` in `compare.mjs`, and `caseMatrix` and
`runCase` in `runner.mjs`.

## Waiting approval checks

Opt in by declaring `approvalsOutlastTurns: true` on a supported kept session with an approval gate and finite operator maximum. The runner discovers support from the ordinary `first-turn` report. If that test uses an ephemeral composition, also report `declarations.waitingSession` from a separate, compatible session probe (with several actors enabled if supported). Do not change the first-turn test's session or invent declaration values. Without a positive declaration the CLI prints a skip reason and does not launch waiting cases. Library callers pass the same observed `{declaration}` as the third argument to `runCase`.

Four [SDK fixtures](../sdk/README.md#waiting-approval-scenarios) run in process, each with and without an OpenTelemetry SDK: allow, decline, expire while stopped and revoke the approver after allow. Revocation uses the fixture's second member and also requires `severalActors`. All four still check the records and counter with export off. Do not use telemetry to decide when work is ready.

**Adapter checkpoint.** In these cases the run request includes a one-shot loopback `parkedUrl`. When the origin prompt has returned, and **before** polling, answering, advancing the clock or killing the writer:

1. Save the origin's committed batches and read the counter file. With instrumentation, have a test span processor identify work spans of this session that started but have not ended. Record their names in `activeWorkAtPark`; no turn, step, call or question operation should still be waiting. Do not count an independent lease renewal as a waiting operation.
2. In the non-crash cases force-flush ended spans and wait for the receiver's export acknowledgements. POST an empty body to `parkedUrl` and wait for 204. This captures a receiver snapshot **before** the decision, not an adapter claim about which spans were exported. Also mark this boundary with export off. In the stopped-writer case do not require a flush from the killed process.
3. Resume the fixture's steps. Use the ordinary bare SDK answer operation, with no enclosing test span. Expiry on reopen is a system closure. On a normal shutdown flush as usual. Never send observations to the trace endpoint as a substitute for an exporter.

**Evidence.** In addition to the common report fields, give the actual session declaration and `waiting: {originBatches, finalBatches, counterAtPark, counterAfter, activeWorkAtPark?}`. Take both sets of batches from the store, not a recipient projection. `turnId` is the origin. Preserve both independent counter readings. Include the test processor observations only with instrumentation. Use the supplied synthetic fixture values in content; put `values.answer` in the optional decline reason and use `values.route` for the answer route where the fixture assigns it. Do not change the approval value `allow`. Report files with this disposable evidence are not telemetry.

The kit matches the opening event to the saved request ID, and the close and its disposition to the later answer or system operation. It checks that the origin turn and step ended at the parked checkpoint. A continuation is a new invocation linked to the origin, not a resumed origin. Across process loss a link is required if the origin context was saved; the original span need not have reached the receiver. An allowed `bump` has one execution span under its continuation step with the old call ID. Decline, expiry and revocation have a pre-dispatch disposition and no execution span. Content and private proof checks include resource attributes, links and events as well as span fields.

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

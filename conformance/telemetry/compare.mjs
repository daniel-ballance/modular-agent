import assert from "node:assert/strict";
import { inspectWire, parseContext } from "./plugin-check.mjs";
import { rejectBaggage, scanExports } from "./privacy.mjs";

const conversation = "gen_ai.conversation.id", turn = "modular_agent.turn.id", step = "modular_agent.step.id";
const operation = "gen_ai.operation.name", callId = "modular_agent.tool.call.id", parentCallId = "modular_agent.tool.parent_call.id";
const resumed = "modular_agent.turn.resumed", outcome = "modular_agent.turn.outcome";
const commit = "modular_agent.history.commit", pluginRequest = "modular_agent.plugin.request";
const question = "modular_agent.question.";
const kinds = ["UNSPECIFIED", "INTERNAL", "SERVER", "CLIENT", "PRODUCER", "CONSUMER"];
const attributes = ({ attributes = [] }) => {
  const map = Object.create(null);
  for (const { key, value } of attributes) {
    assert.equal(typeof key, "string", "Invalid attribute key");
    assert(!Object.hasOwn(map, key), "Duplicate attribute key");
    const [[type, raw]] = Object.entries(value);
    map[key] = type === "intValue" ? Number(raw) : raw;
  }
  return map;
};
const op = span => span.name?.split(" ")[0];
const kind = span => kinds[span.kind] ?? span.kind?.replace(/^SPAN_KIND_/, "");
const one = (matches, what) => {
  assert.equal(matches.length, 1, `${what}: expected one, found ${matches.length}`);
  return matches[0];
};
const attrs = (span, expected) => {
  for (const [key, value] of Object.entries(expected)) {
    // An explicitly undefined value requires the attribute to be absent.
    assert.equal(span.a[key], value, `${op(span)}: ${key}`);
  }
};
const shape = (span, name, type) => {
  assert.equal(span.name, name, "Span name");
  assert.equal(kind(span), type, `${name}: span kind`);
};
const same = (a, b) => a.traceId === b.traceId && a.spanId === b.spanId;
const parent = (child, ancestor) => {
  assert(child && ancestor && child.traceId === ancestor.traceId && child.parentSpanId === ancestor.spanId,
    `${op(child ?? {})}: wrong parent`);
};
const matches = (span, expected) => Object.entries(expected).every(([key, value]) => span.a[key] === value);
const id = value => typeof value === "string" && value.length > 0;
const listed = (value, allowed, what) => assert(allowed.includes(value), `Invalid ${what}`);

// Check the kinds and fields of the profile's supporting spans as well as the
// spans with case-specific assertions. This is not an allowlist of OTel scopes.
function checkSupporting(span) {
  const name = op(span);
  const kindsBySpan = {
    "modular_agent.session.open": ["new", "load", "resume"],
    "modular_agent.session.close": ["close"],
  };
  if (kindsBySpan[name]) listed(span.a["modular_agent.session.operation"], kindsBySpan[name], "session operation");
  if (name === commit) {
    const count = span.a["modular_agent.history.entry.count"];
    assert(Number.isSafeInteger(count) && count > 0, "Invalid history entry count");
    listed(span.a["modular_agent.history.commit.status"], ["committed", "failed", "uncertain"], "history commit status");
  }
  if (name === "modular_agent.job") {
    assert(id(span.a["modular_agent.job.id"]) && id(span.a["modular_agent.job.outcome"]), "Missing job ID or outcome");
  }
  if (name === "modular_agent.capacity.wait" && span.a["modular_agent.capacity.scope"] !== undefined) {
    listed(span.a["modular_agent.capacity.scope"], ["session", "tenant", "agent"], "capacity scope");
  }
  if (name === pluginRequest) {
    assert(id(span.a["modular_agent.plugin.name"]) && id(span.a["modular_agent.plugin.method"]), "Missing plugin name or method");
    assert.equal(span.name, name, "Plugin span name");
    listed(kind(span), ["CLIENT", "SERVER"], "plugin span kind");
  } else if (name?.startsWith("modular_agent.")) {
    shape(span, name, "INTERNAL");
  }
  assert.notEqual(name, "create_agent", "A shared scenario does not create a hosted agent");
  if (span.status?.code === 2 || span.status?.code === "STATUS_CODE_ERROR") {
    assert(typeof span.a["error.type"] === "string" && /^[a-zA-Z0-9_.:$-]{1,128}$/.test(span.a["error.type"]),
      "Failed span lacks a bounded error.type");
  }
}

function checkCrash(scenario, report, invocations) {
  const { crash, sessionId, turnId } = report;
  assert.equal(crash?.signal, "SIGKILL", "Crash must kill the process group with SIGKILL");
  assert.equal(crash.countBefore, 1, "Counter barrier at crash");
  assert.equal(crash.countAfter, 1, "Counter effect repeated after crash");
  const entry = crash.turnStart;
  assert(entry?.kind === "turnStart" && entry.turnId === turnId && entry.sessionId === sessionId, "Missing pre-kill committed turnStart");
  const saved = parseContext(entry.data?.traceContext);
  const recovered = invocations.filter(s => s.a[resumed] === true);
  const old = invocations.filter(s => s.a[resumed] !== true);
  assert(old.length <= 1 && old.every(s => same(s, saved)), "Old invocation must match turnStart checkpoint");
  const timeline = crash.afterRestart;
  const checkpoints = timeline.filter(record => record.kind === "modular-agent.turnTrace");
  if (scenario === "kept-crash") {
    assert.equal(recovered.length, 0, "Kept turn exported a resumed invocation");
    assert.equal(checkpoints.length, 0, "Kept turn wrote a resume checkpoint");
    return null;
  }
  const segment = one(recovered, "Resumed invocation");
  parent(segment, saved);
  assert.notEqual(segment.spanId, saved.spanId, "Resumed invocation must have a fresh span ID");
  one((segment.links ?? []).filter(link => same(link, saved)), "Link to saved segment");
  const checkpoint = one(checkpoints, "Committed resume checkpoint");
  assert.equal(checkpoint.turnId, turnId, "Checkpoint turn ID");
  assert.equal(checkpoint.sessionId, sessionId, "Checkpoint session ID");
  assert.equal(checkpoint.modelVisible, false, "Checkpoint is model-visible");
  assert(same(segment, parseContext(checkpoint.data?.traceContext)), "Checkpoint does not identify resumed span");
  assert(timeline.indexOf(checkpoint) < timeline.findIndex(record => record.kind === "effect"), "Checkpoint must commit before resumed effects");
  return segment;
}

function checkCommits(spans, report) {
  const commits = spans.filter(s => s.name === commit);
  const observations = report.commits;
  assert(observations?.length > 0, "Missing independent history commit observations");
  assert.equal(commits.length, observations.length, "History commit count");
  for (const entry of observations) {
    const expected = { [conversation]: report.sessionId, [turn]: entry.turnId, [step]: entry.stepId,
      "modular_agent.history.entry.count": entry.count, "modular_agent.history.commit.status": entry.status };
    assert(entry.parent && id(entry.parent.name), "Missing history commit parent observation");
    const writer = one(spans.filter(s => op(s) === entry.parent.name && s.a[turn] === entry.parent.turnId &&
      s.a[step] === entry.parent.stepId && s.a[callId] === entry.parent.callId), "History writer");
    const i = commits.findIndex(s => matches(s, expected) && s.traceId === writer.traceId && s.parentSpanId === writer.spanId);
    assert(i >= 0, "Missing history commit with observed scope, writer, batch size and status");
    commits.splice(i, 1);
  }
}

function checkPlugin({ connections, handshake, scenario }, spans, tools, calls) {
  const wire = inspectWire(connections, handshake);
  const nested = scenario === "nested-call";
  assert.equal(connections.length, nested ? 2 : 1, "Plugin connection count");
  assert.equal(wire.calls.length, calls.length, "Wire tools/call count");
  assert.equal(wire.callbacks.length, nested ? 1 : 0, "Wire host/tools/call count");
  const findRpc = (method, plugin, role) => spans.filter(s => s.name === pluginRequest && kind(s) === role &&
    s.a["modular_agent.plugin.method"] === method && s.a["modular_agent.plugin.name"] === plugin);
  for (const call of calls) {
    const tool = tools.get(call.id);
    const rpc = one(wire.calls.filter(r => r.params?.call?.id === call.id), "Wire request for tool call");
    assert.equal(rpc.params.call.name, call.name, "Wire tool name");
    assert.equal(rpc.params.sessionId, tool.a[conversation], "Wire tool session");
    assert.equal(rpc.response?.result?.status, call.status, "Wire tool call did not settle");
    const client = one(findRpc("tools/call", rpc.plugin, "CLIENT"), "Plugin client span");
    attrs(client, { [conversation]: tool.a[conversation], [turn]: tool.a[turn], [step]: tool.a[step] });
    parent(client, tool);
    if (handshake === "agreed") {
      assert(same(client, rpc.context), "Injected context does not identify plugin client span");
      const server = one(findRpc("tools/call", rpc.plugin, "SERVER"), "Plugin server span");
      parent(server, client);
    }
  }
  if (nested) {
    const inner = one(calls.filter(c => c.parentCallId), "Nested call observation");
    const callback = wire.callbacks[0];
    const outer = tools.get(inner.parentCallId);
    assert.equal(callback.parent.params.call.id, inner.parentCallId, "Callback names wrong parent call");
    assert.equal(callback.params.name, inner.name, "Callback names wrong nested tool");
    assert.equal(callback.response?.result?.callId, inner.id, "Callback did not return the nested call ID");
    assert.equal(callback.response?.result?.status, inner.status, "Nested callback did not settle");
    assert.equal(tools.get(inner.id).traceId, outer.traceId, "Nested tool is not in the parent tool trace");
    if (handshake === "agreed") {
      assert.equal(callback.context.traceId, outer.traceId, "Callback is not in the parent tool trace");
      const client = one(findRpc("host/tools/call", callback.plugin, "CLIENT"), "Callback client span");
      assert(same(callback.context, client), "Injected callback context does not identify the client span");
      const server = one(findRpc("tools/call", callback.plugin, "SERVER"), "Parent plugin server span");
      parent(client, server);
    }
  }
}

const counts = {
  "first-turn": [1, []], "tool-call": [2, ["tide"]], "nested-call": [2, ["pilot", "tide"]],
  "gate-refusal": [2, ["bump"]], "question-answered": [2, ["confirm"]],
  "durable-crash": [2, ["bump"]], "kept-crash": [1, ["bump"]],
};

export function compareTrace({ testCase, report, received, connections = [], sentinels }) {
  const { scenario, placement, handshake, sdk } = testCase;
  const { sessionId, turnId } = report;
  assert.equal(report.scenario, scenario, "Runner reported the wrong scenario");
  assert.equal(report.placement, placement, "Runner reported the wrong placement");
  assert.equal(report.passed, true, "Shared outcome and history assertions did not pass");
  assert(id(sessionId) && id(turnId), "Missing scenario session or turn ID");
  assert(Array.isArray(report.historyKinds), "Missing history kinds");
  assert(!report.historyKinds.some(name => /disclosure/i.test(name)), "Version 1 wrote a disclosure marker");
  assert.equal(received.errors.length, 0, "Receiver rejected an OTLP export");
  scanExports(received.payloads, sentinels);
  if (scenario === "first-turn") {
    assert.equal(report.declarations?.agent?.telemetry, 1, "Agent telemetry declaration");
    assert.equal(report.declarations?.session?.telemetry, 1, "Session telemetry declaration");
  }
  assert(Object.hasOwn(counts, scenario), "Unknown telemetry scenario");
  assert.equal(report.outcome, scenario === "kept-crash" ? "failed" : "completed", "Scenario turn outcome");
  if (!sdk) {
    assert.equal(scenario, "first-turn", "Only first-turn runs without an OpenTelemetry SDK");
    assert.equal(received.spans.length, 0, "Spans exported without an OpenTelemetry SDK");
    return;
  }
  const spans = received.spans.map(s => ({ ...s, a: attributes(s) }));
  const spanIds = new Set();
  for (const span of spans) {
    assert(/^[0-9a-f]{32}$/.test(span.traceId) && /[1-9a-f]/.test(span.traceId), "Invalid span trace ID");
    assert(/^[0-9a-f]{16}$/.test(span.spanId) && /[1-9a-f]/.test(span.spanId), "Invalid span ID");
    const identity = `${span.traceId}/${span.spanId}`;
    assert(!spanIds.has(identity), "Duplicate exported span ID");
    spanIds.add(identity);
    checkSupporting(span);
  }
  const scope = { [conversation]: sessionId, [turn]: turnId };
  const crashing = scenario.endsWith("-crash");
  const invocations = spans.filter(s => op(s) === "invoke_agent");
  const invocation = crashing ? checkCrash(scenario, report, invocations) : one(invocations, "Invocation");
  if (!crashing) assert.equal(invocation.a[resumed], undefined, "An ordinary turn is marked resumed");
  for (const span of invocations) {
    shape(span, testCase.agentName ? `invoke_agent ${testCase.agentName}` : "invoke_agent", "INTERNAL");
    attrs(span, { ...scope, [operation]: "invoke_agent", "gen_ai.agent.name": testCase.agentName,
      [outcome]: span === invocation ? report.outcome : "interrupted" });
  }

  const [stepCount, toolNames] = counts[scenario];
  const observedSteps = report.steps;
  const calls = report.calls;
  assert.equal(observedSteps.length, stepCount, "Independent step observation count");
  assert.deepEqual(calls.map(c => c.name).sort(), [...toolNames].sort(), "Independent tool observations");
  assert(observedSteps.every(s => id(s.id)) && new Set(observedSteps.map(s => s.id)).size === stepCount, "Missing or duplicate observed step IDs");
  assert(calls.every(c => id(c.id)) && new Set(calls.map(c => c.id)).size === calls.length, "Missing or duplicate observed call IDs");
  const steps = new Map();
  const inference = spans.filter(s => op(s) === "chat");
  const stepSpans = spans.filter(s => s.name === "modular_agent.step");
  assert.equal(observedSteps.filter(s => s.beforeCrash === true).length, crashing ? 1 : 0, "Independent pre-crash step observation count");
  for (const span of [...inference, ...stepSpans]) {
    assert(observedSteps.some(s => matches(span, { ...scope, [step]: s.id })), "Unobserved step or inference attempt");
  }
  for (const observed of observedSteps) {
    assert(id(observed.model), "Missing final request model");
    const scoped = { ...scope, [step]: observed.id };
    const attempts = inference.filter(s => matches(s, scoped));
    const stepMatches = stepSpans.filter(s => matches(s, scoped));
    if (observed.beforeCrash) {
      const saved = parseContext(report.crash.turnStart.data.traceContext);
      const oldSteps = stepMatches.filter(s => s.traceId === saved.traceId && s.parentSpanId === saved.spanId);
      const restored = stepMatches.filter(s => !oldSteps.includes(s));
      assert(attempts.length <= 1 && oldSteps.length <= 1, "Duplicate pre-crash work");
      assert(restored.length <= 1, "Duplicate restored step");
      // Recovery can finish work on the recorded step without making another
      // model attempt. That work belongs to the resumed segment.
      if (restored[0]) parent(restored[0], invocation);
      if (attempts[0]) {
        assert.equal(attempts[0].traceId, saved.traceId, "Pre-crash inference trace ID");
        if (oldSteps[0]) parent(attempts[0], oldSteps[0]);
        if (restored[0]) assert.notEqual(attempts[0].parentSpanId, restored[0].spanId, "Pre-crash inference under restored step");
      }
    }
    const attempt = observed.beforeCrash ? attempts[0] : one(attempts, "Inference attempt for step ID");
    if (attempt) {
      shape(attempt, `chat ${observed.model}`, "INTERNAL");
      attrs(attempt, { [operation]: "chat", "gen_ai.request.model": observed.model,
        "gen_ai.provider.name": "scripted", "modular_agent.provider.id": "scripted" });
    }
    if (!observed.beforeCrash) {
      const work = one(stepMatches, "Step with observed ID");
      steps.set(observed.id, work);
      parent(work, invocation);
      parent(attempt, work);
    }
  }

  const toolSpans = spans.filter(s => op(s) === "execute_tool");
  const toolResults = new Map();
  assert.equal(toolSpans.length, crashing || scenario === "gate-refusal" ? 0 : calls.length, "Tool execution span count");
  for (const call of calls) {
    const work = steps.get(call.stepId);
    if (crashing) {
      assert.equal(call.status, "outcomeUnknown", "Interrupted tool status");
    } else if (scenario === "gate-refusal") {
      assert.equal(call.status, "refused", "Gate tool status");
      const { event, span } = one(findEvents(spans, "modular_agent.tool.disposition"), "Tool disposition event");
      assert(same(span, work ?? {}), "Tool disposition is not on the dispatching step");
      attrs(event, { [callId]: call.id, "modular_agent.tool.status": "refused" });
    } else {
      assert.equal(call.status, "completed", "Fixture tool status");
      const tool = one(toolSpans.filter(s => matches(s, { ...scope, [step]: call.stepId, [callId]: call.id })), "Tool execution for call ID");
      shape(tool, `execute_tool ${call.name}`, "INTERNAL");
      attrs(tool, { [operation]: "execute_tool", "gen_ai.tool.name": call.name, "gen_ai.tool.call.id": call.providerCallId,
        [parentCallId]: call.parentCallId, "modular_agent.tool.status": call.status });
      toolResults.set(call.id, tool);
      if (!call.parentCallId) parent(tool, work);
    }
  }
  if (scenario === "nested-call") {
    const [inner, outer] = [calls.find(c => c.name === "tide"), calls.find(c => c.name === "pilot")];
    assert.equal(inner.parentCallId, outer.id, "Observed nested parent call ID");
    assert.equal(outer.parentCallId, undefined, "Outer tool has a parent call ID");
    if (placement === "inProcess") parent(toolResults.get(inner.id), toolResults.get(outer.id));
  } else assert(calls.every(c => c.parentCallId === undefined), "Unexpected nested call observation");
  if (scenario === "question-answered") checkQuestion(report, spans, toolResults);
  if (scenario === "first-turn") checkCommits(spans, report);
  if (crashing) rejectBaggage(report.crash);
  if (placement.startsWith("process:")) checkPlugin({ connections, handshake, scenario }, spans, toolResults, calls);
}

function findEvents(spans, name) {
  return spans.flatMap(span => (span.events ?? []).filter(e => e.name === name)
    .map(e => ({ event: { ...e, a: attributes(e) }, span })));
}

function checkQuestion(report, spans, tools) {
  const observed = report.question;
  assert(id(observed?.id) && observed.kind === "choice", "Missing choice question observation");
  const open = one(findEvents(spans, question + "open"), "Question open event");
  const close = one(findEvents(spans, question + "close"), "Question close event");
  const expected = { [question + "id"]: observed.id, [question + "kind"]: observed.kind };
  attrs(open.event, { ...expected, [question + "disposition"]: undefined });
  attrs(close.event, { ...expected, [question + "disposition"]: "answered" });
  const tool = one([...tools.values()], "Question tool span");
  assert(same(open.span, tool), "Question did not open on the tool operation");
  assert(same(close.span, tool) || (close.span.name === question + "answer" && close.span.a[conversation] === report.sessionId),
    "Question did not close on the tool or answer operation");
}

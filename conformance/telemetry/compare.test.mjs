import assert from "node:assert/strict";
import { test } from "node:test";
import { compareTrace } from "./compare.mjs";

const traceId = "1".repeat(32);
const spanId = n => n.toString(16).padStart(16, "0");
const attribute = (key, value) => ({ key, value: {
  [typeof value === "boolean" ? "boolValue" : typeof value === "number" ? "intValue" : "stringValue"]: value,
} });
const makeSpan = (number, parent, name, attrs, kind = 1) => ({ traceId, spanId: spanId(number),
  ...(parent && { parentSpanId: spanId(parent) }), name, kind,
  attributes: Object.entries(attrs).map(([k, v]) => attribute(k, v)) });
const session = { "gen_ai.conversation.id": "session-1" };
const turn = { ...session, "modular_agent.turn.id": "turn-1" };
const step = id => ({ ...turn, "modular_agent.step.id": id });
const attempt = (number, parent, id) => makeSpan(number, parent, "chat script", { ...step(id),
  "gen_ai.operation.name": "chat", "gen_ai.provider.name": "scripted", "gen_ai.request.model": "script",
  "modular_agent.provider.id": "scripted" });
const invoke = { ...turn, "gen_ai.operation.name": "invoke_agent", "modular_agent.turn.outcome": "completed" };

function sample(scenario, spans, report, options = {}) {
  const resourceSpans = [{ resource: { attributes: [attribute("service.name", "fixture")] }, scopeSpans: [{ spans }] }];
  const placement = options.placement ?? "inProcess";
  return {
    testCase: { scenario, placement, sdk: true, ...options },
    report: { sessionId: "session-1", turnId: "turn-1", outcome: "completed", scenario, placement, passed: true,
      historyKinds: ["turnStart", "modelRequest", "turnEnd"], calls: [], steps: [{ id: "step-1", model: "script" }], ...report },
    received: { spans, payloads: [{ resourceSpans }], errors: [] },
    sentinels: ["FIXTURE-PROMPT", "FIXTURE-SECRET"],
  };
}

function firstTurn() {
  return sample("first-turn", [attempt(3, 2, "step-1"), makeSpan(2, 1, "modular_agent.step", step("step-1")),
    makeSpan(4, 1, "modular_agent.history.commit", { ...turn,
      "modular_agent.history.entry.count": 2, "modular_agent.history.commit.status": "committed" }),
    makeSpan(1, null, "invoke_agent", invoke)], {
    declarations: { agent: { telemetry: 1 }, session: { telemetry: 1 } },
    commits: [{ count: 2, status: "committed", turnId: "turn-1", parent: { name: "invoke_agent", turnId: "turn-1" } }],
  });
}

test("accepts a trace with spans exported out of order", () => compareTrace(firstTurn()));

test("checks the input total, cache counts, and output against scripted usage", () => {
  const s = firstTurn();
  s.scriptedReplies = [{ usage: { input: 2, cacheRead: 3, cacheWrite: 5, output: 7 } }];
  const expected = [
    attribute("gen_ai.usage.input_tokens", 10),
    attribute("gen_ai.usage.cache_read.input_tokens", 3),
    attribute("gen_ai.usage.cache_write.input_tokens", 5),
    attribute("gen_ai.usage.output_tokens", 7),
  ];
  const attempt = s.received.spans[0];
  attempt.attributes.push(...expected);
  compareTrace(s);
  for (const count of expected) {
    const i = attempt.attributes.indexOf(count);
    attempt.attributes[i] = attribute(count.key, 2);
    assert.throws(() => compareTrace(s), new RegExp(count.key));
    attempt.attributes[i] = count;
  }
  attempt.attributes.splice(-4, 4, attribute("gen_ai.usage.input_tokens", 2), attribute("gen_ai.usage.output_tokens", 7));
  s.scriptedReplies[0].usage = { input: 2, cacheRead: 0, cacheWrite: 0, output: 7 };
  compareTrace(s);
  attempt.attributes.push(attribute("gen_ai.usage.cache_write.input_tokens", 0));
  assert.throws(() => compareTrace(s), /gen_ai.usage.cache_write.input_tokens/);
});

const modelStep = (stepId, stepNumber, invocationNumber = 1) => [
  makeSpan(stepNumber, invocationNumber, "modular_agent.step", step(stepId)),
  attempt(stepNumber + 1, stepNumber, stepId),
];
const execute = (number, parent, name, id, parentId) => makeSpan(number, parent, `execute_tool ${name}`, {
  ...step("step-1"), "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name,
  "modular_agent.tool.call.id": id, "modular_agent.tool.status": "completed",
  ...(parentId && { "modular_agent.tool.parent_call.id": parentId }),
});
const context = n => ({ traceparent: `00-${traceId}-${spanId(n)}-01` });
const wire = (direction, msg) => ({ direction, raw: JSON.stringify({ jsonrpc: "2.0", ...msg }) });
const host = msg => wire("hostToPlugin", msg);
const peer = msg => wire("pluginToHost", msg);

function toolCall(placement = "process:typescript", nested = false) {
  const calls = nested ? [
    { id: "call-1", stepId: "step-1", name: "pilot", status: "completed" },
    { id: "call-2", stepId: "step-1", name: "tide", status: "completed", parentCallId: "call-1" },
  ] : [{ id: "call-1", stepId: "step-1", name: "tide", status: "completed" }];
  const spans = [makeSpan(1, null, "invoke_agent", invoke), ...modelStep("step-1", 2), ...modelStep("step-2", 4)];
  const s = sample(nested ? "nested-call" : "tool-call", spans, { calls, steps: ["step-1", "step-2"].map(id => ({ id, model: "script" })) },
    { placement });
  const rpc = (number, parent, name, method, kind, scope = session) => makeSpan(number, parent, "modular_agent.plugin.request", {
    ...scope, "modular_agent.plugin.method": method, "modular_agent.plugin.name": name,
  }, kind);
  s.connections = [];
  for (const [index, call] of calls.entries()) {
    const tool = 6 + 3 * index;
    spans.push(execute(tool, call.parentCallId ? 6 : 2, call.name, call.id, call.parentCallId));
    if (placement === "inProcess") continue;
    spans.push(rpc(tool + 1, tool, call.name, "tools/call", 3, step("step-1")));
    spans.push(rpc(tool + 2, tool + 1, call.name, "tools/call", 2));
    const frames = [
      host({ id: 1, method: "plugin/initialize", params: {} }),
      peer({ id: 1, result: { name: call.name } }),
      host({ id: 2, method: "tools/call", params: { sessionId: "session-1", call: { id: call.id, name: call.name },
        traceContext: context(tool + 1) } }),
    ];
    if (call.name === "pilot") {
      spans.push(rpc(12, tool + 2, "pilot", "host/tools/call", 3));
      frames.push(peer({ id: 2, method: "host/tools/call", params: { parentRequestId: 2, name: "tide", input: {},
        traceContext: context(12) } }),
      host({ id: 2, result: { callId: "call-2", status: "completed" } }));
    }
    frames.push(peer({ id: 2, result: { status: "completed" } }));
    s.connections.push({ plugin: call.name, frames });
  }
  return s;
}

function disposition(scenario) {
  const gate = scenario === "gate-refusal";
  const spans = [makeSpan(1, null, "invoke_agent", invoke), ...modelStep("step-1", 2), ...modelStep("step-2", 4)];
  if (gate) {
    spans[1].events = [{ name: "modular_agent.tool.disposition", attributes: [
      attribute("modular_agent.tool.call.id", "call-1"), attribute("modular_agent.tool.status", "refused"),
    ] }];
  } else {
    const tool = execute(6, 2, "confirm", "call-1");
    const attrs = [attribute("modular_agent.question.id", "question-1"), attribute("modular_agent.question.kind", "choice")];
    tool.events = [{ name: "modular_agent.question.open", attributes: attrs }, { name: "modular_agent.question.close",
      attributes: [...attrs, attribute("modular_agent.question.disposition", "answered")] }];
    spans.push(tool);
  }
  return sample(scenario, spans, { steps: ["step-1", "step-2"].map(id => ({ id, model: "script" })),
    calls: [{ id: "call-1", stepId: "step-1", name: gate ? "bump" : "confirm", status: gate ? "refused" : "completed" }],
    question: { id: "question-1", kind: "choice" } });
}

function crash(kept = false) {
  const checkpoint = (kind, number) => ({ kind, turnId: "turn-1", sessionId: "session-1", modelVisible: false,
    data: { traceContext: context(number) } });
  const segment = makeSpan(4, 1, "invoke_agent", { ...invoke, "modular_agent.turn.resumed": true });
  segment.links = [{ traceId, spanId: spanId(1) }];
  return sample(kept ? "kept-crash" : "durable-crash", kept ? [] : [...modelStep("step-2", 5, 4), segment], {
    steps: [{ id: "step-1", model: "script", beforeCrash: true }, ...(!kept ? [{ id: "step-2", model: "script" }] : [])],
    outcome: kept ? "failed" : "completed",
    calls: [{ id: "call-1", name: "bump", status: "outcomeUnknown", stepId: "step-1" }],
    crash: { signal: "SIGKILL", countBefore: 1, countAfter: 1, turnStart: checkpoint("turnStart", 1),
      afterRestart: kept ? [] : [checkpoint("modular-agent.turnTrace", 4), { kind: "effect" }] },
  });
}

for (const placement of ["inProcess", "process:typescript"]) {
  test(`accepts tool and scoped nested calls (${placement})`, () => {
    compareTrace(toolCall(placement));
    compareTrace(toolCall(placement, true));
  });
}
for (const name of ["gate-refusal", "question-answered"]) {
  test(`accepts ${name} events`, () => compareTrace(disposition(name)));
}
for (const kept of [false, true]) {
  test(`accepts ${kept ? "kept" : "durable"} recovery without old exports`, () => compareTrace(crash(kept)));
}

function restoredStep() {
  const example = crash();
  example.received.spans.push(
    makeSpan(2, 1, "modular_agent.step", step("step-1")),
    attempt(3, 2, "step-1"),
    makeSpan(7, 4, "modular_agent.step", step("step-1")),
  );
  return example;
}

test("accepts both segments of a restored step without counting another inference", () => compareTrace(restoredStep()));

const violations = [
  ["duplicate restored step", restoredStep, s => {
    s.received.spans.push(makeSpan(8, 4, "modular_agent.step", step("step-1")));
  }, /Duplicate restored step/],
  ["wrong parent", firstTurn, s => { s.received.spans[0].parentSpanId = spanId(1); }, /wrong parent/],
  ["missing attribute", firstTurn, s => { s.received.spans[0].attributes.pop(); }, /modular_agent.provider.id/],
  ["resource content sentinel", firstTurn, s => { s.received.payloads[0].resourceSpans[0].resource.attributes[0].value.stringValue = "prefix FIXTURE-PROMPT suffix"; }, /Fixture content/],
  ["sentinel in event attributes", firstTurn, s => { s.received.spans[0].events = [{ name: "event", attributes: [{ key: "test", value: { bytesValue: Buffer.from("FIXTURE-SECRET").toString("base64") } }] }]; }, /Fixture content/],
  ["sentinel in a link", () => crash(), s => { s.received.spans.at(-1).links[0].traceState = "fixture=FIXTURE-SECRET"; }, /Fixture content/],
  ["known content attribute without a sentinel", firstTurn, s => { s.received.spans[0].attributes.push(attribute("gen_ai.input.messages", "different body")); }, /Forbidden telemetry attribute/],
  ["disclosure marker", firstTurn, s => { s.report.historyKinds.push("modular-agent.telemetryDisclosure"); }, /disclosure marker/],
  ["baggage", () => toolCall(), s => {
    const record = s.connections[0].frames[2];
    const msg = JSON.parse(record.raw);
    msg.params.traceContext.baggage = "synthetic=test";
    record.raw = JSON.stringify(msg);
  }, /Baggage/],
  ["traceContext on a response", () => toolCall(), s => {
    const record = s.connections[0].frames.at(-1);
    const msg = JSON.parse(record.raw);
    msg.result.traceContext = context(7);
    record.raw = JSON.stringify(msg);
  }, /traceContext on a response/],
  ["context on initialize", () => toolCall(), s => {
    const record = s.connections[0].frames[0];
    const msg = JSON.parse(record.raw);
    msg.params.traceContext = context(12);
    record.raw = JSON.stringify(msg);
  }, /control message/],
  ["resumed span lacking a link", () => crash(), s => { s.received.spans.at(-1).links = []; }, /Link to saved segment/],
  ["checkpoint committed after an effect", () => crash(), s => { s.report.crash.afterRestart.reverse(); }, /before resumed effects/],
];
for (const [name, sample, corrupt, expected] of violations) {
  test(`rejects ${name}`, () => {
    const example = sample();
    corrupt(example);
    assert.throws(() => compareTrace(example), expected);
  });
}

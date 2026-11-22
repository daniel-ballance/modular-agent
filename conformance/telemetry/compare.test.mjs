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

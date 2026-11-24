import assert from "node:assert/strict";
import { test } from "node:test";
import { coveredApproval } from "./covered.mjs";

const declaration = { approvalCoversNested: true, nestedToolCalls: true };
function server(fault) {
  let permission, entries, question, waiting = false;
  return {
    sessionId: "session",
    async waitHistory(ended) { assert.ok(ended(entries)); return entries; },
    duringPermission(handler) { permission = handler; return () => { permission = undefined; }; },
    async rpc(method, params) {
      if (method === "session/set_config_option") { if (params.configId === "approvalWait") waiting = params.value === "untilDeadline"; return {}; }
      if (method === "_modular-agent/answer") {
        assert.equal(params.requestId, question.id); assert.equal(params.value, "allow");
        entries.push({ kind: "turnStart", turnId: "t2", continuesTurnId: "t" },
          { kind: "toolStarted", toolCallId: "c2", data: { call: { name: "bash", parentCallId: "p2" }, approvalCoveredBy: { toolCallId: "p2", requestId: fault === "continued audit" ? "q" : "q2" } } },
          { kind: "toolResult", toolCallId: "c2", data: { status: "completed" } }, { kind: "turnEnd", turnId: "t2" });
        return { accepted: true };
      }
      if (method === "_modular-agent/history") return { entries };
      if (method === "_modular-agent/requests") return { requests: [{ ...question, coversNested: fault !== "poll" }] };
      assert.equal(method, "session/prompt");
      const [, json] = /^tool:nest (.*)$/.exec(params.prompt[0].text), input = JSON.parse(json);
      question = { id: "q", answerable: true, toolCallId: "p", coversNested: true, call: { name: "nest", input } };
      if (waiting) {
        question = { ...question, id: "q2", toolCallId: "p2", approvalWait: "untilDeadline" };
        entries.push({ kind: "inputRequest", turnId: "t", data: { request: question } });
        return { stopReason: "end_turn", _meta: { "modular-agent": { openToolCalls: ["p2"] } } };
      }
      const req = { toolCall: { toolCallId: "p", title: "nest", rawInput: input }, _meta: { "modular-agent": { requestId: "q", coversNested: fault !== "permission" } } };
      const decision = await permission(req);
      assert.equal(decision.outcome.optionId, "allow");
      if (fault === "twice") await permission(req);
      entries = [{ kind: "inputRequest", data: { request: question } },
        { kind: "toolStarted", toolCallId: "c", data: { call: { name: "bash", parentCallId: "p" }, approvalCoveredBy: { toolCallId: "p", requestId: fault === "audit" ? "other" : "q" } } },
        { kind: "toolResult", toolCallId: "c", data: { status: "completed" } }];
      return { stopReason: "end_turn" };
    },
  };
}

test("covered approval reads the poll and the actual start", () => coveredApproval(declaration, server()));
test("a declared waiting approval binds the continued child to the new question", async () => {
  const support = { ...declaration, approvalsOutlastTurns: true };
  await coveredApproval(support, server());
  await assert.rejects(coveredApproval(support, server("continued audit")), /child start names/);
});
test("undeclared coverage skips before sending a request", async () => {
  assert.match(await coveredApproval({}, {}), /does not declare approvalCoversNested/);
});
for (const [fault, why] of [["poll", /poll declares/], ["permission", /permission declares/], ["twice", /only the top-level/], ["audit", /child start names/]]) {
  test("covered approval rejects a fake server with wrong " + fault, () => assert.rejects(coveredApproval(declaration, server(fault)), why));
}

import assert from "node:assert/strict";

function checkStart(entries, by) {
  const question = entries.find(e => e.kind === "inputRequest" && e.data?.request?.id === by.requestId);
  assert.equal(question?.data.request.coversNested, true, "recorded request declares coversNested");
  const children = entries.filter(e => e.kind === "toolStarted" && e.data?.call?.parentCallId === by.toolCallId);
  assert.equal(children.length, 1, "the approved parent dispatches the child once");
  const [child] = children;
  assert.deepEqual(child.data.approvalCoveredBy, by, "child start names the covering call and request");
  assert.equal(child.data.call.name, "bash");
  assert.ok(entries.some(e => e.kind === "toolResult" && e.toolCallId === child.toolCallId && e.data?.status === "completed"));
}

// Runs on the same authenticated connection for the poll and the permission reply.
export async function coveredApproval(declaration, { sessionId, rpc, duringPermission, waitHistory }) {
  if (declaration.approvalCoversNested !== true) return "session does not declare approvalCoversNested";
  if (!declaration.nestedToolCalls) return "session does not declare nestedToolCalls";
  const request = (m, params = {}) => rpc(m, { sessionId, ...params });
  await request("session/set_config_option", { configId: "approval", value: "all" });
  const input = { name: "bash", input: { command: "printf covered" } };
  const permissions = [], polls = [];
  const clear = duringPermission(async p => {
    permissions.push(p);
    polls.push((await request("_modular-agent/requests")).requests);
    return { outcome: { outcome: "selected", optionId: permissions.length === 1 ? "allow" : "refuse" } };
  });
  try {
    const result = await request("session/prompt", { prompt: [{ type: "text", text: "tool:nest " + JSON.stringify(input) }] });
    assert.equal(result.stopReason, "end_turn");
    assert.equal(permissions.length, 1, "only the top-level tool asks");
    const [p] = permissions, m = p._meta?.["modular-agent"], by = { toolCallId: p.toolCall.toolCallId, requestId: m?.requestId };
    assert.equal(m?.coversNested, true, "permission declares coversNested");
    assert.equal(p.toolCall.title, "nest"); assert.deepEqual(p.toolCall.rawInput, input);
    const [q] = polls[0];
    assert.ok(q?.answerable && q.id === by.requestId && q.toolCallId === by.toolCallId);
    assert.equal(q.coversNested, true, "poll declares coversNested"); assert.deepEqual(q.call, { name: "nest", input });
    checkStart((await request("_modular-agent/history")).entries, by);

    // No test clock or private fixture controls: use the real session option and wait for its continuation.
    if (declaration.approvalsOutlastTurns === true) {
      await request("session/set_config_option", { configId: "approvalWait", value: "untilDeadline" });
      try {
        const parked = await request("session/prompt", { prompt: [{ type: "text", text: "tool:nest " + JSON.stringify(input) }] });
        assert.equal(permissions.length, 1, "a waiting call does not open a permission RPC");
        const meta = parked._meta["modular-agent"], [call] = meta.openToolCalls;
        const { requests: [q] } = await request("_modular-agent/requests");
        assert.ok(q?.answerable && q.toolCallId === call && q.approvalWait === "untilDeadline");
        assert.equal(q.coversNested, true, "waiting poll declares coversNested");
        assert.deepEqual(q.call, { name: "nest", input });
        assert.equal((await request("_modular-agent/answer", { requestId: q.id, value: "allow" })).accepted, true);
        const ended = es => {
          const origin = es.find(e => e.kind === "inputRequest" && e.data?.request?.id === q.id)?.turnId;
          const continuation = origin && es.find(e => e.kind === "turnStart" && e.continuesTurnId === origin);
          return !!continuation && es.some(e => e.kind === "turnEnd" && e.turnId === continuation.turnId);
        };
        const entries = await waitHistory(ended);
        assert.ok(ended(entries), "the waiting script finishes in its continuation");
        checkStart(entries, { toolCallId: call, requestId: q.id });
        assert.equal(permissions.length, 1, "continued child does not ask again");
      } finally {
        await request("session/set_config_option", { configId: "approvalWait", value: "live" });
      }
    }
  } finally {
    clear();
    await request("session/set_config_option", { configId: "approval", value: "off" });
  }
}

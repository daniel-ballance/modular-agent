import assert from "node:assert/strict";

// Runs on the same authenticated connection for the poll and the permission reply.
export async function coveredApproval(declaration, { sessionId, rpc, duringPermission }) {
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
    const { entries } = await request("_modular-agent/history");
    const question = entries.find(e => e.kind === "inputRequest" && e.data?.request?.id === q.id);
    assert.equal(question?.data.request.coversNested, true, "recorded request declares coversNested");
    const children = entries.filter(e => e.kind === "toolStarted" && e.data?.call?.parentCallId === by.toolCallId);
    assert.equal(children.length, 1, "the approved parent dispatches the child once");
    const [child] = children;
    assert.deepEqual(child.data.approvalCoveredBy, by, "child start names the covering call and request");
    assert.equal(child.data.call.name, "bash");
    assert.ok(entries.some(e => e.kind === "toolResult" && e.toolCallId === child.toolCallId && e.data?.status === "completed"));
  } finally {
    clear();
    await request("session/set_config_option", { configId: "approval", value: "off" });
  }
}

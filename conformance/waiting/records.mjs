// Assertions on the committed store, not on an ACP or AG-UI recipient projection.
import assert from 'node:assert/strict';

export const rows = (entries, kind) => entries.filter(e => e.kind === kind);
export function one(entries, kind) {
  const matches = rows(entries, kind);
  assert.equal(matches.length, 1, `exactly one ${kind}`);
  return matches[0];
}
export function parked(batches, name, input, { ended = true, otherOpen = [] } = {}) {
  const entries = batches.flat();
  const entry = one(entries.filter(e => e.data?.request?.kind === 'approval'), 'inputRequest');
  const { request: q, call, source, definition } = entry.data;
  assert.ok(q.id && q.id === entry.requestId && q.toolCallId && q.toolCallId === entry.toolCallId, 'bound request and call IDs');
  assert.ok(entry.stepId && entry.turnId && q.question, 'bound step, turn and question');
  assert.ok(typeof q.askedBy === 'string' && q.askedBy.length, 'question names its authenticated asker');
  assert.equal(q.approvalWait, 'untilDeadline');
  assert.equal(q.answerable, false, 'not answerable at publication');
  assert.equal(q.whenTimeLimit, 'decline');
  assert.ok(Number.isSafeInteger(q.timeLimitMs) && q.timeLimitMs >= 0 && Number.isSafeInteger(q.deadlineAt));
  assert.equal(q.deadlineAt, entry.time + q.timeLimitMs, 'deadline from ask time');
  assert.equal(call.id, q.toolCallId);
  assert.equal(call.name, name);
  assert.deepEqual(call.input, input, 'complete bound input');
  assert.ok(source?.plugin && source?.toolSource && definition?.name === name, 'bound registration');
  assert.ok(rows(entries, 'response').some(r => r.turnId === entry.turnId && r.stepId === entry.stepId && entry.sources?.includes(r.id)), 'request names its response');
  const scoped = entries.filter(e => e.toolCallId === q.toolCallId);
  const pending = one(scoped, 'toolPending');
  assert.ok(batches.some(b => b.includes(entry) && b.indexOf(pending) > b.indexOf(entry)), 'request and pending in one ordered batch');
  assert.deepEqual(pending.data.requestIds, [q.id]);
  assert.ok(!('toolStartedId' in pending.data), 'gate pending has no start');
  assert.equal(pending.turnId, entry.turnId);
  assert.equal(pending.stepId, entry.stepId);
  for (const k of ['toolStarted', 'toolResult', 'inputAnswer', 'modular-agent.interfaceHandoff']) assert.equal(rows(scoped, k).length, 0, `parked call has no ${k}`);
  const ends = rows(entries, 'turnEnd').filter(e => e.turnId === entry.turnId);
  if (ended) {
    const end = one(ends, 'turnEnd');
    assert.equal(end.data.outcome.kind, 'completed');
    assert.deepEqual(end.data.result.openToolCalls, [q.toolCallId, ...otherOpen], 'origin ends with its calls open in model order');
    assert.ok(entries.indexOf(end) > entries.indexOf(pending));
  } else assert.equal(ends.length, 0, 'origin not yet ended');
  return entry;
}
export function settled(entries, entry, { status, decision, actor, cause = { kind: 'answer', id: entry.requestId }, continued = true }) {
  const scoped = entries.filter(e => e.toolCallId === entry.toolCallId);
  one(entries.filter(e => e.data?.request?.kind === 'approval'), 'inputRequest');
  one(entries, 'inputAccepted'); one(entries, 'input');
  const answer = one(scoped, 'inputAnswer');
  assert.equal(answer.requestId, entry.requestId);
  if (decision === 'allow') {
    const proof = answer.data.approvalView;
    assert.equal(answer.data.value, 'allow');
    assert.ok(proof?.requestEntryId === entry.id && proof.submittedBy && proof.routeId && ['watch', 'approve'].every(r => proof.rights?.includes(r)), 'allow binds delivered view and ceiling');
    assert.ok(answer.sources?.includes(entry.id));
  } else {
    assert.equal(answer.data.declined, true);
    if (!actor) assert.equal(answer.data.reason, decision);
  }
  assert.equal(answer.data.actorId, actor, 'decision belongs to the winner');
  const turns = rows(entries, 'turnStart');
  assert.equal(turns.length, continued ? 2 : 1, 'no unrelated or duplicate turn');
  const next = turns[1];
  if (continued) {
    assert.equal(next.continuesTurnId, entry.turnId, 'continuation links to origin');
    assert.notEqual(next.turnId, entry.turnId);
    assert.deepEqual(next.data.startedBy, cause);
  }
  const ran = ['completed', 'outcomeUnknown'].includes(status);
  assert.equal(rows(scoped, 'toolStarted').length, Number(ran), 'only initial dispatch has a start');
  if (ran) {
    const start = one(scoped, 'toolStarted');
    assert.equal(start.turnId, next.turnId);
    assert.equal(start.stepId, entry.stepId);
    assert.ok([entry.id, answer.id].every(id => start.sources?.includes(id)), 'start names the request and decision');
    assert.ok(entries.indexOf(answer) < entries.indexOf(next) && entries.indexOf(next) < entries.indexOf(start));
  }
  const result = one(scoped, 'toolResult');
  assert.equal(result.data.status, status);
  assert.equal(result.stepId, entry.stepId);
  assert.ok([next?.turnId, entry.turnId].includes(result.turnId));
  if (ran) assert.equal(result.turnId, next.turnId);
  else assert.ok([entry.id, answer.id].every(id => result.sources?.includes(id)), 'pre-dispatch settlement names its evidence');
}

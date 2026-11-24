import assert from 'node:assert/strict';
import { test } from 'node:test';
import { skipReason, waitingFixtures, waitingKinds, waitingRecords, waitingStep } from './waiting.mjs';

const fixtures = await waitingFixtures();
const choices = new Set(['prompt', 'wait', 'reopen', ...waitingKinds]);
for (const f of fixtures) test(`fixture: ${f.scenario}`, () => {
  assert.ok(skipReason(f, { questionsOutlastTurns: true, lateAnswersStartTurns: true }));
  assert.equal(skipReason(f, f.requires), undefined);
  if (f.agent.severalActors) assert.ok(skipReason(f, { approvalsOutlastTurns: true }));
  assert.ok(f.rules.length && f.about); assert.ok(f.agent.plugins.length);
  if (f.expectCreateError) { assert.deepEqual(f.steps, []); assert.equal(f.expectCreateError.code, 'invalid_composition'); return; }
  assert.ok(f.steps.length);
  let parked = false, active = true, armed, observed = false;
  for (const step of f.steps) {
    const keys = Object.keys(step).filter(k => choices.has(k)); assert.equal(keys.length, 1, 'one runner action');
    const kind = keys[0]; assert.ok(active || ['clock', 'reopen'].includes(kind), 'writer is stopped');
    if (step.as && step.as !== 'user') assert.ok(f.agent.actors.some(a => a.id === step.as));
    if (['poll', 'decide', 'clock', 'barrier', 'stop'].includes(kind)) assert.ok(parked, 'capture the request before using it');
    if (kind === 'barrier') {
      const [op] = Object.keys(step.barrier), at = step.barrier[op];
      assert.ok(['beforeGates', 'beforeHandoff', 'afterAnswer', 'afterEffect'].includes(at));
      if (op === 'arm') { assert.equal(armed, undefined); armed = at; observed = false; }
      else if (op === 'reached') { assert.equal(armed, at); observed = true; }
      else { assert.equal(op, 'release'); assert.equal(armed, at); assert.ok(observed); armed = undefined; }
    }
    if (kind === 'stop') { if (armed) assert.ok(observed); active = false; armed = undefined; }
    if (kind === 'reopen') { assert.ok(!active); active = true; }
    if (step.expect?.parked) {
      assert.equal(step.expect.count, 0); assert.equal(step.expect.parked.timeLimitMs, Math.min(f.fixture?.requestedApprovalMs ?? Infinity, f.agent.maxApprovalWaitMs)); parked = true;
    }
    if (step.expect?.settled) assert.equal(step.expect.count, Number(['completed', 'outcomeUnknown'].includes(step.expect.settled.status)));
  }
  assert.equal(armed, undefined); assert.ok(active);
  if (parked) assert.ok(f.steps.at(-1).expect.settled, 'check terminal records after waiting');
});
const entry = { requestId: 'q', data: { request: { id: 'q', question: 'Count?', deadlineAt: 500 }, call: { id: 'c', name: 'bump', input: { note: 'one' } } } };
const view = { id: 'q', kind: 'approval', question: 'Count?', deadline: 500, call: entry.data.call, approvalWait: 'untilDeadline' };
test('runner uses the requested handle and never polls on behalf of an answer', async () => {
  const calls = [], state = { request: entry };
  const io = { questions: async (as, present) => { calls.push([as, present]); return [view]; },
    answer: async (...args) => { calls.push(args); return false; } };
  await waitingStep({ poll: { present: true }, as: 'reviewer', expect: { view: 'exact' } }, state, io);
  await waitingStep({ decide: 'allow', as: 'worker', expect: { accepted: false } }, state, io);
  assert.deepEqual(calls, [['reviewer', true], ['worker', 'q', 'allow']]);
});
test('runner compares the deadline and entire delivered call against the committed binding', async () => {
  const step = { poll: { present: true }, expect: { view: 'exact' } };
  for (const altered of [{ ...view, deadline: 501 }, { ...view, call: { ...view.call, input: {} } }]) {
    await assert.rejects(waitingStep(step, { request: entry }, { questions: async () => [altered] }));
  }
});
test('controlled clock uses the saved deadline, even without a writer', async () => {
  let now; await waitingStep({ clock: { deadlineOffsetMs: -1 } }, { request: entry }, { setClock(ms) { now = ms; } }); assert.equal(now, 499);
});
test('one expected record does not permit a second one or a hidden start', () => {
  const verify = kinds => waitingRecords({}, { recordCounts: { inputRequest: 1, toolStarted: 0 } }, {}, [kinds.map(kind => ({ kind }))]);
  verify(['inputRequest']); assert.throws(() => verify(['inputRequest', 'inputRequest'])); assert.throws(() => verify(['inputRequest', 'toolStarted']));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { portableProblems, validActor } from './portable.mjs';

const sessionId = 'session', actorId = 'worker';
const auth = { authorizers: [{ sessionId, actorId }], rights: [] };
const content = [{ type: 'text', text: 'example' }];
const entry = (kind, fields, data) => ({ kind, ...fields, data });
const admission = entry('inputAccepted', { actorId, inputId: 'input' }, { ...auth, when: 'after', taken: 'after', content });
const returned = entry('inputHandedBack', { inputId: 'input' }, { reason: 'handled' });
const problems = (...records) => portableProblems(sessionId, records.map((e, i) => ({
  sessionId, time: 10, writer: 'fixture', modelVisible: false, ...e, id: String(i), parentId: i ? String(i - 1) : null,
})));
test('receipts require envelope identity, content, disposition, authority and reason', () => {
  assert.deepEqual(problems(admission, returned), []);
  for (const key of ['content', 'taken', 'rights', 'authorizers']) {
    const e = structuredClone(admission); delete e.data[key]; assert.ok(problems(e).length, key);
  }
  assert.ok(problems(admission, entry('inputHandedBack', {}, { reason: 'handled', inputIds: ['input'] })).length);
  assert.ok(problems(admission, { ...returned, data: {} }).length);
});
test('a preparation failure can settle an admitted input without starting a turn', () => {
  const data = { inputId: 'input', outcome: { kind: 'failed', error: 'cannot save point' },
    result: { openToolCalls: [] }, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } };
  const end = (change = {}) => entry('turnEnd', { turnId: 'turn' }, { ...data, ...change });
  const settlement = { ...returned, data: { reason: 'turnEnded' } };
  assert.deepEqual(problems(admission, settlement, end()), []);
  assert.ok(problems(admission, end()).length);
  assert.ok(problems(end()).length);
  assert.ok(problems(admission, settlement, end({ outcome: { kind: 'completed' } })).length);
});
test('job report admission must match the recorded end', () => {
  const jobId = 'job';
  const start = entry('jobStarted', { actorId, jobId }, { ...auth, kind: 'test', detail: null });
  const end = entry('jobEnded', { jobId }, { report: true, result: content, outcome: { kind: 'completed' } });
  const report = entry('inputAccepted', { actorId, inputId: 'report', jobId },
    { authorizers: [{ sessionId, jobId }], rights: [], key: 'job:job', when: 'after', parked: false, content });
  assert.deepEqual(problems(start, end, report), []);
  assert.ok(problems(start, end).length);
  assert.ok(problems(start, end, { ...report, data: { ...report.data, content: [] } }).length);
});
test('question identity, asker and time limit come from recorded evidence', () => {
  const request = { id: 'q', sessionId, askedBy: actorId, kind: 'text', question: 'Ready?', answerable: false };
  const check = (q, ids = { requestId: 'q' }) => problems(entry('inputRequest', ids, { request: q }));
  assert.deepEqual(check(request), []);
  assert.deepEqual(check({ ...request, timeLimitMs: 0, deadlineAt: 10 }), []);
  for (const change of [{ askedBy: undefined }, { deadlineAt: 10 }, { timeLimitMs: 0 }, { timeLimitMs: 1, deadlineAt: 19 }])
    assert.ok(check({ ...request, ...change }).length);
  assert.ok(check(request, {}).length);
});
test('a step decision belongs to one answered step attempt', () => {
  const model = { provider: 'test', id: 'script' }, turnId = 'turn', stepId = 'step';
  const start = entry('turnStart', { turnId }, { ...auth, startedBy: { kind: 'plugin', id: 'test' }, model, system: '', tools: [], settings: {} });
  const attempt = entry('modelRequest', { turnId, stepId }, { model, tools: [], safeToRepeat: false });
  const response = { kind: 'response', turnId, stepId, sources: ['1'], message: { role: 'assistant', content: [], stop: 'finished' } };
  const decision = entry('modular-agent.stepAfter', { turnId, stepId }, { decision: null });
  assert.deepEqual(problems(start, attempt, response, decision), []);
  assert.ok(problems(start, response).length);
  assert.ok(problems(start, attempt, { ...response, sources: [] }).length);
  assert.ok(problems(start, attempt, response, decision, decision).length);
  assert.ok(problems(start, { ...attempt, data: { ...attempt.data, auxiliary: true } }, response, decision).length);
  assert.ok(problems(start, { ...attempt, data: { ...attempt.data, safeToRepeat: true } }).length);
});
test('check the configured actor and reject failed rewind records', () => {
  assert.equal(validActor({ id: actorId, kind: 'program', rights: [] }), true);
  assert.equal(validActor({ id: actorId, kind: 'program' }), false);
  assert.equal(validActor({ id: actorId, kind: 'plugin', rights: [] }), false);
  assert.ok(problems(entry('position', {}, { to: null, failed: true })).length);
});

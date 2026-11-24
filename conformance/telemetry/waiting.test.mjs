import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareTrace } from './compare.mjs';
import { startReceiver } from './receiver.mjs';
import { waitingCases } from './waiting-cases.mjs';

const attrs = obj => Object.entries(obj).map(([key, value]) => ({ key, value: { stringValue: value } }));
const traceId = '1'.repeat(32), spanId = n => n.toString(16).padStart(16, '0');
const time = n => String(1800000000000000000n + BigInt(n));
const session = { 'gen_ai.conversation.id': 's' }, tx = id => ({ ...session, 'modular_agent.turn.id': id });
const step = turn => ({ ...tx(turn), 'modular_agent.step.id': 'p' });
const call = { 'modular_agent.tool.call.id': 'c' }, request = { 'modular_agent.question.kind': 'approval', 'modular_agent.question.id': 'q' };
const span = (i, parent, name, a, start, end) => ({ spanId: spanId(i), traceId, parentSpanId: parent && spanId(parent), name, kind: 1,
  startTimeUnixNano: time(start), endTimeUnixNano: time(end), attributes: attrs(a) });
const evt = (name, a, t) => ({ name, attributes: attrs(a), timeUnixNano: time(t) });
function sample(scenario = 'waiting-approval', sdk = true, loseOrigin = false) {
  const { status, decision, actor } = waitingCases[scenario], ran = status === 'completed';
  const scope = { turnId: 't', stepId: 'p', toolCallId: 'c' };
  const input = { note: 'fixture-arguments' }, tool = { id: 'c', name: 'bump', input };
  const record = { kind: 'inputRequest', id: 'req', requestId: 'q', time: 10, ...scope, sources: ['response'], data: {
    request: { id: 'q', askedBy: 'gate', kind: 'approval', approvalWait: 'untilDeadline', toolCallId: 'c', question: 'Run the waiting counter?',
      answerable: false, whenTimeLimit: 'decline', deadlineAt: 110, timeLimitMs: 100 }, call: tool, definition: { name: 'bump' }, source: { plugin: 'counter', toolSource: 'source' },
  } };
  const originBatches = [[{ kind: 'inputAccepted' }, { kind: 'turnStart', turnId: 't' }, { kind: 'input' }, { kind: 'response', turnId: 't', stepId: 'p', id: 'response' }],
    [record, { kind: 'toolPending', ...scope, data: { requestIds: ['q'] } }], [{ kind: 'turnEnd', turnId: 't', data: { outcome: { kind: 'completed' }, result: { openToolCalls: ['c'] } } }]];
  const allowed = decision === 'allow';
  const ans = { kind: 'inputAnswer', id: 'ans', requestId: 'q', ...scope, sources: ['req'], data: { ...(actor && { actorId: actor }), ...(allowed ?
    { value: 'allow', approvalView: { requestEntryId: 'req', rights: ['watch', 'approve'], routeId: 'private-route', submittedBy: 'user' } } : { declined: true, ...(!actor && { reason: decision }) }) } };
  const finalBatches = [...originBatches, [ans], [{ kind: 'turnStart', turnId: 'next', continuesTurnId: 't', data: { startedBy: { kind: 'answer', id: 'q' } } }],
    ...(ran ? [[{ kind: 'toolStarted', ...scope, turnId: 'next', sources: ['req', 'ans'] }]] : []),
    [{ kind: 'toolResult', ...scope, turnId: 'next', sources: ['req', 'ans'], data: { status } }],
    [{ kind: 'turnEnd', turnId: 'next', data: { outcome: { kind: 'completed' }, result: { openToolCalls: [] } } }]];
  const invoke = t => ({ ...tx(t), 'gen_ai.operation.name': 'invoke_agent', 'modular_agent.turn.outcome': 'completed' });
  const origin = span(1, 0, 'invoke_agent', invoke('t'), 10, 50), firstStep = span(2, 1, 'modular_agent.step', step('t'), 12, 48);
  firstStep.events = [evt('modular_agent.question.open', request, 20)];
  const close = span(3, 0, actor ? 'modular_agent.question.answer' : 'modular_agent.session.open', actor ? session : { ...session, 'modular_agent.session.operation': 'load' }, 500, 510);
  close.events = [evt('modular_agent.question.close', { ...request, 'modular_agent.question.disposition': { timeLimit: 'timeLimit', allow: 'answered', decline: 'declined' }[decision] }, 505)];
  const next = span(4, 0, 'invoke_agent', invoke('next'), 515, 555);
  next.links = [{ traceId, spanId: origin.spanId }];
  const secondStep = span(5, 4, 'modular_agent.step', step('next'), 516, 552);
  const execute = span(6, 5, 'execute_tool bump', { ...step('next'), ...call, 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'bump', 'modular_agent.tool.status': 'completed' }, 517, 540);
  if (!ran) secondStep.events = [evt('modular_agent.tool.disposition', { ...call, 'modular_agent.tool.status': status }, 520)];
  const early = sdk && !loseOrigin ? [origin, firstStep] : [];
  const spans = sdk ? [...early, next, close, secondStep, ...(ran ? [execute] : [])] : [];
  return { testCase: { scenario, placement: 'inProcess', sdk }, scriptedReplies: [{ toolCalls: [tool] }],
    report: { scenario, placement: 'inProcess', sessionId: 's', turnId: 't', outcome: 'completed', passed: true, historyKinds: finalBatches.flat().map(e => e.kind),
      declarations: { session: { telemetry: 1, approvalsOutlastTurns: true, severalActors: true } },
      waiting: { originBatches, finalBatches, counterAtPark: 0, counterAfter: Number(ran), activeWorkAtPark: [] } },
    received: { spans, errors: [], payloads: [{ resourceSpans: [{ scopeSpans: [{ spans }] }] }] }, atPark: { spans: structuredClone(early) }, sentinels: ['fixture-arguments', 'fixture-secret'] };
}
for (const scenario of Object.keys(waitingCases)) for (const sdk of [true, false]) {
  test(`accept factual ${scenario} with export ${sdk ? 'on' : 'off'}`, () => compareTrace(sample(scenario, sdk)));
}
test('expiry on reopen does not require the killed process to have exported', () => {
  compareTrace(sample('waiting-approval-expire-stopped', true, true));
});
const byName = (s, name) => s.received.spans.find(e => e.name === name);
for (const [fault, change, diagnostic, variant] of [
  ['missing receiver checkpoint', s => delete s.atPark, /receiver checkpoint/],
  ['turn still open', s => s.atPark.spans.shift(), /end and export/],
  ['step still open', s => s.atPark.spans.pop(), /end and export/],
  ['unended span not yet exported', s => s.report.waiting.activeWorkAtPark.push('execute_tool'), /keep a span open/],
  ['early execution export', s => s.atPark.spans.push(byName(s, 'execute_tool bump')), /before dispatch/],
  ['tool span started before allow', s => byName(s, 'execute_tool bump').startTimeUnixNano = time(500), /started before decision/],
  ['span covering idle time', s => s.received.spans.push(span(9, 0, 'approval.wait', session, 20, 510)), /covers the idle/],
  ['counter effect before allow', s => s.report.waiting.counterAtPark++, /Effect before/],
  ['lost counter effect', s => s.report.waiting.counterAfter--, /dispatch count/],
  ['wrong opening ID', s => byName(s, 'modular_agent.step').events[0].attributes[1].value.stringValue = 'other', /question.id/],
  ['close on ended step', s => s.atPark.spans[1].events.push(byName(s, 'modular_agent.question.answer').events[0]), /Close recorded/],
  ['wrong close operation', s => byName(s, 'modular_agent.question.answer').name = 'unrelated', /answer operation/],
  ['expiry reported as decline', s => byName(s, 'modular_agent.session.open').events[0].attributes.at(-1).value.stringValue = 'declined', /question.disposition/, 'waiting-approval-expire-stopped'],
  ['missing continuation link', s => s.received.spans[2].links.pop(), /link to origin/],
  ['old turn as execution parent', s => byName(s, 'execute_tool bump').parentSpanId = spanId(1), /wrong parent/],
  ['changed call identity', s => byName(s, 'execute_tool bump').attributes.find(x => x.key === 'modular_agent.tool.call.id').value.stringValue = 'new', /call.id/],
  ['refused call with execution span', s => s.received.spans.push(span(9, 5, 'execute_tool bump', step('next'), 520, 540)), /actual dispatch/, 'waiting-approval-changed-approver'],
  ['missing pre-dispatch disposition', s => s.received.spans.at(-1).events.pop(), /disposition count/, 'waiting-approval-decline'],
  ['question content', s => s.received.spans[0].attributes.push(...attrs({ other: 'Run the waiting counter?' })), /Fixture content/],
  ['answer content', s => s.received.spans[0].attributes.push(...attrs({ other: 'allow' })), /Fixture content/],
  ['route proof', s => s.received.spans[0].links = [{ traceState: 'private-route' }], /Fixture content/],
]) test(`reject waiting ${fault}`, () => { const s = sample(variant); change(s); assert.throws(() => compareTrace(s), diagnostic); });

test('receiver acknowledges the parked boundary exactly once and freezes that snapshot', async t => {
  const r = await startReceiver({ observeParked: true }); t.after(() => r.close());
  const send = name => fetch(r.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{ name }] }] }] }) });
  await (await send('origin')).text(); assert.equal((await fetch(r.parkedUrl, { method: 'POST' })).status, 204);
  await (await send('continuation')).text(); assert.deepEqual(r.parkedSnapshot().spans, [{ name: 'origin' }]);
  assert.equal((await fetch(r.parkedUrl, { method: 'POST' })).status, 409);
});

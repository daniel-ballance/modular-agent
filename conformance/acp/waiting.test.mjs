import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { support, view } from './waiting.mjs';
import { parked, settled } from '../waiting/records.mjs';

const input = { command: 'printf x >> count' }, scope = { stepId: 's', turnId: 't', toolCallId: 'c' };
function sample() {
  const request = { id: 'q', kind: 'approval', question: 'Run the counter?', toolCallId: 'c', approvalWait: 'untilDeadline', deadlineAt: 110, timeLimitMs: 10, whenTimeLimit: 'decline', answerable: false };
  const e = { kind: 'inputRequest', id: 'r', requestId: 'q', time: 100, ...scope, sources: ['resp'], data: { request,
    call: { id: 'c', name: 'bash', input }, definition: { name: 'bash' }, source: { plugin: 'test', toolSource: 'tools' } } };
  const batches = [[{ kind: 'inputAccepted' }, { kind: 'turnStart', turnId: 't' }, { kind: 'input' }, { kind: 'response', turnId: 't', stepId: 's', id: 'resp' }],
    [e, { kind: 'toolPending', ...scope, data: { requestIds: ['q'] } }], [{ kind: 'turnEnd', turnId: 't', data: { outcome: { kind: 'completed' }, result: { openToolCalls: ['c'] } } }]];
  const later = [{ kind: 'inputAnswer', ...scope, id: 'ans', requestId: 'q', sources: ['r'], data: { value: 'allow', actorId: 'member', approvalView: { requestEntryId: 'r', submittedBy: 'member', routeId: 'route', rights: ['watch', 'approve'] } } },
    { kind: 'turnStart', turnId: 't2', continuesTurnId: 't', data: { startedBy: { kind: 'answer', id: 'q' } } },
    { kind: 'toolStarted', ...scope, turnId: 't2', sources: ['r', 'ans'] }, { kind: 'toolResult', ...scope, turnId: 't2', data: { status: 'completed' } }];
  return { batches, e, later };
}
const expected = { decision: 'allow', status: 'completed', actor: 'member' };
test('accept one bound wait and one initial dispatch', () => {
  const { batches, e, later } = sample(); assert.equal(parked(batches, 'bash', input), e); settled([...batches.flat(), ...later], e, expected);
});
for (const [name, change] of Object.entries({
  'split request and checkpoint': b => b.splice(2, 0, [b[1].pop()]),
  'premature dispatch': b => b[0].push({ kind: 'toolStarted', ...scope }),
  'provisional result': b => b[0].push({ kind: 'toolResult', ...scope }),
  'missing open call': b => b[2][0].data.result.openToolCalls.pop(),
  'extended deadline': b => b[1][0].data.request.deadlineAt++,
  'unbound source': b => delete b[1][0].data.source,
})) test(`reject ${name}`, () => { const { batches } = sample(); change(batches); assert.throws(() => parked(batches, 'bash', input)); });
for (const [name, change] of Object.entries({
  'second decision': es => es.push(es[0]), 'second input': es => es.push({ kind: 'input' }),
  'invented permission': es => delete es[0].data.approvalView, 'unlinked continuation': es => delete es[1].continuesTurnId,
  'lost start lineage': es => es[2].sources.pop(), 'second effect': es => es.push(es[2]),
})) test(`reject ${name}`, () => { const { batches, e, later } = sample(); change(later); assert.throws(() => settled([...batches.flat(), ...later], e, expected)); });
test('an ACP poll must match the recorded view, including the complete input and deadline', () => {
  const { e } = sample(); const q = { id: 'q', question: 'Run the counter?', kind: 'approval', answerable: true, toolCallId: 'c', approvalWait: 'untilDeadline', deadlineAt: 110, call: { name: 'bash', input } };
  view(q, e, input); for (const key of Object.keys(q)) assert.throws(() => view({ ...q, [key]: null }, e, input));
});
test('ordinary late answers do not declare waiting approvals', () => {
  const deps = { lateAnswersStartTurns: true, questionsOutlastTurns: true, portableSessions: true };
  assert.equal(support(deps), false); assert.equal(support({ ...deps, approvalsOutlastTurns: true }), true);
  for (const key of Object.keys(deps)) assert.throws(() => support({ ...deps, approvalsOutlastTurns: true, [key]: false }));
});
test('CLI skips an undeclared session in each ACP version without contacting a control service', async () => {
  const fixture = `require('node:readline').createInterface({input:process.stdin}).on('line',l=>{let {id,method,params}=JSON.parse(l); if(id===undefined)return;const m={binding:params._meta?.['modular-agent'].binding,declaration:{},extensions:[]};console.log(JSON.stringify({jsonrpc:'2.0',id,result:{protocolVersion:1,sessionId:'one',configOptions:[],_meta:{'modular-agent':m}}}));});`;
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./run.mjs', import.meta.url)), '--waiting-approval-only', '--', process.execPath, '-e', fixture]);
  assert.equal(stdout.match(/SKIP .*does not declare approvalsOutlastTurns/g)?.length, 2);
  assert.match(stdout, /2\/2 checks passed/);
});

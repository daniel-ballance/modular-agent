// Language-neutral fixtures and a reference interpreter for the six additional
// step kinds. A runner can implement this contract natively. Never derive an
// observation (especially the counter or the clock) from a scenario's expected result.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { parked, rows, settled } from '../waiting/records.mjs';

const directory = new URL('fixtures/waiting-approval/', import.meta.url);
export async function waitingFixtures() {
  const names = JSON.parse(await readFile(new URL('waiting-scenarios.json', import.meta.url), 'utf8'));
  assert.ok(names.length > 0, 'waiting fixture manifest is empty');
  const files = (await readdir(directory)).filter(n => n.endsWith('.json')).sort();
  assert.deepEqual(files, names.map(n => n + '.json').sort(), 'waiting fixture set differs from manifest');
  return Promise.all(files.map(async n => {
    const fixture = JSON.parse(await readFile(new URL(n, directory), 'utf8'));
    assert.equal(n, fixture.scenario + '.json');
    return fixture;
  }));
}
export function checkWaitingDeclaration(fixture, declaration) {
  const expected = { approvalsOutlastTurns: true, ...(fixture.agent.severalActors && { severalActors: true }), ...fixture.expectDeclaration };
  for (const [key, value] of Object.entries(expected)) assert.equal(declaration[key] ?? false, value, key);
}
export const waitingKinds = ['poll', 'decide', 'barrier', 'clock', 'change', 'stop'];

// state lives in the driver, outside any process killed by the scenario.
// io returns normalized SDK values (decision: true/false, deadline: epoch ms).
export async function waitingStep(step, state, io) {
  const kind = waitingKinds.find(key => Object.hasOwn(step, key));
  const { expect = {}, as = 'user' } = step;
  switch (kind) {
    case 'poll': {
      const views = await io.questions(as, step.poll.present);
      if (expect.view === 'empty') { assert.deepEqual(views, []); break; }
      const e = state.request, { request: q, call } = e.data;
      const v = views.find(v => v.id === q.id);
      if (expect.view === 'notAnswerable') {
        assert.ok(!v || v.answerable === false || v.question !== q.question || !sameCall(v.call, call), 'no actionable unchanged view through a redacting gate'); break;
      }
      assert.ok(v && views.length === 1, 'one matching open question');
      if (expect.view === 'listed') break;
      assert.equal(expect.view, 'exact'); assert.equal(v.kind, 'approval'); assert.equal(v.approvalWait, 'untilDeadline');
      assert.equal(v.deadline, q.deadlineAt); assert.equal(v.question, q.question);
      assert.ok(sameCall(v.call, call), 'poll returns the bound call ID, exact name and complete input'); break;
    }
    case 'decide': {
      // In particular: do not poll to obtain a more recent view before answering.
      const ok = await io.answer(as, state.request.requestId, step.decide);
      assert.equal(ok, expect.accepted, 'decision accepted on this handle'); break;
    }
    case 'clock': await io.setClock(state.request.data.request.deadlineAt + step.clock.deadlineOffsetMs); break;
    case 'barrier': await io.barrier(step.barrier); break;
    case 'change': await io.change(step.change); break;
    case 'stop': await io.stop(step.stop); break;
    default: return false; // prompt, wait, reopen, etc. use the existing driver
  }
  return true;
}
function sameCall(actual, expected) {
  return actual?.id === expected.id && actual.name === expected.name && isDeepStrictEqual(actual.input, expected.input);
}

// Check the additional expectations, alongside (not instead of) count,
// toolResults, outcome and error in the ordinary runner.
export function waitingRecords(fixture, expect, state, batches, promptResult) {
  if (expect.parked) {
    const { name, input } = fixture.model[0].toolCalls[0];
    const e = parked(batches, name, input);
    assert.equal(e.data.request.timeLimitMs, expect.parked.timeLimitMs, 'requested limit clamped by operator maximum');
    if (state.request) assert.deepEqual(e, state.request, 'reopen preserves the immutable request and deadline');
    else state.request = structuredClone(e);
  }
  if (expect.openToolCalls) assert.deepEqual(promptResult.openToolCalls, expect.openToolCalls.map(id => id === '$call' ? state.request.toolCallId : id));
  const es = batches.flat();
  for (const [kind, count] of Object.entries(expect.recordCounts ?? {})) assert.equal(rows(es, kind).length, count, `exact ${kind} count`);
  if (expect.settled) {
    settled(es, state.request, expect.settled);
    if (expect.settled.decision === 'allow') {
      const { approvalView } = rows(es, 'inputAnswer')[0].data;
      assert.equal(approvalView.submittedBy, 'user', 'local principal on the embedded handle');
      const grant = fixture.agent.actors?.find(a => a.id === expect.settled.actor);
      if (grant) assert.ok(approvalView.rights.every(r => grant.rights.includes(r)), 'saved ceiling cannot borrow rights');
    }
  }
}

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { frontend, handoff, options, opts, rawReport, simple, success } from './cases.mjs';
import { controls, hostRead, records } from './host-read.mjs';
import { at, input, json, refused, responseType, sse, threadPath, tool, user } from './wire.mjs';

const scenario = (run, model = simple, extra) => hostRead('runReceipts', model, run, extra);
const path = ({ threadId, runId }) => threadPath(threadId) + '/run-receipt?' + new URLSearchParams({ runId });
const missing = async (api, post) => refused(await api.request(path(post)), 404, 'not_found');
const receipt = async (api, post, terminal, work) => assert.deepEqual(await json(await api.request(path(post))), { terminal, work }, 'status-only receipt at this watermark');
const recorded = (control, post) => control('barrier', { name: 'terminalRecorded', runId: post.runId });
const effectKinds = ['inputAccepted', 'input', 'inputAnswer', 'toolStarted', 'toolResult', 'turnStart', 'turnEnd'];
const effects = evidence => [evidence.batches.flat().filter(e => effectKinds.includes(e.kind)).map(e => e.id), [...evidence.dispatches]];

async function readAndRetry(peer, post, terminal, work) {
  const { api } = peer, control = controls(peer, post.threadId);
  const before = effects(await control('inspect'));
  for (let i = 0; i < 2; i++) await receipt(api, post, terminal, work);
  await refused(await api.post(post), 409, 'conflict');
  // An old message copy alone would conflict even if the run ID were forgotten.
  const current = await api.view(post.threadId);
  await refused(await api.post(input(current, [user('Duplicate run ID, current history.')], { runId: post.runId }), opts(current)), 409, 'conflict');
  assert.deepEqual(effects(await control('inspect')), before, 'receipt reads and retries leave work unchanged');
}

// Read the exchange concurrently with the kill. A partial stream is fine, but
// not a released terminal, an HTTP refusal, a framing error or a client timeout.
async function lost(api, post, view) {
  try {
    const response = await api.post(post, opts(view));
    assert.equal(response.status, 200, 'the interrupted POST was not refused');
    responseType(response, 'text/event-stream');
    for await (const { data } of sse(response)) assert.ok(!['RUN_FINISHED', 'RUN_ERROR'].includes(data?.type), 'a terminal escaped the pre-delivery pause');
  } catch (e) {
    if (!(e instanceof TypeError && ['fetch failed', 'terminated'].includes(e.message))) throw e;
  }
}
async function pausePost(peer, view, post, name) {
  const control = controls(peer, view.threadId);
  await control('hold', { name, runId: post.runId });
  const dropped = lost(peer.api, post, view); dropped.catch(() => {});
  await control('barrier', { name, runId: post.runId });
  return { control, dropped };
}

function crash(name, durable = false) {
  return scenario(async (peer, view) => {
    const { threadId } = view;
    // Keep the thread before arming the kill. A missing provisional thread is
    // not evidence for (or against) admission of a request.
    success(await peer.api.run(input(view, [user('Keep the crash fixture.')]), opts(view)));
    const kept = await peer.api.view(threadId);
    const post = input(kept, [user('Interrupt this exchange.')]);
    const { control, dropped } = await pausePost(peer, kept, post, name);
    const before = await control('inspect');
    const accepted = name !== 'beforeAdmission', ended = name === 'beforeTerminal';
    assert.equal(records(before, 'inputAccepted').length, 1 + Number(accepted), 'kill boundary: committed input admissions');
    assert.equal(records(before, 'turnStart').length, 1 + Number(accepted), 'kill boundary: interrupted turn has started');
    assert.equal(records(before, 'turnEnd').length, 1 + Number(ended), 'kill boundary: committed turn ends');
    const turnId = records(before, 'turnStart').at(-1).turnId;
    if (accepted) await receipt(peer.api, post, 'unknown', ended ? 'completed' : 'unsettled');
    else await missing(peer.api, post);
    peer = await peer.restart(); await dropped;
    const reopened = await peer.api.view(threadId);
    const ctl = controls(peer, threadId);
    if (!accepted) {
      await missing(peer.api, post);
      assert.equal(records(await ctl('inspect'), 'inputAccepted').length, 1, 'kill before admission left no input');
      // The latch, not the 404, proved non-admission. This ID was never claimed.
      success(await peer.api.run(input(reopened, [post.messages.at(-1)], { runId: post.runId }), opts(reopened)));
      await recorded(ctl, post); await readAndRetry(peer, post, 'success', 'completed');
      return;
    }
    if (!ended) await ctl('barrier', { name: 'recoveryEnded', runId: post.runId });
    const ends = records(await ctl('inspect'), 'turnEnd').filter(e => e.turnId === turnId);
    assert.equal(ends.length, 1, 'one committed outcome for the interrupted run');
    const work = ends[0].data.outcome.kind;
    assert.equal(work, ended || durable ? 'completed' : 'failed', 'scripted recovery outcome');
    await readAndRetry(peer, post, 'unknown', work);
    const fresh = await peer.api.view(threadId), later = input(fresh, [user('A later successful turn.')]);
    success(await peer.api.run(later, opts(fresh))); await recorded(ctl, later);
    await receipt(peer.api, later, 'success', 'completed'); await receipt(peer.api, post, 'unknown', work);
  }, [...simple, { text: 'Later answer.' }], { restart: true });
}

export const receipts = {
  'receipt-before-admission': crash('beforeAdmission'),
  'receipt-after-admission': crash('afterAdmission'),
  'receipt-durable': crash('afterAdmission', true),
  'receipt-before-terminal': crash('beforeTerminal'),
  'receipt-interrupt': scenario(async (peer, view) => {
    const { api } = peer, control = controls(peer, view.threadId);
    const presence = await api.presence(view.threadId);
    try {
      const first = input(view, [user('Ask a question.')]);
      const waiting = await api.run(first, opts(view));
      assert.equal(waiting.terminal.outcome?.type, 'interrupt');
      const [q] = waiting.terminal.outcome.interrupts;
      await recorded(control, first); await receipt(api, first, 'interrupt', 'unsettled');
      const v = await api.view(view.threadId), reply = input(v, [], { resume: [{ interruptId: q.id, status: 'resolved', payload: 'yes' }] });
      success(await api.run(reply, opts(v))); await recorded(control, reply);
      await receipt(api, first, 'interrupt', 'completed'); await readAndRetry(peer, reply, 'success', 'completed');
      const seen = await control('inspect');
      assert.equal(records(seen, 'inputAccepted').length, 1, 'answer did not admit input');
      assert.equal(records(seen, 'inputAnswer').length, 1, 'one committed decision');
      assert.equal(records(seen, 'turnStart').length, 1, 'answer followed the live turn');
    } finally { await presence.close(); }
  }),
  'receipt-result': scenario(async (peer, view) => {
    const first = input(view, [user('Hand off once.')], options);
    const call = handoff(await peer.api.run(first, opts(view)));
    await recorded(controls(peer, view.threadId), first); // Do not race the origin's terminal marker with the kill.
    const open = await peer.api.view(view.threadId), report = input(open, [tool(call.id, rawReport)]);
    const { control, dropped } = await pausePost(peer, open, report, 'afterResult');
    const before = await control('inspect');
    assert.equal(records(before, 'turnStart').length, 1, 'continuation has not started');
    assert.deepEqual(records(before, 'toolResult').map(e => e.toolCallId), [call.id], 'report committed before kill');
    await receipt(peer.api, report, 'unknown', 'unsettled');
    peer = await peer.restart(); await dropped; await peer.api.view(view.threadId);
    const ctl = controls(peer, view.threadId); await ctl('barrier', { name: 'recoveryEnded', runId: report.runId });
    const after = await ctl('inspect'), starts = records(after, 'turnStart');
    assert.equal(starts.length, 2, 'one origin and one continuation');
    assert.equal(starts[1].continuesTurnId, starts[0].turnId, 'continued the report origin');
    assert.deepEqual(starts.map(s => records(after, 'turnEnd').find(e => e.turnId === s.turnId)?.data.outcome.kind), ['completed', 'failed'], 'origin and continuation have different outcomes');
    assert.equal(records(after, 'inputAccepted').length, 1, 'one opening input, no result-only admission');
    assert.deepEqual(after.dispatches, [call.id], 'original handoff released only once');
    await receipt(peer.api, first, 'success', 'completed'); await readAndRetry(peer, report, 'unknown', 'failed');
    // With transport intact the same failing continuation releases RUN_ERROR.
    const live = await peer.api.view((await peer.api.create()).threadId);
    const origin = input(live, [user('Hand off and stay connected.')], options);
    const hand = handoff(await peer.api.run(origin, opts(live)));
    const current = await peer.api.view(live.threadId), result = input(current, [tool(hand.id, rawReport)]);
    const run = await peer.api.run(result, opts(current)); assert.equal(run.terminal.type, 'RUN_ERROR');
    const currentCtl = controls(peer, live.threadId);
    await recorded(currentCtl, origin); await recorded(currentCtl, result);
    await receipt(peer.api, origin, 'success', 'completed'); await readAndRetry(peer, result, 'error', 'failed');
  }, [frontend[0], { error: { kind: 'other', message: 'Fixture continuation failed.' } }], { restart: true }),
  'receipt-visibility': scenario(async (peer, view) => {
    const { api, origin, tokens } = peer, id = view.threadId, ctl = controls(peer, id);
    const post = input(view, [user('Keep a receipt.')], { runId: 'kit /+?&= ' + randomUUID() });
    success(await api.run(post, opts(view))); await recorded(ctl, post);
    await readAndRetry(peer, post, 'success', 'completed');
    const absent = { ...post, runId: randomUUID() };
    await missing(api, absent); await missing(api, { ...post, threadId: randomUUID() });
    await refused(await api.request(path(post), { auth: null }), 401, 'unauthenticated');
    for (const role of ['sibling', 'foreign', 'tenant']) {
      const other = at(origin, tokens[role]);
      if (role !== 'tenant') await other.view(id); // Current watch is not ownership of this exchange.
      await missing(other, post);
    }
    await ctl('receiptGate', { mode: 'settlement' }); await missing(api, post);
    for (const mode of ['terminal', 'work', 'reply']) {
      await ctl('receiptGate', { mode });
      await refused(await api.request(path(post)), 403, 'output_withheld');
    }
    await missing(api, absent); await missing(at(origin, tokens.sibling), post);
    await ctl('receiptGate', { mode: 'allow' }); await receipt(api, post, 'success', 'completed');
    await ctl('hold', { name: 'pendingErasure' });
    const erasing = ctl('erase'); erasing.catch(() => {});
    try { await ctl('barrier', { name: 'pendingErasure' }); await missing(api, post); }
    finally { await ctl('release', { name: 'pendingErasure' }); await erasing; }
    await missing(api, post);
  }, simple, { roles: ['sibling', 'foreign', 'tenant'] }),
};

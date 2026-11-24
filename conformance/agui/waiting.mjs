import assert from 'node:assert/strict';
import { at, exchange, finalView, input, tool, user } from './wire.mjs';
import { checkApprovalCall, checkWaiting, dispatch, draft, historyError, offer, options, opts, rawReport, reportRefused, second, success } from './cases.mjs';
import { one, parked, rows, settled } from '../waiting/records.mjs';
import { acpPeer } from '../waiting/acp-peer.mjs';

const args = { hold: false, note: 'waiting-counter-sentinel' };
const bump = { name: 'bump', input: args };
const action = (id, cancel) => cancel ? { interruptId: id, status: 'cancelled' } : { interruptId: id, status: 'resolved', payload: { allow: true } };
const resume = (v, id, cancel = false) => input(v, [], { resume: [action(id, cancel)] });
const state = (peer, id) => peer.control('inspect', { threadId: id });
function interrupt(q, entry) {
  assert.equal(q?.reason, 'approval', 'answerable approval interrupt');
  checkApprovalCall(q, bump, 'waiting');
  if (entry.data.request.coversNested) assert.equal(q.metadata?.['modular-agent.coversNested'], true, 'waiting interrupt declares coversNested');
  assert.equal(q.id, entry.requestId, 'same request ID');
  assert.equal(q.toolCallId, entry.toolCallId, 'same call ID');
  assert.equal(Date.parse(q.expiresAt), entry.data.request.deadlineAt, 'original absolute expiry');
  assert.ok(q.message.includes(entry.data.request.question) && /\bbump\b/.test(q.message) &&
    ['hold', 'false', 'note', args.note].every(part => q.message.includes(part)), 'unchanged prompt, tool name and complete arguments');
}
async function initial(peer, id, { mixed = false, present = false, live = false } = {}) {
  const v = await peer.api.view(id);
  // No run POST can upgrade the session setting. The live case also tries a forged setting.
  const r = await peer.api.run(input(v, [user('Count once.')], { ...(mixed && options), ...(live && { approvalWait: 'untilDeadline' }) }), opts(v));
  if (!present) success(r);
  const seen = await state(peer, id), es = seen.batches.flat();
  assert.equal(seen.counter, 0, 'counter is zero when origin ends');
  if (live) {
    assert.equal(one(es, 'toolResult').data.status, 'refused'); assert.equal(rows(es, 'toolStarted').length, 0);
    assert.equal(r.pending.length, 0); assert.ok(!rows(es, 'inputRequest').some(e => e.data.request?.approvalWait)); return;
  }
  const otherOpen = mixed ? [one(es, 'modular-agent.interfaceHandoff').toolCallId] : [];
  const e = parked(seen.batches, 'bump', args, { otherOpen });
  assert.equal(e.data.request.coversNested, true, 'parked call offers coverage');
  assert.ok(!r.calls.has(e.toolCallId) && !r.terminal.outcome?.pendingToolCallIds?.includes(e.toolCallId), 'no triad, result or executable ID for the parked call');
  assert.deepEqual(r.pending.map(x => x.id), otherOpen, 'only handed-off siblings are executable');
  if (mixed) {
    assert.equal(r.pending[0].start.toolCallName, offer.name); assert.deepEqual(JSON.parse(r.pending[0].args), dispatch);
    assert.deepEqual(seen.dispatches, otherOpen, 'one frontend handoff at release');
  }
  if (present) {
    assert.equal(r.terminal.outcome.type, 'interrupt'); assert.equal(r.terminal.outcome.interrupts.length, 1);
    interrupt(r.terminal.outcome.interrupts[0], e);
  } else assert.ok(!r.terminal.outcome.interrupts?.length, 'offline origin gets no actionable interrupt');
  assert.ok(!finalView(r).messages.some(m => m.role === 'tool' && m.toolCallId === e.toolCallId), 'no provisional tool message');
  await checkWaiting(peer.api, id, 1, otherOpen.length, 'none');
  const snap = await peer.api.view(id); assert.deepEqual(snap.waiting.toolCalls.map(x => x.toolCallId), otherOpen, 'parked call is not an Interface tool');
  if (!present) assert.deepEqual(snap.waiting.questions, [], 'a snapshot without presence is not answerable');
  return { e, snap, other: otherOpen[0] };
}
async function delivered(api, id, e) {
  const v = await api.view(id); assert.equal(v.waiting.questions.length, 1, 'fresh delivery on this presence stream');
  interrupt(v.waiting.questions[0], e); return v;
}
async function outcome(peer, id, e, status, decision, actor, cause) {
  const seen = await state(peer, id);
  settled(seen.batches.flat(), e, { status, decision, actor, cause });
  assert.equal(seen.counter, Number(status === 'completed'), 'actual counter matches settlement');
}
function scenario(run, { mixed, restart, roles = [] } = {}) {
  return { model: [{ toolCalls: [bump, ...(mixed ? [{ name: offer.name, input: draft }] : [])] }, { text: second }],
    control: true, restart, roles, async run(peer) {
      const { threadId, declaration } = await peer.api.create();
      assert.equal(declaration.approvalsOutlastTurns, true, 'fixture must declare approvalsOutlastTurns');
      assert.equal(declaration.approvalCoversNested, true, 'fixture must declare approvalCoversNested');
      if (mixed) assert.equal(declaration.interfaceTools, true, 'fixture must declare interfaceTools');
      assert.ok(peer.control, 'waiting cases require fixture controls');
      if (restart) assert.ok(peer.restart, 'restart case requires a managed command');
      for (const role of roles) assert.ok(peer.tokens[role], `case needs the ${role} token`);
      await run(peer, threadId);
    } };
}
export const waiting = {
  'waiting-live': scenario(async (peer, id) => { await initial(peer, id, { live: true }); await checkWaiting(peer.api, id, 0, 0, 'none'); }),
  'waiting-restart': scenario(async (peer, id) => {
    const { e } = await initial(peer, id);
    const old = await peer.api.presence(id);
    let inbox;
    try { inbox = await delivered(peer.api, id, e); peer = await peer.restart(); } finally { await old.close(); }
    const history = await peer.api.view(id); // Reconcile while absent so stale history cannot mask stale delivery.
    assert.deepEqual(history.waiting.questions, []);
    const fresh = await peer.api.presence(id);
    try {
      await reportRefused(await peer.api.post(resume(history, inbox.waiting.questions[0].id), opts(history)));
      const v = await delivered(peer.api, id, e);
      const changed = resume(v, e.requestId); changed.messages = changed.messages.slice(1);
      await historyError(await peer.api.post(changed, opts(v)));
      await reportRefused(await peer.api.post(input(v, [], { resume: [action('missing-id')] }), opts(v)));
      const r = await peer.api.run(resume(v, e.requestId), opts(v)); success(r);
      assert.equal(r.pending.length, 0); assert.equal(finalView(r).messages.filter(m => m.role === 'user').length, 1);
      await outcome(peer, id, e, 'completed', 'allow', 'kit-owner');
      const after = await peer.api.view(id); assert.deepEqual(after.waiting.questions, []);
      assert.equal(after.declaration.approvalCoversNested, true, 'reopened fixture must declare approvalCoversNested');
      const es = (await state(peer, id)).batches.flat();
      assert.equal(rows(es, 'inputRequest').length, 1, 'only the parent asked');
      const child = one(es.filter(r => r.data?.call?.parentCallId === e.toolCallId), 'toolStarted');
      assert.deepEqual(child.data.approvalCoveredBy, { toolCallId: e.toolCallId, requestId: e.requestId }, 'child start names the covering request');
      assert.equal(one(es.filter(r => r.toolCallId === child.toolCallId), 'toolResult').data.status, 'completed');
      await reportRefused(await peer.api.post(resume(after, e.requestId), opts(after)));
      await outcome(peer, id, e, 'completed', 'allow', 'kit-owner');
    } finally { await fresh.close(); }
  }, { restart: true }),
  'waiting-decline': scenario(async (peer, id) => {
    const { e } = await initial(peer, id), presence = await peer.api.presence(id);
    try {
      const v = await delivered(peer.api, id, e); success(await peer.api.run(resume(v, e.requestId, true), opts(v)));
      await outcome(peer, id, e, 'refused', 'decline', 'kit-owner');
    } finally { await presence.close(); }
  }),
  'waiting-expiry': scenario(async (peer, id) => {
    const { e } = await initial(peer, id), presence = await peer.api.presence(id);
    try {
      const v = await delivered(peer.api, id, e);
      await peer.control('advance', { threadId: id, milliseconds: e.data.request.timeLimitMs });
      await reportRefused(await peer.api.post(resume(v, e.requestId), opts(v)));
      await checkWaiting(peer.api, id, 0, 0, 'none'); assert.deepEqual((await peer.api.view(id)).waiting.questions, []);
      await outcome(peer, id, e, 'notStarted', 'timeLimit');
    } finally { await presence.close(); }
  }),
  'waiting-routes': scenario(async (peer, id) => {
    const { e, snap } = await initial(peer, id);
    await reportRefused(await peer.api.post(resume(snap, e.requestId), opts(snap)));
    const submit = (api, v) => api.post(resume(v, e.requestId), opts(v));
    const owner = await peer.api.presence(id); let saved;
    try {
      await peer.api.list(); await reportRefused(await submit(peer.api, snap)); // listing, no GET since presence
      saved = await delivered(peer.api, id, e);
    } finally { await owner.close(); }
    await peer.control('barrier', { threadId: id, name: 'presenceLost' });
    const replacement = await peer.api.presence(id);
    try {
      await reportRefused(await submit(peer.api, saved));
      const fresh = await delivered(peer.api, id, e);
      await peer.control('approvalGate', { threadId: id, client: 'kit-primary', mode: 'redact' });
      await reportRefused(await submit(peer.api, fresh)); // recheck at POST even without an intervening GET
      const gated = await peer.api.view(id); assert.deepEqual(gated.waiting.questions, [], 'changed view not actionable');
      const watch = at(peer.origin, peer.tokens.watch), watcher = await watch.presence(id);
      try { const v = await watch.view(id); assert.deepEqual(v.waiting.questions, []); await reportRefused(await submit(watch, v)); }
      finally { await watcher.close(); }
      const sibling = at(peer.origin, peer.tokens.sibling), before = await sibling.view(id), other = await sibling.presence(id);
      try {
        await reportRefused(await submit(sibling, before));
        const v = await delivered(sibling, id, e);
        assert.equal((await state(peer, id)).counter, 0, 'invalid routes had no effect');
        success(await sibling.run(resume(v, e.requestId), opts(v))); await outcome(peer, id, e, 'completed', 'allow', 'kit-owner');
      } finally { await other.close(); }
    } finally { await replacement.close(); }
  }, { roles: ['watch', 'sibling'] }),
  'waiting-race': scenario(async (peer, id) => {
    const { e } = await initial(peer, id), presence = await peer.api.presence(id);
    const url = new URL('/', peer.origin); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let acp;
    try {
      acp = await acpPeer(url, peer.tokens.sibling);
      const h = await acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
      const actor = h._meta['modular-agent'].actor.id, cwd = (await state(peer, id)).project;
      await acp.request('session/resume', { sessionId: id, cwd, mcpServers: [] });
      const { requests: [q] } = await acp.request('_modular-agent/requests', { sessionId: id });
      assert.ok(q?.answerable && q.id === e.requestId); assert.deepEqual(q.call, bump);
      if (e.data.request.coversNested) assert.equal(q.coversNested, true, 'ACP offers the same coverage');
      const v = await delivered(peer.api, id, e), post = resume(v, q.id);
      const [reply, ack] = await Promise.all([peer.api.post(post, opts(v)), acp.request('_modular-agent/answer', { sessionId: id, requestId: q.id, value: 'refuse' })]);
      if (reply.status === 200) { success(await exchange(reply, post)); assert.deepEqual(ack, { accepted: false, reason: 'not_open' }); }
      else { await reportRefused(reply); assert.deepEqual(ack, { accepted: true }); }
      await peer.control('barrier', { threadId: id, name: 'continuationEnded' });
      assert.deepEqual((await peer.api.view(id)).waiting.questions, [], 'refresh after race');
      await outcome(peer, id, e, ack.accepted ? 'refused' : 'completed', ack.accepted ? 'decline' : 'allow', ack.accepted ? actor : 'kit-owner');
    } finally { await acp?.close(); await presence.close(); }
  }, { roles: ['sibling'] }),
};
for (const first of ['report', 'answer']) waiting[`waiting-mixed-${first}-first`] = scenario(async (peer, id) => {
  const owner = first === 'answer' ? await peer.api.presence(id) : undefined;
  const sibling = at(peer.origin, peer.tokens.sibling), presence = await sibling.presence(id);
  try {
    const { e, other, snap } = await initial(peer, id, { mixed: true, present: !!owner });
    const s = await delivered(sibling, id, e);
    const decide = async () => {
      const v = first === 'report' ? await delivered(sibling, id, e) : s;
      return sibling.run(resume(v, e.requestId), opts(v));
    };
    const report = async () => { const v = first === 'report' ? snap : await peer.api.view(id); return peer.api.run(input(v, [tool(other, rawReport)]), opts(v)); };
    const firstRun = first === 'report' ? report() : decide(); firstRun.catch(() => {});
    await peer.control('barrier', { threadId: id, name: first === 'report' ? 'reportCommitted' : 'answerCommitted' });
    const interim = await state(peer, id), es = interim.batches.flat();
    assert.equal(rows(es, 'turnStart').length, 1, 'first settlement cannot start a continuation');
    assert.equal(interim.counter, 0, 'no dispatch until both waits settle');
    assert.equal(rows(es, 'toolResult').filter(r => r.toolCallId === other).length, Number(first === 'report'));
    assert.equal(rows(es, 'inputAnswer').length, Number(first === 'answer'));
    for (const r of await Promise.all([firstRun, first === 'report' ? decide() : report()])) { success(r); assert.equal(r.pending.length, 0, 'no repeated frontend handoff'); }
    const final = await state(peer, id); assert.deepEqual(final.dispatches, [other], 'frontend released exactly once');
    const result = one(final.batches.flat().filter(x => x.toolCallId === other), 'toolResult'); assert.equal(result.data.status, 'completed');
    await outcome(peer, id, e, 'completed', 'allow', 'kit-owner', first === 'report' ? undefined : { kind: 'toolResult', id: result.id });
  } finally { await presence.close(); await owner?.close(); }
}, { mixed: true, roles: ['sibling'] });

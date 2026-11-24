import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acpPeer } from '../waiting/acp-peer.mjs';
import { frontend, handoff, options, opts, rawReport, reportRefused, simple, success } from './cases.mjs';
import { controls, hostRead, records } from './host-read.mjs';
import { at, deadline, input, refused, responseType, sse, threadPath, tool, user } from './wire.mjs';

const path = (id, cursor) => threadPath(id) + '/wait-closures' + (cursor === undefined ? '' : '?' + new URLSearchParams({ after: cursor }));
const scenario = (run, model = simple, roles = ['sibling']) => hostRead('waitCursor', model, run, { roles });
const question = (requestId, reason) => ({ requestId, reason });
const ask = async (control, kind = 'choice') => {
  const { requestId } = await control('openWait', { kind });
  assert.ok(typeof requestId === 'string' && requestId.length, 'fixture opened a recorded question');
  return requestId;
};

// Do not wait for a heartbeat. A server may send nothing until the first item.
async function follow(api, id, after, fn, options) {
  const stop = new AbortController();
  const stream = api.request(path(id, after), { signal: AbortSignal.any([deadline(), stop.signal]), headers: { Accept: 'text/event-stream' } }).then(response => {
    assert.equal(response.status, 200, 'wait feed status');
    responseType(response, 'text/event-stream');
    return sse(response, options);
  });
  stream.catch(() => {});
  const seen = new Set([after]);
  async function next(hidden = []) {
    const frames = await stream;
    for (;;) {
      const frame = await frames.next();
      if (frame.done) return;
      if (!frame.value.comment) return frame.value.data;
      for (const value of hidden) assert.ok(!frame.value.text.includes(value), 'wait heartbeat disclosed a hidden ID or reason');
    }
  }
  try {
    await fn({ next, async expect(expected, hidden) {
      const item = await next(hidden);
      const cursor = item?.cursor;
      for (const value of hidden ?? []) assert.ok(!cursor?.includes(value), 'wait cursor disclosed a hidden ID or reason');
      assert.deepEqual(item, { ...expected, cursor }, 'expected one status-only closure in commit order');
      assert.ok(typeof cursor === 'string' && cursor.length && !seen.has(cursor), 'cursor advances at each visible closure');
      seen.add(cursor);
      return cursor;
    } });
  } finally { stop.abort(); await stream.then(frames => frames.return(), () => {}); }
}

async function withAcp(peer, view, fn) {
  // ACP resumes a kept session, not the provisional thread from creation.
  success(await peer.api.run(input(view, [user('Keep this thread.')]), opts(view)));
  const id = view.threadId, control = controls(peer, id);
  const url = new URL('/', peer.origin); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const acp = await acpPeer(url, peer.tokens.sibling, { holdPermissions: true });
  try {
    await acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await acp.request('session/resume', { sessionId: id, cwd: (await control('inspect')).project, mcpServers: [] });
    const poll = async requestId => {
      const { requests } = await acp.request('_modular-agent/requests', { sessionId: id });
      assert.ok(requests.some(q => q.id === requestId && q.answerable), 'ACP can still answer this question');
    };
    const answer = async (requestId, decline = false) => {
      assert.deepEqual(await acp.request('_modular-agent/answer', { sessionId: id, requestId, ...(decline ? { declined: true } : { value: 'yes' }) }), { accepted: true }, 'ACP committed the decision');
    };
    await fn({ control, poll, answer, id });
  } finally { await acp.close(); }
}

export const closures = {
  'closure-order': scenario((peer, view) => withAcp(peer, view, async ({ control, poll, answer, id }) => {
    const first = await ask(control); await poll(first);
    const snap = await peer.api.view(id); // Last read before the ACP commit.
    await answer(first);
    let saved;
    await control('hold', { name: 'beforeWaitDelivery' });
    await follow(peer.api, id, snap.waitCursor, async feed => {
      await control('barrier', { name: 'waitFollowing' });
      const live = await ask(control); await poll(live); await answer(live, true);
      await control('release', { name: 'beforeWaitDelivery' }); // Live commit while catch-up is still buffered.
      await feed.expect(question(first, 'answered'));
      saved = await feed.expect(question(live, 'declined'));
    });
    const timed = await ask(control, 'deadline'); await control('advance', { milliseconds: 5000 });
    const expiry = records(await control('inspect'), 'inputAnswer').filter(e => e.data.requestId === timed);
    assert.ok(expiry.length === 1 && expiry[0].data.declined && !expiry[0].data.actorId && expiry[0].data.reason === 'timeLimit', 'expiry has a committed system timeLimit');
    await follow(peer.api, id, saved, async feed => {
      await feed.expect(question(timed, 'expired'));
      const restricted = await ask(control, 'revocable'); await poll(restricted);
      await control('revokeRight', { right: 'answer' });
      const decisions = records(await control('inspect'), 'inputAnswer').filter(e => e.data.requestId === restricted);
      assert.ok(decisions.length === 1 && decisions[0].data.cause === 'revoked' && decisions[0].data.declined && !decisions[0].data.actorId &&
        ['refused', 'noLongerAnswerable'].includes(decisions[0].data.reason), 'recorded revocation caused the system decision');
      await feed.expect(question(restricted, 'revoked'));
    });
  })),
  'closure-routes': scenario((peer, view) => withAcp(peer, view, async ({ control, poll, answer, id }) => {
    const presence = await peer.api.presence(id);
    try {
      const current = await peer.api.view(id);
      const run = await peer.api.run(input(current, [user('Ask before picking.')], options), opts(current));
      const [q] = run.terminal.outcome?.interrupts ?? [];
      assert.equal(q?.reason, 'approval', 'primary presence route actually received the approval');
      const requestId = q.id; await poll(requestId); // Now both routes have an unchanged view.
      const snap = await peer.api.view(id);
      await follow(peer.api, id, snap.waitCursor, async feed => {
        await control('barrier', { name: 'waitFollowing' });
        await presence.close(); await control('barrier', { name: 'presenceLost' });
        const current = await peer.api.view(id);
        const forged = input(current, [], { resume: [{ interruptId: requestId, status: 'resolved', payload: { allow: true } }] });
        await reportRefused(await peer.api.post(forged, opts(current)));
        await poll(requestId); await answer(requestId, true);
        await feed.expect(question(requestId, 'declined')); // No earlier closure on loss of one route.
        const fence = await ask(control); await poll(fence); await answer(fence);
        await feed.expect(question(fence, 'answered'));
      });
    } finally { await presence.close(); }
  }), [simple[0], ...frontend]),
  'closure-presence': scenario(async (peer, view) => {
    const control = controls(peer, view.threadId);
    await follow(peer.api, view.threadId, view.waitCursor, async () => {
      await control('barrier', { name: 'waitFollowing' });
      const run = await peer.api.run(input(view, [user('Ask before the call.')], options), opts(view));
      assert.ok(run.terminal.outcome?.type === 'success' && !run.pending.length, 'feed alone is not presence for a live approval');
      assert.deepEqual(records(await control('inspect'), 'toolResult').map(e => e.data.status), ['refused'], 'no eligible route: the gated call was refused');
    });
    // This time actually deliver an approval, then drop the last presence. Its
    // system refusal has no revocation cause. The feed cannot keep it alive.
    const id = (await peer.api.create()).threadId, ctl = controls(peer, id);
    const presence = await peer.api.presence(id);
    try {
      const v = await peer.api.view(id);
      const run = await peer.api.run(input(v, [user('Ask the present route.')], options), opts(v));
      const [q] = run.terminal.outcome?.interrupts ?? []; assert.equal(q?.reason, 'approval');
      const snap = await peer.api.view(id);
      await follow(peer.api, id, snap.waitCursor, async feed => {
        await ctl('barrier', { name: 'waitFollowing' });
        await presence.close(); await ctl('barrier', { name: 'presenceLost' });
        const decisions = records(await ctl('inspect'), 'inputAnswer').filter(e => e.data.requestId === q.id);
        assert.ok(decisions.length === 1 && decisions[0].data.reason === 'refused' && !Object.hasOwn(decisions[0].data, 'cause'), 'loss of last presence is a refusal, not a recorded revocation');
        await feed.expect(question(q.id, 'refused'));
      });
    } finally { await presence.close(); }
  }, frontend, []),
  'closure-left-open': scenario((peer, view) => withAcp(peer, view, async ({ control, poll, answer, id }) => {
    const q = await ask(control, 'leaveOpen');
    const snap = await peer.api.view(id);
    await follow(peer.api, id, snap.waitCursor, async feed => {
      await control('advance', { milliseconds: 5000 });
      const evidence = await control('inspect');
      const opening = records(evidence, 'inputRequest').find(e => e.data.request.id === q);
      assert.ok(opening?.data.request.whenTimeLimit === 'leaveOpen' && records(evidence, 'toolPending').some(e => e.data.requestIds.includes(q)), 'the leaveOpen wait actually reached pending');
      assert.ok(!records(evidence, 'inputAnswer').some(e => e.data.requestId === q), 'the timeout did not commit a decision');
      await poll(q); await answer(q);
      await feed.expect(question(q, 'answered')); // The deadline ended the synchronous wait, not the question.
      const fence = await ask(control); await poll(fence); await answer(fence, true);
      await feed.expect(question(fence, 'declined'));
    });
  })),
  'closure-interface': scenario(async (peer, view) => {
    const { id } = handoff(await peer.api.run(input(view, [user('Pick a color.')], options), opts(view)));
    const open = await peer.api.view(view.threadId), control = controls(peer, view.threadId);
    const sibling = at(peer.origin, peer.tokens.sibling), other = await sibling.view(view.threadId);
    await follow(peer.api, view.threadId, open.waitCursor, async feed => {
      success(await peer.api.run(input(open, [tool(id, rawReport)]), opts(open)));
      await feed.expect({ toolCallId: id, reason: 'settled', status: 'completed' });
      assert.deepEqual(records(await control('inspect'), 'toolResult').filter(e => e.toolCallId === id).map(e => e.data.status), ['completed'], 'settlement has one matching terminal result');
    });
    const visible = await ask(control, 'deadline'); await control('advance', { milliseconds: 5000 });
    await follow(sibling, view.threadId, other.waitCursor, feed => feed.expect(question(visible, 'expired'), [id, 'settled']));
  }, frontend),
  'closure-buffered': scenario(async (peer, initial) => {
    for (const mode of ['opening', 'decision', 'notice', 'watch']) {
      const view = mode === 'opening' ? initial : await peer.api.view((await peer.api.create()).threadId);
      await withAcp(peer, view, async ({ control, poll, answer, id }) => {
        let q = await ask(control); await poll(q);
        const snap = await peer.api.view(id);
        // Watch loss must close an established stream, not reject its handshake.
        if (mode === 'watch') await answer(q, true);
        else await control('hold', { name: 'beforeWaitDelivery' });
        const replay = mode === 'opening' || mode === 'notice';
        if (replay) await answer(q);
        await follow(peer.api, id, snap.waitCursor, async feed => {
          await control('barrier', { name: 'waitFollowing' });
          if (mode === 'watch') {
            await feed.expect(question(q, 'declined'));
            q = await ask(control); await poll(q); await control('hold', { name: 'beforeWaitDelivery' });
          }
          if (!replay) await answer(q);
          await control('barrier', { name: 'beforeWaitDelivery' });
          if (mode === 'watch') await control('revokeRight', { right: 'watch' });
          else await control('waitGate', { requestId: q, mode });
          await control('release', { name: 'beforeWaitDelivery' });
          const hidden = [q, 'answered'];
          if (mode === 'watch') assert.equal(await feed.next(hidden), undefined, 'loss of watch closes the feed with no final notice');
          else {
            const fence = await ask(control); await poll(fence); await answer(fence, true);
            await feed.expect(question(fence, 'declined'), hidden);
          }
        }, { allowReset: mode === 'watch' });
      });
    }
  }),
  'closure-cursor': scenario(async (peer, view) => {
    const { api } = peer, id = view.threadId;
    await refused(await api.request(path(id), { auth: null }), 401, 'unauthenticated');
    await refused(await api.request(path(id), { headers: { 'Last-Event-ID': view.waitCursor } }), 400, 'invalid_request');
    await refused(await api.request(path(id, randomUUID())), 409, 'cursor_expired');
    const sibling = at(peer.origin, peer.tokens.sibling);
    await sibling.view(id); // Same actor, active membership, independent client ID.
    await refused(await sibling.request(path(id, view.waitCursor)), 409, 'cursor_expired');
    await controls(peer, id)('expireWaitCursor', { cursor: view.waitCursor });
    await refused(await api.request(path(id, view.waitCursor)), 409, 'cursor_expired');
  }),
};

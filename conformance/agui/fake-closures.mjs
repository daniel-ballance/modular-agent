// Wire peer for the wait-feed checks. No SDK implementation uses these hooks.
import { randomUUID } from 'node:crypto';
import { fakeFixture } from './fake-fixture.mjs';

export function fakeClosures(name, fault, model) {
  const base = fakeFixture(name === 'closure-presence' ? 'approval' : 'report-cutoffs', undefined, model);
  const approval = fakeFixture('approval', undefined, model);
  function inbox(s) {
    return s.inbox ??= { items: [], cursors: new Map(), followers: new Set(), latches: new Map() };
  }
  function mark(s, client, index, item = false) {
    const cursor = randomUUID(); inbox(s).cursors.set(cursor, { client, index, item }); return cursor;
  }
  function latch(s, key) {
    const latches = inbox(s).latches;
    if (!latches.has(key)) latches.set(key, Promise.withResolvers());
    return latches.get(key);
  }
  function publish(s, item) {
    const box = inbox(s); box.items.push(item);
    for (const follower of box.followers) follower(item, box.items.length);
  }
  function decide(s, data, reason) {
    const requestId = s.waitQ; s.waitQ = undefined;
    if (s.question?.id === requestId) delete s.question;
    s.batches.push([{ kind: 'inputAnswer', id: randomUUID(), requestId, data }]);
    publish(s, { requestId, reason, ...(fault === 'answer-in-notice' && { value: 'yes' }) });
  }
  return {
    ...base,
    snapshot(s, client) { return { waitCursor: mark(s, client, inbox(s).items.length) }; },
    feed(s, client, url, res, error) {
      const box = inbox(s), after = url.searchParams.get('after'), cursor = box.cursors.get(after);
      if (after === null) return fault === 'missing-after' ? error(res, 409, 'cursor_expired') : error(res, 400, 'invalid_request');
      if (!cursor || cursor.client !== client) return error(res, 409,
        (fault === 'stale-wait-cursor' && after === box.expired || fault === 'foreign-wait-cursor' && cursor) ? 'conflict' : 'cursor_expired');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }); res.flushHeaders();
      let queue = Promise.resolve();
      const enqueue = (item, index) => { queue = queue.then(async () => {
        if (box.hold) {
          latch(s, 'beforeWaitDelivery').resolve(); await box.hold.promise;
        }
        if (res.destroyed || res.writableEnded || item.toolCallId && client !== 'owner' && fault !== 'other-executor-notice') return;
        if (box.noWatch) {
          if (fault === 'comment-disclosure') res.write(`: ${item.requestId} ${item.reason}\n\n`);
          if (fault === 'reset-on-watch-loss') return res.destroy();
          if (fault !== 'skip-watch-recheck') return res.end();
        }
        if (box.policy && box.policy.requestId === item.requestId && ({ opening: 'skip-source-gate', decision: 'skip-decision-gate', notice: 'changed-notice' })[box.policy.mode] !== fault) return;
        const data = { cursor: mark(s, client, index, true), ...item };
        if (fault === 'cursor-disclosure' && box.policy) data.cursor += ':' + box.policy.requestId;
        res.write(`data: ${JSON.stringify(data)}\n${fault === 'wait-bad-framing' ? 'id: forbidden\n' : ''}\n`);
        if (box.noWatch) res.end();
      }); };
      box.followers.add(enqueue); res.once('close', () => box.followers.delete(enqueue));
      const from = cursor.index - Number(cursor.item && fault === 'repeat-after');
      for (let i = from; i < box.items.length && fault !== 'miss-catchup'; ++i) enqueue(box.items[i], i + 1);
      if (fault === 'repeat-cutover' && box.items.length > from) enqueue(box.items.at(-1), box.items.length);
      latch(s, 'waitFollowing').resolve();
    },
    async run(args) {
      const { s, client, suffix, resume } = args;
      if (s.waitQ && resume.length) {
        if (fault !== 'feed-can-answer') return [409, 'conflict'];
        decide(s, { actorId: 'kit-owner', value: 'allow' }, 'answered'); args.emit(); args.finish({ type: 'success' }); return;
      }
      if (fault === 'feed-is-presence' && inbox(s).followers.size) s.presence.add(client);
      if (name === 'closure-routes' && args.offered) {
        const result = await approval.run(args); s.waitQ = s.question?.id; return result;
      }
      const call = s.open, result = await base.run(args);
      if (call && suffix[0]?.role === 'tool' && !result) {
        if (fault === 'settlement-without-result') s.batches = s.batches.filter(batch => !batch.some(e => e.kind === 'toolResult'));
        publish(s, { toolCallId: call, reason: 'settled', status: fault === 'wrong-settlement' ? 'failed' : 'completed' });
      }
      return result;
    },
    disconnect(s, client) {
      if (name === 'closure-routes' && s.waitQ) {
        if (fault === 'route-is-closure') publish(s, { requestId: s.waitQ, reason: 'revoked' });
      } else {
        const q = s.question?.id;
        base.disconnect(s, client);
        if (q && !s.question) {
          if (fault === 'mark-loss-revoked') s.batches.flat().find(e => e.kind === 'inputAnswer' && e.requestId === q).data.cause = 'revoked';
          publish(s, { requestId: q, reason: fault === 'guess-revocation' ? 'revoked' : 'refused' });
        }
      }
      latch(s, 'presenceLost').resolve();
    },
    acp(ws, client, { method, params }, sessions) {
      if (method === 'initialize') return { protocolVersion: 1 };
      if (method === 'session/resume') { ws.sid = params.sessionId; return {}; }
      const s = sessions.get(ws.sid);
      if (!s || params.sessionId !== ws.sid) return;
      if (method === '_modular-agent/requests') return { requests: s.waitQ ? [{ id: s.waitQ, answerable: true }] : [] };
      if (method === '_modular-agent/answer' && params.requestId === s.waitQ) {
        decide(s, { actorId: 'kit-owner', ...(params.declined ? { declined: true } : { value: params.value }) }, params.declined ? 'declined' : 'answered');
        return { accepted: true };
      }
      return { accepted: false, reason: 'not_open' };
    },
    async control(operation, s, args) {
      const box = inbox(s);
      switch (operation) {
        case 'inspect': return { ...await base.control(operation, s, args), project: '/fixture' };
        case 'openWait':
          s.waitKind = args.kind; s.waitQ = randomUUID();
          s.batches.push([{ kind: 'inputRequest', id: randomUUID(), requestId: s.waitQ, data: { request: { id: s.waitQ, askedBy: 'fixture', whenTimeLimit: args.kind === 'leaveOpen' ? 'leaveOpen' : 'decline' } } }]);
          return { requestId: s.waitQ };
        case 'advance':
          if (s.waitKind === 'leaveOpen') {
            if (fault !== 'no-pending-wait') s.batches.push([{ kind: 'toolPending', id: randomUUID(), data: { requestIds: [s.waitQ] } }]);
            if (fault === 'timeout-is-closure') publish(s, { requestId: s.waitQ, reason: 'expired' });
          } else decide(s, { declined: true, reason: fault === 'invent-expiry' ? 'cancelled' : 'timeLimit' }, fault === 'deadline-is-decline' ? 'declined' : 'expired');
          break;
        case 'revokeRight':
          if (args.right === 'watch') box.noWatch = true;
          else decide(s, { declined: true, reason: 'noLongerAnswerable', ...(fault !== 'unrecorded-revocation' && { cause: 'revoked' }) }, fault === 'lose-revocation' ? 'refused' : 'revoked');
          break;
        case 'waitGate': box.policy = args; break;
        case 'hold': box.hold = Promise.withResolvers(); break;
        case 'release': box.hold.resolve(); delete box.hold; break;
        case 'expireWaitCursor': box.cursors.delete(args.cursor); box.expired = args.cursor; break;
        case 'barrier': await latch(s, args.name).promise; break;
        default: throw new Error('unknown wait fixture operation');
      }
      return {};
    },
  };
}

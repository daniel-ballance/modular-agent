// Test double for the kit. The wire, records and counter can each be wrong
// independently; never use this peer as evidence for a real Harness.
import { randomUUID as id } from 'node:crypto';
import { dispatch, offer } from './cases.mjs';

export function fakeWaiting(name, fault, model, covers) {
  const mixed = name.startsWith('waiting-mixed-');
  const call = model[0].toolCalls[0];
  function append(s, kind, data, scope = {}) {
    const e = { id: id(), time: s.now, kind, data, ...scope }; s.batches.push([e]); return e;
  }
  function signal(s, key) { s.barriers.set(key, true); s.waiters.get(key)?.(); s.waiters.delete(key); }
  function barrier(s, key) {
    if (!s.barriers.has(key)) return new Promise(resolve => s.waiters.set(key, resolve));
  }
  function visible(s, client) { return !!s.question && (client !== 'watch' || fault === 'wait-watch') && (!s.redacted || client !== 'owner' || fault === 'wait-gate'); }
  function questions(s, client) {
    if (!visible(s, client) || !s.presence.has(client) && fault !== 'wait-no-presence') return [];
    s.delivered.add(client);
    return [{ ...s.question, ...(fault === 'wait-name' && { message: 'Allow a tool?' }), ...(fault === 'wait-id' && { toolCallId: 'replacement' }),
      ...(fault === 'wait-args' && { message: s.question.message.replace('false', 'true') }),
      ...(fault === 'wait-expiry-view' && { expiresAt: new Date(s.now + 90000).toISOString() }) }];
  }
  function init(s, prompt) {
    s.delivered = new Set(); s.counter = 0;
    s.scope = { turnId: id(), stepId: id(), toolCallId: id() }; s.qid = id();
    const { turnId, stepId, toolCallId } = s.scope;
    s.messages.push({ role: 'user', id: 'ma:user:' + id(), content: prompt.content }, { role: 'assistant', id: 'ma:assistant:' + stepId, content: '' });
    append(s, 'inputAccepted', {}); append(s, 'turnStart', {}, { turnId }); append(s, 'input', {}, { turnId });
    const response = append(s, 'response', {}, { turnId, stepId });
    if (name === 'waiting-live' && fault !== 'wait-live-opt-in') { append(s, 'toolResult', { status: 'refused' }, s.scope); }
    else {
      const deadlineAt = s.now + 5000, question = `Allow ${call.name} with ${JSON.stringify(call.input)}?`;
      s.question = { id: s.qid, reason: 'approval', message: question, toolCallId,
        ...(covers && fault !== 'missing-waiting-coverage' && { metadata: { 'modular-agent.coversNested': true } }), expiresAt: new Date(deadlineAt).toISOString() };
      s.entry = append(s, 'inputRequest', { request: { id: s.qid, toolCallId, question, deadlineAt, timeLimitMs: 5000,
        ...(covers && { coversNested: true }), whenTimeLimit: 'decline', kind: 'approval', approvalWait: 'untilDeadline', answerable: false }, call: { ...call, id: toolCallId },
        source: { plugin: 'counter', toolSource: 'counter' }, definition: { name: call.name } }, { ...s.scope, requestId: s.qid, sources: [response.id] });
      const pending = append(s, 'toolPending', { requestIds: [s.qid] }, s.scope);
      if (fault !== 'wait-split-batch') { s.batches.pop(); s.batches.at(-1).push(pending); }
      if (fault === 'wait-early-start') append(s, 'toolStarted', {}, s.scope);
      if (fault === 'wait-early-effect') s.counter++;
    }
    if (mixed) {
      s.open = id(); s.front = s.open; s.expiresAt = new Date(s.now + 60000).toISOString();
      const start = append(s, 'toolStarted', {}, { turnId, stepId, toolCallId: s.front });
      s.batches.at(-1).push({ id: id(), kind: 'modular-agent.interfaceHandoff', turnId, stepId, toolCallId: s.front, data: { toolStartedId: start.id } });
      s.dispatches.push(s.front);
    }
    const openToolCalls = [...(s.question ? [toolCallId] : []), ...(s.front ? [s.front] : [])];
    append(s, 'turnEnd', { outcome: { kind: 'completed' }, result: { openToolCalls } }, { turnId });
  }
  function decide(s, allow, client, system) {
    const actorId = client === 'foreign' ? 'kit-foreign' : 'kit-owner', value = allow ? { value: 'allow', actorId,
      approvalView: { requestEntryId: s.entry.id, submittedBy: actorId, routeId: client, rights: ['approve', 'watch'] } } :
      { declined: true, ...(system ? { reason: 'timeLimit' } : { actorId }) };
    s.answer = append(s, 'inputAnswer', { requestId: s.qid, ...value }, { ...s.scope, requestId: s.qid, sources: [s.entry.id] });
    s.status = allow ? 'completed' : system && fault !== 'wait-expiry-refused' ? 'notStarted' : fault === 'wait-decline-runs' ? 'completed' : 'refused';
    s.question = undefined; s.cause = { kind: 'answer', id: s.qid }; signal(s, 'answerCommitted');
  }
  function advance(s) {
    if (s.ended || ((!s.answer || s.open) && fault !== 'wait-early-ready')) return;
    const turnId = id(), cause = s.cause;
    append(s, 'turnStart', { startedBy: cause }, { turnId, continuesTurnId: fault === 'wait-unlinked' ? 'new-input' : s.scope.turnId });
    if (fault === 'wait-new-input') append(s, 'inputAccepted', {});
    if (s.answer) {
      const scope = { ...s.scope, turnId, sources: [s.entry.id, s.answer.id] };
      if (s.status === 'completed') { s.counter++; append(s, 'toolStarted', {}, scope); }
      if (s.status === 'completed' && covers && name === 'waiting-restart') {
        const child = { ...scope, toolCallId: id() };
        append(s, 'toolStarted', { call: { id: child.toolCallId, name: 'increment', parentCallId: scope.toolCallId },
          approvalCoveredBy: { toolCallId: scope.toolCallId, requestId: fault === 'wrong-covering-request' ? 'other' : s.qid } }, child);
        append(s, 'toolResult', { status: 'completed' }, child);
      }
      append(s, 'toolResult', { status: s.status }, scope);
    }
    if (fault === 'wait-rehandoff' && s.front) s.dispatches.push(s.front);
    s.messages.push({ role: 'assistant', id: 'ma:assistant:' + id(), content: 'Done.' });
    append(s, 'turnEnd', { outcome: { kind: 'completed' }, result: { openToolCalls: [] } }, { turnId });
    s.ended = true; signal(s, 'continuationEnded'); s.follow?.();
  }
  function triad(push, callId, name, args) {
    push('TOOL_CALL_START', { toolCallId: callId, toolCallName: name }); push('TOOL_CALL_ARGS', { toolCallId: callId, delta: JSON.stringify(args) }); push('TOOL_CALL_END', { toolCallId: callId });
  }
  return {
    questions, reopen() {}, waiting(s, client) {
      if (fault === 'wait-list-grants' && s.presence.has(client)) s.delivered?.add(client);
      return { questions: Number(visible(s, client) && (fault !== 'wait-list-needs-presence' || s.presence.has(client))),
        toolCalls: Number(!!s.open && client === 'owner') + Number(!!s.question && fault === 'wait-list-tool'), turn: s.question && fault === 'wait-list-running' ? 'running' : 'none' };
    },
    disconnect(s, client) {
      if (!['wait-keep-delivery', 'wait-restore-delivery'].includes(fault)) s.delivered?.delete(client);
      if (fault === 'wait-close-on-loss' && s.question) decide(s, false, client);
      signal(s, 'presenceLost');
    },
    async restart(sessions) { for (const s of sessions.values()) { s.presence.clear(); if (fault !== 'wait-restore-delivery') s.delivered?.clear(); s.views.clear(); } },
    async control(op, s, args) {
      if (op === 'inspect') return { batches: s.batches, counter: s.counter ?? 0, dispatches: s.dispatches, project: '/fixture' };
      if (op === 'barrier') await barrier(s, args.name);
      else if (op === 'approvalGate') s.redacted = true;
      else if (op === 'advance') {
        s.now += args.milliseconds;
        if (s.question && s.now >= Date.parse(s.question.expiresAt) && fault !== 'wait-late-answer') { decide(s, false, '', true); advance(s); }
      } else throw new Error('unknown waiting-fixture control');
      return {};
    },
    acp(route, client, msg, sessions) {
      if (msg.method === 'initialize') return { protocolVersion: 1, _meta: { 'modular-agent': { actor: { id: client === 'foreign' ? 'kit-foreign' : 'kit-owner' } } } };
      const s = sessions.get(msg.params.sessionId);
      if (msg.method === 'session/resume') { route.sid = msg.params.sessionId; return {}; }
      if (route.sid !== msg.params.sessionId || !s) throw new Error('session not attached');
      if (msg.method === '_modular-agent/requests') {
        route.seen = s.question?.id;
        return { requests: s.question ? [{ id: s.qid, answerable: true, call, ...(covers && { coversNested: true }) }] : [] };
      }
      if (msg.method === '_modular-agent/answer' && route.seen === msg.params.requestId) {
        if (s.question) { decide(s, false, client); advance(s); return { accepted: true }; }
        if (fault === 'wait-double-race') return { accepted: true };
      }
      return { accepted: false, reason: 'not_open' };
    },
    async run({ s, client, suffix, resume, push, emit, finish, response }) {
      if (suffix[0]?.role === 'user') {
        if (s.scope) return [409, 'conflict'];
        init(s, suffix[0]);
        if (s.front) triad(push, s.front, offer.name, dispatch);
        if (fault === 'wait-triad' || fault === 'wait-result') {
          triad(push, s.scope.toolCallId, call.name, call.input);
          if (fault === 'wait-result') push('TOOL_CALL_RESULT', { messageId: 'ma:tool:' + id(), toolCallId: s.scope.toolCallId, content: '0', role: 'tool' });
        }
        const qs = s.presence.has(client) ? questions(s, client) : fault === 'wait-offline-interrupt' ? [s.question] : [];
        const ids = [...(s.front ? [s.front] : []), ...(['wait-triad', 'wait-pending-id'].includes(fault) ? [s.scope.toolCallId] : [])];
        emit(); finish(qs.length ? { type: 'interrupt', interrupts: qs } : { type: 'success', ...(ids.length && { pendingToolCallIds: ids }) }); return;
      }
      if (resume.length) {
        const match = resume.find(r => r.interruptId === s.qid);
        if (name === 'waiting-race' && !s.question && fault === 'wait-double-race') { emit(); finish({ type: 'success' }); return; }
        const stolen = fault === 'wait-sibling-delivery' && client === 'sibling';
        if (!s.question || (!match && fault !== 'wait-ignore-coverage') || !visible(s, client) ||
          (!s.presence.has(client) || (!s.delivered.has(client) && !stolen)) && fault !== 'wait-accept-without-presence') return [409, 'conflict'];
        decide(s, match?.status !== 'cancelled', client);
      } else if (suffix.length === 1 && suffix[0].role === 'tool' && s.open && suffix[0].toolCallId === s.open && client === 'owner') {
        const result = append(s, 'toolResult', { status: 'completed' }, { ...s.scope, toolCallId: s.open }); s.open = undefined;
        s.cause = { kind: 'toolResult', id: result.id }; signal(s, 'reportCommitted');
        s.messages.push({ id: 'ma:tool:' + s.front, role: 'tool', toolCallId: s.front, content: 'Checked frontend result.' });
      } else return [409, 'conflict'];
      advance(s);
      if (!s.ended) await new Promise(resolve => { s.follow = resolve; response.once('close', resolve); });
      if (response.destroyed) return [-1];
      emit(); finish({ type: 'success' });
    },
  };
}

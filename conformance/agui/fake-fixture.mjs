import { randomUUID } from 'node:crypto';
import { dispatch, offer, rawReport, second, transformed } from './cases.mjs';
import { foreignEvent, hidden, redacted } from './advanced.mjs';

const turnId = () => 'turn-' + randomUUID();
export const makeSession = () => ({
  batches: [], dispatches: [], model: [], warnings: [], spans: [], erasure: { outOfReach: [] }, now: 1_800_000_000_000,
  barriers: new Map(), waiters: new Map(), releases: new Map(),
});

export function fakeFixture(name, fault, script, covers) {
  const record = (s, kind, data = {}, identifiers = {}) => {
    const e = { kind, id: randomUUID(), data, ...identifiers };
    s.batches.push([e]);
    return e;
  };
  function signal(s, key) {
    s.barriers.set(key, true);
    for (const resolve of s.waiters.get(key) ?? []) resolve();
    s.waiters.delete(key);
  }
  function barrier(s, key) {
    if (s.barriers.has(key)) return;
    return new Promise(resolve => {
      if (!s.waiters.has(key)) s.waiters.set(key, []);
      s.waiters.get(key).push(resolve);
    });
  }
  function hold(s, key, response) {
    return new Promise(resolve => {
      s.releases.set(key, () => resolve(true));
      response.once('close', () => resolve(false));
      signal(s, key);
    });
  }
  function span(s, name, context, attributes = {}, links = []) {
    const e = { name, ...context, spanId: randomUUID().replaceAll('-', '').slice(0, 16), attributes, links: links.map(({ spanId, traceId }) => ({ spanId, traceId })) };
    s.spans.push(e);
    return e;
  }
  const context = (headers, client) => {
    const valid = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/.exec(headers.traceparent ?? '');
    if (valid && (client === 'owner' || fault === 'untrusted-trace')) return { traceId: valid[1], parentSpanId: valid[2] };
    return { traceId: randomUUID().replaceAll('-', '') };
  };
  const addModel = (s, offered) => s.model.push({ tools: offered ? [offer.name] : [], messages: s.messages.map(m => ({
    role: m.role === 'tool' ? 'toolResult' : m.role, text: m.content, ...(m.role === 'tool' ? { name: offer.name } : {}),
  })) });
  const turnEnd = (s, turnId, openToolCalls = []) => record(s, 'turnEnd', { result: { openToolCalls } }, { turnId });
  function begin(s, requestData, headers, client) {
    s.originTurn = turnId();
    s.context = context(headers, client);
    s.originSpan = span(s, 'invoke_agent', s.context, { 'modular_agent.turn.id': s.originTurn });
    if (requestData.context?.length) s.warnings.push('context');
    if (requestData.protocolVersion !== '1.0') s.warnings.push('protocolVersion');
    const prompt = requestData.messages.at(-1);
    record(s, 'inputAccepted', { key: 'agui:' + requestData.runId });
    record(s, 'turnStart', {}, { turnId: s.originTurn });
    record(s, 'input', { text: prompt.content }, { turnId: s.originTurn });
    s.messages.push({ id: `ma:user:${randomUUID()}`, role: 'user', content: prompt.content });
  }
  function stage(s, call, stepId) {
    s.call = call;
    s.stepId = stepId;
    const keys = { turnId: s.originTurn, stepId, toolCallId: call };
    const start = record(s, 'toolStarted', { safeToRepeat: false, openWorld: true, call: { id: call, input: dispatch } }, keys);
    const checkpoint = { kind: 'modular-agent.interfaceHandoff', id: randomUUID(), ...keys,
      data: { toolStartedId: start.id, executorActorId: 'kit-owner', routeId: 'kit-primary', rights: ['watch', 'tools'], deadline: s.now + 60_000 } };
    if (fault !== 'missing-checkpoint') s.batches.at(-1).push(checkpoint);
    s.start = start;
    s.checkpoint = checkpoint;
    s.execution = span(s, `execute_tool ${offer.name}`, s.context, { 'modular_agent.tool.call.id': call, 'modular_agent.tool.status': 'pending' });
    s.expiresAt = new Date(checkpoint.data.deadline).toISOString();
  }
  function releaseCall(s, push) {
    const toolCallId = s.open = s.call;
    s.dispatches.push(toolCallId);
    push('TOOL_CALL_START', { toolCallId, toolCallName: offer.name, parentMessageId: s.messages.at(-1)?.id });
    push('TOOL_CALL_ARGS', { toolCallId, delta: JSON.stringify(dispatch) });
    push('TOOL_CALL_END', { toolCallId });
  }
  function settle(s, status, report, operationContext = {}) {
    const result = record(s, 'toolResult', { status }, { turnId: s.originTurn, stepId: s.stepId, toolCallId: s.call,
      ...(report ? { actorId: 'kit-owner' } : {}), sources: [s.start.id, s.checkpoint.id] });
    span(s, 'modular_agent.tool.settle', operationContext, { 'modular_agent.tool.call.id': s.call, 'modular_agent.tool.status': status }, [s.execution]);
    s.messages.push({ id: `ma:tool:${s.call}`, role: 'tool', toolCallId: s.call, content: report ? transformed : 'Tool may have run.', ...(status === 'completed' ? {} : { error: 'Tool may have run.' }) });
    s.open = undefined;
    s.views.clear();
    s.result = result;
    return result;
  }
  function startContinuation(s, operationContext) {
    s.nextTurn = turnId();
    s.nextContext = operationContext;
    record(s, 'turnStart', { startedBy: { kind: 'toolResult', id: s.result.id } }, { turnId: s.nextTurn, continuesTurnId: s.originTurn });
  }
  function completeContinuation(s, push, recovered = false) {
    const ctx = recovered && fault === 'lost-recovery-trace' ? context({}, 'owner') : s.nextContext;
    span(s, 'invoke_agent', ctx, { 'modular_agent.turn.id': s.nextTurn, ...(recovered ? { 'modular_agent.turn.resumed': true } : {}) }, [s.originSpan]);
    step(s, push, second, { keep: true });
    turnEnd(s, s.nextTurn);
  }
  function step(s, push, text, { keep = false, stored = text, reasoning = false, offered = false } = {}) {
    addModel(s, offered);
    const stepName = randomUUID();
    const messageId = `ma:assistant:${stepName}`;
    push('STEP_STARTED', { stepName });
    record(s, 'response', {}, { stepId: stepName, message: { role: 'assistant', content: [{ type: 'text', text: stored }], stop: 'finished' } });
    if (reasoning) {
      const id = { messageId: 'ma:reasoning:' + stepName };
      push('REASONING_START', id);
      push('REASONING_MESSAGE_START', { ...id, role: 'reasoning' });
      push('REASONING_MESSAGE_CONTENT', { ...id, delta: 'readable reasoning' });
      push('REASONING_MESSAGE_END', id);
      push('REASONING_END', id);
    }
    if (text) {
      push('TEXT_MESSAGE_START', { messageId, role: 'assistant' });
      push('TEXT_MESSAGE_CONTENT', { messageId, delta: text });
      push('TEXT_MESSAGE_END', { messageId });
    }
    if (keep) s.messages.push({ id: messageId, role: 'assistant', content: text });
    push('STEP_FINISHED', { stepName });
    return stepName;
  }
  function question(s, reason, toolCallId) {
    s.question = { id: randomUUID(), reason, message: reason === 'approval' ? `Allow ${offer.name} with ${JSON.stringify(dispatch)}?` : 'Choose yes or no.',
      expiresAt: new Date(s.now + 5000).toISOString(), ...(toolCallId ? { toolCallId } : {}),
      ...(reason === 'approval' && { metadata: {
        ...(covers && fault !== 'missing-live-coverage' && { 'modular-agent.coversNested': true }),
        ...(fault !== 'omit-approval-call' && { 'modular-agent.approvalCall': { name: offer.name, input: dispatch } }),
      } }),
      responseSchema: reason === 'approval' ? { type: 'object', properties: { allow: { type: 'boolean' } }, required: ['allow'] } : { type: 'string', enum: ['yes', 'no'] } };
    record(s, 'inputRequest', { request: { id: s.question.id, ...(covers && reason === 'approval' && { coversNested: true }) } }, { requestId: s.question.id, turnId: s.originTurn });
    return s.question;
  }
  function closeQuestion(s, { reason, declined, value, system = false }) {
    if (!s.question) return;
    record(s, 'inputAnswer', { requestId: s.question.id, ...(declined ? { declined } : { value }), ...(reason ? { reason } : {}) }, { turnId: s.originTurn, ...(system ? {} : { actorId: 'kit-owner' }) });
    if (s.question.reason === 'approval' && declined) record(s, 'toolResult', { status: 'refused' }, { toolCallId: s.question.toolCallId, turnId: s.originTurn });
    s.question = undefined;
  }
  const sendEnd = (s, emit, push, finish, outcome = { type: 'success' }) => { emit(); finish(outcome); };
  function safeError(push) { push('RUN_ERROR', { code: 'output_withheld', message: 'Output withheld.' }); }

  function eligible(s, client) {
    return s.question && client === 'owner' && s.presence.has(client);
  }
  const toolScenario = ['report-cutoffs', 'release-gate', 'trace'].includes(name) || name?.startsWith('crash-');

  async function run({ s, suffix, resume, data, offered, headers, client, push, emit, finish, response }) {
    if (s.revoked && suffix[0]?.role === 'tool') return [403, 'refused'];
    if (!suffix.length && resume.length) {
      if (!eligible(s, client)) return [409, 'conflict'];
      const decisions = resume.filter(r => r.interruptId === s.question.id);
      if (decisions.length !== 1) return [409, 'conflict'];
      const [{ status, payload: value }] = decisions;
      const approval = s.question.reason === 'approval';
      if (!['resolved', 'cancelled'].includes(status) || (status === 'resolved' && (approval ? typeof value?.allow !== 'boolean' : !['yes', 'no'].includes(value)))) return [400, 'invalid_request'];
      const id = s.question.toolCallId;
      const declined = status === 'cancelled' || (approval && !value.allow);
      closeQuestion(s, { declined, value: approval && !declined ? 'allow' : value });
      emit();
      if (approval && !declined) stage(s, id, s.stepId);
      if (s.call) {
        turnEnd(s, s.originTurn, [s.call]);
        releaseCall(s, push);
        return sendEnd(s, emit, push, finish, { type: 'success', pendingToolCallIds: [s.call] });
      }
      step(s, push, script[0].text, { keep: true });
      turnEnd(s, s.originTurn);
      return sendEnd(s, emit, push, finish);
    }
    if (suffix[0]?.role === 'tool') {
      if (client !== 'owner' || !s.open || suffix.length !== 1 || suffix[0].toolCallId !== s.open) return [409, 'conflict'];
      const ctx = context(headers, client);
      settle(s, 'completed', true, ctx);
      emit();
      if (name === 'crash-after-result' && !s.restarted && !await hold(s, 'afterResult', response)) return [-1];
      startContinuation(s, ctx);
      if (name === 'crash-continuation' && !s.restarted && !await hold(s, 'duringContinuation', response)) return [-1];
      completeContinuation(s, push);
      return sendEnd(s, emit, push, finish);
    }
    if (suffix.length !== 1 || suffix[0]?.role !== 'user' || resume.length) return [400, 'invalid_request'];
    begin(s, data, headers, client);
    emit();
    if (name === 'questions') {
      const q = question(s, 'choice');
      return sendEnd(s, emit, push, finish, { type: 'interrupt', interrupts: [q] });
    }
    if (name?.startsWith('approval')) {
      s.stepId = step(s, push, '', { offered: true, keep: true });
      const id = randomUUID();
      if ((!s.presence.has(client) && fault !== 'approval-without-presence') || name === 'approval-redacted') {
        record(s, 'toolResult', { status: 'refused' }, { toolCallId: id, turnId: s.originTurn });
        if (fault === 'approval-without-presence') throw new Error('unreachable');
        turnEnd(s, s.originTurn);
        return sendEnd(s, emit, push, finish);
      }
      const q = structuredClone(question(s, 'approval', id));
      if (fault === 'model-history-call') q.metadata['modular-agent.approvalCall'] = script[0].toolCalls[0];
      if (fault === 'wrong-snapshot-call') {
        delete q.metadata['modular-agent.approvalCall'];
        s.question.metadata['modular-agent.approvalCall'].name = 'other';
      }
      return sendEnd(s, emit, push, finish, { type: 'interrupt', interrupts: [q] });
    }
    if (name === 'error-gate') {
      push('RUN_ERROR', { code: 'output_withheld', message: fault === 'leak-error' ? script[0].error.message : 'Output withheld.' });
      return;
    }
    if (name === 'state-and-gate') {
      const snapshot = counter => push('STATE_SNAPSHOT', { snapshot: { counter } });
      const delta = value => push('STATE_DELTA', { delta: [{ op: 'replace', path: '/counter', value }] });
      snapshot(0); delta(1);
      if (fault === 'stale-state-base') delta(2);
      snapshot(4); delta(5);
      push('CUSTOM', { name: 'modular-agent.event', value: { type: 'kit.visible', data: { value: 'gated' } } });
      push('CUSTOM', { name: 'modular-agent.entry', value: { kind: 'kit.entry', data: 'visible' } });
      push('RAW', { source: 'kit', event: { type: foreignEvent } });
      step(s, push, fault === 'leak-gate' ? hidden : redacted, { stored: hidden, keep: true, reasoning: true });
      turnEnd(s, s.originTurn);
      return sendEnd(s, emit, push, finish);
    }
    if (!offered || (!toolScenario && name !== 'mixed')) {
      step(s, push, script[0].text ?? 'No tool offered.', { keep: true });
      turnEnd(s, s.originTurn);
      return sendEnd(s, emit, push, finish);
    }
    const stepId = step(s, push, '', { offered, keep: true });
    if (name === 'crash-before-handoff' && !s.restarted && !await hold(s, 'beforeHandoff', response)) return [-1];
    stage(s, randomUUID(), stepId);
    if (name === 'mixed') {
      if (fault === 'staged-executable') releaseCall(s, push);
      return sendEnd(s, emit, push, finish, { type: 'interrupt', interrupts: [question(s, 'choice')] });
    }
    turnEnd(s, s.originTurn, [s.call]);
    if (name === 'release-gate') {
      if (!await hold(s, 'beforeRelease', response)) return [-1];
      if (s.revoked && fault !== 'skip-final-authority') { safeError(push); return; }
    }
    releaseCall(s, push);
    return sendEnd(s, emit, push, finish, { type: 'success', pendingToolCallIds: [s.call] });
  }

  return {
    run, eligible,
    waiting(s, client) {
      const records = s.batches.flat(), start = records.findLast(e => e.kind === 'turnStart');
      const unfinished = start && !records.some(e => e.kind === 'turnEnd' && e.turnId === start.turnId);
      return { questions:Number(!!(eligible(s, client) || fault === 'list-foreign-question' && s.question)),
        toolCalls:Number(!!s.checkpoint && !s.result && client === 'owner'),
        turn:unfinished && fault !== 'list-idle' ? s.needsReopen ? 'interrupted' : 'running' : 'none' };
    },
    disconnect(s, client) {
      if (client !== 'owner') return;
      if (fault !== 'keep-presence' && s.question?.reason === 'approval') closeQuestion(s, { reason: 'refused', declined: true, system: true });
      signal(s, 'presenceLost');
    },
    async restart(sessions) {
      for (const s of sessions.values()) {
        s.restarted = true;
        s.views.clear();
        s.needsReopen = true;
      }
    },
    reopen(s) {
        if (!s.needsReopen) return;
        s.needsReopen = false;
        if (name === 'crash-before-handoff' && s.originTurn && !s.call) {
          record(s, 'toolResult', { status: 'notStarted' }, { turnId: s.originTurn });
          turnEnd(s, s.originTurn);
        } else if (name === 'crash-after-handoff' && fault === 'extend-deadline') s.expiresAt = new Date(Date.parse(s.expiresAt) + 10_000).toISOString();
        else if (s.result && !s.batches.flat().some(r => r.kind === 'turnEnd' && r.turnId === s.nextTurn)) {
          if (!s.nextTurn) startContinuation(s, s.context);
          completeContinuation(s, () => {}, name === 'crash-continuation');
        }
    },
    async control(operation, s, args) {
      switch (operation) {
        case 'inspect': return { batches: s.batches, dispatches: s.dispatches, model: s.model, warnings: s.warnings, spans: s.spans, erasure: s.erasure };
        case 'barrier': await barrier(s, args.name); break;
        case 'release': s.releases.get('beforeRelease')?.(); break;
        case 'revoke': s.revoked = true; break;
        case 'advance': {
          s.now += args.milliseconds;
          if (s.question && Date.parse(s.question.expiresAt) <= s.now) closeQuestion(s, { declined: true, reason: 'timeLimit', system: true });
          if (s.open && Date.parse(s.expiresAt) <= s.now && fault !== 'lost-expiry') {
            settle(s, 'outcomeUnknown', false);
            startContinuation(s, {});
            completeContinuation(s, () => {});
          }
          break;
        }
        case 'move': case 'erase':
          s.messages = []; s.views.clear(); s.invalidated = true;
          if (s.open) { s.erasure.outOfReach.push(s.call); s.open = undefined; }
          break;
        default: throw new Error(`unknown fixture operation ${operation}`);
      }
      return {};
    },
  };
}

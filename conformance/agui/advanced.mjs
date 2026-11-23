import assert from 'node:assert/strict';
import { checkTls } from './tls.mjs';
import { answer, dispatch, draft, first, frontend, handoff, historyError, offer, options, opts, rawReport, reportRefused, second, simple, success, transformed } from './cases.mjs';
import { at, clean, finalView, input, refused, threadPath, tool, user } from './wire.mjs';

const action = (id, value, status = 'resolved') => ({ interruptId: id, status, ...(value === undefined ? {} : { payload: value }) });
const resume = (...answers) => ({ resume: answers });
const scenario = (model, run, extra = {}) => ({ model, run, control: true, ...extra });
const prompt = async (api, extra = {}) => {
  const view = await api.view((await api.create()).threadId);
  return { view, request: input(view, [user('kit-message-sentinel')], extra) };
};
const modelError = 'provider-diagnostic-sentinel';
export const hidden = 'kit-hidden-output-sentinel';
export const redacted = 'Gated text.';
export const foreignEvent = 'fixture.foreign';
export const trace = (digit, parent) => `00-${digit.repeat(32)}-${parent.repeat(16)}-01`;
const headers = digit => ({ traceparent: trace(digit, 'a'), tracestate: 'kit=allowed,vendor=deny-sentinel', baggage: 'secret=baggage-sentinel' });
const evidenceFor = (control, id) => control('inspect', { threadId: id });
const entries = (evidence, kind) => evidence.batches.flat().filter(entry => entry.kind === kind);
const interrupts = (run, reason) => {
  finalView(run);
  assert.equal(run.terminal.outcome?.type, 'interrupt', `expected ${reason} interrupt`);
  const values = run.terminal.outcome.interrupts;
  assert.ok(values.length && values.every(i => i.id && i.reason === reason && i.message), 'eligible interrupt has identity, kind and prompt');
  return values;
};
const fail = run => {
  assert.equal(run.terminal.type, 'RUN_ERROR', 'unsafe delivery fails the stream');
  assert.ok(typeof run.terminal.code === 'string' && run.terminal.code.length <= 128, 'bounded error code');
  assert.ok(typeof run.terminal.message === 'string' && run.terminal.message.length <= 256, 'bounded fixed diagnostic');
  assert.equal(run.pending.length, 0, 'unsafe executable handoff is withheld');
};

// Inspect the store and request log, not an inferred order from SSE output.
function startRecord(evidence, callId) {
  const starts = entries(evidence, 'toolStarted').filter(e => e.toolCallId === callId);
  assert.equal(starts.length, 1, 'exactly one committed toolStarted');
  const [start] = starts;
  const batch = evidence.batches.find(batch => batch.some(entry => entry.id === start.id));
  const checkpoint = batch[batch.indexOf(start) + 1];
  assert.equal(checkpoint?.kind, 'modular-agent.interfaceHandoff', 'handoff checkpoint follows toolStarted in the same batch');
  assert.equal(checkpoint.toolCallId, callId);
  assert.equal(checkpoint.turnId, start.turnId);
  assert.equal(checkpoint.stepId, start.stepId);
  assert.equal(checkpoint.data.toolStartedId, start.id);
  assert.equal(start.data.safeToRepeat, false);
  assert.equal(start.data.openWorld, true);
  assert.deepEqual(start.data.call.input, dispatch, 'committed call input');
  assert.ok(Number.isSafeInteger(checkpoint.data.deadline) && checkpoint.data.deadline > 0, 'absolute deadline in checkpoint');
  assert.equal(checkpoint.data.executorActorId, 'kit-owner');
  assert.equal(checkpoint.data.routeId, 'kit-primary');
  assert.ok(checkpoint.data.rights.includes('watch') && checkpoint.data.rights.includes('tools'), 'executor ceiling is saved');
  assert.equal(entries(evidence, 'toolPending').filter(e => e.toolCallId === callId).length, 0, 'handoff is not a pending question-backed call');
  return { start, checkpoint };
}

function settled(evidence, callId, status, { continuation = true, report = status === 'completed' } = {}) {
  const { start, checkpoint } = startRecord(evidence, callId);
  const records = evidence.batches.flat();
  const results = entries(evidence, 'toolResult').filter(e => e.toolCallId === callId);
  assert.equal(results.length, 1, 'one terminal result for the Interface call');
  const [result] = results;
  assert.equal(result.data.status, status, 'terminal settlement status');
  assert.equal(result.actorId, report ? 'kit-owner' : undefined, 'report actor is from authentication');
  assert.equal(result.turnId, start.turnId, 'result belongs to origin');
  assert.equal(result.stepId, start.stepId);
  assert.ok(result.sources.includes(start.id) && result.sources.includes(checkpoint.id), 'result preserves handoff erasure lineage');
  const continuations = entries(evidence, 'turnStart').filter(e => e.data.continuesTurnId === start.turnId);
  assert.equal(continuations.length, Number(continuation), 'one continuation iff origin is ready and remains eligible');
  if (!continuation) return;
  const [next] = continuations;
  assert.ok(records.findIndex(e => e.kind === 'turnEnd' && e.turnId === start.turnId && e.data.result.openToolCalls.includes(callId)) < records.indexOf(result), 'origin ends with call open before settlement');
  assert.ok(records.indexOf(result) < records.indexOf(next), 'commit result before continuing');
  assert.deepEqual(next.data.startedBy, { kind: 'toolResult', id: result.id });
  assert.equal(entries(evidence, 'inputAccepted').length, 1, 'result-only continuation does not admit an input');
  assert.equal(entries(evidence, 'input').length, 1, 'result-only continuation does not take an input');
  assert.equal(evidence.dispatches.filter(id => id === callId).length, 1, 'one executable handoff across recovery');
  assert.equal(evidence.model.at(-1)?.messages.filter(m => m.role === 'user').length, 1, 'result is not model user input');
  assert.ok(evidence.model.at(-1)?.messages.some(m => m.role === 'toolResult' && m.name === offer.name), 'result-only model step sees the committed result');
}

export const advanced = {
  tls: scenario(simple, checkTls),
  'approval-absent': scenario(frontend, async ({ api, control }) => {
    const { view, request } = await prompt(api, options);
    // A snapshot and the run stream are not the separate presence route.
    const run = await api.run(request, opts(view));
    success(run);
    assert.equal(run.calls.size, 0, 'no executable tool without eligible approval presence');
    const evidence = await evidenceFor(control, view.threadId);
    assert.equal(entries(evidence, 'toolStarted').length, 0, 'absent approval never starts the tool');
    assert.ok(entries(evidence, 'toolResult').some(e => e.data.status === 'refused'), 'approval refused');
  }),

  'approval': scenario(frontend, async ({ api, origin, tokens, control }) => {
    const { view, request } = await prompt(api, options);
    const presence = await api.presence(view.threadId);
    try {
      const duplicate = await api.request(threadPath(view.threadId) + '/presence');
      assert.notEqual(duplicate.status, 200, 'only one presence stream per client and session');
      await duplicate.body?.cancel();
      const waiting = await api.run(request, opts(view));
      assert.equal(waiting.calls.size, 0, 'no handoff before approval');
      const [approval] = interrupts(waiting, 'approval');
      assert.ok(approval.toolCallId && approval.message.includes(offer.name) && approval.message.includes(dispatch.color), 'approval view names exact dispatched tool and arguments');
      assert.ok(Number.isFinite(Date.parse(approval.expiresAt)), 'approval deadline is ISO 8601');
      const delivered = finalView(waiting);
      const sibling = at(origin, tokens.sibling);
      const alien = await sibling.view(view.threadId);
      const otherPresence = await sibling.presence(view.threadId);
      try {
        assert.equal(alien.waiting.questions.length, 0, 'another client does not get the answerable approval');
        await reportRefused(await sibling.post(input(alien, [], resume(action(approval.id, { allow: true }))), opts(alien)));
      } finally { await otherPresence.close(); }
      await reportRefused(await api.post(input(delivered, [], resume(action('invented-id', { allow: true }))), opts(delivered)));
      await refused(await api.post(input(delivered, [], resume(action(approval.id, { allow: 'true' }))), opts(delivered)), 400, 'invalid_request');
      const { id } = handoff(await api.run(input(delivered, [], resume(action('unknown-id', { allow: false }), action(approval.id, { allow: true }))), opts(delivered)));
      assert.equal(id, approval.toolCallId);
      const evidence = await evidenceFor(control, view.threadId);
      const { start } = startRecord(evidence, id);
      assert.equal(entries(evidence, 'turnStart').length, 1, 'approval resumes existing turn');
      const record = evidence.batches.flat().find(e => e.kind === 'inputAnswer' && e.data.requestId === approval.id);
      assert.ok(record && evidence.batches.flat().indexOf(record) < evidence.batches.flat().indexOf(start), 'allow is committed before dispatch');
    } finally { await presence.close(); }
  }),

  ...Object.fromEntries(['approval-redacted', 'approval-lost', 'approval-expired'].map(name => [name, scenario(frontend, async ({ api, control }) => {
    const { view, request } = await prompt(api, options);
    const presence = await api.presence(view.threadId);
    try {
      const run = await api.run(request, opts(view));
      if (name === 'approval-redacted') {
        success(run);
        assert.equal(run.calls.size, 0, 'changed approval view cannot allow dispatch');
      } else {
        const [approval] = interrupts(run, 'approval');
        if (name === 'approval-lost') {
          await presence.close();
          await control('barrier', { threadId: view.threadId, name: 'presenceLost' });
        } else await control('advance', { threadId: view.threadId, milliseconds: 5000 });
        const current = await api.view(view.threadId);
        assert.equal(current.waiting.questions.length, 0, 'closed approval is not answerable from a snapshot');
        const replacement = name === 'approval-lost' ? await api.presence(view.threadId) : undefined;
        try { await reportRefused(await api.post(input(current, [], resume(action(approval.id, { allow: true }))), opts(current))); }
        finally { await replacement?.close(); }
      }
      const evidence = await evidenceFor(control, view.threadId);
      assert.equal(entries(evidence, 'toolStarted').length, 0, 'closed approval cannot start tool');
      assert.ok(entries(evidence, 'toolResult').some(e => e.data.status === 'refused'), 'approval is refused');
    } finally { await presence.close(); }
  })])),

  'questions': scenario(simple, async ({ api, control }) => {
    for (const [value, status] of [['yes', 'resolved'], [undefined, 'cancelled'], [undefined, 'expired']]) {
      const { view, request } = await prompt(api);
      const presence = await api.presence(view.threadId);
      try {
        const r1 = await api.run(request, opts(view));
        const [question] = interrupts(r1, 'choice');
        const delivered = finalView(r1);
        assert.ok(Number.isFinite(Date.parse(question.expiresAt)), 'choice has closing deadline');
        if (question.responseSchema !== undefined) assert.deepEqual(question.responseSchema.enum, ['yes', 'no']);
        await refused(await api.post(input(delivered, [], resume(action(question.id, 'outside-options'))), opts(delivered)), 400, 'invalid_request');
        if (status === 'expired') {
          await control('advance', { threadId: view.threadId, milliseconds: 5000 });
          const current = await api.view(view.threadId);
          assert.deepEqual(current.waiting.questions, [], 'expired question no longer answerable');
          await reportRefused(await api.post(input(current, [], resume(action(question.id, 'yes'))), opts(current)));
        } else {
          const req = input(delivered, [], resume(action(question.id, value, status)));
          answer(await api.run(req, opts(delivered)), first);
          await historyError(await api.post(req, opts(delivered)));
        }
        const evidence = await evidenceFor(control, view.threadId);
        assert.equal(entries(evidence, 'turnStart').length, 1, 'resumed question uses original turn');
        const answers = entries(evidence, 'inputAnswer');
        assert.equal(answers.length, 1, 'question decision commits once');
        assert.equal(answers[0].data.declined ?? false, status !== 'resolved');
        if (status === 'expired') assert.equal(answers[0].data.reason, 'timeLimit');
      } finally { await presence.close(); }
    }
  }),

  'mixed': scenario(frontend, async ({ api, control }) => {
    const { view, request } = await prompt(api, options);
    const presence = await api.presence(view.threadId);
    try {
      const r1 = await api.run(request, opts(view));
      const [q] = interrupts(r1, 'choice');
      assert.equal(r1.calls.size, 0, 'in-turn interrupt does not release staged tool');
      const evidence = await evidenceFor(control, view.threadId);
      const [start] = entries(evidence, 'toolStarted');
      startRecord(evidence, start.toolCallId);
      assert.deepEqual(evidence.dispatches, [], 'not delivered at staging');
      const delivered = finalView(r1);
      const waiting = await api.view(view.threadId);
      await reportRefused(await api.post(input(waiting, [tool(start.toolCallId, rawReport)]), opts(waiting)));
      const r2 = await api.run(input(waiting, [], resume(action(q.id, 'yes'))), opts(waiting));
      const { id } = handoff(r2);
      assert.equal(id, start.toolCallId);
      const current = finalView(r2);
      answer(await api.run(input(current, [tool(id, rawReport)]), opts(current)), second);
      settled(await evidenceFor(control, delivered.threadId), id, 'completed');
    } finally { await presence.close(); }
  }),

  'history-invalidation': scenario(simple, async ({ api, control }) => {
    for (const operation of ['move', 'erase']) {
      const { view, request } = await prompt(api);
      const old = answer(await api.run(request, opts(view)), first);
      await control(operation, { threadId: view.threadId });
      const update = input(old, [user('must not be admitted')]);
      await historyError(await api.post(update, opts(old)));
      await historyError(await api.post(update));
      const current = await api.view(view.threadId);
      clean(current, 'kit-message-sentinel');
      const evidence = await evidenceFor(control, view.threadId);
      assert.equal(entries(evidence, 'inputAccepted').length, 1, 'invalidated view did not admit new work');
    }
  }),

  'report-cutoffs': scenario(frontend, async ({ api, control }) => {
    for (const operation of ['timeout', 'report-first', 'revoke', 'erase']) {
      const { view, request } = await prompt(api, options);
      const { id } = handoff(await api.run(request, opts(view)));
      const snapshot = await api.view(view.threadId);
      const before = await evidenceFor(control, view.threadId);
      const { checkpoint } = startRecord(before, id);
      assert.equal(Date.parse(snapshot.waiting.toolCalls[0].expiresAt), checkpoint.data.deadline, 'snapshot uses original deadline');
      const report = input(snapshot, [tool(id, rawReport)]);
      if (operation === 'report-first') {
        const run = await api.run(report, opts(snapshot));
        answer(run, second);
        await control('advance', { threadId: view.threadId, milliseconds: 60_000 });
        settled(await evidenceFor(control, view.threadId), id, 'completed');
      } else {
        if (operation === 'timeout') await control('advance', { threadId: view.threadId, milliseconds: 60_000 });
        else await control(operation, { threadId: view.threadId });
        await reportRefused(await api.post(report, opts(snapshot)));
        const current = await api.view(view.threadId);
        await reportRefused(await api.post(input(current, [tool(id, rawReport)]), opts(current)));
        const evidence = await evidenceFor(control, view.threadId);
        if (operation === 'timeout') settled(evidence, id, 'outcomeUnknown');
        else if (operation === 'erase') {
          assert.equal(entries(evidence, 'turnStart').filter(e => e.data.continuesTurnId).length, 0, 'erased call cannot authorize a continuation');
          assert.ok(evidence.erasure.outOfReach.length, 'possibly handed-off copy is out of reach');
          clean(current, dispatch.color, rawReport);
        } else assert.equal(entries(evidence, 'toolResult').some(e => e.actorId), false, 'changed tool authority refuses the report');
      }
    }
  }),

  'release-gate': scenario(frontend, async ({ api, control }) => {
    const { view, request } = await prompt(api, options);
    const running = api.run(request, opts(view));
    running.catch(() => {});
    await control('barrier', { threadId: view.threadId, name: 'beforeRelease' });
    await control('revoke', { threadId: view.threadId });
    await control('release', { threadId: view.threadId });
    fail(await running);
    const evidence = await evidenceFor(control, view.threadId);
    assert.deepEqual(evidence.dispatches, [], 'final authority rechecked after staging');
  }),

  'state-and-gate': scenario([{ text: hidden, reasoning: 'readable reasoning' }], async ({ api, origin, tokens, control }) => {
    const { view, request } = await prompt(api, { state: { kit: 'state-copy-sentinel' }, context: [{ description: 'unused', value: 'context-sentinel' }], forwardedProps: { kit: 'forwarded-sentinel' } });
    const run = await api.run(request, opts(view));
    const final = answer(run, redacted);
    clean(run.events, hidden, 'provider-only-sentinel', 'state-copy-sentinel', 'context-sentinel', 'forwarded-sentinel', 'wrong-plugin-sentinel', 'withheld-extension-sentinel');
    assert.deepEqual(run.events.filter(e => e.type.startsWith('STATE_')).map(e => e.snapshot ?? e.delta), [
      { counter: 0 }, [{ op: 'replace', path: '/counter', value: 1 }], { counter: 4 }, [{ op: 'replace', path: '/counter', value: 5 }],
    ], 'suppress stale/gated patches and resnapshot before later deltas');
    assert.ok(run.events.some(e => e.type === 'CUSTOM' && e.name === 'modular-agent.event' && e.value?.type === 'kit.visible'), 'gated custom event delivered');
    assert.ok(run.events.some(e => e.type === 'CUSTOM' && e.name === 'modular-agent.entry'), 'gated entry extension delivered');
    assert.ok(run.events.some(e => e.type === 'RAW' && e.source === 'kit' && e.event?.type === foreignEvent), 'configured raw passthrough');
    assert.ok((await evidenceFor(control, view.threadId)).warnings.includes('context'), 'nonempty context gets a warning');
    const copy = await api.view(view.threadId);
    assert.deepEqual(copy.messages, final.messages, 'gated replay matches live view');
    await refused(await at(origin, tokens.sibling).request(threadPath(view.threadId)), 403, 'output_withheld');
    assert.ok(entries(await evidenceFor(control, view.threadId), 'response').some(e => e.message?.content.some(p => p.type === 'text' && p.text === hidden)), 'redaction does not change the authoritative response');
  }),

  'output-size': scenario(simple, async ({ api, origin, tokens }) => {
    const { view, request } = await prompt(api);
    const run = await api.run(request, opts(view));
    answer(run, first);
    assert.ok(!run.events.some(e => e.name === 'modular-agent.event' && e.value?.type === 'kit.oversized'), 'oversized optional event must not go on the wire');
    const sibling = at(origin, tokens.sibling);
    await refused(await sibling.request(threadPath(view.threadId)), 413, 'result_too_large');
  }),

  'error-gate': scenario([{ error: { kind: 'other', message: modelError } }], async ({ api }) => {
    const { view, request } = await prompt(api);
    const run = await api.run(request, opts(view));
    fail(run);
    clean(run.events, modelError);
    await refused(await api.request(''), 403, 'output_withheld');
  }),

  ...Object.fromEntries(['before-handoff', 'after-handoff', 'after-result', 'continuation'].map(phase => [`crash-${phase}`, scenario(frontend, async ({ api, control, restart }) => {
    const { view, request } = await prompt(api, options);
    if (phase === 'before-handoff') {
      const dropped = interrupted(api.run(request, { ...opts(view), headers: headers('1') }));
      await control('barrier', { threadId: view.threadId, name: 'beforeHandoff' });
      assert.equal(entries(await evidenceFor(control, view.threadId), 'toolStarted').length, 0, 'kill before write of toolStarted');
      const reopened = await restart();
      await dropped;
      const snapshot = await reopened.api.view(view.threadId);
      assert.deepEqual(snapshot.waiting.toolCalls, [], 'transient Runtime cannot release an interrupted draft');
      const evidence = await evidenceFor(reopened.control, view.threadId);
      assert.deepEqual(evidence.dispatches, [], 'no handoff on reopen');
      assert.ok(entries(evidence, 'toolResult').some(e => e.data.status === 'notStarted'), 'known unstarted call is settled');
      return;
    }
    const { id } = handoff(await api.run(request, { ...opts(view), headers: headers('1') }));
    const delivered = await api.view(view.threadId);
    const originalExpiry = delivered.waiting.toolCalls[0].expiresAt;
    const report = input(delivered, [tool(id, rawReport)]);
    let dropped;
    if (phase !== 'after-handoff') {
      dropped = interrupted(api.run(report, { ...opts(delivered), headers: headers('2') }));
      await control('barrier', { threadId: view.threadId, name: phase === 'after-result' ? 'afterResult' : 'duringContinuation' });
      const before = await evidenceFor(control, view.threadId);
      assert.equal(entries(before, 'toolResult').length, 1, 'kill after terminal result is durable');
      assert.equal(entries(before, 'turnStart').length, phase === 'after-result' ? 1 : 2, 'kill at the specified continuation boundary');
    }
    const reopened = await restart();
    await dropped;
    const snapshot = await reopened.api.view(view.threadId, { headers: headers('9') });
    clean(snapshot, dispatch.color, rawReport, '9'.repeat(32));
    await reportRefused(await reopened.api.post(report, opts(delivered)));
    if (phase === 'after-handoff') {
      assert.deepEqual(snapshot.waiting.toolCalls, [{ toolCallId: id, expiresAt: originalExpiry }], 'restart restores deadline without extending it');
      assert.equal(entries(await evidenceFor(reopened.control, view.threadId), 'toolResult').length, 0, 'restart must not settle a still-open call');
      const next = await reopened.api.view(view.threadId);
      const r2 = await reopened.api.run(input(next, [tool(id, rawReport)]), { ...opts(next), headers: headers('2') });
      answer(r2, second);
    } else {
      assert.deepEqual(snapshot.waiting.toolCalls, [], 'committed result stays settled after restart');
      assert.equal(snapshot.messages.at(-1)?.content, second, 'eligible continuation recovers ahead of fresh work');
      await reportRefused(await reopened.api.post(input(snapshot, [tool(id, rawReport)]), opts(snapshot)));
    }
    const evidence = await evidenceFor(reopened.control, view.threadId);
    settled(evidence, id, 'completed');
    if (phase === 'continuation') {
      const resumed = evidence.spans.find(s => s.attributes['modular_agent.turn.resumed'] === true);
      assert.equal(resumed?.traceId, '2'.repeat(32), 'recovered segment uses authoritative continuation context');
    }
  }, { restart: true })])),

  'trace': scenario(frontend, async ({ api, origin, tokens, control }) => {
    const { view, request } = await prompt(api, options);
    await api.view(view.threadId, { headers: headers('8') });
    const noCursor = await api.run(request, { headers: headers('1') });
    const { id } = handoff(noCursor);
    const view2 = await api.view(view.threadId, { headers: headers('9') });
    const r2 = await api.run(input(view2, [tool(id, rawReport)]), { ...opts(view2), headers: headers('2') });
    answer(r2, second);
    const ev = await evidenceFor(control, view.threadId);
    settled(ev, id, 'completed');
    const spans = ev.spans, turns = spans.filter(s => s.name.startsWith('invoke_agent'));
    const handoffs = spans.filter(s => s.name.startsWith('execute_tool') && s.attributes['modular_agent.tool.call.id'] === id);
    assert.equal(handoffs.length, 1, 'one handoff span');
    const [execution] = handoffs;
    const settlement = spans.find(s => s.name === 'modular_agent.tool.settle' && s.attributes['modular_agent.tool.call.id'] === id);
    assert.equal(execution.attributes['modular_agent.tool.status'], 'pending', 'execution span ends pending');
    assert.equal(execution.traceId, '1'.repeat(32));
    assert.equal(settlement?.attributes['modular_agent.tool.status'], 'completed', 'separate terminal settlement span');
    assert.equal(settlement.traceId, '2'.repeat(32), 'settlement uses authorized report context');
    assert.ok(settlement.links.some(link => link.spanId === execution.spanId && link.traceId === execution.traceId), 'settlement links to available handoff span');
    assert.equal(turns.length, 2, 'one originating and one continuation turn span');
    assert.equal(turns[0].traceId, '1'.repeat(32));
    assert.equal(turns[1].traceId, '2'.repeat(32));
    assert.ok(turns[1].links.some(link => link.spanId === turns[0].spanId && link.traceId === turns[0].traceId), 'continuation links to origin');
    const untrusted = at(origin, tokens.foreign);
    const bad = await prompt(untrusted);
    await untrusted.run(bad.request, { ...opts(bad.view), headers: headers('7') });
    const untrustedSpans = (await evidenceFor(control, bad.view.threadId)).spans;
    assert.ok(untrustedSpans.some(s => s.name.startsWith('invoke_agent')) && untrustedSpans.every(s => s.traceId !== '7'.repeat(32)), 'untrusted header ignored');
    clean([noCursor.events, r2.events], ...['1', '2', '8', '9'].map(n => n.repeat(32)), tokens.owner);
    clean([spans, untrustedSpans], 'vendor=deny-sentinel', 'baggage-sentinel', 'kit-message-sentinel', rawReport, transformed, dispatch.color, draft.color, tokens.owner);
  }),
};

// A process kill must drop this exchange before it can authorize anything.
function interrupted(run) {
  return run.then(() => new Error('crashed exchange completed before restart'), error => error).then(error => {
    if (error.message === 'crashed exchange completed before restart') throw error;
  });
}

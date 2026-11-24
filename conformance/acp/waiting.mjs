// ADR 0034. All decisions go through ACP. The separate fixture control can stop
// the clock or a writer, but cannot answer a question or run a continuation.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isLoopback } from '../tools/websocket.mjs';
import { acpPeer } from '../waiting/acp-peer.mjs';
import { one, parked, rows, settled } from '../waiting/records.mjs';

const NS = 'modular-agent', meta = r => r?._meta?.[NS];
const ext = (a, m, sessionId, args = {}) => a.request(`_${NS}/${m}`, { sessionId, ...args });
const answer = (a, sid, id, value = 'allow', actorId) => ext(a, 'answer', sid, { requestId: id, value, ...(actorId && { actorId }) });
const poll = async (a, sid) => (await ext(a, 'requests', sid)).requests;
const notOpen = { accepted: false, reason: 'not_open' }, accepted = { accepted: true };
const handshake = (a, v) => a.request('initialize', { protocolVersion: 1, clientCapabilities: {}, _meta: { [NS]: { binding: `modular-agent-acp/${v}` } } });
const open = (a, cwd, sessionId) => a.request(sessionId ? 'session/resume' : 'session/new', { cwd, mcpServers: [], ...(sessionId && { sessionId }) });
const select = (a, sessionId, configId, value) => a.request('session/set_config_option', { sessionId, configId, value });
const ask = (a, sessionId, input) => a.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: `tool:bash ${JSON.stringify(input)}` }] });
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => {
  writeFileSync(path + '.new', JSON.stringify(value), { mode: 0o600 });
  renameSync(path + '.new', path);
};
const errorCode = (number, code) => e => e.code === number && e.data?.code === code;

export function support(d) {
  assert.ok(d && typeof d === 'object', 'missing declaration');
  assert.ok(!('approvalsOutlastTurns' in d) || typeof d.approvalsOutlastTurns === 'boolean', 'invalid approvalsOutlastTurns');
  if (d.approvalsOutlastTurns !== true) return false;
  for (const key of ['questionsOutlastTurns', 'lateAnswersStartTurns', 'portableSessions']) assert.equal(d[key], true, `waiting approvals require ${key}`);
  return true;
}
function option(reply, value = 'live') {
  const supported = support(meta(reply)?.declaration);
  const options = reply.configOptions.filter(o => o.id === 'approvalWait');
  assert.equal(options.length, Number(supported), 'approvalWait only with the declaration');
  if (supported) {
    assert.equal(options[0].type, 'select');
    assert.equal(options[0].currentValue, value);
    assert.deepEqual(options[0].options.map(o => o.value).sort(), ['live', 'untilDeadline']);
    assert.ok(reply.configOptions.some(o => o.id === 'approval'), 'approval gate offered');
  }
  return supported;
}
export function view(q, entry, input, declaration = {}) {
  if (declaration.approvalCoversNested === true) assert.equal(entry.data.request.coversNested, true, "waiting request declares coversNested");
  assert.deepEqual(q, { id: entry.requestId, kind: 'approval', question: entry.data.request.question,
    ...(entry.data.request.coversNested === true && { coversNested: true }), answerable: true, toolCallId: entry.toolCallId, call: { name: 'bash', input }, approvalWait: 'untilDeadline', deadlineAt: entry.data.request.deadlineAt }, 'fresh unchanged ACP view');
}

// A fresh disposable project file distinguishes actual dispatch from an early or
// duplicate toolStarted. Each reopen keeps the same fixture dir, clock and grants.
async function launch(kit, name, version, run) {
  const dir = mkdtempSync(join(kit.root, 'wait-'));
  const conf = join(dir, 'fixture.json'), ready = join(dir, 'ready.json');
  const marker = `count-${randomUUID()}`, clock = join(dir, 'clock.json');
  const input = { command: `printf x >> ${marker}` };
  const roles = ['approver', 'other', 'answerOnly', 'tenant', 'representative', 'control'];
  const tokens = Object.fromEntries(roles.map(role => [role, randomBytes(32).toString('hex')]));
  const tokenFiles = Object.fromEntries(roles.map(role => [role, join(dir, role + '.token')]));
  for (const role of roles) writeFileSync(tokenFiles[role], tokens[role], { mode: 0o600 });
  write(clock, 1800000000000);
  const config = { name, version, ready, clock, tokenFiles, maxApprovalWaitMs: 60000, project: kit.project };
  const env = { MODULAR_AGENT_DATA_DIR: dir, MA_ACP_WAIT_FIXTURE: conf };
  let host, a, sid, readyInfo, d, extensions;
  const peers = new Set();
  const info = () => readyInfo ??= read(ready);
  async function control(operation, args = {}) {
    const url = new URL(info().control);
    assert.ok(url.protocol === 'http:' && isLoopback(url.hostname) && !url.username && !url.password, 'use disposable loopback control');
    const r = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${tokens.control}`, 'content-type': 'application/json' }, body: JSON.stringify({ operation, sessionId: sid, ...args }) });
    assert.equal(r.status, 200, `fixture ${operation}`);
    return r.json();
  }
  async function start(reopen = false, change = {}) {
    write(conf, { ...config, ...change }); rmSync(ready, { force: true }); readyInfo = undefined;
    host = kit.connect(reopen ? kit.second : kit.command, env);
    host.state.permissionAnswer = 'refuse';
    const agent = host;
    a = { request: (m, args) => kit.within(30000, agent.ctx.request(m, args), m) };
    const h = await handshake(a, version);
    assert.equal(meta(h)?.binding, `modular-agent-acp/${version}`);
    support(meta(h)?.declaration);
    const reply = await open(a, kit.project, reopen ? sid : undefined);
    if (!reopen) sid = reply.sessionId;
    assert.ok(sid);
    extensions = meta(h).extensions ?? [];
    d = meta(reply)?.declaration;
    const capable = option(reply, reopen ? 'untilDeadline' : 'live');
    assert.equal(capable, change.reopen !== 'unsupported', 'waiting fixture session declaration');
    if (capable) assert.equal(meta(h).declaration.approvalsOutlastTurns, true);
    return capable;
  }
  async function crash() {
    await closePeers();
    assert.equal(host.permissions.length, 0, 'no waiting permission RPC');
    await kit.crash(host); host = undefined;
  }
  async function peer(role, attach = true) {
    const url = new URL(info().acp);
    assert.ok(isLoopback(url.hostname), 'use disposable loopback ACP listener');
    const p = await acpPeer(url, tokens[role]); peers.add(p);
    const request = p.request;
    p.request = (m, args) => kit.within(15000, request(m, args), m);
    const h = await handshake(p, version); p.actor = meta(h).actor.id;
    if (attach) await open(p, kit.project, sid);
    return p;
  }
  async function closePeers() {
    for (const p of peers) { await p.close(); assert.equal(p.permissions.length, 0, 'no waiting permission RPC on return'); peers.delete(p); }
  }
  const c = { input, peer, control, crash, start, clock, project: kit.project,
    get extensions() { return extensions; },
    get a() { return a; }, get sid() { return sid; }, get d() { return d; },
    count() { const path = join(kit.project, marker); return existsSync(path) ? readFileSync(path, 'utf8').length : 0; },
    async optIn() { option(await select(a, sid, 'approvalWait', 'untilDeadline'), 'untilDeadline'); },
    async prompt() { return ask(a, sid, input); },
    async batches() { return (await control('inspect')).batches; },
    async idle() { await control('idle'); },
    async advance(to) { write(clock, to); await control('tick'); },
  };
  try {
    await start();
    return await run(c);
  } finally {
    try { await closePeers(); } finally { if (host) { await kit.stop(host); assert.equal(host.permissions.length, 0, 'no live permission RPC for an offline or waiting decision'); } }
  }
}

async function origin(c) {
  const reply = await c.prompt();
  const e = parked(await c.batches(), 'bash', c.input);
  assert.equal(reply.stopReason, 'end_turn'); assert.equal(meta(reply).outcome?.kind, 'completed');
  assert.deepEqual(meta(reply).openToolCalls, [e.toolCallId]);
  assert.equal(c.count(), 0, 'counter before decision');
  return e;
}
async function delivery(c, e, role = 'approver') {
  const p = await c.peer(role);
  const qs = await poll(p, c.sid); assert.equal(qs.length, 1); view(qs[0], e, c.input, c.d);
  return p;
}
async function finish(c, e, status, decision, actor, opts) {
  await c.idle();
  settled((await c.batches()).flat(), e, { status, decision, actor, ...opts });
  assert.equal(c.count(), Number(['completed', 'outcomeUnknown'].includes(status)), 'actual number of effects');
}
async function routes(c, e) {
  const p = await c.peer('approver');
  const history = await ext(p, 'history', c.sid);
  assert.ok(history.entries.some(r => r.requestId === e.requestId), 'history shows the ID');
  assert.deepEqual(await answer(p, c.sid, e.requestId), notOpen, 'history cannot authorize');
  for (const gate of ['redact', 'block']) {
    await c.control('gate', { role: 'approver', mode: gate });
    if (gate === 'redact') {
      const qs = await poll(p, c.sid); assert.equal(qs.length, 1); assert.equal(qs[0].answerable, false);
      assert.ok(!JSON.stringify(qs).includes(c.input.command), 'redacted input is not exposed');
    } else await assert.rejects(poll(p, c.sid), errorCode(-32000, 'withheld'));
    assert.deepEqual(await answer(p, c.sid, e.requestId), notOpen, 'changed or withheld delivery cannot authorize');
  }
  await c.control('gate', { role: 'approver', mode: 'pass' });
  view((await poll(p, c.sid))[0], e, c.input, c.d);
  const sibling = await c.peer('approver'); assert.deepEqual(await answer(sibling, c.sid, e.requestId), notOpen, 'second socket needs its own poll');
  if (c.d.severalActors) {
    const rep = await c.peer('representative'); await poll(rep, c.sid);
    assert.deepEqual(await answer(rep, c.sid, e.requestId, 'allow', p.actor), notOpen, 'no matching represented delivery');
    const only = await c.peer('answerOnly'); assert.ok(!(await poll(only, c.sid)).some(q => q.answerable));
    assert.deepEqual(await answer(only, c.sid, e.requestId), notOpen, 'answer alone is not approve');
  }
  if (c.d.tenants) {
    const foreign = await c.peer('tenant', false);
    await assert.rejects(open(foreign, c.project, c.sid), errorCode(-32602, 'forbidden'));
    await assert.rejects(ext(foreign, 'requests', c.sid), errorCode(-32602, 'forbidden'));
    await assert.rejects(answer(foreign, c.sid, e.requestId), errorCode(-32602, 'forbidden'));
  }
  assert.deepEqual(await answer(p, c.sid, e.requestId), accepted);
  await finish(c, e, 'completed', 'allow', p.actor);
  assert.deepEqual(await answer(p, c.sid, e.requestId), notOpen);
  assert.ok(!JSON.stringify(await ext(p, 'history', c.sid)).includes('approvalView'), 'history omits private proof');
}

const cases = {
  'live-offline': async c => {
    const r = await c.prompt(); assert.equal(r.stopReason, 'end_turn');
    const es = (await c.batches()).flat(); assert.equal(one(es, 'toolResult').data.status, 'refused');
    assert.equal(rows(es, 'toolStarted').length, 0); assert.equal(c.count(), 0);
    assert.ok(!rows(es, 'inputRequest').some(e => e.data.request.approvalWait));
  },
  'before-end': async c => {
    const p = await c.peer('approver'); // Present before the gate. It must still return pending.
    await c.control('pause', { at: 'requestPending' });
    const prompt = c.prompt(); prompt.catch(() => {});
    await c.control('reached', { at: 'requestPending' });
    const e = parked(await c.batches(), 'bash', c.input, { ended: false });
    assert.ok(!(await poll(p, c.sid)).some(q => q.answerable));
    assert.deepEqual(await answer(p, c.sid, e.requestId), notOpen);
    await c.control('release'); const reply = await prompt;
    assert.equal(reply.stopReason, 'end_turn'); assert.deepEqual(meta(reply).openToolCalls, [e.toolCallId]);
    await routes(c, parked(await c.batches(), 'bash', c.input));
  },
  'race-routes': async c => {
    const e = await origin(c), a = await delivery(c, e), b = await delivery(c, e, 'other');
    const [allow, decline] = await Promise.all([answer(a, c.sid, e.requestId), answer(b, c.sid, e.requestId, 'refuse')]);
    assert.deepEqual([allow, decline], allow.accepted ? [accepted, notOpen] : [notOpen, accepted]);
    await finish(c, e, allow.accepted ? 'completed' : 'refused', allow.accepted ? 'allow' : 'decline', allow.accepted ? a.actor : b.actor);
  },
  'race-expiry': async c => {
    const e = await origin(c), p = await delivery(c, e);
    await c.control('pause', { at: 'beforeHandoff' });
    const [r] = await Promise.all([answer(p, c.sid, e.requestId), c.advance(e.data.request.deadlineAt)]);
    assert.deepEqual(r, r.accepted ? accepted : notOpen); await c.control('release');
    await finish(c, e, 'notStarted', r.accepted ? 'allow' : 'timeLimit', r.accepted ? p.actor : undefined);
  },
};
for (const last of [false, true]) cases[last ? 'remove-last' : 'remove-one'] = async c => {
  const e = await origin(c), a = await delivery(c, e), b = await delivery(c, e, 'other');
  await c.control('revoke', { role: 'approver', right: 'approve' });
  assert.deepEqual(await answer(a, c.sid, e.requestId), notOpen);
  if (last) {
    await c.control('revoke', { role: 'other', right: 'approve' });
    await finish(c, e, 'refused', 'noLongerAnswerable');
  } else { assert.deepEqual(await answer(b, c.sid, e.requestId), accepted); await finish(c, e, 'completed', 'allow', b.actor); }
};
for (const cut of ['worker-ceiling', 'approver-rights', 'route-authorization', 'disconnect', 'stale-writer']) cases[cut] = async c => {
  const e = await origin(c), p = await delivery(c, e);
  await c.control('pause', { at: 'beforeHandoff' });
  assert.deepEqual(await answer(p, c.sid, e.requestId), accepted);
  await c.control('reached', { at: 'beforeHandoff' });
  if (cut === 'disconnect') await p.close();
  else await c.control('cut', { kind: cut });
  await c.control('release');
  if (cut === 'stale-writer') {
    await c.idle(); assert.equal(c.count(), 0, 'stale writer cannot hand off');
  } else await finish(c, e, cut === 'disconnect' ? 'completed' : 'refused', 'allow', p.actor);
};
for (const at of ['requestPending', 'originEnd', 'answerCommit', 'continuationStart', 'afterEffect', 'expire-stopped', 'unsupported', 'missing-proof']) cases[`reopen-${at}`] = async c => {
  let e, p;
  if (at === 'requestPending') {
    await c.control('pause', { at }); const pending = c.prompt(); pending.catch(() => {});
    await c.control('reached', { at }); e = parked(await c.batches(), 'bash', c.input, { ended: false });
  } else {
    e = await origin(c); p = await delivery(c, e);
    if (['answerCommit', 'continuationStart', 'afterEffect', 'missing-proof'].includes(at)) {
      const barrier = at === 'missing-proof' ? 'answerCommit' : at;
      await c.control('pause', { at: barrier });
      const answering = answer(p, c.sid, e.requestId); answering.catch(() => {});
      await c.control('reached', { at: barrier }); assert.equal(c.count(), Number(at === 'afterEffect'));
    }
  }
  const transient = !c.d.continuesAfterRestart;
  await c.crash();
  if (at === 'expire-stopped') write(c.clock, e.data.request.deadlineAt);
  if (at === 'unsupported' || at === 'missing-proof') {
    // A reader unable to settle safely may refuse to take up this history.
    try { await c.start(true, { reopen: at }); }
    catch (err) { if (!['not_supported', 'conflict', 'unavailable'].includes(err.data?.code)) throw err; assert.equal(c.count(), 0); return; }
    await c.idle(); const es = (await c.batches()).flat();
    assert.equal(c.count(), 0); assert.equal(rows(es, 'toolStarted').length, 0);
    if (at === 'unsupported') { assert.ok(!support(c.d)); assert.equal(one(es, 'inputAnswer').data.reason, 'noLongerAnswerable'); assert.equal(one(es, 'toolResult').data.status, 'notStarted'); }
    else { assert.equal(one(es, 'toolResult').data.status, 'refused'); one(es, 'inputRequest'); }
    return;
  }
  assert.equal(await c.start(true), true, 'reopener supports waiting approvals'); await c.idle();
  if (at === 'requestPending' && transient) {
    const es = (await c.batches()).flat(); assert.equal(one(es, 'turnEnd').data.outcome.kind, 'failed');
    assert.equal(one(es, 'toolResult').data.status, 'notStarted'); assert.equal(rows(es, 'toolStarted').length, 0); assert.equal(c.count(), 0); return;
  }
  if (at === 'expire-stopped') {
    assert.deepEqual(await poll(await c.peer('approver'), c.sid), []);
    return finish(c, e, 'notStarted', 'timeLimit');
  }
  if (['originEnd', 'requestPending'].includes(at)) {
    const back = await c.peer('approver'); assert.deepEqual(await answer(back, c.sid, e.requestId), notOpen, 'restart drops all deliveries');
    view((await poll(back, c.sid))[0], e, c.input, c.d);
    assert.deepEqual(await answer(back, c.sid, e.requestId), accepted); p = back;
  }
  await finish(c, e, at === 'afterEffect' ? 'outcomeUnknown' : 'completed', 'allow', p.actor);
};
for (const transition of ['fork', 'rewind', 'move']) cases[transition] = async c => {
  const e = await origin(c), before = (await c.batches()).flat().find(r => r.kind === 'plugins');
  const change = () => ext(c.a, transition === 'fork' ? 'fork' : 'move', c.sid, { entryId: before.id, ...(transition === 'rewind' && { rewind: true }) });
  if (transition === 'move' && c.d.movingWithUnfinishedWork === 'cancels') {
    await change(); const es = (await c.batches()).flat();
    assert.equal(one(es, 'toolResult').data.status, 'notStarted'); assert.equal(c.count(), 0);
    assert.deepEqual(await poll(await c.peer('approver'), c.sid), []); return;
  }
  await assert.rejects(change(), errorCode(-32602, 'busy'));
  const p = await delivery(c, e); assert.deepEqual(await answer(p, c.sid, e.requestId), accepted); await finish(c, e, 'completed', 'allow', p.actor);
  if (transition === 'fork') {
    const es = (await c.batches()).flat(); const fork = await ext(c.a, 'fork', c.sid, { entryId: es.at(-1).id });
    await open(p, c.project, fork.sessionId);
    assert.deepEqual(await poll(p, fork.sessionId), []); assert.deepEqual(await answer(p, fork.sessionId, e.requestId), notOpen);
    const { batches } = await c.control('inspect', { sessionId: fork.sessionId });
    assert.ok(!rows(batches.flat(), 'inputAnswer').some(r => r.data?.approvalView), 'fork copies no approval proof'); assert.equal(c.count(), 1);
  }
};
for (const target of ['inputRequest', 'inputAnswer']) cases[`erase-${target}`] = async c => {
  const e = await origin(c), p = await delivery(c, e);
  await c.control('pause', { at: 'beforeHandoff' }); assert.deepEqual(await answer(p, c.sid, e.requestId), accepted);
  await c.control('reached', { at: 'beforeHandoff' });
  const victim = one((await c.batches()).flat(), target);
  await c.control('pause', { at: 'pendingErasure' });
  const erasing = ext(c.a, 'erase', c.sid, { entryIds: [victim.id] }); erasing.catch(() => {});
  await c.control('reached', { at: 'pendingErasure' });
  await c.control('release', { at: 'beforeHandoff' }); await c.control('barred', { toolCallId: e.toolCallId });
  assert.equal(c.count(), 0);
  await c.control('release', { at: 'pendingErasure' }); await erasing; await c.idle();
  assert.deepEqual(await poll(p, c.sid), []);
  const es = (await c.batches()).flat(); assert.ok(es.some(r => r.id === victim.id && r.erased));
  const terminal = one(es.filter(r => r.toolCallId === e.toolCallId), 'toolResult'); assert.equal(terminal.stepId, e.stepId);
  assert.equal(rows(es, 'toolStarted').length, 0); assert.equal(c.count(), 0);
};
cases.capacity = async c => {
  const e = await origin(c); await c.crash(); await c.start(true);
  const r = await c.prompt(); assert.equal(meta(r).outcome.kind, 'limit'); assert.equal(meta(r).outcome.limit, 'capacity');
  const p = await delivery(c, e); assert.deepEqual(await answer(p, c.sid, e.requestId, 'refuse'), accepted);
  await c.idle(); const es = (await c.batches()).flat(); assert.equal(one(es.filter(x => x.toolCallId === e.toolCallId), 'toolResult').data.status, 'refused');
  assert.equal(c.count(), 0); const reply = await c.prompt(); assert.equal(reply.stopReason, 'end_turn');
  assert.equal(meta(reply).openToolCalls?.length, 1, 'reservation was released');
};
export async function waitingChecks(kit) {
  for (const v of [1, 2]) {
    const label = `ACP/${v} waiting approval`;
    for (const [name, scenario] of Object.entries(cases)) await kit.attempt(`${label}: ${name}`, async () => {
      await launch(kit, name, v, async c => {
        const feature = ({ 'remove-one': 'severalActors', 'remove-last': 'severalActors', fork: 'forking', rewind: 'rewinding', 'erase-inputRequest': 'erasure', 'erase-inputAnswer': 'erasure', capacity: 'resourceReservations' })[name];
        if (feature) assert.equal(c.d[feature], true, `fixture must declare ${feature}`);
        if (name === 'move') assert.ok(c.extensions.includes('move'), 'fixture must offer move');
        if (name.startsWith('erase-')) assert.equal(c.d.erasureDuringTurn, 'allowed', 'fixture must allow erasure during a turn');
        await select(c.a, c.sid, 'model', 'conformance/echo'); await select(c.a, c.sid, 'approval', 'all');
        if (name !== 'live-offline') await c.optIn();
        await scenario(c); kit.check(`${label}: ${name}`, true);
      });
    });
  }
}

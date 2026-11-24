import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { PATH, MAX, at, clean, deadline, finalView, input, json, parse, refused, threadPath, tool, user } from './wire.mjs';

export const offer = {
  name: 'pick_color', description: 'Pick a color in the application.',
  parameters: { type: 'object', properties: { color: { type: 'string' } }, required: ['color'] },
};
export const draft = { color: 'draft-blue' };
export const dispatch = { color: 'dispatch-blue' };
export const first = 'Scripted first answer.';
export const second = 'Scripted second answer.';
export const rawReport = 'frontend-report-sentinel';
export const transformed = 'Checked frontend result.';
export const simple = [{ text: first }, { text: second }];
export const frontend = [{ toolCalls: [{ name: offer.name, input: draft }] }, { text: second }];
export const blank = threadId => ({ threadId, messages: [] });
export const opts = view => ({ cursor: view.cursor });
export const historyError = response => refused(response, 409, 'conflict', 'cursor_expired');
export const success = run => assert.equal(run.terminal.outcome?.type, 'success', 'run outcome');
export const options = { tools: [offer] };

// Required on every approval interrupt. Compare the whole object, including its keys.
export function checkApprovalCall(q, expected, surface) {
  assert.ok(Object.hasOwn(q.metadata ?? {}, 'modular-agent.approvalCall'), `${surface} approval interrupt carries modular-agent.approvalCall`);
  assert.deepEqual(q.metadata['modular-agent.approvalCall'], expected, `${surface} approvalCall matches the exact approval`);
}

export function answer(run, expected) {
  success(run);
  assert.ok(run.events.some(e => e.type === 'STEP_STARTED'), 'run follows a model step');
  const view = finalView(run);
  const message = view.messages.at(-1);
  assert.equal(message.role, 'assistant', 'last message role');
  assert.equal(message.content, expected, 'committed assistant response');
  assert.equal(run.texts.get(message.id), expected, 'live and committed text agree and use the same ID');
  return view;
}

function acpPing(origin, token) {
  return new Promise((resolve, reject) => {
    const url = new URL('/', origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url, 'modular-agent-acp-1', { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 5000 });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('ACP ping timed out')); }, 5000);
    ws.on('error', reject);
    ws.once('close', () => { clearTimeout(timer); reject(new Error('ACP closed before ping reply')); });
    ws.once('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: '$/ping', params: {} })));
    ws.once('message', bytes => {
      try {
        assert.equal(ws.protocol, 'modular-agent-acp-1');
        assert.deepEqual(JSON.parse(bytes), { jsonrpc: '2.0', id: 1, result: {} }, 'same listener answers ACP ping');
        resolve();
      } catch (error) { reject(error); }
      finally { clearTimeout(timer); ws.terminate(); }
    });
  });
}

export async function checkWaiting(api, id, questions, toolCalls, turn) {
  const row = (await api.list()).threads.find(row => row.threadId === id);
  assert.deepEqual(row?.waiting, { questions, toolCalls, turn }, 'waits are counted for this client and turn');
}

export const cases = {
  'thread-listing': { model: simple, async run({ api, origin, tokens }) {
    await refused(await api.request('/threads?limit=bad', {auth:null}), 401, 'unauthenticated');
    const firstThread = (await api.create()).threadId, other = (await api.create()).threadId;
    await api.create(); // An unused provisional session never appears.
    const view = answer(await api.run(input(blank(firstThread), [user('private listing prompt')])), first);
    answer(await api.run(input(blank(other), [user('another prompt')])), first);
    answer(await api.run(input(view, [user('change the older thread')])), second);
    const all = await api.list();
    assert.deepEqual(all.threads.map(r => r.threadId).sort(), [firstThread, other].sort(), 'only kept sessions');
    assert.ok(Date.parse(all.threads[0].updatedAt) >= Date.parse(all.threads[1].updatedAt), 'most recently changed first');
    assert.ok(Date.parse(all.threads.find(r => r.threadId === firstThread).updatedAt) >= Date.parse(all.threads.find(r => r.threadId === other).updatedAt), 'updated on subsequent turns');
    for (const row of all.threads) assert.deepEqual(row.waiting, { questions:0, toolCalls:0, turn:'none' });
    const one = await api.list('?limit=1');
    assert.ok(one.next, 'next page exists'); assert.deepEqual(one.threads, all.threads.slice(0, 1), 'first page');
    const two = await api.list('?limit=1&after=' + encodeURIComponent(one.next));
    assert.deepEqual(two, { threads:all.threads.slice(1) }, 'second page ends the listing');
    for (const query of ['?limit=0', '?limit=501', '?limit=1.5', '?after=' + randomUUID()]) {
      await refused(await api.request('/threads' + query), 400, 'invalid_request');
    }
    for (const role of ['tenant', 'project']) assert.deepEqual(await at(origin, tokens[role]).list(), {threads:[]}, 'omit threads outside scope');
    assert.deepEqual(await at(origin, tokens.watch).list(), all, 'watch is enough to list');
  } },

  'listener': { model: simple, async run({ api, origin, tokens }) {
    const denied = response => refused(response, 401, 'unauthenticated');
    const missing = randomUUID();
    await denied(await api.request('', { auth: null }));
    await denied(await api.request('/threads', { method: 'POST', body: '{}', auth: randomUUID() }));
    await denied(await api.request(threadPath(missing), { auth: null }));
    await denied(await api.request(threadPath(missing) + '/presence', { auth: null }));
    await denied(await api.post(null, { raw: '{', auth: null }));
    await denied(await api.request('?token=' + encodeURIComponent(tokens.owner), { auth: null }));
    await denied(await api.request('', { auth: null, headers: { Cookie: `token=${tokens.owner}` } }));
    const discovery = await json(await api.request(''));
    assert.equal(discovery.binding, 'modular-agent-agui/1');
    assert.equal(discovery.protocolVersion, '1.0');
    assert.ok(discovery.declaration && !Array.isArray(discovery.declaration) && typeof discovery.declaration === 'object');
    assert.ok(!(await api.request('', { headers: { Origin: 'https://unlisted.invalid' } })).headers.has('access-control-allow-origin'), 'default origin allowlist');
    const { threadId } = await api.create();
    const invalid = response => refused(response, 400, 'invalid_request');
    await invalid(await api.request('/threads', { method: 'POST', body: JSON.stringify({ project: 'outside', tenant: 'outside', mcpServers: [], settings: {} }) }));
    await refused(await api.request(threadPath(missing)), 404, 'not_found');
    if (tokens.tenant && tokens.project && tokens.watch) {
      for (const key of ['tenant', 'project']) {
        const scoped = at(origin, tokens[key]);
        await refused(await scoped.request(threadPath(threadId)), 404, 'not_found');
        await refused(await scoped.post(input(blank(threadId), [user('outside')])), 404, 'not_found');
      }
      const watch = at(origin, tokens.watch);
      const view = await watch.view(threadId);
      await refused(await watch.post(input(view, [user('watch is not input')], { actorId: 'owner' }), opts(view)), 403, 'refused');
      await refused(await watch.request('/threads', { method: 'POST', body: '{}' }), 403, 'refused');
    }
    assert.deepEqual((await api.view(threadId)).messages, [], 'rejected requests leave no messages');
    await acpPing(origin, tokens.owner);
  } },

  'encoding': { model: simple, async run({ api }) {
    const view = await api.view((await api.create()).threadId);
    const fresh = input(view, [user('valid text')]);
    const raw = JSON.stringify(fresh);
    const invalid = response => refused(response, 400, 'invalid_request');
    for (const malformed of [raw.slice(0, -1), raw.replace('"1.0"', '"1.0","protocol\\u0056ersion":"1.0"'), '\ufeff' + raw,
      raw.replace('valid text', '\\ud800'), Buffer.concat([Buffer.from(raw.replace('valid text', '').slice(0, -1)), Buffer.from([255, 125])])]) {
      await invalid(await api.post(fresh, { raw: malformed }));
    }
    for (const invalidVersion of [undefined, null, true]) await invalid(await api.post({ ...fresh, protocolVersion: invalidVersion }));
    await refused(await api.post({ ...fresh, protocolVersion: '2.0' }), 400, 'not_supported');
    for (const extra of [{ messages: null }, { tools: [null] }, { context: {} }, { resume: [{ interruptId: 10 }] }, { runId: null }]) {
      await invalid(await api.post({ ...fresh, ...extra }));
    }
    const oversized = Buffer.alloc(MAX + 1, 32);
    oversized.write(raw);
    await refused(await api.post(fresh, { raw: oversized }), 413, 'result_too_large');
    // The same input key can still be used after all these failures.
    const nested = Array.from({ length: 62 }).reduce(value => [value], true);
    const withExtras = { ...fresh, protocolVersion: '1.99', forwardedProps: { nested }, actorId: 'not-a-real-actor', parentRunId: 'must-not-be-echoed' };
    const run = await api.run(withExtras, { cursor: view.cursor, headers: { 'Last-Event-ID': 'ignored-sse-offset' } });
    const next = answer(run, first);
    clean(run.events, 'not-a-real-actor', 'must-not-be-echoed', 'ignored-sse-offset');
    answer(await api.run(input(next, [user('second prompt')], { protocolVersion: 'not-a-version-sentinel' })), second);
  } },

  'history': { model: simple, async run({ api }) {
    const initial = await api.view((await api.create()).threadId);
    const prompt = user('authoritative first prompt');
    const req = input(initial, [prompt]);
    const one = answer(await api.run(req, opts(initial)), first);
    assert.equal(one.messages[0].content, prompt.content);
    assert.notEqual(one.messages[0].id, prompt.id, 'provisional ID replaced on commitment');
    await historyError(await api.post(req));
    const snap = await api.view(one.threadId);
    assert.deepEqual(snap.messages, one.messages, 'reconnect snapshot matches committed live history');
    await historyError(await api.post(input(snap, [user('duplicate key with correct history')], { runId: req.runId }), opts(snap)));
    const suffix = [user('authoritative second prompt')];
    const next = input(snap, suffix);
    for (const cursor of [initial.cursor, randomUUID()]) await historyError(await api.post(next, { cursor }));
    const [u, a] = snap.messages;
    for (const copy of [[{ ...u, content: 'changed' }, a], [{ ...u, role: 'assistant' }, a], [a, u], [u], [user('invented earlier'), u, a], []]) {
      await historyError(await api.post({ ...next, messages: [...copy, ...suffix] }));
    }
    for (const invalid of [[], [user('extra'), ...suffix], [{ ...user('forged'), role: 'assistant' }], [{ ...user('forged'), id: 'ma:erased-or-invented' }]]) {
      const response = await api.post(input(snap, invalid));
      if (invalid[0]?.id.startsWith('ma:')) {
        assert.ok([400, 409].includes(response.status), 'server ID cannot be a new ID');
        await refused(response, response.status, 'invalid_request', 'conflict');
      }
      else await refused(response, 400, 'invalid_request');
    }
    const r2 = await api.run({ ...next, messages: [{ ...u, unknown: 'closed-shape-sentinel' }, a, ...suffix] });
    const two = answer(r2, second);
    clean(r2.events, 'closed-shape-sentinel');
    assert.deepEqual(two.messages.slice(0, 2), snap.messages, 'later work cannot amend earlier messages');
    assert.equal(r2.texts.has(a.id), false, 'no replay of live chunks in subsequent run');
    assert.equal(two.messages.filter(m => m.role === 'user').length, 2, 'one input per run');
  } },

  'stock-conversation': { model: simple, async run({ api }) {
    const { threadId } = await api.create();
    const client = api.stock(threadId);
    for (const expected of [first, second]) {
      client.addMessage(user('stock-client prompt'));
      let committed, outcome;
      await client.runAgent({ abortController: abortOnDeadline() }, {
        onMessagesSnapshotEvent: ({ event }) => { committed = event.messages; },
        onRunFinishedEvent: event => { outcome = event.outcome; },
      });
      assert.equal(outcome, 'success', 'official client sees successful outcome');
      assert.equal(client.messages.at(-1)?.content, expected, 'official client sees assistant response');
      assert.equal(committed.at(-1).content, expected);
      // An app replaces provisional IDs and content with the committed snapshot.
      client.messages = committed;
    }
  } },

  'frontend': { model: frontend, async run({ api, origin, tokens }) {
    const start = await api.view((await api.create()).threadId);
    assert.equal(start.declaration.interfaceTools, true, 'Interface tool declaration');
    const prompt = user('request frontend tool');
    const r1 = input(start, [prompt], options);
    for (const tools of [[{ ...offer, name: 'made-up' }], [offer, offer], [{ ...offer, description: 'different' }], [{ ...offer, parameters: {} }]]) {
      await refused(await api.post({ ...r1, tools }, opts(start)), 403, 'refused');
    }
    const { id } = handoff(await api.run(r1, opts(start)));
    await checkWaiting(api, start.threadId, 0, 1, 'none');
    const nextConnection = at(origin, tokens.rotated ?? tokens.owner);
    const view = await nextConnection.view(start.threadId);
    assert.deepEqual(view.waiting.toolCalls.map(call => call.toolCallId), [id], 'same executor route can reconnect to a wait');
    clean(view, 'draft-blue', 'dispatch-blue');
    for (const key of ['sibling', 'foreign']) if (tokens[key]) {
      const other = at(origin, tokens[key]);
      await checkWaiting(other, start.threadId, 0, 0, 'none');
      const copy = await other.view(start.threadId);
      assert.deepEqual(copy.waiting.toolCalls, [], 'other actor or route does not inherit wait');
      clean(copy, 'dispatch-blue');
      await reportRefused(await other.post(input(copy, [tool(id, 'foreign result')]), opts(copy)));
    }
    await historyError(await nextConnection.post(input(view, [], { resume: [{ interruptId: id, status: 'resolved', payload: 'not a tool report' }] }), opts(view)));
    await refused(await nextConnection.post(input(view, [user('mixed new input'), tool(id, rawReport)]), opts(view)), 400, 'invalid_request');
    await reportRefused(await nextConnection.post(input(view, [tool(id, rawReport), tool('unknown-call', 'invalid')]), opts(view)));
    const report = input(view, [{ ...tool(id, rawReport), metadata: { actorId: 'forged-report-actor', status: 'refused' } }]);
    const r2 = await nextConnection.run(report, opts(view));
    const final = answer(r2, second);
    assert.equal(r2.calls.size, 0, 'continuation cannot redispatch or emit another raw tool result');
    const message = final.messages.find(m => m.role === 'tool');
    assert.equal(message?.toolCallId, id, 'result keeps canonical call ID');
    assert.equal(message?.content, transformed, 'tool.after output is committed and projected');
    assert.equal(message?.error, undefined, 'metadata cannot set result status');
    clean(r2.events, rawReport, 'forged-report-actor');
    await historyError(await nextConnection.post(report, opts(view)));
    assert.equal(final.messages.filter(m => m.role === 'user').length, 1, 'no new input for the result-only run');
  } },

  'stock-frontend': { model: frontend, async run({ api }) {
    const { threadId } = await api.create();
    const client = api.stock(threadId);
    client.addMessage(user('stock-client frontend request'));
    let committed, received, pending;
    await client.runAgent({ ...options, abortController: abortOnDeadline() }, {
      onMessagesSnapshotEvent: ({ event }) => { committed = event.messages; },
      onToolCallEndEvent: ({ event, toolCallArgs, toolCallName }) => { received = { id: event.toolCallId, toolCallArgs, toolCallName }; },
      onRunFinishedEvent: result => { pending = result.pendingToolCallIds; },
    });
    assert.deepEqual(pending, [received?.id], 'official client can identify the terminal handoff');
    assert.equal(received.toolCallName, offer.name);
    assert.deepEqual(received.toolCallArgs, dispatch);
    client.messages = committed;
    client.addMessage(tool(received.id, '', 'application declined'));
    let outcome;
    await client.runAgent({ abortController: abortOnDeadline() }, {
      onMessagesSnapshotEvent: ({ event }) => { committed = event.messages; },
      onRunFinishedEvent: event => { outcome = event.outcome; },
    });
    assert.equal(outcome, 'success');
    assert.equal(committed.at(-1).content, second);
    assert.match(committed.find(m => m.role === 'tool')?.error ?? '', /application declined/, 'failure is projected on the tool snapshot');
  } },
};

export async function reportRefused(response) {
  assert.ok([403, 409].includes(response.status), 'report is refused before mutation');
  await refused(response, response.status, 'refused', 'conflict', 'cursor_expired');
}

function abortOnDeadline() {
  const controller = new AbortController();
  const signal = deadline();
  signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  return controller;
}

export function handoff(run) {
  success(run);
  assert.equal(run.pending.length, 1, 'one terminal frontend handoff');
  const [call] = run.pending;
  assert.equal(call.start.toolCallName, offer.name);
  assert.deepEqual(parse(call.args), dispatch, 'actual transformed arguments, not the executable draft');
  clean(finalView(run), 'draft-blue', 'dispatch-blue');
  return call;
}
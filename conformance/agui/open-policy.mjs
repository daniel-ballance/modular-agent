import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { at, deadline, input, json, refused, threadPath, user } from './wire.mjs';
import { blank, simple, success } from './cases.mjs';

async function acp(peer, role, work) {
  const url = new URL('/', peer.origin);
  url.protocol = 'ws:';
  const socket = new WebSocket(url, 'modular-agent-acp-1', {
    headers: { Authorization: `Bearer ${peer.tokens[role]}` }, handshakeTimeout: 5000,
  });
  let id = 0;
  try {
    await once(socket, 'open', { signal: deadline() });
    async function call(method, params) {
      const request = { jsonrpc: '2.0', id: ++id, method, params };
      const done = new Promise((resolve, reject) => {
        const signal = deadline();
        function clean() {
          socket.off('message', receive);
          socket.off('error', fail);
          signal.removeEventListener('abort', fail);
        }
        function fail(error) { clean(); reject(error); }
        function receive(data) {
          const response = JSON.parse(data);
          if (response.id === request.id) { clean(); resolve(response); }
        }
        socket.on('message', receive);
        socket.once('error', fail);
        signal.addEventListener('abort', fail, { once: true });
      });
      socket.send(JSON.stringify(request));
      return done;
    }
    const initialized = await call('initialize', { protocolVersion: 1, clientCapabilities: {} });
    assert.ok(initialized.result, JSON.stringify(initialized));
    return await work(call);
  } finally { socket.terminate(); }
}

const idFor = { foreign: 'kit-other', 'default-join': 'acp-user', departed: 'kit-departed', outside: 'kit-outside', 'no-watch': 'kit-no-watch' };
const denied = ['default-join', 'outside', 'departed', 'no-watch'];
async function grants(peer, threadId) {
  return (await peer.control('inspect', { threadId })).batches.flat()
    .filter(e => e.kind === 'actorJoined' || e.kind === 'actorLeft')
    .map(e => [e.kind, e.data.actor?.id ?? e.data.actorId]);
}
async function seed(peer) {
  const { threadId } = await peer.api.create();
  const request = input(blank(threadId), [user('Keep this multi-member session.')]);
  success(await peer.api.run(request));
  const { project: cwd } = await peer.control('inspect', { threadId });
  const params = { sessionId: threadId, cwd, mcpServers: [] };
  await acp(peer, 'owner', async call => {
    const open = await call('session/load', params);
    assert.ok(open.result, JSON.stringify(open));
    assert.equal(open.result._meta['modular-agent'].declaration.severalActors, true);
    const actor = { id: idFor.departed, kind: 'user', rights: ['watch'] };
    for (const [method, rest] of [['join', { actor, present: false }], ['leave', { actorId: actor.id }]]) {
      const reply = await call('_modular-agent/' + method, { sessionId: threadId, ...rest });
      assert.ok(reply.result, JSON.stringify(reply));
    }
  });
  return { threadId, params };
}
async function verify(peer, { threadId, params }, protocol, phase) {
  const initial = await grants(peer, threadId);
  assert.deepEqual(initial.filter(([, actor]) => actor !== 'user'),
    [['actorJoined', 'kit-owner'], ['actorJoined', idFor.departed], ['actorLeft', idFor.departed]], 'seeded membership: ' + JSON.stringify(initial));
  for (const role of [...denied, 'owner', 'foreign']) {
    if (phase === 'kept' && role === 'foreign') peer = await peer.restart();
    const label = `${protocol} ${phase} ${role}`;
    const visible = !denied.includes(role);
    if (protocol === 'ACP') {
      await acp(peer, role, async call => {
        const list = await call('session/list', {});
        if (role === 'no-watch' && list.error) assert.equal(list.error.data?.code, 'forbidden', label);
        else assert.equal(list.result?.sessions.some(s => s.sessionId === threadId), visible, label + ' discovery: ' + JSON.stringify(list));
        assert.deepEqual(await grants(peer, threadId), initial, label + ' list recorded membership');
        const opened = await call(phase === 'live' ? 'session/resume' : 'session/load', params);
        if (visible) assert.ok(opened.result, label + ': ' + JSON.stringify(opened));
        else assert.equal(opened.error?.data?.code, 'forbidden', label);
      });
    } else {
      const api = at(peer.origin, peer.tokens[role]);
      assert.equal((await api.list()).threads.some(t => t.threadId === threadId), visible, label + ' discovery');
      assert.deepEqual(await grants(peer, threadId), initial, label + ' list recorded membership');
      const response = await api.request(threadPath(threadId));
      if (visible) assert.equal((await json(response)).threadId, threadId, label);
      else await refused(response, 404, 'not_found');
    }
    const expected = role === 'foreign' ? [...initial, ['actorJoined', idFor.foreign]] : initial;
    assert.deepEqual(await grants(peer, threadId), expected, label + ' membership history');
  }
}

export const openPolicy = {
  model: simple, control: true, restart: true, roles: ['default-join', 'outside', 'departed', 'no-watch', 'foreign'],
  async run(peer) {
    for (const protocol of ['ACP', 'AG-UI']) await verify(peer, await seed(peer), protocol, 'live');
    const kept = [await seed(peer), await seed(peer)];
    // A recorded-member probe would reopen the session before testing an opt-in.
    // Restart again between probes that open it successfully.
    for (const [index, protocol] of ['ACP', 'AG-UI'].entries()) {
      peer = await peer.restart();
      await verify(peer, kept[index], protocol, 'kept');
    }
  },
};

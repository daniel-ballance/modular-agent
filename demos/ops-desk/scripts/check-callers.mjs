import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join } from 'node:path';
import { CONTROL_MS, PLUGIN_PROTOCOL, endpoint, readToken, upgradeStatus } from '../../../conformance/tools/websocket.mjs';

const [address, coderThread] = process.argv.slice(2);
const url = endpoint(address);
assert.equal(url.hostname, '127.0.0.1');
const root = process.cwd();

async function rpc(ws, id, method, params) {
  const reply = once(ws, 'message', { signal: AbortSignal.timeout(CONTROL_MS) });
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  const [{ data }] = await reply;
  const response = JSON.parse(data);
  assert.equal(response.id, id, 'wrong RPC response');
  return response;
}

assert.deepEqual(await upgradeStatus(url, PLUGIN_PROTOCOL, 'not-a-desk-token'), { status: 401, upgraded: false });
for (const agent of ['triage', 'coder', 'verifier']) {
  const claim = agent === 'coder' ? 'verifier' : 'coder';
  const project = join(root, 'trees', claim);
  const token = readToken(join(root, agent + '-tools.token'));
  const ws = new WebSocket(url, { protocols: [PLUGIN_PROTOCOL], headers: { Authorization: `Bearer ${token}` } });
  try {
    await Promise.race([
      once(ws, 'open', { signal: AbortSignal.timeout(CONTROL_MS) }),
      once(ws, 'error', { signal: AbortSignal.timeout(CONTROL_MS) }).then(() => { throw Error('WebSocket connection failed'); })
    ]);
    assert.equal(ws.protocol, PLUGIN_PROTOCOL);
    const { result } = await rpc(ws, 'init', 'plugin/initialize', {
      binding: 'modular-agent-plugin/1', host: { name: claim, version: '1' }, project,
      home: join(root, 'home'), config: { callerId: claim }
    });
    assert.equal(result.toolSources.length, 1);
    const [source] = result.toolSources;
    const names = source.tools.map(tool => tool.name).sort();
    assert.deepEqual(names, agent === 'verifier' ? ['post'] : ['hand_off', 'post'], 'claim changed registration');
    if (agent === 'verifier') {
      const reply = await rpc(ws, 'post', 'tools/call', {
        toolSource: source.id, sessionId: coderThread, project,
        call: { id: 'claimed-post', name: 'post', actorId: 'coder', startedBy: 'model',
          input: { kind: 'change', text: 'Not from the coder.' } }
      });
      assert.ok(['refused', 'failed'].includes(reply.result?.status), 'verifier posted as coder');
    }
  } finally {
    ws.close();
  }
}

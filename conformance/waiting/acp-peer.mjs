// A second authenticated connection to the same writer, not a second writer.
import { ACP_PROTOCOL, endpoint, socketPeer } from '../tools/websocket.mjs';

export async function acpPeer(url, token) {
  const pending = new Map(), permissions = [];
  let id = 0;
  const wire = socketPeer({ url: endpoint(url), protocol: ACP_PROTOCOL, token }, (_, msg) => {
    if (!msg || !Object.hasOwn(msg, 'id')) return;
    if (msg.method) {
      if (msg.method === 'session/request_permission') permissions.push(msg.params);
      wire.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...(msg.method === 'session/request_permission' ?
        { result: { outcome: { outcome: 'selected', optionId: 'refuse' } } } : { error: { code: -32601, message: 'Not supported' } }) }));
    } else {
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.error) waiter.reject(Object.assign(new Error('ACP request refused'), { code: msg.error.code, data: msg.error.data }));
      else waiter.resolve(msg.result);
    }
  });
  await wire.ready;
  void wire.closed.then(() => { for (const w of pending.values()) w.reject(new Error('ACP connection closed')); pending.clear(); });
  return { permissions, close: async () => { wire.end(); await wire.closed; }, request(method, params) {
    const msg = { jsonrpc: '2.0', id: ++id, method, params };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      if (!wire.send(JSON.stringify(msg), msg)) { pending.delete(id); reject(new Error('ACP connection closed')); }
    });
  } };
}

// Self-test service. The files named by this fixture must be in the kit's
// scratch directory. Its environment is a map: it never runs a command.
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { rpcError } from './peer.mjs';

const fault = process.argv[2], root = process.cwd();
function local(path) {
  if (dirname(path) !== root) throw Error('expected a kit scratch file');
  return path;
}
const cfg = JSON.parse(readFileSync(local(process.env.MA_PLUGIN_FIXTURE), 'utf8'));
const ids = new Set(), table = new Map();
function invalid() { console.log(JSON.stringify({ error: 'invalid_composition' })); process.exit(1); }
if (cfg.tokenFile && fault !== 'allow-mixed-table') invalid();
for (const { callerId, tokenFile } of cfg.callers) {
  const token = readFileSync(local(tokenFile), 'utf8').trim();
  if (ids.has(callerId) && fault !== 'allow-duplicate-id' || table.has(token) && fault !== 'allow-duplicate-token') invalid();
  ids.add(callerId); table.set(token, callerId);
}
const audit = (event, callerId) => appendFileSync(local(cfg.auditFile), JSON.stringify({ event, callerId }) + '\n');
const stored = new Map(), files = new Map(), live = new Set(), pair = [];
const server = createServer((req, res) => { res.writeHead(404); res.end(); });
const sockets = new WebSocketServer({ noServer: true });
const send = (ws, msg) => ws.send(JSON.stringify({ jsonrpc: '2.0', ...msg }));
function settle(work, result) {
  if (!work.ws.calls.delete(work.m.id)) return;
  send(work.ws, { id: work.m.id, result });
}
function callback(target, work) {
  target.callbacks.set('callback-1', work); // Same callback, parent, call and session IDs on both connections.
  send(target, { method: 'host/env/exec', id: 'callback-1', params: { parentRequestId: work.m.id, sessionId: work.m.params.sessionId,
    cwd: work.m.params.project, command: work.m.params.call.input.command } });
}
server.on('upgrade', (req, socket, head) => {
  const callerId = table.get(req.headers.authorization?.slice('Bearer '.length));
  if (!callerId) {
    if (fault === 'setup-before-auth') audit('factory', 'unmatched');
    return socket.end(`HTTP/1.1 ${fault === 'wrong-token-status' ? '403 Forbidden' : '401 Unauthorized'}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  }
  sockets.handleUpgrade(req, socket, head, ws => {
    ws.callerId = callerId;
    if (fault !== 'no-factory-audit') audit('factory', callerId);
    ws.callbacks = new Map(); ws.calls = new Map(); live.add(ws);
    ws.once('close', () => live.delete(ws));
    const project = cfg.scopes.find(s => s.callerId === callerId).project;
    ws.on('message', bytes => {
      const m = JSON.parse(bytes), p = m.params, reply = result => send(ws, { id: m.id, result });
      const fail = code => send(ws, { id: m.id, error: rpcError(code) });
      if (!m.method) {
        const work = ws.callbacks.get(m.id);
        if (work) settle(work, { status: m.error ? 'cancelled' : 'completed', content: [{ type: 'text', text: m.result?.output ?? 'Cancelled.' }] });
        return;
      }
      if (m.method === '$/ping') return reply({});
      if (m.method === 'plugin/initialize') {
        ws.claim = p.config.callerId; ws.home = p.home;
        if (p.project !== project) return fail('not_supported');
        audit('setup', callerId);
        return reply({ binding: 'modular-agent-plugin/1', name: 'fake-named', workingEnvironment: { containment: 'none' },
          toolSources: [{ id: 'fixture', tools: ['bash', 'caller_probe'].map(name => ({ name, description: name, parameters: true })) }] });
      }
      if (m.method === 'tools/call' && p.call.name === 'caller_probe') {
        const { callerId: claim, write } = p.call.input;
        const selected = fault === 'trust-config' ? ws.claim : fault === 'trust-input' ? claim : callerId;
        const slot = fault === 'shared-home-state' ? ws.home : fault === 'state-by-input' ? claim : fault === 'state-by-config' ? ws.claim : fault === 'state-by-socket' ? ws : callerId;
        const previous = stored.get(slot) ?? null;
        if (write !== undefined) stored.set(slot, write);
        return reply({ status: 'completed', content: [], value: { previous, callerId: selected } });
      }
      if (m.method === 'tools/call' && p.call.name === 'bash') {
        const work = { ws, m }; ws.calls.set(m.id, work);
        if (fault === 'cross-callback') {
          pair.push(work);
          if (pair.length === 2) {
            const [a, b] = pair.splice(0); const swap = a.ws.callerId !== b.ws.callerId;
            callback(swap ? b.ws : a.ws, a); callback(swap ? a.ws : b.ws, b);
          }
        } else callback(ws, work);
        return;
      }
      if (m.method === '$/cancel') {
        for (const other of live) if (other === ws || (fault === 'cross-cancel' && other.callerId !== callerId) || (fault === 'same-cancel' && other.callerId === callerId)) {
          const work = other.calls.get(p.id);
          if (work) settle(work, { status: 'cancelled', content: [{ type: 'text', text: 'Cancelled.' }] });
        }
        return;
      }
      if (m.method === 'env/read' || m.method === 'env/write') {
        const path = resolve(p.cwd, p.path), wrong = fault === 'wrong-project' || fault === 'reconnect-project' && ws.claim === callerId;
        if (!wrong && (p.cwd !== project || dirname(path) !== project)) return fail('invalid_request');
        if (m.method === 'env/write') { files.set(path, p.data); return reply({}); }
        return files.has(path) ? reply({ data: files.get(path) }) : fail('not_found');
      }
      fail('method_not_found');
    });
  });
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: `ws://127.0.0.1:${server.address().port}/` })));

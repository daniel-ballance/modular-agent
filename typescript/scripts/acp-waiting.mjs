// Disposable waiting-approval application. The controls never answer a request or call a tool.
import assert from 'node:assert/strict';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ALL_AUTHORITY, Harness } from '@modular-agent/harness';
import { approval } from '@modular-agent/approval';
import { cliAgentFromHarness } from '@modular-agent/core/internal-cli';
import { localEnvironment } from '@modular-agent/env-local';
import { JsonlHistoryStore } from '@modular-agent/history-jsonl';
import { ACP_PROTOCOL, conformanceProvider, conformanceTools, connectWebSocket } from '@modular-agent/plugin-wire';
import { durableRuntime } from '@modular-agent/runtime-durable';

assert.equal(process.env.MODULAR_AGENT_CONFORMANCE, '1');
const config = JSON.parse(await readFile(process.env.MA_ACP_WAIT_FIXTURE, 'utf8'));
const {clock, project, tokenFiles, ready, maxApprovalWaitMs} = config;
const home = process.env.MODULAR_AGENT_DATA_DIR, directory = join(home, 'history');
const now = () => Number(JSON.parse(readFileSync(clock, 'utf8')));
const gates = new Map(), latches = new Map();
async function boundary(at) {
  const latch = latches.get(at);
  if (latch) { latch.reached.resolve(); await latch.release.promise; }
}
const fences = new Map();
class Store extends JsonlHistoryStore {
  writerSignal(id) {
    if (!fences.has(id)) fences.set(id, new AbortController());
    return fences.get(id).signal;
  }
  async append(id, entries) {
    this.writerSignal(id).throwIfAborted();
    await super.append(id, entries);
    appendFileSync(join(home, id + '.batches'), JSON.stringify(entries.map(e => e.id)) + '\n');
    if (entries.some(e => e.kind === 'inputAnswer')) await boundary('answerCommit');
    if (entries.some(e => e.kind === 'turnStart' && e.continuesTurnId)) await boundary('continuationStart');
  }
}
const store = new Store(directory);
// Only the corrupt-state test asks for this. Drop the proof before any writer opens the disposable store.
if (config.reopen === 'missing-proof') {
  for (const file of await readdir(directory, {recursive:true})) if (file.endsWith('.jsonl')) {
    const path = join(directory, file);
    const rows = (await readFile(path, 'utf8')).trimEnd().split('\n').map(x => JSON.parse(x));
    for (const {entry} of rows) if (entry?.kind === 'inputAnswer') delete entry.data.approvalView;
    await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  }
}

const worker = {id:'worker', kind:'host', rights:ALL_AUTHORITY.filter(r => r !== 'approve')};
const approvers = ['approver', 'other'].map(id => ({id, kind:'user', rights:['watch','answer','approve']}));
const others = ['answerOnly','tenant','representative'].map(id => ({id,kind:'user',rights:['watch','answer']}));
const harness = new Harness({ project, home, now, questionsOutlastTurns:true,
  resourceReservations:config.name === 'capacity' ? {session:{calls:1}} : {} });
const api = harness.api('fixture');
await harness.load([conformanceProvider(), conformanceTools(), localEnvironment({cwd:project}),
  durableRuntime(), approval({policy:'all'}), { name:'fixture', setup(api) {
    api.provide('history-store',store);
    api.on('session.prepare', async ({sessionId,resumed}) => {
      if (!resumed) for (const a of approvers) await api.openSession(sessionId,{id:a.id,kind:a.kind,authority:a.rights});
    });
    api.on('turn.end', () => boundary('requestPending'));
    api.on('tool.before', () => boundary('beforeHandoff'), 'last');
    api.on('tool.after', () => boundary('afterEffect'));
    api.on('output', ({recipient,events}) => {
      const gate = gates.get(recipient);
      if (!gate || gate === 'pass') return;
      for (const e of events) if (e.type === 'reply' && e.data?.method === '_modular-agent/requests') {
        if (gate === 'block') return {action:'block'};
        for (const q of e.data.result.requests) if (q.call) q.call.input = {};
        return {action:'pass',events};
      }
    });
  }}]);
if (config.reopen !== 'unsupported') harness.enableWaitingApprovals(maxApprovalWaitMs);
const agent = await cliAgentFromHarness(harness, project);
const workerToken = join(home, 'worker.token');
await writeFile(workerToken, randomBytes(32).toString('hex'), {mode:0o600});
const actors = [worker,...approvers,...others].map(actor => ({
  actor, projects:[project], tokenFile:actor === worker ? workerToken : tokenFiles[actor.id],
  tenants:actor.id === 'tenant' ? ['outside'] : [null],
  ...(actor.id === 'representative' && {represents:['approver']}),
}));
const listener = await agent.serveAcp({listen:'127.0.0.1:0', actors, hostMcpServers:false});

async function control({operation,sessionId:id,at,role,mode,kind,right}) {
  // IDs may be used as file names only for sessions the application actually created.
  if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) throw Error('Invalid session');
  const revoke = async (actorId, right) => {
    assert.ok(['approver','other'].includes(actorId));
    const a = api.session(id).actors.find(a => a.id === actorId);
    await api.join(id,{...a,authority:a.authority.filter(r => r !== right)},worker.id);
  };
  switch (operation) {
    case 'inspect': {
      const entries = new Map((await store.load(id)).entries.map(e => [e.id,e]));
      const lines = (await readFile(join(home, id + '.batches'),'utf8')).trim().split('\n');
      return {batches:lines.map(line => JSON.parse(line).map(i => entries.get(i)))};
    }
    case 'idle': if (!store.writerSignal(id).aborted) await api.waitForIdle(id); break;
    case 'tick': await api.refreshApprovals(id); break;
    case 'pause': latches.set(at,{reached:Promise.withResolvers(),release:Promise.withResolvers()}); break;
    case 'reached': await latches.get(at).reached.promise; break;
    case 'release':
      for (const [key,latch] of latches) if (!at || key === at) { latch.release.resolve(); latches.delete(key); }
      break;
    case 'gate': gates.set(role,mode); break;
    case 'revoke': await revoke(role,right); break;
    case 'cut':
      if (kind === 'worker-ceiling') {
        await api.openSession(id,{id:'operator',kind:'host',authority:ALL_AUTHORITY});
        await api.setLimit(id,ALL_AUTHORITY.filter(r => r !== 'tools'),'operator');
      }
      else if (kind === 'approver-rights') await revoke('approver','approve');
      else if (kind === 'stale-writer') fences.get(id).abort(Error('Fixture lease lost'));
      else if (kind === 'route-authorization') {
        const decision = api.history(id).findLast(e => e.kind === 'inputAnswer');
        const route = decision.data.approvalView.routeId;
        api.registerApprovalRoute({id:route,ceiling:() => [],unchanged:async () => false});
      } else throw Error('Unknown cut');
      break;
    default: throw Error('Unknown control operation');
  }
  return {};
}
const hash = s => createHash('sha256').update(s).digest();
const bearer = hash('Bearer ' + (await readFile(tokenFiles.control,'utf8')).trim());
const controls = createServer(async (req,res) => {
  if (req.method !== 'POST' || !timingSafeEqual(bearer,hash(req.headers.authorization ?? ''))) {
    res.writeHead(403).end(); return;
  }
  try {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 65536) throw Error('Invalid control'); }
    const result = await control(JSON.parse(body));
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(result));
  } catch (error) { console.error('Waiting fixture:',error.message); res.writeHead(400).end(); }
});
await new Promise((resolve,reject) => controls.once('error',reject).listen(0,'127.0.0.1',resolve));
// A stdio worker and independently authenticated ACP clients share one real listener and writer.
const socket = await connectWebSocket(listener.url,workerToken,ACP_PROTOCOL,5000);
socket.on('message', data => process.stdout.write(data.toString() + '\n'));
await writeFile(ready,JSON.stringify({acp:listener.url,control:'http://127.0.0.1:' + controls.address().port}),{mode:0o600});
try { for await (const line of createInterface({input:process.stdin})) socket.send(line); }
finally { socket.close(); controls.close(); await listener.close(); }

// Controlled, disposable SDK application for conformance/agui. No controls are part of ma.
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { mock } from 'node:test';
import { trace } from '@opentelemetry/api';
import { SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { createAgent, defaultAcpActor, definePlugin, durableRuntime, transientRuntime, tool } from '@modular-agent/core';
import { memoryEnvironment } from '@modular-agent/core/testing';
import { JsonlHistoryStore } from '@modular-agent/history-jsonl';
import { loadScript } from '../packages/ma/dist/src/script.js';
import { disposableTls } from '../../conformance/agui/tls-fixture.mjs';

const env = process.env;
const { name, tokenFiles, project, offer, controlTokenFile } = JSON.parse(await readFile(env.MA_AGUI_FIXTURE, 'utf8'));
const dataDir = env.MODULAR_AGENT_DATA_DIR;
const { rights } = defaultAcpActor();
const actors = Object.entries(tokenFiles).map(([role, tokenFile]) => ({ tokenFile,
  actor: { id: role === 'foreign' ? 'kit-foreign' : 'kit-owner', kind: 'user', rights: role === 'watch' ? ['watch'] : rights },
  clientId: ['owner','rotated'].includes(role) ? 'kit-primary' : `kit-${role}`, projects: role === 'project' ? [] : [project],
  tenants: role === 'tenant' ? ['other'] : ['kit'], traceTrusted: ['owner','rotated'].includes(role) }));
const waiting = name.startsWith("waiting-");
const redacted = new Set();
const source = { sourceId: 'palette', actorId: 'kit-owner', routeId: 'kit-primary', resultTimeoutMs: 60000, tools: [{ ...offer, ...(name.startsWith("waiting-mixed") ? { hints: { readOnly: true } } : {}), callers: ['model'] }] };
// Export synchronously. export() must not depend on advancing the question clock.
const captured = [];
const exporter = { export(spans, callback) { captured.push(...spans); callback({code:0}); }, async shutdown() {} };
const tracer = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
trace.setGlobalTracerProvider(tracer);
const controlledClock = waiting || ['approval-expired','questions','report-cutoffs'].includes(name);
if (controlledClock) mock.timers.enable({ apis: ['Date', 'setTimeout'], now: waiting ? 1_800_000_000_000 : Date.now() });
const barriers = new Map();
function latch(id, at) {
  const key = JSON.stringify([id,at]);
  if (!barriers.has(key)) barriers.set(key, Promise.withResolvers());
  return barriers.get(key);
}
async function pause(id, at) { latch(id, at).resolve(); await latch(id, 'release').promise; }
const lines = async file => (await readFile(file, 'utf8').catch(e => { if (e.code !== 'ENOENT') throw e; return ''; })).trim().split('\n').filter(Boolean).map(x => JSON.parse(x));
class Store extends JsonlHistoryStore {
  supports = { ...this.supports, persistent: true, portableSessions: true };
  async append(id, entries) {
    if (name === 'crash-before-handoff' && entries.some(e => e.kind === 'toolStarted')) await pause(id, 'beforeHandoff');
    await super.append(id, entries);
    // Only IDs in the observation log. Read current bodies, including tombstones, from the store on inspect.
    await appendFile(join(dataDir, `${id}.batches`), JSON.stringify(entries.map(e => e.id)) + '\n');
    if (name === 'crash-after-result' && entries.some(e => e.kind === 'toolResult')) await pause(id, 'afterResult');
    if (name === 'crash-continuation' && entries.some(e => e.kind === 'turnStart' && e.continuesTurnId)) await pause(id, 'duringContinuation');
    if (entries.some(e => e.kind === 'turnEnd') && this.continuations?.has(id)) latch(id,'continuationEnded').resolve();
    if (entries.some(e => e.kind === 'turnStart' && e.continuesTurnId)) (this.continuations ??= new Set()).add(id);
    if (entries.some(e => e.kind === 'inputAnswer')) latch(id,'answerCommitted').resolve();
    if (entries.some(e => e.kind === 'toolResult')) latch(id,'reportCommitted').resolve();
    if (entries.some(e => e.kind === 'turnEnd')) latch(id, 'turnEnd').resolve();
    if (entries.some(e => e.kind === 'turnStart' && e.continuesTurnId)) latch(id, 'continued').resolve();
    if (entries.some(e => e.kind === 'toolResult')) latch(id, 'settled').resolve();
  }
}
const store = new Store(join(dataDir, 'kit-history'));
const sessions = new Map(), documents = new Map(), warnings = [], erasures = new Map();
const state = name === 'state-and-gate';
const snapshot = id => documents.get(id) ?? { revisionId: '0', snapshot: { counter: 0 } };
const ns = 'modular-agent.agui.';
const question = tool({ name: 'kit_choice', description: 'Ask a test question', input: {type:'object'}, callers: ['ui'],
  async run(_input, cx) { await cx.ask({ kind: 'choice', question: 'Choose a color?', options: ['yes','no'], timeLimitMs: 5000 }); return ''; } });
const plugin = definePlugin({ name: 'kit', replaces: ['history-store'], setup(r) {
  r.historyStore(store);
  if (waiting) {
    const increment = async () => { await appendFile(join(dataDir, 'counter'), '1'); return 'Incremented'; };
    if (name === 'waiting-restart') r.tool(tool({ name:'increment', description:'Increment', input:{type:'object'}, callers:['plugin'], run:increment }));
    r.tool(tool({ name:'bump', description:'Increment the counter', input:{type:'object'},
      run: (_, cx) => name === 'waiting-restart' ? cx.tools.call('increment', {}) : increment() }));
  }
  if (['questions','mixed'].includes(name)) r.tool(question);
  r.on('session.start', async ({sessionId, resumed}) => {
    if (!resumed) sessions.set(sessionId, await agent.openSession(sessionId));
  });
  r.on('tool.before', ({call}) => { if (call.name === offer.name && call.input.color === 'draft-blue') return { change: { color: 'dispatch-blue' } }; }, 'first');
  r.on('tool.after', ({call,result}) => { if (call.name === offer.name && result.status === 'completed') return { change: { content: [{ type: 'text', text: 'Checked frontend result.' }] } }; });
  if (name === 'questions') r.on('turn.start', ({sessionId}) => sessions.get(sessionId).callTool('kit_choice', {}).then(() => {}));
  if (name === 'mixed') r.on('step.after', async ({sessionId,response}) => { if (response.content.some(p => p.type === 'toolCall')) await sessions.get(sessionId).callTool('kit_choice', {}); });
  if (state) r.on('step.before', ({sessionId}, cx) => {
    const delta = (base, next) => { documents.set(sessionId, { revisionId: String(next), snapshot: {counter:next} }); cx.emit(ns+'stateDelta', { baseRevisionId: String(base), revisionId: String(next), delta: [{op:'replace',path:'/counter',value:next}] }); };
    delta(0,1); delta(0,2); delta(2,3);
    const snap = { revisionId:'4', snapshot:{counter:4} }; documents.set(sessionId,snap); cx.emit(ns+'stateSnapshot',snap); delta(4,5);
    cx.emit('kit.visible',{test:true}); cx.emit('kit.withheld',{copy:'withheld-extension-sentinel'}); cx.emit(ns+'raw',{event:{type:'fixture.foreign'}});
  });
  if (name === 'output-size') r.on('step.before', (_,cx) => cx.emit('kit.oversized', { copy: 'expanded by gate' }));
  r.on('output', async ({ sessionId, recipient, events }) => {
    const event = events[0], d = event.data;
    if (name === 'release-gate' && event.type === 'reply' && d.method === 'agui.events' && d.result.some(e => e.type === 'TOOL_CALL_START')) await pause(sessionId, 'beforeRelease');
    if ((name === 'approval-redacted' || redacted.has(d?.clientId)) && d?.method === 'agui.interrupt') d.interrupt.message = 'Changed arguments';
    else if (name === 'error-gate' && (d?.method === 'agui.discovery' || event.type === 'turnEnded' && d.outcome.kind === 'failed')) return 'block';
    else if (name === 'output-size' && event.type === 'kit.oversized') d.copy = 'x'.repeat(64*1024*1024);
    else if (name === 'output-size' && d?.method === 'agui.snapshot' && d.clientId === 'kit-sibling') d.result.messages.at(-1).content = 'x'.repeat(64*1024*1024);
    else if (state && d?.method === 'agui.snapshot' && d.clientId === 'kit-sibling' || state && (event.type === 'kit.withheld' || event.type === ns+'stateDelta' && d.revisionId === '3')) return 'block';
    else if (state && recipient === 'kit-owner' && events.some(e => e.type === 'text')) { for (const e of events) if (e.type === 'text') e.data.delta = 'Gated text.'; }
    else if (state && recipient === 'kit-owner' && event.type === 'entry' && d.entry.message?.role === 'assistant') { for (const p of d.entry.message.content) if (p.type === 'text') p.text = 'Gated text.'; }
    else return;
    return {redact:events};
  });
} });
const plugins = [plugin];
if (state) plugins.push(definePlugin({name:'other', hooks:{'step.before':(_,cx) => cx.emit(ns+'stateSnapshot',{revisionId:'bad',snapshot:'wrong-plugin-sentinel'})}}));
const runtime = name === 'crash-continuation' ? durableRuntime() : transientRuntime();
if (state) {
  const run = runtime.runTurn.bind(runtime);
  runtime.runTurn = async (input, host, signal) => { await host.record({kind:'kit.entry', writer:'kit', modelVisible:false, data:{visible:true}}); return run(input,host,signal); };
}
const script = await loadScript(env.MODULAR_AGENT_SCRIPT, env.MODULAR_AGENT_SCRIPT_LOG);
const provider = state ? { ...script, async request(...args) { const m = await script.request(...args); return { ...m, providerData:'provider-only-sentinel' }; } } : script;
const agent = await createAgent({ project, severalActors: true, sessionLimits: true, tenants: { kit: {rights} }, environment: memoryEnvironment(), runtime,
  durability: name === 'crash-continuation' ? 'durable' : 'kept', dataDir, interfaceTools: [source], plugins, approval: name.startsWith('waiting-mixed') ? 'ask' : waiting || name.startsWith('approval') ? 'all' : 'off',
  approvalCoversNested: waiting || name.startsWith('approval'),
  ...(waiting ? { questionsOutlastTurns:true, maxApprovalWaitMs:5000 } : {}),
  settings:{approvalWaitMs:5000, ...(waiting && name !== 'waiting-live' ? {approvalWait:'untilDeadline'} : {})}, providers:[provider] });
// Observe delivery at the real connection callback, not a model draft or a snapshot.
const connect = agent.connectInterfaceTools.bind(agent);
agent.connectInterfaceTools = (id, options) => connect(id, { ...options, onHandoff(request) {
  options.onHandoff(request); appendFileSync(join(dataDir, `${id}.dispatches`), JSON.stringify(request.call.id)+'\n');
} });
const tls = name === 'tls' && await disposableTls();
let tlsOptions;
if (tls) {
  const [certFile,keyFile,clientCaFile] = ['cert','key','ca'].map(k => join(dataDir,k));
  await Promise.all(Object.entries({certFile,keyFile,clientCaFile}).map(([key,file]) => writeFile(file,tls.server[{certFile:'cert',keyFile:'key',clientCaFile:'ca'}[key]],{mode:0o600})));
  tlsOptions = {certFile,keyFile,clientCaFile};
}
const listener = await agent.serveAgui({ listen: env.MA_AGUI_LISTEN, actors, tenant: 'kit', acp: true, tls:tlsOptions,
  statePlugin: state ? {name:'kit',snapshot} : undefined, rawSources: {kit:'kit'}, traceStateVendors:['kit'], onWarning: field => warnings.push(field) });
const auth = createHash('sha256').update('Bearer '+(await readFile(controlTokenFile,'utf8')).trim()).digest();
async function control({operation,threadId:id,name:at,milliseconds,client,mode}) {
  if (operation === 'tls') return tls.client;
  if (!/^[\w-]+$/.test(id)) throw Error('invalid session');
  const session = sessions.get(id);
  switch (operation) {
    case 'inspect': {
      const {entries} = await store.load(id); const index = new Map(entries.map(e => [e.id,e]));
      const batches = (await lines(join(dataDir,`${id}.batches`))).map(ids => ids.map(i => index.get(i)));
      await tracer.forceFlush();
      const spans = captured.filter(s => s.attributes['gen_ai.conversation.id'] === id).map(s => ({name:s.name,...s.spanContext(),
        parentSpanId:s.parentSpanContext?.spanId, attributes:s.attributes, links:s.links.map(l => l.context)}));
      return {project, batches, counter: (await readFile(join(dataDir,'counter')).catch(e => { if (e.code !== 'ENOENT') throw e; return ''; })).length, dispatches:await lines(join(dataDir,`${id}.dispatches`)), model:await lines(env.MODULAR_AGENT_SCRIPT_LOG), warnings, spans, erasure:erasures.get(id) ?? {outOfReach:[]}};
    }
    case 'barrier': if (at === 'presenceLost') await session.waitIdle(); else await latch(id,at).promise; break;
    case 'advance': {
      mock.timers.tick(milliseconds);
      if (name === 'report-cutoffs' && (await store.load(id)).entries.every(e => e.kind !== 'toolResult')) await latch(id,'settled').promise;
      if (name === 'report-cutoffs') {
        // A timeout schedules its continuation after the settlement append returns.
        await latch(id,'continued').promise;
      }
      await session.waitIdle(); break;
    }
    case 'approvalGate': if (mode === 'redact') redacted.add(client); else redacted.delete(client); break;
    case 'release': latch(id,'release').resolve(); break;
    case 'revoke': await session.setLimit(rights.filter(r => r !== 'tools')); break;
    case 'move': { const {entries} = await store.load(id); await session.moveTo(entries[entries.findIndex(e => e.kind === 'inputAccepted')-1].id); break; }
    case 'erase': { const {entries} = await store.load(id); erasures.set(id, await session.erase(entries.filter(e => ['input','inputAccepted','toolStarted','response'].includes(e.kind)).map(e => e.id))); break; }
    default: throw Error('unknown operation');
  }
  return {};
}
const server = createServer(async (req,res) => { try {
  if (req.url !== '/fixture' || req.method !== 'POST' || !timingSafeEqual(auth,createHash('sha256').update(req.headers.authorization ?? '').digest())) { res.writeHead(403).end(); return; }
  let body=''; for await (const chunk of req) { body+=chunk; if (body.length > 8192) throw Error('control request too large'); }
  res.end(JSON.stringify(await control(JSON.parse(body))));
} catch (e) { console.error(e.stack); res.writeHead(400).end(); } });
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
console.log(JSON.stringify({url:listener.url,control:`http://127.0.0.1:${server.address().port}/fixture`}));

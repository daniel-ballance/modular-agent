// Disposable writer for the ADR 0034 scenarios. Every command uses the public Session API.
import { readFileSync, watch } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgent, definePlugin, defineToolSource, tool } from '@modular-agent/core';
import { memoryEnvironment, scriptedProvider } from '@modular-agent/core/testing';
import { JsonlHistoryStore } from '@modular-agent/history-jsonl';
import { fixture, count } from '../packages/fixtures/dist/src/index.js';

const [file, dir] = process.argv.slice(2), scenario = JSON.parse(readFileSync(file, 'utf8'));
const realNow = Date.now;
let now = Number(readFileSync(join(dir,'clock'),'utf8')), telemetry;
const history = new class extends JsonlHistoryStore {
  supports = { ...this.supports, portableSessions:true };
  async append(id, entries) {
    await super.append(id, entries);
    await appendFile(join(dir,'batches'), JSON.stringify(entries.map(e=>e.id)) + '\n');
  }
}(join(dir,'history'));
const countPath = join(dir,'count'), latches = new Map(), handles = new Map();
let agent, session, backing, changeCatalog, input, redacted, secondTurn = false;
const hold = async name => { const l = latches.get(name); if (l) { l.at.resolve(); await l.go.promise; } };
const controls = definePlugin({name:'waiting.controls',replaces:['history-store'],setup(r) {
  r.historyStore(history);
  r.on('turn.before', async () => { if (secondTurn) { await hold('afterAnswer'); await hold('beforeGates'); } secondTurn = true; });
  r.on('tool.before', ({call})=> input && call.input.note !== input.note ? {change:input} : undefined, 'first');
  r.on('tool.before', async () => { await hold('beforeHandoff'); }, 'last');
  r.on('output', ({recipient,events})=>recipient === redacted && events.some(e=>e.type==='input.request.opened') ? 'block' : undefined);
}});
function placed(p) {
  const plugins = scenario.agent.plugins, config = {path:countPath};
  return p.servicePlugins ? {servicePlugins:p.servicePlugins} : p.command ? {processPlugins:plugins.map(name=>({command:[...p.command,name],config}))}
    : {plugins:plugins.map(name=>fixture(name,config))};
}
// Only the catalog-change tests need a refreshable registration. Both catalogs use
// the same real placed counter; changing the registration never changes its file.
async function catalogs(placement) {
  backing = await createAgent({...placement, environment:memoryEnvironment(), providers:[scriptedProvider([])]});
  const executor = await backing.session();
  const make = description => tool({name:'bump',description,input:{type:'object'},run:async args=>(await executor.callTool('bump',args)).text()});
  let source = 0, item = make('Increment the counter');
  const sources = [0,1].map(i => defineToolSource({id:'counter-'+i,tools:()=>source===i ? [item] : []}));
  changeCatalog = change => { if(change==='source') source=1; else item=make('Changed counter description'); for(const s of sources) s.changed(); };
  return {plugins:[definePlugin({name:'refreshable-counter',setup:r=>{for(const s of sources) r.tools(s);}})]};
}
const resultOf = r => r && ({outcome:r.outcome,text:r.text,openToolCalls:r.openToolCalls,toolResults:r.toolResults().map(t=>({name:t.name,status:t.status,text:t.text()}))});
const handle = as => { if (!handles.has(as)) handles.set(as,as==='user'?session:session.as(as)); return handles.get(as); };
async function execute(op, arg) {
  switch(op) {
    case 'start': {
      const {plugins,actors,settings,...options} = scenario.agent;
      let parts = placed(arg.placement);
      if (scenario.steps.some(s=>s.change?.registration)) parts=await catalogs(parts);
      if(arg.run?.sdk) { const {startTelemetry}=await import('../packages/fixtures/dist/src/telemetry.js'); telemetry=startTelemetry(process.env.MODULAR_AGENT_TELEMETRY_OTLP); }
      Date.now = () => now;
      try { agent = await createAgent({...options,...parts,agentName:arg.run?.agentName, dataDir:dir,project:dir,environment:memoryEnvironment(),questionsOutlastTurns:true,
        providers:[scriptedProvider(scenario.model)],
        plugins:[...parts.plugins??[],controls]}); } finally { Date.now=realNow; }
      session = arg.id ? await agent.openSession(arg.id) : await agent.session({actors,settings:{...settings,
        ...(scenario.fixture?.requestedApprovalMs!==undefined ? {approvalWaitMs:scenario.fixture.requestedApprovalMs}:{})}});
      return {id:session.id,declaration:session.declaration()};
    }
    case 'prompt': return resultOf(await handle(arg.as??'user').prompt(arg.prompt));
    case 'wait': await session.waitIdle(); return resultOf(await session.lastTurn());
    case 'last': return resultOf(await session.lastTurn());
    case 'questions': return handle(arg.as).questions(arg.present?{present:true}:{});
    case 'answer': try { await handle(arg.as).answer(arg.id,arg.answer); return true; }
      catch(e) { if (['forbidden','conflict','not_found'].includes(e.code)) return false; throw e; }
    case 'clock': now=arg; await session.questions(); return;
    case 'barrier': {
      const [[action,name]]=Object.entries(arg);
      if(action==='arm') latches.set(name,{at:Promise.withResolvers(),go:Promise.withResolvers()});
      else if(action==='release') latches.get(name).go.resolve();
      else if(name==='afterEffect') {
        // Watch the independent file while the counter itself holds its invocation.
        const ready=Promise.withResolvers(), watcher=watch(dir,()=>{if(count(countPath)>0) ready.resolve();});
        try { if(!count(countPath)) await ready.promise; } finally { watcher.close(); }
      } else await latches.get(name).at.promise;
      return;
    }
    case 'change':
      if(arg.setting) for(const [k,v] of Object.entries(arg.setting)) await session.setSetting(k,v);
      if(arg.gateView) redacted=arg.gateView.actor;
      if(arg.gateInput) input=arg.gateInput;
      if(arg.registration) changeCatalog(arg.registration);
      if(arg.removeRight) {
        const actor=scenario.agent.actors.find(a=>a.id===arg.removeRight.actor);
        await session.leave(actor.id); await session.join({...actor,rights:actor.rights.filter(r=>r!==arg.removeRight.right)});
      }
      return;
    case 'batches': {
      if(!session) return [];
      const ids=await readFile(join(dir,'batches'),'utf8').catch(e=>{if(e.code!=='ENOENT')throw e;return '';});
      if(!ids.trim()) return [];
      const index=new Map((await history.load(session.id)).entries.map(e=>[e.id,e]));
      return ids.trim().split('\n').map(row=>JSON.parse(row).map(id=>index.get(id)).filter(Boolean)).filter(row=>row.length);
    }
    case 'parked': {
      await session.waitIdle();
      const active=telemetry?.activeWork(session.id);
      if(arg.flush) await telemetry?.flush();
      return active;
    }
    case 'close': await agent?.close(); await telemetry?.(); await backing?.close(); return;
    default: throw Error('Unknown waiting scenario operation: '+op);
  }
}
process.on('message', async ({id,op,arg}) => {
  try { process.send({id,result:await execute(op,arg)}); }
  catch(e) { process.send({id,error:{code:e.code,message:e.message}}); }
});

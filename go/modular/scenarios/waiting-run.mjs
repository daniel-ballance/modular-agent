// Controller for the Go SDK's waiting-approval fixtures. The agent is a
// separate test process; the controller survives SIGKILL and holds no delivery.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile, writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';

const [config,exe]=process.argv.slice(2);
const {Path:path,Dir:dir}=JSON.parse(await readFile(config));
const sc=JSON.parse(await readFile(path));
const telemetry=process.env.MODULAR_AGENT_TELEMETRY_RUN && JSON.parse(await readFile(process.env.MODULAR_AGENT_TELEMETRY_RUN));
const rules=telemetry?resolve(process.cwd(),'conformance/sdk/waiting.mjs'):resolve(dirname(path),'../../waiting.mjs');
const {waitingStep,waitingRecords,skipReason}=await import(pathToFileURL(rules));
let child,exit,lines,id,now=1740000000000;
const start=()=>{
 child=spawn(exe,['-test.run=^TestWaitingScenarioProcess$'],{env:{...process.env,MA_GO_WAIT_WORKER:config},detached:true,stdio:['pipe','pipe','inherit']});
 exit=once(child,'exit');lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
};
async function rpc(op,params={}){
 child.stdin.write(JSON.stringify({op,...params})+'\n');
 const {value,done}=await lines.next();assert.ok(!done,'worker exited before '+op);
 const r=JSON.parse(value);if(r.error)throw Object.assign(Error(r.error),{code:r.code});return r.value;
}
async function stop(mode){
 if(!child)return;
 if(mode==='kill')process.kill(-child.pid,'SIGKILL');else await rpc('close');
 const [code,signal]=await exit;assert.ok(mode==='kill'?signal==='SIGKILL':code===0);child=undefined;
}
const states={},io={
 questions:(as,present)=>rpc('poll',{as,present}),answer:(as,id,decision)=>rpc('answer',{as,id,decision}),
 setClock:async ms=>{assert.ok(ms>=now);now=ms;if(child)await rpc('clock',{now});},
 barrier:barrier=>rpc('barrier',{barrier}),change:change=>rpc('change',{change}),stop,
};
async function records(){try{return (await readFile(join(dir,'commits'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)}catch(e){if(e.code==='ENOENT')return [];throw e}}
async function count(){try{return Number(await readFile(join(dir,'count'),'utf8'))}catch(e){if(e.code==='ENOENT')return 0;throw e}}

async function run(){
 start();const compatible=await rpc('probe',{now});await stop('close');
 const reason=skipReason(sc,compatible);if(reason){console.log('SKIP '+reason);return;}
 start();if(sc.expectCreateError){await assert.rejects(()=>rpc('open',{now}),e=>e.code===sc.expectCreateError.code);return;}
 const opened=await rpc('open',{now});id=opened.id;
 for(const [k,v] of Object.entries(sc.expectDeclaration??{}))assert.equal(opened.declaration[k]??false,v);
 let parked,last;
 for(const step of sc.steps){
  const w=step.expect??{};let result;
  try{
   if(!await waitingStep(step,states,io)){
    if(step.prompt)result=await rpc('prompt',{text:step.prompt,as:step.as});
    else if(step.wait)result=await rpc('wait');
    else if(step.reopen){start();await rpc('open',{now,id})}
    else assert.fail('unknown waiting step '+JSON.stringify(step));
   }
  }catch(e){if(w.error && e.code===w.error)continue;throw e}
  assert.ok(!w.error,'expected '+w.error);
  if(w.count!==undefined)assert.equal(await count(),w.count,'counter');
  if(w.outcome)assert.equal(result.outcome,w.outcome);
  if(w.text)assert.equal(result.text,w.text);
  if(w.toolResults){const got=result.toolResults??[];assert.equal(got.length,w.toolResults.length);for(let i=0;i<got.length;i++){assert.equal(got[i].name,w.toolResults[i].name);assert.equal(got[i].status,w.toolResults[i].status);}}
  waitingRecords(sc,w,states,await records(),result);
  if(result)last=result;
  if(telemetry && step.prompt){parked={originBatches:await records(),counterAtPark:await count(),activeWorkAtPark:await rpc('parked')}}
 }
 if(telemetry){
  const finalBatches=await records(),historyKinds=finalBatches.flat().map(r=>r.kind);
  const declaration=await rpc('declaration');
  await writeFile(telemetry.reportPath,JSON.stringify({scenario:sc.scenario,placement:telemetry.placement,passed:true,sessionId:id,turnId:states.request.turnId,outcome:last.outcome,historyKinds,declarations:{session:declaration},waiting:{...parked,finalBatches,counterAfter:await count()}}));
  await stop('close');
 }
}
try{await run()}finally{await stop('kill')}

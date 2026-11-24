import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkWaitingDeclaration, waitingRecords, waitingStep } from '../../conformance/sdk/waiting.mjs';
import { count } from '../packages/fixtures/dist/src/index.js';
import { servicesFor, waitGroup } from '../packages/fixtures/dist/src/scenarios.js';

export async function runWaitingScenario(path, placement, run) {
  const scenario = JSON.parse(await readFile(path,'utf8'));
  const dir = await mkdtemp(join(tmpdir(),'waiting-scenario-')), state = {};
  let spec, child, rpc, exited, sessionId;
  const waiting = {};
  const start = async () => {
    spec = await servicesFor(scenario,dir,placement);
    child = fork(new URL('waiting-writer.mjs',import.meta.url),[path,dir],{detached:true,execArgv:[],stdio:['ignore','ignore','inherit','ipc']});
    exited = once(child,'exit');
    const requests = new Map(); let seq = 0;
    child.on('message',({id,result,error})=>{ const task=requests.get(id); if(!task)return; requests.delete(id);
      if(error) task.reject(Object.assign(new Error(error.message),{code:error.code})); else task.resolve(result); });
    void exited.then(()=>{ for(const task of requests.values()) task.reject(Error('Scenario writer exited')); });
    rpc = (op,arg)=>{ const id=++seq, task=Promise.withResolvers(); requests.set(id,task); child.send({id,op,arg}); return task.promise; };
    const opened = await rpc('start',{placement:spec.placement, id:sessionId,run});
    sessionId=opened.id;
    return opened.declaration;
  };
  const stop = async how => {
    if(!child)return;
    const pid=child.pid;
    try { if(how==='close') await rpc('close'); }
    finally {
      try { process.kill(-pid,'SIGKILL'); } catch(e) { if(e.code!=='ESRCH')throw e; }
      await exited; await waitGroup(pid); await spec.stop(); child=undefined;
    }
  };
  try {
    await writeFile(join(dir,'clock'),'1800000000000');
    if(scenario.expectCreateError) {
      await assert.rejects(start(),err=>err.code===scenario.expectCreateError.code && err.message.includes(scenario.expectCreateError.messageContains??'')); return [];
    }
    const declaration=await start();
    checkWaitingDeclaration(scenario,declaration);
    for(const step of scenario.steps) {
      const expect=step.expect??{}; let result, error;
      const io={questions:(as,present)=>rpc('questions',{as,present}), answer:(as,id,answer)=>rpc('answer',{as,id,answer:run && answer==='decline'?{declined:true,reason:run.values.answer}:answer}),
        setClock:async ms=>{ await writeFile(join(dir,'clock'),String(ms)); if(child) await rpc('clock',ms); },
        barrier:op=>rpc('barrier',op), change:op=>rpc('change',op), stop};
      try {
        if('prompt' in step) result=await rpc('prompt',step);
        else if('wait' in step) result=await rpc('wait');
        else if('reopen' in step) { if(child) await stop('close'); checkWaitingDeclaration(scenario,await start()); result=await rpc('last'); }
        else assert.ok(await waitingStep(step,state,io),'unknown waiting scenario step');
      } catch(e) { if(!expect.error)throw e; error=e.code; }
      assert.equal(error,expect.error);
      if(expect.outcome) assert.equal(result?.outcome?.kind,expect.outcome);
      if(expect.text) assert.equal(result?.text,expect.text);
      if(expect.toolResults) { assert.equal(result.toolResults.length,expect.toolResults.length); expect.toolResults.forEach((t,i)=>{
        for(const [key,value] of Object.entries(t)) if(key==='contains')assert.ok(result.toolResults[i].text.includes(value)); else assert.equal(result.toolResults[i][key],value);
      }); }
      if(expect.count!==undefined)assert.equal(count(join(dir,'count')),expect.count);
      if(child) {
        const batches=await rpc('batches');
        waitingRecords(scenario,expect,state,batches,result);
        if(run && expect.parked && !waiting.originBatches) {
          waiting.originBatches=batches; waiting.counterAtPark=count(join(dir,'count'));
          waiting.activeWorkAtPark=await rpc('parked',{flush:!scenario.steps.some(s=>s.stop==='kill')});
          const url=new URL(run.parkedUrl); assert.ok(url.protocol==='http:' && ['127.0.0.1','[::1]'].includes(url.hostname));
          assert.equal((await fetch(url,{method:'POST',redirect:'error'})).status,204);
        }
      }
    }
    if(run) {
      waiting.finalBatches=await rpc('batches'); waiting.counterAfter=count(join(dir,'count'));
      const entries=waiting.finalBatches.flat(), end=entries.findLast(e=>e.kind==='turnEnd');
      await writeFile(run.reportPath,JSON.stringify({scenario:scenario.scenario,placement:placement.name,passed:true,sessionId,turnId:state.request.turnId,
        outcome:end.data.outcome.kind,historyKinds:entries.map(e=>e.kind),declarations:{session:declaration},waiting}));
      await stop('close');
    }
    return [];
  } finally { try { await stop('kill'); } finally { await rm(dir,{recursive:true,force:true}); } }
}

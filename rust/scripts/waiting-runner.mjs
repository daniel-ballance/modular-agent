// Drive a disposable SDK writer. This process owns the clock, external tool
// services and file observer, so a writer can be killed at a commit boundary.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [path, dir, binary, placement, ...command] = process.argv.slice(2);
const reference=process.env.MA_SDK_WAITING_FIXTURES ? resolve(process.env.MA_SDK_WAITING_FIXTURES,'../../waiting.mjs') : resolve(dirname(path),'../../waiting.mjs');
const { waitingStep, waitingRecords, skipReason } = await import(pathToFileURL(existsSync(reference)?reference:resolve('conformance/sdk/waiting.mjs')));
const trace=process.env.MODULAR_AGENT_TELEMETRY_RUN && JSON.parse(readFileSync(process.env.MODULAR_AGENT_TELEMETRY_RUN));
let declaration, parked;
const spec = JSON.parse(readFileSync(path));
const state = {}, groups = [];
let worker, session, clock = 1_800_000_000_000;
const count = () => existsSync(join(dir, 'count')) ? Number(readFileSync(join(dir, 'count'), 'utf8')) : 0;
const batches = () => existsSync(join(dir, 'batches')) ? readFileSync(join(dir, 'batches'), 'utf8').trim().split('\n').map(s => JSON.parse(s)) : [];
function child(cmd, args, extra = {}) {
  const p = spawn(cmd, args, { detached: true, stdio: ['pipe', 'pipe', 'inherit'], ...extra });
  const exit = new Promise((resolve, reject) => {p.once('error', reject); p.once('exit', resolve);});
  const lines = createInterface({ input: p.stdout })[Symbol.asyncIterator]();
  const read = async () => {const r = await lines.next(); assert.ok(!r.done, 'fixture closed before reply'); return r.value;};
  groups.push({ p, exit }); return { p, read };
}
async function stop(mode) {
  if (mode === 'close') await rpc({op:'close'});
  worker = undefined;
  for (const {p,exit} of groups.splice(0).reverse()) {
    try {process.kill(-p.pid,'SIGKILL');} catch (e) {if(e.code!=='ESRCH') throw e;}
    await exit;
  }
}
async function start(op, open) {
  mkdirSync(join(dir, 'project'), { recursive: true });
  if (placement.startsWith('service:')) {
    const token = join(dir, 'service-token'); writeFileSync(token, randomUUID()+randomUUID(), {mode:0o600});
    const urls=[];
    for(const name of spec.agent.plugins) {
      const s=child(command[0], [...command.slice(1),name,'--listen','127.0.0.1:0','--token-file',token],{cwd:join(dir,'project'),env:{PATH:process.env.PATH}});
      const url=await s.read(); assert.ok(url.startsWith('ws://127.0.0.1:')); urls.push(url);
    }
    writeFileSync(join(dir,'services.json'),JSON.stringify(urls));
  }
  worker=child(binary,['--waiting',path,dir,placement,...command]);
  return rpc({op,clock,open});
}
async function rpc(p) {
  worker.p.stdin.write(JSON.stringify(p)+'\n'); const response=JSON.parse(await worker.read());
  if(response.error) throw Object.assign(new Error(response.message), {code:response.error});
  return response.value;
}
async function afterEffect() {
  // Subscribe before inspecting the file, including an already committed rename.
  await new Promise((resolve,reject)=>{
    const check=()=>{if(count()!==0){changes.close();resolve();}};
    const changes=watch(dir,check); changes.once('error',reject);check();
  });
}
async function run() {
  const probe=await start('probe'); const reason=skipReason(spec,probe.declaration);
  await stop('close');
  if(reason){console.error(`${spec.scenario} ${placement}: ${reason}`);return;}
  try {
    const actual=await start('init');session=actual.id;declaration=actual.declaration;
    for(const [k,v] of Object.entries(spec.expectDeclaration??{})) assert.equal(actual.declaration[k]??false,v);
  } catch(e) {
    if(e.code!==spec.expectCreateError?.code || (spec.expectCreateError?.messageContains && !e.message.includes(spec.expectCreateError.messageContains))) throw e;
    return;
  }
  assert.equal(spec.expectCreateError,undefined);
  for(const step of spec.steps) {
    const expect=step.expect??{};let result;
    const io={questions:(as,present)=>rpc({op:'poll',as,present}),answer:(as,id,answer)=>rpc({op:'decide',as,id,answer,reason:answer==='decline'?trace?.values.answer:undefined}),
      setClock:async at=>{assert.ok(at>=clock);clock=at;if(worker)await rpc({op:'clock',at});},
      barrier:async barrier=>{if(barrier.arm==='afterEffect') return;if(barrier.reached==='afterEffect') return afterEffect();await rpc({op:'barrier',barrier});},
      change:change=>rpc({op:'change',change,as:step.as}),stop};
    try {
      if(step.reopen) {if(worker)await stop('close');await start('init',session);}
      else if(step.prompt) result=await rpc({op:'prompt',as:step.as,text:step.prompt});
      else if(step.wait) result=await rpc({op:'wait'});
      else assert.ok(await waitingStep(step,state,io),'unknown step');
      assert.equal(expect.error,undefined);
    } catch(e) {if(expect.error && e.code===expect.error)continue;throw e;}
    if(expect.outcome) assert.equal(result.outcome.kind,expect.outcome);
    if(expect.toolResults){assert.equal(result.toolResults.length,expect.toolResults.length);expect.toolResults.forEach((t,i)=>{for(const [k,v] of Object.entries(t))assert.deepEqual(result.toolResults[i][k],v);});}
    if(expect.count!==undefined) assert.equal(count(),expect.count);
    waitingRecords(spec,expect,state,batches(),result);
    if(trace && expect.parked && !parked) {
      const originBatches=batches(),counterAtPark=count();
      const activeWorkAtPark=await rpc({op:'parked',flush:spec.scenario!=='waiting-approval-expire-stopped'});
      parked={originBatches,counterAtPark,...(trace.sdk?{activeWorkAtPark}:{})};
      assert.equal((await fetch(trace.parkedUrl,{method:'POST'})).status,204);
    }
  }
  if(trace) {
    const finalBatches=batches(); const es=finalBatches.flat();
    const outcome=es.findLast(e=>e.kind==='turnEnd').data.outcome.kind;
    await rpc({op:'flush'});
    writeFileSync(trace.reportPath,JSON.stringify({scenario:spec.scenario,placement,passed:true,sessionId:session,turnId:state.request.turnId,outcome,historyKinds:es.map(e=>e.kind),declarations:{session:declaration},waiting:{...parked,finalBatches,counterAfter:count()}}));
  }
}
try {await run();} finally {await stop('kill');}

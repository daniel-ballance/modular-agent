// Disposable writer for the post-flush SIGKILL boundary. All I/O uses the test directory.
import { join } from 'node:path';
import { Harness } from '@modular-agent/harness';
import { createAgent, defaultAcpActor, tool } from '@modular-agent/core';
import { memoryEnvironment, scriptedProvider } from '@modular-agent/core/testing';
import { RunReceipts } from '../packages/harness/dist/src/run-receipts.js';
const [dir, stop] = process.argv.slice(2);
const batch = ['after-answer','read-batch'].includes(stop);
const script = batch ? [{toolCalls:[{name:'bump',input:{}},{name:'pick',input:{}}]},{text:'Done.'}] : [{text:'Done.'}];
const agent = await createAgent({project:dir,dataDir:dir,durability:'kept',environment:memoryEnvironment(),providers:[scriptedProvider(script)],
  ...(batch && {approval:'ask', questionsOutlastTurns:true, maxApprovalWaitMs:60000, settings:{approvalWait:'untilDeadline'},
    tools:[tool({name:'bump',description:'A local change',input:{},run:()=>'Changed.'})],
    interfaceTools:[{sourceId:'ui',actorId:'user',routeId:'host',resultTimeoutMs:60000,
      tools:[{name:'pick',description:'Choose',parameters:{},callers:['model'],hints:{readOnly:true}}]}]})});
if (stop==='after-answer') {
  const commit = Harness.prototype.commit;
  Harness.prototype.commit = async function(...args) {
    const entries = await commit.apply(this,args);
    if (entries.some(e=>e.kind==='inputAnswer' && e.actorId==='user')) process.kill(process.pid,'SIGKILL');
    return entries;
  };
}
const record = RunReceipts.prototype.released;
RunReceipts.prototype.released = function(id,status) {
  if (stop==='before-marker') process.kill(process.pid,'SIGKILL');
  record.call(this,id,status);
  if (stop==='after-marker') process.kill(process.pid,'SIGKILL');
};
const listener = await agent.serveAgui({listen:'127.0.0.1:0',actors:[{tokenFile:join(dir,'token'),actor:{...defaultAcpActor(),id:'user'},clientId:'host'}]});
process.send(listener.url);
process.once('message',async()=>{ await listener.close(); await agent.close(); process.disconnect(); });

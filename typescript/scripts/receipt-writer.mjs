// Disposable writer for the post-flush SIGKILL boundary. All I/O uses the test directory.
import { join } from 'node:path';
import { createAgent, defaultAcpActor } from '@modular-agent/core';
import { memoryEnvironment, scriptedProvider } from '@modular-agent/core/testing';
import { RunReceipts } from '../packages/harness/dist/src/run-receipts.js';
const [dir, stop] = process.argv.slice(2);
const agent = await createAgent({project:dir,dataDir:dir,durability:'kept',environment:memoryEnvironment(),providers:[scriptedProvider([{text:'Done.'}])]});
const record = RunReceipts.prototype.released;
RunReceipts.prototype.released = function(id,status) {
  if (stop==='before-marker') process.kill(process.pid,'SIGKILL');
  record.call(this,id,status);
  if (stop==='after-marker') process.kill(process.pid,'SIGKILL');
};
const listener = await agent.serveAgui({listen:'127.0.0.1:0',actors:[{tokenFile:join(dir,'token'),actor:{...defaultAcpActor(),id:'user'},clientId:'host'}]});
process.send(listener.url);
process.once('message',async()=>{ await listener.close(); await agent.close(); process.disconnect(); });

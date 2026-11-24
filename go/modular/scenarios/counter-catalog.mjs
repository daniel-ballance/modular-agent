// Add a mutable catalog to a static peer fixture for the two registration
// tests. All tool execution still goes to the real process or service. No
// history, gate decision, answer or result is supplied by this relay.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {readFile} from 'node:fs/promises';

const args=process.argv.slice(2);
let send,close,init,original,mode,tools;
const replacement='waiting-counter-replacement';
function write(m){process.stdout.write(JSON.stringify(m)+'\n')}
function receive(line){
 const m=JSON.parse(line);
 if(!m.method && m.id===init && m.result){
  const r=m.result,source=r.toolSources.find(s=>s.tools.some(t=>t.name==='bump'));
  original=source.id;tools=source.tools;
  if(r.commands?.some(c=>c.name==='changeCounter')){original=undefined}
  else {
   r.toolSources.push({id:replacement,tools:[]});
   (r.commands??=[]).push({name:'changeCounter',description:'Refresh the counter registration.'});
  }
 }
 write(m);
}
if(args[0]==='--service'){
 // Only the disposable loopback service and private token created by the
 // fixture launcher are accepted. No application configuration is read.
 const u=new URL(args[1]);if(u.protocol!=='ws:'||u.hostname!=='127.0.0.1')throw Error('not a loopback test service');
 const token=(await readFile(args[2],'utf8')).trim();
 const ws=new WebSocket(u,{protocols:['modular-agent-plugin-1'],headers:{Authorization:'Bearer '+token}});
 await once(ws,'open');ws.addEventListener('message',e=>receive(e.data));
 send=m=>ws.send(JSON.stringify(m));close=()=>ws.close();
}else{
 const p=spawn(args[0],args.slice(1),{stdio:['pipe','pipe','inherit']});
 createInterface({input:p.stdout}).on('line',receive);
 send=m=>p.stdin.write(JSON.stringify(m)+'\n');close=()=>p.stdin.end();
}
try{
 for await (const line of createInterface({input:process.stdin})){
  const m=JSON.parse(line),v=m.params??{};
  if(m.method==='plugin/initialize')init=m.id;
  if(original && m.method==='command/run' && v.name==='changeCounter'){
   mode=v.args.trim();if(!['source','definition'].includes(mode))throw Error('unknown catalog change');
   for(const toolSource of [original,replacement])write({jsonrpc:'2.0',method:'tools/changed',params:{toolSource,parentRequestId:m.id}});
   write({jsonrpc:'2.0',id:m.id,result:{output:'changed'}});continue;
  }
  if(original && m.method==='tools/list' && [original,replacement].includes(v.toolSource)){
   const available=(mode==='source')===(v.toolSource===replacement);
   write({jsonrpc:'2.0',id:m.id,result:{tools:available?tools.map(t=>mode==='definition'&&t.name==='bump'?{...t,description:'Changed description.'}:t):[]}});continue;
  }
  if(original && m.method==='tools/call' && v.toolSource===replacement)v.toolSource=original;
  send(m);
 }
}finally{close()}

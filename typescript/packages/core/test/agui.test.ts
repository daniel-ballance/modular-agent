import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createAgent, defaultAcpActor, definePlugin, tool, type AgentOptions, type ServeAguiOptions } from "../src/index.js";
import { memoryEnvironment, scriptedProvider } from "../src/testing.js";

const prompt = (content: unknown) => ({role:"user", id:randomUUID(), content});
const definition = { name: "pick", description: "Choose", parameters: {} };
const source = {sourceId:"ui",actorId:"user",routeId:"primary",resultTimeoutMs:60000,tools:[{...definition,callers:["model" as const]}]};
function latch() { let resolve!: () => void; const promise = new Promise<void>(done => {resolve=done;}); return {promise,resolve}; }
async function setup(t: TestContext, options: AgentOptions = {}, serving: Partial<ServeAguiOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(),"sdk-agui-")); t.after(() => rm(dir,{recursive:true,force:true}));
  const actor = {...defaultAcpActor(),id:"user"};
  const tokens = [randomUUID(),randomUUID()];
  const actors = await Promise.all(tokens.map(async (token,i) => { const tokenFile = join(dir,String(i)); await writeFile(tokenFile,token,{mode:0o600}); return {actor,tokenFile,clientId:i?"secondary":"primary"}; }));
  const agent = await createAgent({environment:memoryEnvironment(), providers:[scriptedProvider([{text:"one"},{text:"two"}])],...options}); t.after(() => agent.close());
  const listener = await agent.serveAgui({listen:"127.0.0.1:0", actors, ...serving});
  const base = listener.url+"/agui/v1";
  const request = (path: string, data?: unknown, client=0, headers = {}) => fetch(base+path,{ method:data===undefined?"GET":"POST", headers:{authorization:`Bearer ${tokens[client]}`,"content-type":"application/json",...headers},body:data===undefined?undefined:JSON.stringify(data) });
  const thread = async () => { const res = await request("/threads",{}); assert.equal(res.status,201); return (await res.json() as {threadId:string}).threadId; };
  const run = (threadId:string,messages:unknown[], extra={},client=0,headers={}) => request("/run",{threadId,runId:randomUUID(),protocolVersion:"1.0",messages,...extra},client,headers);
  return { agent,listener,actors,base,request,thread,run };
}
async function events(res: Response) {
  assert.equal(res.status,200); return (await res.text()).split("\n").filter(l=>l.startsWith("data: ")).map(l=>JSON.parse(l.slice(6)));
}
const deltas = (es: any[]) => es.filter(e=>e.type==="TEXT_MESSAGE_CONTENT").map(e=>e.delta).join("");

test("an allowlisted browser can preflight without a token; closing the listener leaves the embedded session open",async t=>{
  const origin="https://editor.example";
  const {agent,listener,base,request,thread}=await setup(t,{}, {origins:[origin]});
  const preflight=await fetch(base+"/run",{method:"OPTIONS",headers:{origin,"access-control-request-method":"POST","access-control-request-headers":"authorization,content-type"}});
  assert.equal(preflight.status,204); assert.equal(preflight.headers.get("access-control-allow-origin"),origin); assert.equal(await preflight.text(),"");
  assert.equal((await request("/threads",{},0,{origin:"https://other.example"})).status,403);
  const id=await thread(), session=await agent.openSession(id);
  await listener.close(); assert.equal((await session.prompt("Still open")).text,"one");
});

test("a withheld HTTP snapshot retires its cursor, even if the gate later opens",async t=>{
  let blocked=false;
  const plugin=definePlugin({name:"privacy", hooks:{output:({events})=> {if (blocked && events.some(e=>(e.data as any)?.method==="agui.snapshot")) return "block";}}});
  const {request,run,thread}=await setup(t,{plugins:[plugin]}); const id=await thread();
  const path="/threads/"+id; const initial=await (await request(path)).json() as {cursor:string};
  blocked=true; assert.equal((await request(path)).status,403); blocked=false;
  assert.equal((await run(id,[prompt("old")],{},0,{"ma-history-cursor":initial.cursor})).status,409);
  await request(path); assert.equal(deltas(await events(await run(id,[prompt("fresh")]))),"one");
});

test("a queued client follows only its own turn and does not inherit another client's offer",async t=>{
  const entered=latch(), release=latch(), seen:string[][]=[];
  t.after(()=>release.resolve());
  const plugin=definePlugin({name:"stop-first",hooks:{"provider.request":async ({request})=>{
    seen.push(request.tools.map(t=>t.name)); if (seen.length===1){entered.resolve();await release.promise;}
  }}});
  const {thread,run,request}=await setup(t,{plugins:[plugin],interfaceTools:[source]}); const id=await thread();
  const first=run(id,[prompt("first")],{tools:[definition]});
  try {
    await entered.promise;
    const view=await (await request("/threads/"+id,undefined,1)).json() as {messages:unknown[]};
    const second=await run(id,[...view.messages,prompt("second")],{},1); release.resolve();
    assert.equal(deltas(await events(await first)),"one"); assert.equal(deltas(await events(second)),"two");
    assert.deepEqual(seen,[["pick"],[]]);
  } finally { release.resolve(); }
});

test("an accepted report ends its waiting exchange with busy when the continuation cannot reserve a turn", { timeout: 10000 }, async t=>{
  const dir = await mkdtemp(join(tmpdir(),"agui-capacity-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const options = {project:dir, dataDir:dir, durability:"kept" as const, interfaceTools:[source],
    providers:[scriptedProvider([{toolCalls:[{name:"pick",input:{}}]}])]};
  const first = await setup(t, options);
  const id = await first.thread();
  const origin = await events(await first.run(id,[prompt("choose")],{tools:[definition]}));
  const [call] = origin.at(-1).outcome.pendingToolCallIds;
  await first.listener.close();
  await first.agent.close();
  // Lowering the limit cannot consume the open call's settlement reservation.
  const next = await setup(t, {...options, resourceReservations:{session:{storageBytes:1,controlBytes:0}}});
  const view = await (await next.request("/threads/"+id)).json() as {messages:unknown[]};
  const settled = await events(await next.run(id,[...view.messages,{id:"report",role:"tool",toolCallId:call,content:"blue"}]));
  assert.equal(settled.at(-1).type,"RUN_ERROR");
  assert.equal(settled.at(-1).code,"busy");
  const history=await (await next.agent.openSession(id)).history();
  assert.equal(history.filter(e=>e.kind==="turnStart").length,1);
  assert.equal(history.filter(e=>e.kind==="toolResult").length,1);
});

test("media stay in order and only text and inline image bytes reach the model", async t=>{
  const warnings:string[]=[], seen:unknown[]=[];
  const audit=definePlugin({name:"audit",hooks:{"provider.request":({request})=>{seen.push(request.messages.at(-1)?.content);}}});
  const {thread,run}=await setup(t,{plugins:[audit]},{onWarning:f=>warnings.push(f)});
  const image={type:"image",source:{type:"data",mimeType:"image/png",value:"AA=="}};
  const message=prompt([{type:"text",text:"before"},image,{type:"audio",source:{type:"file",value:"opaque"}},{type:"text",text:"after"}]);
  const es=await events(await run(await thread(),[message])); assert.equal(es.at(-1).type,"RUN_FINISHED");
  assert.deepEqual(seen,[[{type:"text",text:"before"},{type:"image",mimeType:"image/png",data:"AA=="},{type:"text",text:"after"}]]);
  assert.deepEqual(es.filter(e=>e.type==="MESSAGES_SNAPSHOT").at(-1).messages[0].content,[{type:"text",text:"before"},image,{type:"text",text:"after"}]);
  assert.deepEqual(warnings,["messages.content"]);
});

test("a withheld model stream cannot be read back through another client's snapshot",async t=>{
  const gate=definePlugin({name:"no-text",hooks:{output:({events})=>{if(events.some(e=>e.type==="text")) return "block";}}});
  const {thread,run,request}=await setup(t,{plugins:[gate],providers:[scriptedProvider([{text:"PRIVATE_RESPONSE"}])]}); const id=await thread();
  const es=await events(await run(id,[prompt("ask")])); assert.ok(!JSON.stringify(es).includes("PRIVATE_RESPONSE"));
  assert.ok(!(await (await request("/threads/"+id,undefined,1)).text()).includes("PRIVATE_RESPONSE"));
});

test("server tool framing is contiguous, and withholding the result withholds the call group and its snapshot copy",async t=>{
  let blocked=false;
  const gate=definePlugin({name:"hide-result",hooks:{output:({events})=>{if (blocked && events.some(e=>e.type==="toolResult")) return "block";}}});
  const {thread,run}=await setup(t,{plugins:[gate],providers:[scriptedProvider([{toolCalls:[{name:"echo",input:{secret:"INPUT_MARKER"}}]},{text:"done"}])],
    tools:[tool({name:"echo",description:"echo",input:{type:"object"},run:()=>"RESULT_MARKER"})]});
  const visible=await events(await run(await thread(),[prompt("show")])); const start=visible.findIndex(e=>e.type==="TOOL_CALL_START");
  assert.deepEqual(visible.slice(start,start+4).map(e=>e.type),["TOOL_CALL_START","TOOL_CALL_ARGS","TOOL_CALL_END","TOOL_CALL_RESULT"]);
  blocked=true; const hidden=await events(await run(await thread(),[prompt("hide")]));
  assert.equal(hidden.at(-1).type,"RUN_FINISHED"); assert.ok(!hidden.some(e=>e.type.startsWith("TOOL_CALL_")));
  assert.doesNotMatch(JSON.stringify(hidden),/INPUT_MARKER|RESULT_MARKER/);
});

test("a tenant without input authority cannot allocate even a provisional thread", async t=>{
  let created=0;
  const {actors}=await setup(t), agent=await createAgent({environment:memoryEnvironment(),tenants:{readonly:{rights:["watch"]}},
    plugins:[definePlugin({name:"count",hooks:{"session.start":()=>{created++;}}})]}); t.after(()=>agent.close());
  const token=randomUUID(); const tokenFile=actors[0].tokenFile; await writeFile(tokenFile,token,{mode:0o600});
  const server=await agent.serveAgui({listen:"127.0.0.1:0",tenant:"readonly",actors:[{...actors[0],tenants:["readonly"]}]});
  const res=await fetch(server.url+"/agui/v1/threads",{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:"{}"});
  assert.equal(res.status,403); assert.equal(created,0);
});

test("reconciliation uses the exact redacted HTTP snapshot, not the earlier live view",async t=>{
  const gate=definePlugin({name:"short-view",hooks:{output:({events})=>{
    const data=events[0].data as any;
    if(data?.method==="agui.snapshot" && data.result.messages.length){data.result.messages[0].content="Redacted.";return {redact:events};}
  }}});
  const {thread,run,request}=await setup(t,{plugins:[gate]}); const id=await thread();
  const live=(await events(await run(id,[prompt("original")]))).filter(e=>e.type==="MESSAGES_SNAPSHOT").at(-1).messages;
  const res=await request("/threads/"+id); assert.equal(res.status,200); const {messages}=await res.json() as {messages:any[]};
  assert.equal(messages[0].content,"Redacted."); assert.equal((await run(id,[...live,prompt("stale")])).status,409);
  assert.equal(deltas(await events(await run(id,[...messages,prompt("next")]))),"two");
});

test("a token rotation cannot rebind a registered route to another actor",async t=>{
  const {actors}=await setup(t); const agent=await createAgent({interfaceTools:[source],environment:memoryEnvironment()}); t.after(()=>agent.close());
  await assert.rejects(agent.serveAgui({listen:"127.0.0.1:0",actors:[actors[0],{...actors[1],clientId:"primary",actor:{...actors[0].actor,id:"stranger"}}]}),{code:"invalid_composition"});
});

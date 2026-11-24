import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createAgent, defaultAcpActor, definePlugin, tool, type Actor, type AgentOptions, type ServeAguiOptions } from "../src/index.js";
import { memoryEnvironment, scriptedProvider } from "../src/testing.js";

const prompt = (content: unknown) => ({role:"user", id:randomUUID(), content});
const definition = { name: "pick", description: "Choose", parameters: {} };
const source = {sourceId:"ui",actorId:"user",routeId:"primary",resultTimeoutMs:60000,tools:[{...definition,callers:["model" as const]}]};
function latch() { let resolve!: () => void; const promise = new Promise<void>(done => {resolve=done;}); return {promise,resolve}; }
const owner = {...defaultAcpActor(), id:"user"};
async function setup(t: TestContext, options: AgentOptions = {}, serving: Partial<ServeAguiOptions> = {}, principals: Actor[] = [owner,owner]) {
  const dir = await mkdtemp(join(tmpdir(),"sdk-agui-")); t.after(() => rm(dir,{recursive:true,force:true}));
  const tokens = principals.map(() => randomUUID());
  const actors = await Promise.all(tokens.map(async (token,i) => { const tokenFile = join(dir,String(i)); await writeFile(tokenFile,token,{mode:0o600}); return {actor:principals[i],tokenFile,clientId:["primary","secondary"][i] ?? String(i)}; }));
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

test("the session approval setting requires settings and accepts no other key", async t => {
  const { thread, request, agent } = await setup(t, { approval: "off", approvalCoversNested: true }, {}, [owner, { ...owner, rights: ["watch"] }]);
  const id = await thread(), other = await thread(), path = "/threads/" + id + "/settings";
  assert.equal((await request(path, { approval: "all" }, 1)).status, 403);
  assert.equal((await request(path, { approval: "all", model: "other" })).status, 400);
  assert.equal((await request(path, { approval: "sometimes" })).status, 400);
  assert.equal((await request(path, { approval: "all" })).status, 200);
  assert.equal((await agent.openSession(id)).settings().approval, "all");
  assert.equal((await agent.openSession(other)).settings().approval, "off");
});

test("listing returns only kept threads, with a timestamp and no content", async t => {
  const dir = await mkdtemp(join(tmpdir(), "agui-list-")); t.after(() => rm(dir, {recursive:true, force:true}));
  for (const kept of [true, false]) {
    const {thread, run, request} = await setup(t, kept ? {dataDir:dir, durability:"kept"} : {});
    const id = await thread();
    await events(await run(id, [prompt("private message")]));
    await thread(); // provisional
    const res = await request("/threads");
    assert.equal(res.status, 200);
    const page = await res.json() as { threads: { updatedAt: string }[] };
    const updatedAt = page.threads[0]?.updatedAt;
    if (kept) assert.ok(Number.isFinite(Date.parse(updatedAt)));
    assert.deepEqual(page, { threads: kept ? [{ threadId:id, updatedAt, waiting:{questions:0, toolCalls:0, turn:"none"} }] : [] });
  }
});

test("listing counts committed waits per client, pages in change order and does not reopen", async t => {
  const dir = await mkdtemp(join(tmpdir(), "agui-waits-"));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const kept = {project:dir, dataDir:dir, durability:"kept" as const, questionsOutlastTurns:true, interfaceTools:[source]};
  const note = tool({name:"note", description:"Ask for a note", input:{type:"object"}, async run(_, cx) {
    await cx.ask({kind:"text", question:"PRIVATE QUESTION", answerers:["user"]}, {wait:0, then:"leaveOpen"});
  }});
  const seed = await createAgent({...kept, environment:memoryEnvironment(), tools:[note],
    providers:[scriptedProvider([{toolCalls:[{name:"note",input:{}}]}])]});
  const q = await seed.session();
  try { assert.equal((await q.prompt("leave a question")).openToolCalls.length, 1); }
  finally { await seed.close(); }

  const opened: string[] = [], recovered: string[] = [];
  const audit = definePlugin({name:"audit-opens", hooks:{"session.start":({sessionId}) => {opened.push(sessionId);}}});
  const options = {...kept, tools:[note], plugins:[audit], providers:[scriptedProvider([{toolCalls:[{name:"pick",input:{}}]}])]};
  const server = await setup(t, options, {}, [owner, {...owner,rights:["watch"]}, owner, {...owner,id:"unjoined"}]);
  const call = await server.thread();
  assert.equal((await events(await server.run(call, [prompt("private call")], {tools:[definition]}))).at(-1).outcome.pendingToolCallIds.length, 1);
  const list = async (client:number, query = "") => {
    const res = await server.request("/threads" + query, undefined, client);
    assert.equal(res.status, 200);
    return await res.json() as {threads:{threadId:string; waiting:{questions:number;toolCalls:number;turn:string}}[];next?:string};
  };
  const waits = (page: Awaited<ReturnType<typeof list>>) => page.threads.map(t => [t.threadId, t.waiting]);
  const idle = {questions:0, toolCalls:0, turn:"none"};
  assert.deepEqual(waits(await list(0)), [[call,{...idle,toolCalls:1}], [q.id,{...idle,questions:1}]]);
  assert.deepEqual(waits(await list(1)), [[call,idle], [q.id,idle]]);
  assert.deepEqual(waits(await list(2)), [[call,idle], [q.id,{...idle,questions:1}]]);
  assert.deepEqual(await list(3), {threads:[]});
  const first = await list(0, "?limit=1");
  assert.ok(first.next); assert.deepEqual(waits(first), [[call,{...idle,toolCalls:1}]]);
  const second = await list(0, "?limit=1&after=" + encodeURIComponent(first.next));
  assert.deepEqual(waits(second), [[q.id,{...idle,questions:1}]]); assert.equal(second.next, undefined);
  const invalid = async (res:Response) => { assert.equal(res.status, 400); assert.deepEqual(await res.json(), {code:"invalid_request"}); };
  await invalid(await server.request("/threads?after=" + first.next, undefined, 1));
  for (const value of ["0","501","1.5","x",""]) await invalid(await server.request("/threads?limit=" + value));
  await server.listener.close(); await server.agent.close();
  const restarted = await setup(t, options, {resumeOpen:true, onResumeOpen:id => recovered.push(id)});
  await invalid(await restarted.request("/threads?after=" + first.next));
  assert.deepEqual(recovered, []); assert.deepEqual(opened, [call]);
});

test("a presence opened after the turn receives a waiting approval only on its own snapshot", async t => {
  const dir = await mkdtemp(join(tmpdir(), "agui-approval-")); t.after(() => rm(dir,{recursive:true,force:true}));
  let effects = 0;
  const {thread, run, request} = await setup(t, {dataDir:dir, durability:"kept", approval:"all", maxApprovalWaitMs:60_000,
    questionsOutlastTurns:true, settings:{approvalWait:"untilDeadline"}, tools:[tool({name:"bump", description:"Increment", input:{type:"object"}, run:()=>String(++effects)})],
    providers:[scriptedProvider([{toolCalls:[{name:"bump", input:{amount:1}}]},{text:"Done"}])]});
  const id = await thread(), path = "/threads/" + id;
  const end = (await events(await run(id,[prompt("Increment")]))).at(-1);
  assert.deepEqual(end.outcome,{type:"success"}); assert.equal(effects,0);
  assert.deepEqual((await (await request(path)).json() as any).waiting,{questions:[],toolCalls:[]});
  const presence = await request(path + "/presence");
  try {
    const snap = await (await request(path)).json() as any;
    const [q] = snap.waiting.questions;
    assert.equal(q.reason,"approval"); assert.match(q.message,/bump.*amount/s); assert.ok(Date.parse(q.expiresAt));
    const resume = [{interruptId:q.id, status:"resolved", payload:{allow:true}}];
    const other = await (await request(path,undefined,1)).json() as any;
    assert.deepEqual(other.waiting.questions,[]);
    assert.equal((await run(id,other.messages,{resume},1)).status,409);
    const continuation = await events(await run(id,snap.messages,{resume}));
    assert.equal(continuation.at(-1).outcome.type,"success"); assert.equal(effects,1);
  } finally { await presence.body?.cancel(); }
});

test("a closure cursor replays a decision to its own client without delivering an approval", {timeout:10000}, async t => {
  const dataDir = await mkdtemp(join(tmpdir(),"closure-replay-")); t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const {thread, run, request, agent} = await setup(t, {dataDir,durability:"kept", sessionLimits:true, approval:"all", maxApprovalWaitMs:60_000,
    questionsOutlastTurns:true, settings:{approvalWait:"untilDeadline"}, tools:[tool({name:"bump", description:"Increment", input:{}, run:()=>"ran"})],
    providers:[scriptedProvider([{toolCalls:[{name:"bump",input:{}}]}])]});
  const id = await thread(), path = "/threads/"+id;
  await events(await run(id,[prompt("increment")]));
  const snap = await (await request(path)).json() as any;
  const feed = path+"/wait-closures", after = "?after="+snap.waitCursor;
  assert.equal((await request(feed)).status,400);
  assert.equal((await request(feed+"?after="+snap.cursor)).status,409);
  assert.equal((await request(feed+after,undefined,1)).status,409);
  assert.deepEqual(snap.waiting.questions,[]);
  const session = await agent.openSession(id);
  const [opened] = (await session.history()).filter(e=>e.kind==="inputRequest");
  await session.setLimit(owner.rights.filter(r=>r!=="approve"));
  const res = await request(feed+after);
  assert.equal(res.status,200);
  const reader = res.body!.getReader();
  try {
    const {value} = await reader.read(); const item = JSON.parse(new TextDecoder().decode(value).trim().slice(6));
    assert.deepEqual(item,{cursor:item.cursor,requestId:opened.requestId,reason:"revoked"});
    assert.notEqual(item.cursor,snap.waitCursor);
  } finally { await reader.cancel(); }
});

for (const stop of ["before-marker","after-marker"]) test(`SIGKILL ${stop}: read the released exchange after restart without reopening`, async t => {
  const dir = await mkdtemp(join(tmpdir(),"receipt-flush-")); t.after(()=>rm(dir,{recursive:true,force:true}));
  const token = randomUUID(); await writeFile(join(dir,"token"),token,{mode:0o600});
  async function writer(stop:string) {
    const child = fork(new URL("../../../../scripts/receipt-writer.mjs",import.meta.url),[dir,stop],{stdio:["ignore","ignore","inherit","ipc"]});
    const ended = once(child,"exit"); t.after(()=>{ if (child.exitCode===null && child.signalCode===null) child.kill("SIGKILL"); });
    const [origin] = await once(child,"message");
    const http = (path:string,body?:unknown)=>fetch(`${origin}/agui/v1`+path,{method:body?"POST":"GET",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:body===undefined ? undefined : JSON.stringify(body)});
    return {child,ended,http};
  }
  const first = await writer(stop), {threadId} = await (await first.http("/threads",{})).json() as any;
  const runId = randomUUID(), post = first.http("/run",{threadId,runId,protocolVersion:"1.0",messages:[prompt("Begin")]});
  await post.then(r=>r.text()).catch(()=>{}); assert.deepEqual(await first.ended,[null,"SIGKILL"]);
  const second = await writer("read");
  try { assert.deepEqual(await (await second.http(`/threads/${threadId}/run-receipt?runId=${runId}`)).json(),
    {terminal:stop==="before-marker"?"unknown":"success",work:"completed"}); }
  finally { second.child.send("stop"); await second.ended; }
});

test("a handled input binds its no-turn disposition before release",async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),"handled-receipt-")); t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const {request,thread,run} = await setup(t,{dataDir,durability:"kept",plugins:[definePlugin({name:"handler",hooks:{input:()=>({handle:true})}})]});
  const id=await thread(), runId=randomUUID(); await events(await run(id,[prompt("Handle")],{runId}));
  assert.deepEqual(await (await request(`/threads/${id}/run-receipt?runId=${runId}`)).json(),{terminal:"success",work:"handled"});
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
  const dataDir=await mkdtemp(join(tmpdir(),"agui-running-")); t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const {thread,run,request}=await setup(t,{dataDir,durability:"kept",plugins:[plugin],interfaceTools:[source]}); const id=await thread();
  const first=run(id,[prompt("first")],{tools:[definition]});
  try {
    await entered.promise;
    const listing=await (await request("/threads",undefined,1)).json() as {threads:{waiting:unknown}[]};
    assert.deepEqual(listing.threads.map(t=>t.waiting), [{questions:0,toolCalls:0,turn:"running"}]);
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

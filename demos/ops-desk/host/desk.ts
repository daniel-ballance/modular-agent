import { serve, tool, type ToolContext } from '@modular-agent/core';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Agui, HttpError, type Decision, type Snapshot } from './agui.js';
import { launch, Projects, token } from './processes.js';
import { agents, Store, type Agent, type Question, type Route } from './store.js';

type Process = ReturnType<typeof launch>;
class Slot {
  route?: Route;
  process?: Process;
  presence?: AbortController;
  waiting = false;
  ended = false;
  recovering = false;
  idle?: NodeJS.Timeout;
  poll?: NodeJS.Timeout;
  tail = Promise.resolve();
  // A new GET supersedes a client's cursor. Do not let a debug read race a POST.
  serial<T>(fn: () => Promise<T>) {
    const result = this.tail.then(fn);
    this.tail = result.then(()=>{},()=>{});
    return result;
  }
}
const string = {type:'string',minLength:1,maxLength:4096} as const;
export class Desk {
  private slots = {triage:new Slot(),coder:new Slot(),verifier:new Slot()};
  private services = new Map<Agent,{url:string; close():Promise<void>}>();
  private closing = false;
  constructor(readonly db: Store, readonly projects: Projects, private idleMs: number, private approvalMs: number, private notify: () => void) {}
  async start() {
    for (const a of agents) {
      const source = (ctx: ToolContext) => {
        const r = this.slots[a].route;
        if (!r || !r.thread || r.thread !== ctx.sessionId) throw Error('No active work from that session');
        return r;
      };
      const service = await serve({name:'desk',setup:reg=>{
        reg.tool(tool({name:'post',description:'Post a summary, change or verdict to the desk.',input:{type:'object',properties:{kind:{enum:['summary','change','verdict']},text:string},required:['kind','text'],additionalProperties:false},run:({text,kind},ctx)=>{
          this.db.post(source(ctx),ctx.callId,kind,text); this.wake(); return 'Posted.';
        }}));
        if (a !== 'verifier') reg.tool(tool({name:'hand_off',description:'Queue a task for another desk agent.',input:{type:'object',properties:{to:{type:'string'},task:string},required:['to','task'],additionalProperties:false},run:async({to,task},ctx)=>{
          const r = source(ctx);
          this.db.handOff(r,to,task,this.projects.revision(a)); this.wake();
          // Crash check: the route is committed, but the coder has no tool result yet.
          const marker = join(this.projects.root,'held-handoff');
          if (a === 'coder' && process.env.DESK_TEST_HOLD_HANDOFF === '1' && !existsSync(marker)) {
            const child = this.slots.coder.process!;
            writeFileSync(marker,String(child.pid)); await child.exited;
          }
          return 'Queued.';
        }}));
        reg.on('turn.end',({sessionId})=>{ const s=this.slots[a]; if (s.route?.thread===sessionId) s.ended=true; });
      }},{listen:'127.0.0.1:0',tokenFile:token(this.projects.root,a+'-tools').path});
      this.services.set(a,service);
    }
    this.wake();
  }
  wake() { if (!this.closing) { this.notify(); for (const a of agents) this.pump(a); } }
  private async connect(a: Agent) {
    const s = this.slots[a]; clearTimeout(s.idle);
    if (!s.process) {
      const p = s.process = launch(this.projects,a,this.services.get(a)!.url,this.approvalMs);
      this.notify();
      void p.exited.then(()=>s.serial(async()=>{
        if (s.process !== p) return;
        s.process = undefined; this.notify();
        if (s.route && !this.closing) {
          if (s.recovering || !s.route.thread) this.finish(a,'failed',`${a} exited before it could serve the session.`);
          else { s.recovering=true; this.detach(s); await this.drive(a,s.route); }
        }
      }));
    }
    return s.process.ready;
  }
  private armIdle(a: Agent) {
    const s=this.slots[a]; clearTimeout(s.idle);
    if (!s.route && s.process && !this.closing) s.idle=setTimeout(()=>void s.serial(async()=>{
      if (!s.route && s.process) { const p=s.process; s.process=undefined; await p.stop(); this.notify(); }
    }),this.idleMs);
  }
  private pump(a: Agent) {
    const s=this.slots[a];
    if (s.route || this.closing) return;
    const r=this.db.next(a);
    if (!r) return;
    clearTimeout(s.idle); s.route=r; s.recovering=false; s.ended=false;
    void s.serial(()=>this.drive(a,r));
  }
  private detach(s: Slot) {
    s.presence?.abort(); s.presence=undefined; s.waiting=false; clearTimeout(s.poll);
  }
  private finish(a: Agent, state: 'done'|'reopened'|'failed', note?: string) {
    const s=this.slots[a]; this.detach(s); this.db.finish(s.route!,state,note); s.route=undefined;
    this.armIdle(a); this.wake();
  }
  private async drive(a: Agent,r: Route) {
    const s=this.slots[a];
    try {
      const api=await this.connect(a); await api.discover(r.parent);
      if (!r.thread) { this.projects.prepare(r); this.db.thread(r,await api.create(r)); }
      const view=await api.snapshot(r); // GET reopens the same session and runs recovery.
      if (view.messages.some(m=>m.role==='user')) {
        this.db.admitted(r);
        this.finish(a,'reopened',`${a} reopened the interrupted session. No new input was sent.`); return;
      }
      s.presence=new AbortController();
      await api.presence(r,s.presence,()=>{ void s.process?.stop(); });
      const outcome=await api.run(r,view,undefined,()=>this.db.admitted(r));
      this.outcome(a,outcome);
    } catch(e) { await this.problem(a,e); }
  }
  private async problem(a: Agent,e: unknown) {
    const s=this.slots[a]; if (this.closing || !s.route) return;
    // A lost exchange is not a failed turn. Stop the old writer before reopening.
    if (s.process?.abort.signal.aborted) return; // exit callback owns recovery
    if (s.route.thread && !s.recovering && e instanceof TypeError && e.cause) { await s.process?.stop(); return; }
    this.finish(a,'failed',`${a}: ${e instanceof Error ? e.message : 'operation failed'}`);
  }
  private outcome(a: Agent, outcome: {type:string; interrupts?:Question[]}) {
    const s=this.slots[a];
    if (outcome.type==='success') this.finish(a,'done');
    else if (outcome.type==='interrupt' && outcome.interrupts?.length) {
      this.db.observe(s.route!,outcome.interrupts); s.waiting=true; this.notify(); this.poll(a);
    } else this.finish(a,'failed',`${a}: ${outcome.type}`);
  }
  private poll(a: Agent) {
    const s=this.slots[a]; clearTimeout(s.poll);
    if (s.waiting && !this.closing) s.poll=setTimeout(()=>void s.serial(async()=>{
      try { await this.refresh(a); } catch(e) { await this.problem(a,e); } this.poll(a);
    }),300);
  }
  private async refresh(a: Agent): Promise<Snapshot | undefined> {
    const s=this.slots[a], r=s.route;
    if (!s.waiting || !r || !s.process || this.closing) return;
    const view=await (await s.process.ready).snapshot(r);
    // Only the same presence's current answerable projection can enable a button.
    for (const q of this.db.questions(r)) if (!view.waiting.questions.some(v=>v.id===q.id)) {
      this.db.resolve(r,q,q.expiresAt && Date.parse(q.expiresAt)<=Date.now() ? 'expired' : 'closed'); this.notify();
    }
    this.db.observe(r,view.waiting.questions);
    if (!view.waiting.questions.length && s.ended) this.finish(a,'done');
    return view;
  }
  async answer(id: number, answers: Decision[]) {
    const r=this.db.route(id); if (!r) throw new HttpError(404,'Unknown route');
    const s=this.slots[r.agent];
    return s.serial(async()=>{
      if (s.route?.id!==id || !s.waiting) throw new HttpError(409,'This question is closed');
      const view=await this.refresh(r.agent), questions=view?.waiting.questions;
      if (!view || !questions?.length || !s.waiting || !Array.isArray(answers) || answers.length!==questions.length) throw new HttpError(409,'The questions changed');
      for (const q of questions) {
        const ans=answers.find(v=>v.interruptId===q.id);
        if (!ans || (q.expiresAt && Date.parse(q.expiresAt)<=Date.now())) throw new HttpError(409,'Question is not answerable');
        if (ans.status==='cancelled') continue;
        if (ans.status!=='resolved' || (q.reason==='approval' ? typeof (ans.payload as {allow?:unknown})?.allow!=='boolean' : typeof ans.payload!=='string')) throw new HttpError(400,'Invalid answer');
      }
      try {
        const outcome=await (await s.process!.ready).run(r,view,answers,()=>{
          for (const q of questions) {
            const ans=answers.find(v=>v.interruptId===q.id)!;
            this.db.resolve(r,q,ans.status==='cancelled' || (ans.payload as {allow?:unknown})?.allow===false ? 'declined' : 'answered');
          }
        });
        this.outcome(r.agent,outcome);
      } catch(e) { if (!(e instanceof HttpError)) await this.problem(r.agent,e); throw e; }
    });
  }
  async state() {
    await Promise.all(agents.filter(a=>this.slots[a].waiting).map(a=>this.slots[a].serial(()=>this.refresh(a))));
    const inbox=this.db.inbox().map(q=>({...q,answerable:q.status==='open' && this.slots[q.agent as Agent].waiting && this.slots[q.agent as Agent].route?.id===q.route && (!q.expiresAt || Date.parse(q.expiresAt)>Date.now())}));
    return {posts:this.db.conversation(),inbox,agents:Object.fromEntries(agents.map(a=>[a,this.slots[a].route?'working':this.slots[a].process?'idle':'stopped'])),routes:this.db.routes(),cursor:this.db.cursor()};
  }
  async debug(id: number) {
    const r=this.db.route(id); if (!r?.thread) throw new HttpError(404,'No snapshot');
    return this.slots[r.agent].serial(async()=>{ try { return await (await this.connect(r.agent)).snapshot(r); } finally { this.armIdle(r.agent); } });
  }
  async close() {
    this.closing=true;
    for (const s of Object.values(this.slots)) { clearTimeout(s.idle); this.detach(s); }
    await Promise.all(Object.values(this.slots).map(s=>s.process?.stop()));
    await Promise.all(Object.values(this.slots).map(s=>s.tail));
    await Promise.all([...this.services.values()].map(p=>p.close()));
  }
}

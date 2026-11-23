import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Agui } from './agui.js';
import { agents, type Agent, type Route } from './store.js';

export const demo = fileURLToPath(new URL('../../',import.meta.url));
export const rights = ['watch','input','tools','approve','answer'];
export function token(root: string, name: string) {
  const path = join(root,name+'.token');
  if (!existsSync(path)) writeFileSync(path,randomBytes(32).toString('hex')+'\n',{mode:0o600,flag:'wx'});
  if (statSync(path).mode & 0o077) throw Error('Token file is not owner-only');
  return {path,value:readFileSync(path,'utf8').trim()};
}
function env(root: string): NodeJS.ProcessEnv {
  return {HOME:join(root,'home'),PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,LANG:'C.UTF-8',
    GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',PYTHONDONTWRITEBYTECODE:'1',
    ...(process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? {OTEL_EXPORTER_OTLP_ENDPOINT:process.env.OTEL_EXPORTER_OTLP_ENDPOINT,OTEL_EXPORTER_OTLP_PROTOCOL:'http/protobuf'} : {}),
    OTEL_SDK_DISABLED:process.env.OTEL_SDK_DISABLED};
}
export class Projects {
  constructor(readonly root: string, sample: string) {
    mkdirSync(join(root,'home'),{recursive:true});
    const seed = join(root,'sample');
    if (!existsSync(join(seed,'.git'))) {
      cpSync(sample,seed,{recursive:true,filter:path=>!['.git','__pycache__'].includes(path.split('/').at(-1)!)});
      this.git(seed,'init','-b','sample');
      this.git(seed,'config','user.name','Desk coder'); this.git(seed,'config','user.email','desk@example.invalid');
      this.git(seed,'add','.'); this.git(seed,'commit','-m','Sample before the fix'); this.git(seed,'tag','seed');
    }
    for (const a of agents) if (!existsSync(join(this.tree(a),'.git'))) this.git(seed,'worktree','add','--detach',this.tree(a),'seed');
  }
  tree(a: Agent) { return join(this.root,'trees',a); }
  git(cwd: string,...args: string[]) { return execFileSync('git',args,{cwd,env:env(this.root),encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim(); }
  prepare(r: Route) {
    // Only reset a private demo worktree, never the owner's project or a turn being recovered.
    this.git(this.tree(r.agent),'reset','--hard',r.revision);
    this.git(this.tree(r.agent),'clean','-fdx');
  }
  revision(a: Agent) { return this.git(this.tree(a),'rev-parse','HEAD'); }
}
export function launch(projects: Projects, agent: Agent, pluginUrl: string, approvalMs: number) {
  const root = projects.root, project = projects.tree(agent), data = join(root,'agents',agent);
  const auth = token(root,agent+'-agui');
  const childEnv = env(root);
  const plugins: object[] = [{url:pluginUrl,tokenFile:token(root,agent+'-tools').path}];
  const python = join(demo,'triage','.venv','bin','python');
  mkdirSync(data,{recursive:true});
  Object.assign(childEnv,{MODULAR_AGENT_DATA_DIR:data,DESK_PROJECT:project,DESK_TOKEN_FILE:auth.path,OTEL_SERVICE_NAME:'desk-'+agent});
  let cmd: string[];
  if (agent === 'coder') {
    plugins.push({command:[python,join(demo,'coder','change.py')],env:{DESK_APPROVAL_MS:String(approvalMs)}});
    childEnv.MODULAR_AGENT_SCRIPT = join(demo,'coder','model.json');
    const policy = join(data,'policy.json');
    writeFileSync(policy,JSON.stringify({actors:[{tokenFile:auth.path,actor:{id:'desk',kind:'user',rights},clientId:'ops-desk',projects:[project]}]}));
    cmd = [resolve(demo,'../../rust/target/debug/ma'),'--agui','--listen','127.0.0.1:0','--policy',policy,'--project',project,'--model','scripted/script'];
  } else cmd = agent === 'triage' ? [python,join(demo,'triage','main.py')] : [join(demo,'.build','verifier')];
  childEnv.MODULAR_AGENT_PLUGINS = JSON.stringify(plugins);
  const log = openSync(join(root,agent+'.log'),'a',0o600);
  const proc = spawn('setpriv',['--pdeathsig','KILL','--',...cmd],{cwd:project,env:childEnv,detached:true,stdio:['ignore','pipe',log]});
  closeSync(log);
  const abort = new AbortController();
  const exited = new Promise<void>(resolve=>{ const stopped=()=>{ abort.abort(); resolve(); }; proc.once('exit',stopped); proc.once('error',stopped); });
  const kill = (sig: NodeJS.Signals) => { if (proc.pid) try { process.kill(-proc.pid,sig); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; } };
  void exited.then(()=>kill('SIGKILL')); // includes a plugin orphaned by SIGKILL
  const lines = createInterface({input:proc.stdout!});
  const ready = new Promise<Agui>((res,rej)=>{
    lines.once('line',line=>{ try { res(new Agui(line.trim(),auth.value,abort.signal)); } catch (e) { rej(e); } });
    void exited.then(()=>rej(Error(`${agent} exited; see ${agent}.log`)));
  });
  return {pid:proc.pid,abort,ready,exited,stop:async()=>{
    // ma handles Ctrl-C by closing the listener, agent and exporters. Keep its
    // plugin alive until then. Clean up remaining descendants after leader exit.
    if (!abort.signal.aborted) proc.kill(agent === 'coder' ? 'SIGINT' : 'SIGTERM');
    await exited;
  }};
}

import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const agents = ['triage', 'coder', 'verifier'] as const;
export type Agent = typeof agents[number];
export type Route = { id: number; event: number; agent: Agent; attempt: number; task: string; runKey: string; revision: string; thread: string | null; state: string; parent: string | null };
export type Question = { id: string; reason: string; message: string; toolCallId?: string; expiresAt?: string; responseSchema?: { enum?: string[] }; metadata?: Record<string,string> };
const pending = "('queued','sending','admitted')";

export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, externalId TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, parent TEXT);
      CREATE TABLE IF NOT EXISTS listener(singleton INTEGER PRIMARY KEY CHECK(singleton=1), cursor INTEGER NOT NULL);
      INSERT OR IGNORE INTO listener VALUES(1,0);
      CREATE TABLE IF NOT EXISTS routes(id INTEGER PRIMARY KEY, event INTEGER NOT NULL REFERENCES events(seq), agent TEXT NOT NULL, attempt INTEGER NOT NULL,
        task TEXT NOT NULL, runKey TEXT NOT NULL, revision TEXT NOT NULL, thread TEXT, state TEXT NOT NULL DEFAULT 'queued', UNIQUE(event,agent,attempt));
      CREATE TABLE IF NOT EXISTS posts(id INTEGER PRIMARY KEY, event INTEGER NOT NULL REFERENCES events(seq), route INTEGER REFERENCES routes(id), kind TEXT NOT NULL, text TEXT NOT NULL, callId TEXT, UNIQUE(route,callId));
      CREATE TABLE IF NOT EXISTS inbox(route INTEGER REFERENCES routes(id), question TEXT NOT NULL, view TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(route,question));`);
  }
  close() { this.db.close(); }
  private atomic<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  private queue(event: number, agent: Agent, attempt: number, task: string, revision: string, key = randomUUID() as string) {
    this.db.prepare('INSERT INTO routes(event,agent,attempt,task,revision,runKey) VALUES(?,?,?,?,?,?) ON CONFLICT(event,agent,attempt) DO NOTHING').run(event, agent, attempt, task, revision, key);
  }
  receive(id: string, kind: string, payload: unknown, parent: string | null) {
    return this.atomic(() => {
      const text = JSON.stringify(payload);
      const result = this.db.prepare('INSERT INTO events(externalId,kind,payload,parent) VALUES(?,?,?,?) ON CONFLICT(externalId) DO NOTHING').run(id, kind, text, parent);
      if (!result.changes) return false;
      const seq = Number(result.lastInsertRowid);
      const task = `${kind}: ${text}`;
      this.db.prepare("INSERT INTO posts(event,kind,text) VALUES(?,'event',?)").run(seq, task);
      this.queue(seq, 'triage', 0, task, 'seed', id);
      return true;
    });
  }
  private select(where: string, value: string | number) {
    return this.db.prepare(`SELECT r.*, e.parent FROM routes r JOIN events e ON e.seq=r.event WHERE ${where} ORDER BY r.id LIMIT 1`).get(value) as Route | undefined;
  }
  next(agent: Agent) {
    // An admitted route at the cursor may still need its session reopened.
    const afterCursor = agent === 'triage' ? " AND (event>(SELECT cursor FROM listener) OR state='admitted')" : '';
    return this.select(`agent=? AND state IN ${pending}${afterCursor}`,agent);
  }
  route(id: number) { return this.select('r.id=?', id); }
  thread(r: Route, id: string) { this.db.prepare("UPDATE routes SET thread=?,state='sending' WHERE id=?").run(id,r.id); r.thread = id; }
  admitted(r: Route) {
    this.atomic(() => {
      this.db.prepare("UPDATE routes SET state='admitted' WHERE id=?").run(r.id);
      if (r.agent === 'triage') this.db.prepare('UPDATE listener SET cursor=max(cursor,?)').run(r.event);
    });
  }
  cursor() { return this.db.prepare('SELECT cursor FROM listener').get()!.cursor; }
  finish(r: Route, status: 'done'|'reopened'|'failed', note?: string) {
    this.atomic(() => {
      if (note) this.db.prepare("INSERT INTO posts(event,route,kind,text) VALUES(?,?,'notice',?)").run(r.event,r.id,note);
      this.db.prepare('UPDATE routes SET state=? WHERE id=?').run(status,r.id);
      this.db.prepare("UPDATE inbox SET status='closed' WHERE route=? AND status='open'").run(r.id);
    });
  }
  post(r: Route, call: string, kind: string, text: string) {
    if (kind !== ({triage:'summary',coder:'change',verifier:'verdict'})[r.agent]) throw Error('Wrong post kind for this agent');
    if (kind === 'verdict' && !/^(PASS|FAIL): /.test(text)) throw Error('A verdict starts with PASS: or FAIL:');
    this.atomic(() => {
      const row = this.db.prepare('INSERT INTO posts(event,route,kind,text,callId) VALUES(?,?,?,?,?) ON CONFLICT(route,callId) DO NOTHING').run(r.event,r.id,kind,text,call);
      if (row.changes && kind === 'verdict' && text.startsWith('FAIL: ') && r.attempt < 2) this.queue(r.event,'coder',r.attempt+1,text,r.revision);
    });
  }
  handOff(r: Route, to: string, task: string, revision: string) {
    if (r.agent === 'triage' && to === 'coder') this.queue(r.event,'coder',0,task,'seed');
    else if (r.agent === 'coder' && to === 'verifier' && /^[a-f0-9]{40,64}$/.test(revision)) this.queue(r.event,'verifier',r.attempt,task,revision);
    else throw Error('This hand-off is not allowed');
  }
  observe(r: Route, questions: Question[]) {
    const upsert = this.db.prepare(`INSERT INTO inbox VALUES(?,?,?,'open') ON CONFLICT(route,question) DO UPDATE SET view=excluded.view WHERE status='open'`);
    for (const q of questions) upsert.run(r.id,q.id,JSON.stringify(q));
  }
  resolve(r: Route, q: Question, status: string) {
    this.atomic(() => {
      const changed = this.db.prepare("UPDATE inbox SET status=? WHERE route=? AND question=? AND status='open'").run(status,r.id,q.id);
      if (changed.changes && status === 'expired') this.db.prepare("INSERT INTO posts(event,route,kind,text) VALUES(?,?,'notice',?)").run(r.event,r.id,`${q.reason === 'approval' ? 'Approval refused' : 'Question closed'} at its deadline: ${q.message}`);
    });
  }
  questions(r: Route): Question[] { return this.db.prepare("SELECT view FROM inbox WHERE route=? AND status='open'").all(r.id).map(x=>JSON.parse(String(x.view))); }
  inbox() { return this.db.prepare(`SELECT i.route,r.agent,r.thread,i.status,i.view FROM inbox i JOIN routes r ON r.id=i.route ORDER BY coalesce(json_extract(view,'$.expiresAt'),'~'),i.rowid`).all().map(({view,...x})=>({...x,...JSON.parse(String(view))})); }
  conversation() { return this.db.prepare('SELECT p.id,e.externalId AS event,p.route,r.thread,r.agent,p.kind,p.text FROM posts p JOIN events e ON e.seq=p.event LEFT JOIN routes r ON r.id=p.route ORDER BY p.id').all(); }
  routes() { return this.db.prepare('SELECT id,event,agent,attempt,thread,state,revision FROM routes ORDER BY id').all(); }
}

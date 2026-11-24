import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HistoryEntry } from "./types.js";

export type TerminalClass = "success" | "interrupt" | "cancelled" | "error";
/** Only references needed to re-gate the original release. Never store frame bodies. */
export interface ReleaseProof {
  through?: string; cursor?: string; groupDigest?:string; questions?: string[]; calls?: string[]; error?: string;
  sources: string[];
}
export interface ReceiptOperation { id:string; thread:string; actor:string; key:string; answers:Set<string>; reports:Set<string>; bound?:boolean }
export function receiptId(thread: string, actor: string, client: string, run: string) {
  return createHash("sha256").update(JSON.stringify(["agui.runReceipt/1", thread, actor, client, run])).digest("hex");
}
export function linkedWork(branch: HistoryEntry[], op: HistoryEntry) {
  if (op.kind === "inputAccepted") {
    const handback = branch.find(e => e.kind === "inputHandedBack" && (e.inputId === op.inputId || e.inputIds?.includes(op.inputId!)));
    const taken = branch.find(e => e.kind === "input" && e.inputId === op.inputId);
    return { turn:taken?.turnId, taken, handback };
  }
  const ended = branch.slice(0, branch.indexOf(op)).some(e => e.kind === "turnEnd" && e.turnId === op.turnId);
  const taken = branch.find(e => e.kind === "turnStart" && (ended ? e.continuesTurnId === op.turnId : e.turnId === op.turnId));
  return { turn:taken?.turnId, taken };
}

/** Deployment metadata, outside branch history. The key is also the first operation's
 * ordinary entry ID: without that committed entry a slot proves nothing. In particular,
 * killing a writer after reservation does not claim the run. Erasure keeps no slot. */
export class RunReceipts {
  private path: string;
  constructor(private dir:string) { this.path = join(dir,"agui-receipts.sqlite"); }
  private use<T>(fn:(db:DatabaseSync)=>T) {
    const db = new DatabaseSync(this.path);
    try { chmodSync(this.path,0o600); db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON"); return fn(db); }
    finally { db.close(); }
  }
  reserve(thread:string, id:string) {
    mkdirSync(this.dir,{recursive:true,mode:0o700});
    this.use(db => {
      db.exec("CREATE TABLE IF NOT EXISTS receipt (id TEXT PRIMARY KEY, thread TEXT NOT NULL, terminal TEXT NOT NULL, proof TEXT NOT NULL)");
      db.prepare("INSERT OR REPLACE INTO receipt VALUES (?,?,?,?)").run(id,thread,"unknown  ","{}");
    });
  }
  stage(id:string, proof:ReleaseProof) {
    this.use(db => { if (!db.prepare("UPDATE receipt SET proof=? WHERE id=?").run(JSON.stringify(proof),id).changes) throw new Error("Receipt erased"); });
  }
  released(id:string, terminal:TerminalClass) {
    // The class has a fixed-size slot before admission; never recreate an erased row.
    this.use(db => db.prepare("UPDATE receipt SET terminal=? WHERE id=?").run(terminal.padEnd(9),id));
  }
  get(id:string) {
    if (!existsSync(this.path)) return;
    return this.use(db => {
      const row = db.prepare("SELECT terminal, proof FROM receipt WHERE id=?").get(id);
      if (row) return {terminal:String(row.terminal).trim() as TerminalClass | "unknown", proof:JSON.parse(String(row.proof)) as ReleaseProof};
    });
  }
  erase(thread:string, ids:Set<string>, entries:HistoryEntry[]) {
    if (!existsSync(this.path)) return;
    this.use(db => {
      const remove = db.prepare("DELETE FROM receipt WHERE id=?");
      for (const row of db.prepare("SELECT id, proof FROM receipt WHERE thread=?").all(thread)) {
        const id = String(row.id), op = entries.find(e => e.id === id);
        const {turn,taken,handback} = op ? linkedWork(entries,op) : {};
        const end = turn && entries.find(e => e.kind === "turnEnd" && e.turnId === turn);
        const {sources=[]} = JSON.parse(String(row.proof)) as ReleaseProof;
        if ([id,taken?.id,handback?.id,end && end.id,...sources].some(s => s && ids.has(s))) remove.run(id);
      }
    });
  }
}

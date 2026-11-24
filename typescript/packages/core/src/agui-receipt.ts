import { linkedWork, receiptId, type HistoryEntry, type ReleaseProof, type TerminalClass } from "@modular-agent/harness";
import { HostRead } from "./agui-host-reads.js";
import { callFrames } from "./agui-exchange.js";
import { assistantId, messages, reply } from "./agui-view.js";
import { fail, hash, object, same, type WireEvent } from "./agui-wire.js";

async function visibleRelease(r:HostRead, runId:string, entries:HistoryEntry[], terminal:TerminalClass, proof:ReleaseProof) {
  const boundary = {threadId:r.id,runId};
  let group:WireEvent[];
  if (terminal === "error") {
    group = [{type:"RUN_ERROR", code:proof.error, message:"Run could not be delivered."}];
  } else {
    const cut = entries.findIndex(e => e.id === proof.through);
    if (cut < 0 || !proof.cursor) return false;
    const prefix = entries.slice(0,cut+1);
    const copy = await messages(r.t.api,r.id,r.p,prefix,new Set());
    const calls = [], questions = [];
    for (const id of proof.questions ?? []) {
      const entry = prefix.find(e=>e.kind === "inputRequest" && e.requestId === id);
      const q = entry && await r.question(entry);
      const {rights} = await r.view();
      if (!rights.includes(q?.reason === "approval" ? "approve" : "answer")) return false;
      if (!q) return false;
      questions.push(q);
    }
    for (const id of proof.calls ?? []) {
      if (!(await r.view()).rights.includes("tools")) return false;
      const call = await r.handoff(prefix,id);
      if (!call) return false;
      calls.push(call);
    }
    const outcome = {type:terminal, ...(questions.length && {interrupts:questions}), ...(terminal === "success" && calls.length && {pendingToolCallIds:proof.calls})};
    group = [...calls.flatMap(call => callFrames(call,call.stepId && copy.some(m=>m.id === assistantId(call.stepId)) ? assistantId(call.stepId) : undefined)),
      {type:"MESSAGES_SNAPSHOT",messages:copy}, {type:"CUSTOM",name:"modular-agent.history",value:{cursor:proof.cursor,lastMessageId:copy.at(-1)?.id ?? null}},
      {type:"RUN_FINISHED",...boundary,outcome}];
  }
  if (proof.groupDigest && hash(group) !== proof.groupDigest) return false;
  return same(group, await reply(r.t.api,r.id,r.p,"events",structuredClone(group)));
}

/** Resolve both facts on one branch. No openSession, recovery, presence or effect. */
export async function runReceipt(r:HostRead, query:URLSearchParams) {
  const v = await r.view();
  const runId = query.get("runId");
  if (!runId || query.getAll("runId").length !== 1) fail("invalid_request");
  const id = receiptId(r.id,r.p.actor.id,r.p.clientId,runId), entries = v.records;
  const op = entries.find(e=>e.id === id);
  if (!v.kept || !op || op.erased || op.actorId !== r.p.actor.id || !["inputAccepted","inputAnswer","toolResult"].includes(op.kind)) fail("not_found");
  const mark = r.t.h.receipts.get(id);
  if (!mark) fail("not_found");
  const {turn,taken,handback} = linkedWork(v.all,op);
  const branchIds = new Set(entries.map(e=>e.id));
  if ([taken,handback,...v.all.filter(e=>turn && e.turnId===turn && e.kind==="turnEnd")].some(e=>e && !branchIds.has(e.id))) fail("not_found");
  const end = turn && entries.find(e=>e.kind === "turnEnd" && e.turnId === turn);
  const facts = async () => {
    if (!await r.entry(op) || taken && !await r.entry(taken) || handback && !await r.entry(handback)) fail("not_found");
    if (op.kind !== "inputAccepted" && !await r.closure(entries,op)) fail("not_found");
    let work = "unsettled";
    if (handback) {
      const visible = await r.entry(handback);
      if (!object(handback.data) || !object(visible?.data) || visible.data.reason !== handback.data.reason) fail("not_found");
      work = handback.data.reason === "handled" ? "handled" : "handedBack";
    }
    else if (end) {
      const raw = end.data;
      const projected = await r.entry(end);
      if (!object(raw) || !object(projected?.data) || !same(projected.data.outcome,raw.outcome)) fail("not_found");
      const allowed = await r.gate("turn.ended", {outcome:raw.outcome,result:raw.result}, end);
      if (!same(allowed?.outcome,raw.outcome) || !["completed","cancelled","failed","limit"].includes(raw.outcome.kind)) fail("not_found");
      work = raw.outcome.kind;
    }
    if (mark.terminal !== "unknown" && (mark.proof.sources.some(id=>!entries.some(e=>e.id === id && !e.erased)) ||
      !await visibleRelease(r,runId,entries,mark.terminal,mark.proof))) fail("not_found");
    return {terminal:mark.terminal, work};
  };
  try {
    const out = await facts();
    const gated = await r.gate("reply",{method:"agui.runReceipt",clientId:r.p.clientId,result:out});
    // A reply gate can wait. Recheck source gates and the grant before release.
    await facts();
    const fresh = await r.view();
    if (v.generation !== fresh.generation || !fresh.records.some(e=>e.id===op.id && !e.erased)) fail("not_found");
    if (!same(v.rights, fresh.rights)) fail("not_found");
    if (!same(gated,{method:"agui.runReceipt",clientId:r.p.clientId,result:out})) return undefined;
    return out;
  } catch (e) {
    if (["output_withheld","result_too_large"].includes((e as {code:string}).code)) fail("not_found");
    throw e;
  }
}

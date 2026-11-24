// Latches on actual commits, gates and transport boundaries in the disposable kit process.
// The control port can hold an operation, not manufacture its decision or its receipt.
import { Harness, receiptId, linkedWork } from '@modular-agent/harness';
import { WaitClosures, HostRead } from '../packages/core/dist/src/agui-host-reads.js';
import { Route } from '../packages/core/dist/src/agui.js';
import { RunReceipts } from '../packages/harness/dist/src/run-receipts.js';

export function hostControls(name, latch) {
  const armed = new Map(), waitPolicy = new Map(), opened = new Map(), jobs = new Map();
  let cursors, receiptPolicy;
  const key = (id, at) => JSON.stringify([id,at]);
  function hold(id, at, runId) { armed.set(key(id,at),{runId,release:Promise.withResolvers()}); }
  async function boundary(id, at, runId) {
    const fence = armed.get(key(id,at));
    if (!fence || runId && fence.runId && runId !== fence.runId) return;
    latch(id,at).resolve(); await fence.release.promise;
  }
  if (/^(closure|receipt)-/.test(name)) {
    const serve = WaitClosures.prototype.serve;
    WaitClosures.prototype.serve = function(r,res,...args) {
      cursors = this;
      const flush = res.flushHeaders.bind(res);
      res.flushHeaders = () => { flush(); latch(r.id,'waitFollowing').resolve(); };
      return serve.call(this,r,res,...args);
    };
    const presence = Route.prototype.presence;
    Route.prototype.presence = function(res) {
      const value = presence.call(this,res);
      res.once('close',()=>latch(this.id,'presenceLost').resolve()); return value;
    };
    const remember = WaitClosures.prototype.remember;
    WaitClosures.prototype.remember = function(...args) { cursors=this; return remember.apply(this,args); };
    const gate = HostRead.prototype.gate;
    HostRead.prototype.gate = async function(type,...args) {
      if (type === 'modular-agent.waitClosed') await boundary(this.id,'beforeWaitDelivery');
      return gate.call(this,type,...args);
    };
    const commit = Harness.prototype.commit;
    Harness.prototype.commit = async function(s,drafts,...args) {
      const result = await commit.call(this,s,drafts,...args);
      for (const e of result) {
        if (e.kind === 'inputRequest') opened.get(s.id)?.resolve(e.requestId);
        if (e.kind === 'toolResult') await boundary(s.id,'afterResult');
        if (e.kind === 'turnEnd') latch(s.id,'recoveryEnded').resolve();
      }
      return result;
    };
    const record = RunReceipts.prototype.released;
    RunReceipts.prototype.released = function(id,status) { record.call(this,id,status); latch(id,'terminalRecorded').resolve(); };
  }
  return { waitPolicy, opened, jobs, boundary,
    hold, release(id,at) { const k=key(id,at); armed.get(k)?.release.resolve(); armed.delete(k); },
    expire(cursor) { cursors.cursors.delete(cursor); },
    receiptGate(mode) { receiptPolicy=mode; },
    async output(id,event) {
      const d=event.data;
      if (event.type==='reply' && d.method==='agui.events') {
        const end=d.result.find(e=>e.type==='RUN_FINISHED'); if (end) await boundary(id,'beforeTerminal',end.runId);
      }
      if (['terminal','work'].includes(receiptPolicy) && d?.method==='agui.runReceipt') { d.result[receiptPolicy]='changed'; return {redact:[event]}; }
      if (receiptPolicy==='settlement' && event.type==='turnEnded' || receiptPolicy==='reply' && d?.method==='agui.runReceipt') return 'block';
      if (event.type==='entry' && ((d.entry.kind==='inputRequest' && waitPolicy.get(d.entry.requestId)==='opening') ||
          (d.entry.kind==='inputAnswer' && waitPolicy.get(d.entry.requestId)==='decision'))) return 'block';
      if (event.type==='modular-agent.waitClosed' && waitPolicy.get(d.requestId)==='notice') { d.reason='changed'; return {redact:[event]}; }
    },
    async barrier(id,at,runId,store) {
      if (at==='terminalRecorded') return latch(receiptId(id,'kit-owner','kit-primary',runId),at).promise;
      if (at==='recoveryEnded') {
        await latch(id,at).promise;
        const {entries} = await store.load(id), op=entries.find(e=>e.id===receiptId(id,'kit-owner','kit-primary',runId));
        if (!op || !entries.some(e=>e.kind==='turnEnd' && e.turnId===linkedWork(entries,op).turn)) throw Error('linked work has not ended');
        return;
      }
      return latch(id,at).promise;
    }
  };
}

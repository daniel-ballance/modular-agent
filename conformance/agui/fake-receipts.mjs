import { randomUUID as id } from 'node:crypto';
import { dispatch, offer } from './cases.mjs';

// Keep exchange markers apart from turn ends, including across a fake restart.
export function fakeReceipts(name, fault) {
  const book = s => s.receipts ??= new Map();
  const append = (s, kind, data = {}, scope = {}) => s.batches.push([{ id: id(), kind, data, ...scope }]);
  const end = (s, turnId, kind) => append(s, 'turnEnd', { outcome: { kind } }, { turnId });
  const start = (s, origin) => {
    const turnId = id(); append(s, 'turnStart', {}, { turnId, ...(origin && { continuesTurnId: origin }) }); return turnId;
  };
  function latch(s, name, runId = '') {
    const key = name + ':' + runId;
    if (!s.waiters.has(key)) s.waiters.set(key, Promise.withResolvers());
    return s.waiters.get(key);
  }
  function bind(s, client, post, turnId) {
    const entry = { client, runId: post.runId, terminal: 'unknown', turnId };
    book(s).set(post.runId, entry); s.runs.add(`${client}:${post.runId}`); return entry;
  }
  async function pause(s, post, response) {
    const { name } = s.hold;
    if (fault === 'early-terminal' && name === 'beforeTerminal') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      response.end('data: {"type":"RUN_FINISHED"}\n\n');
      latch(s, name, post.runId).resolve(); return [-1];
    }
    const closed = new Promise(resolve => response.once('close', resolve));
    latch(s, name, post.runId).resolve(); await closed; return [-1];
  }
  return {
    snapshot() { return { runReceipts: 1 }; }, eligible() { return false; }, disconnect() {},
    receipt(s, client, url, res, json, error) {
      const r = book(s).get(url.searchParams.get('runId'));
      const visible = r && (r.client === client || fault === client + '-receipt') && !(s.erased && fault !== 'erased-receipt') && !(s.erasing && fault !== 'pending-receipt');
      if (!visible || s.policy === 'settlement' && fault !== 'settlement-as-unknown') {
        if (fault === 'withheld-oracle' && s.policy === 'reply') return error(res, 403, 'output_withheld');
        return error(res, 404, 'not_found');
      }
      if (s.policy === 'reply' && fault !== 'ignore-reply-gate') return error(res, 403, 'output_withheld');
      const ends = s.batches.flat().filter(e => e.kind === 'turnEnd');
      let work = ends.find(e => e.turnId === r.turnId)?.data.outcome.kind ?? 'unsettled';
      let terminal = r.terminal;
      if (fault === 'exchange-is-work' && terminal === 'interrupt') work = 'completed';
      if (fault === 'latest-turn' && s.recovered) work = ends.at(-1).data.outcome.kind;
      if (fault === 'assume-transient' && s.recovered && r.terminal === 'unknown') work = 'failed';
      if (fault === 'infer-error-from-loss' && s.recovered) terminal = 'error';
      if (fault === 'infer-success-from-end' && work === 'completed') terminal = 'success';
      if (fault === 'follow-origin' && r.origin) work = 'completed';
      if (fault === 'merge-exchanges') terminal = [...book(s).values()].at(-1).terminal;
      if (fault === 'read-admits') append(s, 'inputAccepted');
      if (fault === 'read-rehandoff' && r.origin && s.recovered) s.dispatches.push(s.dispatches[0]);
      return json(res, 200, { terminal, work, ...(fault === 'receipt-body' && { messages: s.messages }) });
    },
    duplicate(s, post) {
      if (fault === 'retry-decision' && post.resume?.length) append(s, 'inputAnswer');
      return fault === 'accept-used-id';
    },
    async run({ s, client, data, suffix, resume, push, emit, finish, response }) {
      const phase = s.hold?.runId === data.runId && s.hold.name;
      if (phase === 'beforeAdmission') {
        if (fault === 'early-link' || fault === 'reserve-rejected-id') bind(s, client, data);
        if (fault === 'reserve-rejected-id') book(s).delete(data.runId);
        return pause(s, data, response);
      }
      let r, outcome = { type: 'success' };
      if (resume.length) {
        if (!s.question || !s.presence.has(client) || resume[0].interruptId !== s.question.id) return [409, 'conflict'];
        append(s, 'inputAnswer', { requestId: s.question.id }); delete s.question;
        r = bind(s, client, data, s.origin); end(s, s.origin, 'completed');
      } else if (suffix[0]?.role === 'tool') {
        if (!s.open || suffix[0].toolCallId !== s.open) return [409, 'conflict'];
        append(s, 'toolResult', { status: 'completed' }, { toolCallId: s.open, turnId: s.origin }); delete s.open;
        r = bind(s, client, data); r.origin = s.origin;
        if (fault === 'extra-result-input') append(s, 'inputAccepted');
        if (phase === 'afterResult') return pause(s, data, response);
      } else if (suffix.length === 1 && suffix[0].role === 'user') {
        append(s, 'inputAccepted'); s.origin = start(s); append(s, 'input', {}, { turnId: s.origin });
        s.messages.push({ ...suffix[0], id: 'ma:user:' + id() });
        r = bind(s, client, data, s.origin);
        if (phase === 'afterAdmission') {
          if (fault === 'late-link') book(s).delete(data.runId);
          return pause(s, data, response);
        }
        if (name === 'receipt-interrupt') {
          s.question = { id: id(), reason: 'choice', message: 'Choose yes or no.' };
          outcome = { type: 'interrupt', interrupts: [s.question] };
        } else {
          if (name === 'receipt-result') {
            s.open = id(); s.expiresAt = new Date(s.now + 60000).toISOString(); const toolCallId = s.open;
            append(s, 'toolStarted', {}, { turnId: s.origin, toolCallId });
            push('TOOL_CALL_START', { toolCallId, toolCallName: offer.name });
            push('TOOL_CALL_ARGS', { toolCallId, delta: JSON.stringify(dispatch) }); push('TOOL_CALL_END', { toolCallId });
            outcome.pendingToolCallIds = [toolCallId]; s.dispatches.push(toolCallId);
          }
          end(s, s.origin, 'completed');
          if (phase === 'beforeTerminal') return pause(s, data, response);
        }
      } else return [400, 'invalid_request'];
      emit(); finish(outcome); r.terminal = outcome.type;
      latch(s, 'terminalRecorded', data.runId).resolve();
    },
    async restart(sessions) {
      for (const s of sessions.values()) { s.recover = s.hold; delete s.hold; s.views.clear(); }
    },
    reopen(s) {
      if (!s.recover) return;
      const { name: phase, runId } = s.recover; delete s.recover; s.recovered = true;
      if (phase === 'afterAdmission') end(s, s.origin, name === 'receipt-durable' ? 'completed' : 'failed');
      if (phase === 'afterResult') {
        const r = book(s).get(runId); r.turnId = start(s, r.origin); end(s, r.turnId, 'failed');
      }
      if (fault === 'lose-link') book(s).delete(runId);
      latch(s, 'recoveryEnded', runId).resolve();
    },
    async control(op, s, args) {
      switch (op) {
        case 'inspect': return { batches: s.batches, dispatches: s.dispatches };
        case 'hold': s.hold = args; break;
        case 'barrier': await latch(s, args.name, args.runId).promise; break;
        case 'release': latch(s, 'release-' + args.name).resolve(); break;
        case 'receiptGate': s.policy = args.mode; break;
        case 'erase':
          s.erasing = true; latch(s, 'pendingErasure').resolve(); await latch(s, 'release-pendingErasure').promise;
          s.erasing = false; s.erased = true; break;
        default: throw new Error('unknown receipt fixture operation');
      }
      return {};
    },
  };
}

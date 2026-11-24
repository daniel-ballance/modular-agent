import { randomUUID } from 'node:crypto';
import type { Question, Receipt, Route, WaitClosure } from './store.js';
import { operation } from './trace.js';

export type Snapshot = {
  threadId: string;
  messages: { role: string; content?: unknown }[];
  cursor: string;
  waitCursor: string;
  runReceipts: 1;
  waiting: { questions: Question[]; toolCalls: { toolCallId: string; expiresAt: string }[] };
};
export type Decision = { interruptId: string; status: 'resolved' | 'cancelled'; payload?: unknown };
type Outcome = { type: string; interrupts?: Question[]; pendingToolCallIds?: string[] };
export type Listed = {
  threadId: string;
  waiting: { questions: number; toolCalls: number; turn: 'none' | 'running' | 'interrupted' };
};
export function admission(r: Route) {
  return 'Desk route: ' + JSON.stringify(r.runKey) + '\n\n' + r.task;
}
// EOF is a transport loss, not a terminal outcome from the agent.
export class LostExchange extends Error {}
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}
async function* events(res: Response) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const reader = res.body!.getReader();
  let rest = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = rest.indexOf('\n')) !== -1) {
        const line = rest.slice(0, newline).trimEnd();
        rest = rest.slice(newline + 1);
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data: ')) throw Error('Invalid AG-UI SSE frame');
        yield JSON.parse(line.slice(6));
      }
      if (rest.length > 64 * 1024 * 1024) throw Error('Oversized AG-UI frame');
    }
    if (rest || decoder.decode()) throw new LostExchange('Incomplete AG-UI frame');
  } finally {
    await reader.cancel().catch(() => {});
  }
}
async function* closureItems(res: Response): AsyncGenerator<WaitClosure> {
  for await (const item of events(res)) {
    const question = typeof item.requestId === 'string' && ['answered', 'declined', 'expired', 'revoked',
      'cancelled', 'noLongerAnswerable', 'refused', 'superseded'].includes(item.reason);
    const tool = typeof item.toolCallId === 'string' && item.reason === 'settled' && typeof item.status === 'string';
    if (typeof item.cursor !== 'string' || !item.cursor || (!question && !tool)) throw Error('Invalid wait closure');
    yield item;
  }
}
export class Agui {
  constructor(
    readonly origin: string,
    private token: string,
    readonly signal: AbortSignal
  ) {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw Error('Expected an agent on numeric loopback');
  }
  private async request(path: string, parent: string | null, init: RequestInit = {}) {
    const span = operation('desk.agui', parent);
    const traceparent = span.header ?? parent;
    try {
      const res = await fetch(this.origin + '/agui/v1' + path, {
        ...init,
        redirect: 'error',
        signal: init.signal ?? this.signal,
        headers: {
          Authorization: 'Bearer ' + this.token,
          ...(traceparent ? { traceparent } : {}),
          ...init.headers
        }
      });
      if (!res.ok) {
        const code = (await res.json()).code;
        throw new HttpError(res.status, `AG-UI ${res.status}: ${code}`);
      }
      return res;
    } finally {
      span.end();
    }
  }
  async discover(parent: string | null) {
    const d = await (await this.request('', parent)).json();
    if (d.binding !== 'modular-agent-agui/1' || d.protocolVersion !== '1.0')
      throw Error('Unsupported AG-UI binding');
  }
  async *threads(parent: string | null): AsyncGenerator<Listed> {
    let after: string | undefined;
    do {
      const path = '/threads' + (after ? '?after=' + encodeURIComponent(after) : '');
      const page = await (await this.request(path, parent)).json();
      for (const row of page.threads) yield row;
      after = page.next;
    } while (after);
  }
  async create(r: Route): Promise<string> {
    const res = await this.request('/threads', r.parent, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    const { threadId } = await res.json();
    if (typeof threadId !== 'string' || !threadId) throw Error('Missing thread ID');
    return threadId;
  }
  private path(r: Pick<Route, 'thread'>) {
    return '/threads/' + encodeURIComponent(r.thread!);
  }
  async snapshot(r: Pick<Route, 'thread' | 'parent'>): Promise<Snapshot> {
    const s = await (await this.request(this.path(r), r.parent)).json();
    if (
      s.threadId !== r.thread ||
      s.runReceipts !== 1 ||
      typeof s.waitCursor !== 'string' || !s.waitCursor ||
      !Array.isArray(s.messages) ||
      !Array.isArray(s.waiting?.questions) ||
      !Array.isArray(s.waiting.toolCalls)
    )
      throw Error('Invalid thread snapshot');
    return s;
  }
  async receipt(thread: string, runId: string): Promise<Receipt | null> {
    const path = this.path({ thread }) + '/run-receipt?' + new URLSearchParams({ runId });
    try {
      const v = await (await this.request(path, null)).json();
      if (!['unknown', 'success', 'interrupt', 'cancelled', 'error'].includes(v.terminal) ||
          !['unsettled', 'completed', 'cancelled', 'failed', 'limit', 'handled', 'handedBack'].includes(v.work))
        throw Error('Invalid run receipt');
      return { terminal: v.terminal, work: v.work };
    } catch (e) {
      // Missing and inaccessible look alike. Neither authorizes another POST.
      if (e instanceof HttpError && (e.status === 404 || e.status === 403)) return null;
      throw e;
    }
  }
  async closures(r: Route, after: string, signal: AbortSignal) {
    const path = this.path(r) + '/wait-closures?' + new URLSearchParams({ after });
    const res = await this.request(path, r.parent, { signal, headers: { Accept: 'text/event-stream' } });
    return closureItems(res);
  }
  async presence(r: Pick<Route, 'thread' | 'parent'>, stop: AbortController, lost: () => void) {
    const signal = AbortSignal.any([this.signal, stop.signal]);
    const res = await this.request(this.path(r) + '/presence', r.parent, { signal });
    const reader = res.body!.getReader();
    if ((await reader.read()).done) throw Error('Presence ended before the run');
    void (async () => {
      try {
        while (!(await reader.read()).done) {
          /* SSE comments, not events */
        }
      } catch {
        /* Closing the request detaches this route. */
      } finally {
        reader.releaseLock();
        if (!signal.aborted) lost();
      }
    })();
  }
  async run(
    r: Route,
    runId: string,
    view: Snapshot,
    decisions: Decision[] | undefined,
    admitted: () => void
  ): Promise<Outcome> {
    const messages = decisions
      ? view.messages
      : [...view.messages, { id: randomUUID(), role: 'user', content: admission(r) }];
    const res = await this.request('/run', r.parent, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'MA-History-Cursor': view.cursor
      },
      body: JSON.stringify({
        threadId: r.thread,
        runId,
        protocolVersion: '1.0',
        messages,
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
        ...(decisions ? { resume: decisions } : {})
      })
    });
    let started = false, terminal: Outcome | undefined;
    for await (const e of events(res)) {
      if (e.type === 'RUN_STARTED') {
        if (e.threadId !== r.thread || e.runId !== runId || started) throw Error('Wrong run identity');
        started = true;
        admitted();
      } else if (e.type === 'RUN_ERROR') terminal = { type: 'error' };
      else if (e.type === 'RUN_FINISHED' && started && e.threadId === r.thread && e.runId === runId)
        terminal = e.outcome;
    }
    if (!terminal) throw new LostExchange('AG-UI stream ended without a terminal event');
    return terminal;
  }
}

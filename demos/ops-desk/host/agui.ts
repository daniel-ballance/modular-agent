import { randomUUID } from 'node:crypto';
import type { Question, Route } from './store.js';
import { operation } from './trace.js';

export type Snapshot = {
  threadId: string;
  messages: { role: string; content?: unknown }[];
  cursor: string;
  waiting: { questions: Question[] };
};
export type Decision = { interruptId: string; status: 'resolved' | 'cancelled'; payload?: unknown };
type Outcome = { type: string; interrupts?: Question[] };
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
    try {
      const res = await fetch(this.origin + '/agui/v1' + path, {
        ...init,
        redirect: 'error',
        signal: init.signal ?? this.signal,
        headers: {
          Authorization: 'Bearer ' + this.token,
          ...(span.header ? { traceparent: span.header } : {}),
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
  private path(r: Route) {
    return '/threads/' + encodeURIComponent(r.thread!);
  }
  async snapshot(r: Route): Promise<Snapshot> {
    const s = await (await this.request(this.path(r), r.parent)).json();
    if (s.threadId !== r.thread || !Array.isArray(s.messages) || !Array.isArray(s.waiting?.questions))
      throw Error('Invalid thread snapshot');
    return s;
  }
  async presence(r: Route, stop: AbortController, lost: () => void) {
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
    view: Snapshot,
    decisions: Decision[] | undefined,
    admitted: () => void
  ): Promise<Outcome> {
    const runId = decisions ? randomUUID() : r.runKey;
    const messages = decisions
      ? view.messages
      : [...view.messages, { id: randomUUID(), role: 'user', content: r.task }];
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
    let started = false,
      terminal: Outcome | undefined,
      rest = '';
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const reader = res.body!.getReader();
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
          const e = JSON.parse(line.slice(6));
          if (e.type === 'RUN_STARTED') {
            if (e.threadId !== r.thread || e.runId !== runId || started) throw Error('Wrong run identity');
            started = true;
            admitted();
          } else if (e.type === 'RUN_ERROR') throw Error('Agent ended the run: ' + e.code);
          else if (e.type === 'RUN_FINISHED' && started && e.threadId === r.thread && e.runId === runId)
            terminal = e.outcome;
        }
        if (rest.length > 64 * 1024 * 1024) throw Error('Oversized AG-UI frame');
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (rest || !terminal) throw new LostExchange('AG-UI stream ended without a terminal event');
    return terminal;
  }
}

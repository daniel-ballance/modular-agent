import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { Agui } from './agui.js';
import { token } from './processes.js';
import type { Agent, Route } from './store.js';

// Private process control, not a source of session IDs. Discover work over AG-UI.
export class Control {
  private socket = connect('station.sock');
  private next = 0;
  private replies = new Map<number, { ok(value?: string): void; fail(e: Error): void }>();
  private running = new Map<Agent, AbortController>();
  constructor(
    readonly root: string,
    notice: (agent?: Agent, ended?: string) => void
  ) {
    createInterface({ input: this.socket }).on('line', (line) => {
      const m = JSON.parse(line);
      if (m.event === 'exit') {
        this.running.get(m.agent)?.abort();
        this.running.delete(m.agent);
      } else if (m.event === 'ended') notice(m.agent, m.thread);
      else if (m.event === 'work') notice();
      else {
        const p = this.replies.get(m.id);
        this.replies.delete(m.id);
        if (m.error) p?.fail(Error(m.error));
        else p?.ok(m.value);
      }
    });
    this.socket.once('close', () => {
      for (const p of this.replies.values()) p.fail(Error('Agent station stopped'));
      this.replies.clear();
      for (const a of this.running.values()) a.abort();
    });
  }
  private request(command: object) {
    if (this.socket.destroyed) return Promise.reject(Error('Agent station stopped'));
    const id = ++this.next;
    return new Promise<string | undefined>((ok, fail) => {
      this.replies.set(id, { ok, fail });
      this.socket.write(JSON.stringify({ ...command, id }) + '\n');
    });
  }
  start(agent: Agent, approvalMs: number) {
    const abort = new AbortController();
    this.running.set(agent, abort);
    const exited = new Promise<void>((ok) =>
      abort.signal.addEventListener('abort', () => ok(), { once: true })
    );
    return {
      abort,
      exited,
      ready: this.request({ op: 'start', agent, approvalMs }).then(
        (origin) => new Agui(origin!, token(this.root, agent + '-agui').value, abort.signal)
      ),
      stop: async () => {
        if (!abort.signal.aborted) await this.request({ op: 'stop', agent });
      }
    };
  }
  presence(r: Route) {
    return this.request({ op: 'presence', agent: r.agent, thread: r.thread, parent: r.parent });
  }
  detach(r: Route) {
    return this.request({ op: 'detach', agent: r.agent, thread: r.thread });
  }
  close() {
    this.socket.end();
  }
}

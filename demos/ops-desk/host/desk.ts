import { setTimeout as delay } from 'node:timers/promises';
import { HttpError, LostExchange, Agui, admission, type Decision, type Snapshot } from './agui.js';
import { Control } from './control.js';
import { Projects } from './processes.js';
import { agents, Store, type Agent, type Question, type Route } from './store.js';

type Process = ReturnType<Control['start']>;
class Slot {
  route?: Route;
  process?: Process;
  presence?: AbortController;
  feed?: AbortController;
  waiting = false;
  ended = false;
  recovering = false;
  idle?: NodeJS.Timeout;
  poll?: NodeJS.Timeout;
  tail = Promise.resolve();
  // A new GET supersedes a client's cursor. Do not let a debug read race a POST.
  serial<T>(fn: () => Promise<T>) {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => {},
      () => {}
    );
    return result;
  }
}
export class Desk {
  private slots = { triage: new Slot(), coder: new Slot(), verifier: new Slot() };
  private control: Control;
  private starting = true;
  private closing = false;
  constructor(
    readonly db: Store,
    readonly projects: Projects,
    private idleMs: number,
    private approvalMs: number,
    private notify: () => void
  ) {
    this.control = new Control(projects.root, (a, ended) => {
      if (a && this.slots[a].route?.thread === ended) this.slots[a].ended = true;
      if (!this.starting) this.wake();
    });
  }
  async start() {
    for (const a of agents) {
      const slot = this.slots[a];
      await this.connect(a, null);
      if (!slot.route) {
        const p = slot.process!;
        slot.process = undefined;
        await p.stop();
      }
    }
    this.starting = false;
    this.wake();
  }
  wake() {
    if (!this.closing && !this.starting) {
      this.notify();
      for (const a of agents) this.pump(a);
    }
  }
  private async connect(a: Agent, parent: string | null) {
    const s = this.slots[a];
    clearTimeout(s.idle);
    if (!s.process) {
      const p = (s.process = this.control.start(a, this.approvalMs));
      this.notify();
      void p.exited.then(() =>
        s.serial(async () => {
          if (s.process !== p) return;
          s.process = undefined;
          this.notify();
          if (s.route && !this.closing) {
            if (s.recovering || !s.route.thread)
              this.finish(a, 'failed', `${a} exited before it could serve the session.`);
            else {
              s.recovering = true;
              this.detach(s);
              try {
                await this.connect(a, s.route.parent); // --resume-open, then list the agent again
                if (!s.route) {
                  this.armIdle(a);
                  this.wake();
                } else if (!s.waiting)
                  this.finish(a, 'failed', 'The agent did not list the interrupted route.');
              } catch (e) {
                await this.problem(a, e);
              }
            }
          }
        })
      );
      const api = await p.ready;
      await api.discover(parent);
      await this.findWork(a, api, parent);
    }
    return s.process.ready;
  }

  private async findWork(a: Agent, api: Agui, parent: string | null) {
    const s = this.slots[a];
    for await (const row of api.threads(parent)) {
      const { threadId: thread, waiting } = row;
      let r = this.db.activeThread(a, thread);
      if (waiting.turn === 'none' && !waiting.questions && !waiting.toolCalls && !(r && this.db.questions(r).length)) {
        // Recovery may have finished before the listener started. A kept
        // thread for this delivery is not a reason to submit the input again.
        if (r) {
          this.db.admitted(r);
          this.db.finish(r, 'reopened', a + ' reopened the session. No new input was sent.');
          if (s.route?.id === r.id) s.route = undefined;
        }
        continue;
      }
      const view = await api.snapshot({ thread, parent: r?.parent ?? null });
      if (!r) {
        // Only match the actual first admission, not model or tool output.
        const input = view.messages.find((m) => m.role === 'user')?.content;
        if (typeof input !== 'string' || !input.startsWith('Desk route: ')) continue;
        const key = JSON.parse(input.split('\n', 1)[0].slice('Desk route: '.length));
        r = typeof key === 'string' ? this.db.activeKey(a, key) : undefined;
        if (!r || r.thread || input !== admission(r)) continue;
        this.db.link(r, thread);
      }
      if (s.route && s.route.id !== r.id) throw Error(a + ' has two active routes');
      s.route = r;
      s.recovering = true;
      this.db.admitted(r);
      // A parked approval needs a fresh delivery on this host's presence.
      await this.holdPresence(s, api, r);
      const current = await api.snapshot(r);
      this.db.seedWaits(r, current.waitCursor, current.waiting.questions);
      s.waiting = true;
      this.follow(a, api, r);
      this.poll(a);
    }
  }
  private armIdle(a: Agent) {
    const s = this.slots[a];
    clearTimeout(s.idle);
    if (!s.route && s.process && !this.closing)
      s.idle = setTimeout(
        () =>
          void s.serial(async () => {
            if (!s.route && s.process) {
              const p = s.process;
              s.process = undefined;
              await p.stop();
              this.notify();
            }
          }),
        this.idleMs
      );
  }
  private pump(a: Agent) {
    const s = this.slots[a];
    if (s.route || this.closing) return;
    const r = this.db.next(a);
    if (!r) return;
    clearTimeout(s.idle);
    s.route = r;
    s.recovering = false;
    s.ended = false;
    void s.serial(() => this.drive(a, r));
  }
  private async holdPresence(s: Slot, api: Agui, r: Route) {
    if (!s.presence) {
      const p = (s.presence = new AbortController());
      await api.presence(r, p, () => {
        if (s.presence === p) s.presence = undefined;
        this.notify();
      });
    }
  }
  private detach(s: Slot) {
    s.feed?.abort();
    s.feed = undefined;
    s.presence?.abort();
    s.presence = undefined;
    s.waiting = false;
    clearTimeout(s.poll);
  }
  private finish(a: Agent, state: 'done' | 'reopened' | 'failed', note?: string) {
    const s = this.slots[a];
    this.detach(s);
    this.db.finish(s.route!, state, note);
    s.route = undefined;
    this.armIdle(a);
    this.wake();
  }
  private async drive(a: Agent, r: Route) {
    const s = this.slots[a];
    try {
      const api = await this.connect(a, r.parent);
      if (s.route?.id !== r.id || s.waiting) return;
      if (!r.thread) {
        this.projects.prepare(r);
        this.db.thread(r, await api.create(r));
      }
      const view = await api.snapshot(r); // GET reopens the same session and runs recovery.
      this.db.seedWaits(r, view.waitCursor, view.waiting.questions);
      await this.holdPresence(s, api, r);
      if (view.messages.some((m) => m.role === 'user')) {
        // Each thread belongs to one input route. A committed user message is
        // evidence of admission, even if this host died before saving its cursor.
        this.db.admitted(r);
        const current = await api.snapshot(r);
        if (current.waiting.questions.length)
          this.outcome(a, api, { type: 'interrupt', interrupts: current.waiting.questions });
        else this.finish(a, 'reopened', `${a} reopened the interrupted session. No new input was sent.`);
        return;
      }
      const outcome = await api.run(r, view, undefined, () => this.db.admitted(r));
      this.outcome(a, api, outcome);
    } catch (e) {
      await this.problem(a, e);
    }
  }
  private async problem(a: Agent, e: unknown) {
    const s = this.slots[a];
    if (this.closing || !s.route) return;
    // A lost exchange is not a failed turn. Stop the old writer before reopening.
    if (s.process?.abort.signal.aborted) return; // exit callback owns recovery
    if (
      s.route.thread &&
      !s.recovering &&
      (e instanceof LostExchange || (e instanceof TypeError && e.cause))
    ) {
      await s.process?.stop();
      return;
    }
    this.finish(a, 'failed', `${a}: ${e instanceof Error ? e.message : 'operation failed'}`);
  }
  private outcome(
    a: Agent,
    api: Agui,
    outcome: { type: string; interrupts?: Question[]; pendingToolCallIds?: string[] }
  ) {
    const s = this.slots[a];
    if (outcome.type === 'success' && (outcome.pendingToolCallIds?.length || this.db.questions(s.route!).length)) {
      // A successful answer exchange is not a closure notice.
      s.waiting = true;
      this.follow(a, api, s.route!);
      this.poll(a);
    } else if (outcome.type === 'success') this.finish(a, 'done');
    else if (outcome.type === 'interrupt' && outcome.interrupts?.length) {
      this.db.observe(s.route!, outcome.interrupts);
      s.waiting = true;
      this.follow(a, api, s.route!);
      this.notify();
      this.poll(a);
    } else this.finish(a, 'failed', `${a}: ${outcome.type}`);
  }
  private follow(a: Agent, api: Agui, r: Route) {
    const s = this.slots[a];
    if (s.feed) return;
    const stop = (s.feed = new AbortController());
    const signal = AbortSignal.any([api.signal, stop.signal]);
    const read = async () => {
      while (!signal.aborted) {
        try {
          for await (const item of api.closures(r, this.db.waitCursor(r)!, signal)) {
            if (signal.aborted) return;
            this.db.waitClosed(r, item);
            this.notify();
          }
        } catch (e) {
          if (signal.aborted) return;
          if (e instanceof HttpError && e.status === 409 && e.message.endsWith('cursor_expired')) {
            await s.serial(async () => {
              if (signal.aborted) return;
              const view = await api.snapshot(r);
              this.db.resetWaits(r, view.waitCursor, view.waiting.questions);
              this.notify();
            });
            continue;
          }
          if (!(e instanceof LostExchange || (e instanceof TypeError && e.cause))) throw e;
        }
        // EOF can mean a slow reader was disconnected. Follow from the last commit, not a new snapshot.
        await delay(100, undefined, { signal });
      }
    };
    void read().catch(e => s.serial(async () => {
      if (!signal.aborted) await this.problem(a, e);
    }));
  }
  private poll(a: Agent) {
    const s = this.slots[a];
    clearTimeout(s.poll);
    if (s.waiting && !this.closing)
      s.poll = setTimeout(
        () =>
          void s.serial(async () => {
            try {
              // Listing tracks work, not closure reasons. Do not read a snapshot to poll a question.
              const r = s.route;
              if (r && s.waiting && !this.db.questions(r).length && (s.ended || s.recovering)) {
                const api = await s.process!.ready;
                for await (const row of api.threads(r.parent)) {
                  if (row.threadId !== r.thread) continue;
                  if (row.waiting.questions) await this.refresh(a);
                  else if (!row.waiting.toolCalls && row.waiting.turn === 'none')
                    this.finish(a, s.recovering ? 'reopened' : 'done');
                  break;
                }
              }
            } catch (e) {
              await this.problem(a, e);
            }
            this.poll(a);
          }),
        300
      );
  }
  private async refresh(a: Agent): Promise<Snapshot | undefined> {
    const s = this.slots[a],
      r = s.route;
    if (!s.waiting || !r || !s.process || this.closing) return;
    let view: Snapshot;
    try {
      const api = await s.process.ready;
      await this.holdPresence(s, api, r);
      view = await api.snapshot(r);
    } catch (e) {
      // A deadline can commit while the agent builds its snapshot. Without a
      // single-watermark view there is no button, and no change to the route.
      if (e instanceof HttpError && e.status === 409) return;
      throw e;
    }
    // This read delivers a current view. Its missing rows are not decisions.
    this.db.observe(r, view.waiting.questions);
    return view;
  }
  async answer(id: number, answers: Decision[]) {
    const r = this.db.route(id);
    if (!r) throw new HttpError(404, 'Unknown route');
    const s = this.slots[r.agent];
    return s.serial(async () => {
      if (s.route?.id !== id || !s.waiting) throw new HttpError(409, 'This question is closed');
      const view = await this.refresh(r.agent),
        questions = view?.waiting.questions;
      if (
        !view ||
        !questions?.length ||
        !s.waiting ||
        !Array.isArray(answers) ||
        answers.length !== questions.length
      )
        throw new HttpError(409, 'The questions changed');
      for (const q of questions) {
        const ans = answers.find((v) => v.interruptId === q.id);
        if (!ans || (q.expiresAt && Date.parse(q.expiresAt) <= Date.now()))
          throw new HttpError(409, 'Question is not answerable');
        if (ans.status === 'cancelled') continue;
        if (
          ans.status !== 'resolved' ||
          (q.reason === 'approval'
            ? typeof (ans.payload as { allow?: unknown })?.allow !== 'boolean'
            : typeof ans.payload !== 'string')
        )
          throw new HttpError(400, 'Invalid answer');
      }
      try {
        const api = await s.process!.ready;
        const outcome = await api.run(r, view, answers, () => {});
        this.outcome(r.agent, api, outcome);
      } catch (e) {
        if (!(e instanceof HttpError)) {
          await this.problem(r.agent, e);
          throw new HttpError(
            503,
            'Answer exchange interrupted. Refresh the desk; do not repeat the answer.'
          );
        }
        throw e;
      }
    });
  }
  async state() {
    const views = await Promise.all(
      agents.filter((a) => {
        const s = this.slots[a];
        return s.waiting && s.route && this.db.questions(s.route).length;
      }).map((a) => this.slots[a].serial(() => this.refresh(a)))
    );
    const inbox = this.db.inbox().map((q) => ({
      ...q,
      answerable:
        q.status === 'open' &&
        this.slots[q.agent as Agent].route?.id === q.route &&
        views.some(
          (v) => v?.threadId === q.thread && v?.waiting.questions.some((open) => open.id === q.id)
        ) &&
        (!q.expiresAt || Date.parse(q.expiresAt) > Date.now())
    }));
    return {
      posts: this.db.conversation(),
      inbox,
      agents: Object.fromEntries(
        agents.map((a) => [a, this.slots[a].route ? 'working' : this.slots[a].process ? 'idle' : 'stopped'])
      ),
      routes: this.db.routes(),
      cursor: this.db.cursor()
    };
  }
  async debug(id: number) {
    const r = this.db.route(id);
    if (!r?.thread) throw new HttpError(404, 'No snapshot');
    return this.slots[r.agent].serial(async () => {
      try {
        return await (await this.connect(r.agent, r.parent)).snapshot(r);
      } finally {
        this.armIdle(r.agent);
      }
    });
  }
  async close() {
    this.closing = true;
    for (const s of Object.values(this.slots)) {
      clearTimeout(s.idle);
      this.detach(s);
    }
    await Promise.all(Object.values(this.slots).map((s) => s.process?.stop()));
    await Promise.all(Object.values(this.slots).map((s) => s.tail));
    this.control.close();
  }
}

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpError, LostExchange, Agui, type Decision, type Snapshot } from './agui.js';
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
  answering = false;
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
            if (!s.route.thread)
              this.finish(a, 'failed', `${a} exited before it could serve the session.`);
            else {
              s.recovering = true;
              this.detach(s);
              try {
                await this.connect(a, s.route.parent); // --resume-open, then list the agent again
                if (!s.route) {
                  this.armIdle(a);
                  this.wake();
                }
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
    const r = this.db.inFlight(a);
    for (const run of this.db.runs(a)) {
      if (run.stream === 'open') this.db.stream(run.id, 'lost');
      const receipt = await api.receipt(run.thread, run.runId);
      this.db.receipt(run.id, receipt);
      if (r && r.id === run.route && run.kind === 'input' && receipt) {
        if (!r.thread) this.db.link(r, run.thread);
        this.db.admitted(r);
      }
    }
    let listed;
    for await (const row of api.threads(parent)) {
      if (r?.thread === row.threadId) listed = row.waiting;
    }
    if (!r) return;
    s.route = r;
    s.recovering = true;
    if (!listed || !r.thread) {
      if (!this.finishFromReceipt(r)) this.finish(a, 'unconfirmed', 'Work is unsettled and the thread is not listed.');
      return;
    }
    if (listed.turn === 'none' && !listed.questions && !listed.toolCalls && !this.db.expectsClosure(r) &&
        this.finishFromReceipt(r)) return;
    // The listing locates work. Only the new presence and snapshot deliver a parked approval.
    await this.holdPresence(s, api, r);
    const current = await api.snapshot(r);
    this.db.seedWaits(r, current.waitCursor, current.waiting.questions);
    s.waiting = true;
    await this.follow(a, api, r);
    this.poll(a);
  }
  private finishFromReceipt(r: Route) {
    const last = this.db.runs(r.id).at(-1);
    if (last?.work === 'unsettled') return false;
    if (!last?.work) this.finish(r.agent, 'unconfirmed', 'No visible receipt. No work was resubmitted.');
    else if (['completed', 'handled', 'handedBack'].includes(last.work)) this.finish(r.agent, 'done');
    else this.finish(r.agent, 'failed', `The run receipt reports work ${last.work}.`);
    return true;
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
      try {
        await api.presence(r, p, () => {
          if (s.presence === p) s.presence = undefined;
          this.notify();
        });
      } catch (e) {
        s.presence = undefined;
        p.abort();
        throw e;
      }
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
  private finish(a: Agent, state: 'done' | 'unconfirmed' | 'failed', note?: string) {
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
      if (r.thread) throw Error('A saved thread cannot start a second input');
      this.projects.prepare(r);
      this.db.thread(r, await api.create(r));
      const view = await api.snapshot(r);
      this.db.seedWaits(r, view.waitCursor, view.waiting.questions);
      await this.holdPresence(s, api, r);
      const outcome = await this.exchange(api, r, view);
      await this.outcome(a, api, outcome);
    } catch (e) {
      await this.problem(a, e);
    }
  }
  private async exchange(api: Agui, r: Route, view: Snapshot, answers?: Decision[]) {
    const runId = answers ? randomUUID() : r.runKey;
    const id = this.db.beginRun(r, runId, answers ? 'answer' : 'input'); // before the POST, even for answers
    let outcome;
    try {
      outcome = await api.run(r, runId, view, answers, () => {
        if (!answers) this.db.admitted(r);
      });
    } catch (e) {
      this.db.stream(id, e instanceof HttpError ? 'refused' : 'lost');
      throw e;
    }
    this.db.stream(id, 'ended');
    this.db.receipt(id, await api.receipt(r.thread!, runId));
    return outcome;
  }
  private async problem(a: Agent, e: unknown) {
    const s = this.slots[a];
    if (this.closing || !s.route) return;
    // A lost stream is not a failed turn. The station wakes a writer only if it exited.
    if (s.process?.abort.signal.aborted) return; // exit callback owns recovery
    if (
      s.route.thread &&
      this.db.runs(s.route.id).length &&
      (e instanceof LostExchange || (e instanceof TypeError && e.cause))
    ) {
      s.recovering = true;
      s.waiting = true;
      this.poll(a);
      return;
    }
    this.finish(a, 'failed', `${a}: ${e instanceof Error ? e.message : 'operation failed'}`);
  }
  private async outcome(
    a: Agent,
    api: Agui,
    outcome: { type: string; interrupts?: Question[]; pendingToolCallIds?: string[] }
  ) {
    const s = this.slots[a];
    if (outcome.type === 'success' && (outcome.pendingToolCallIds?.length || this.db.expectsClosure(s.route!))) {
      // A successful answer exchange is not a closure notice.
      s.waiting = true;
      await this.follow(a, api, s.route!);
      this.poll(a);
    } else if (outcome.type === 'success') this.finish(a, 'done');
    else if (outcome.type === 'interrupt' && outcome.interrupts?.length) {
      this.db.observe(s.route!, outcome.interrupts);
      s.waiting = true;
      await this.follow(a, api, s.route!);
      this.notify();
      this.poll(a);
    } else this.finish(a, 'failed', `${a}: ${outcome.type}`);
  }
  private async follow(a: Agent, api: Agui, r: Route) {
    const s = this.slots[a];
    if (s.feed) return;
    const stop = (s.feed = new AbortController());
    const signal = AbortSignal.any([api.signal, stop.signal]);
    const open = () => api.closures(r, this.db.waitCursor(r)!, signal);
    const expired = (e: unknown) =>
      e instanceof HttpError && e.status === 409 && e.message.endsWith('cursor_expired');
    const reset = async () => {
      if (signal.aborted) return;
      const view = await api.snapshot(r);
      this.db.resetWaits(r, view.waitCursor, view.waiting.questions);
      this.notify();
    };
    let first;
    try {
      // Resolve an expired checkpoint before this host can send an answer.
      // Otherwise the reset snapshot might land after the new decision.
      first = await open().catch(async e => {
        if (!expired(e)) throw e;
        await reset();
        return open();
      });
    } catch (e) {
      s.feed = undefined;
      stop.abort();
      throw e;
    }
    const read = async (items?: Awaited<ReturnType<typeof open>>) => {
      while (!signal.aborted) {
        try {
          const stream = items ?? await open();
          items = undefined;
          for await (const item of stream) {
            if (signal.aborted) return;
            this.db.waitClosed(r, item);
            this.notify();
          }
        } catch (e) {
          if (signal.aborted) return;
          if (expired(e)) {
            await s.serial(reset);
            continue;
          }
          if (!(e instanceof LostExchange || (e instanceof TypeError && e.cause))) throw e;
        }
        // EOF can mean a slow reader was disconnected. Follow from the last commit, not a new snapshot.
        await delay(100, undefined, { signal });
      }
    };
    void read(first).catch(e => s.serial(async () => {
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
              if (r && s.waiting && !this.db.expectsClosure(r) && (s.ended || s.recovering)) {
                const api = await s.process!.ready;
                const latest = this.db.runs(r.id).at(-1);
                if (latest && (s.recovering || latest.work === 'unsettled'))
                  this.db.receipt(latest.id, await api.receipt(latest.thread, latest.runId));
                let listed = false;
                for await (const row of api.threads(r.parent)) {
                  if (row.threadId !== r.thread) continue;
                  listed = true;
                  if (row.waiting.questions) {
                    await this.refresh(a);
                    await this.follow(a, api, r);
                  } else if (!row.waiting.toolCalls && row.waiting.turn === 'none')
                    this.finishFromReceipt(r);
                  break;
                }
                if (!listed && !this.finishFromReceipt(r))
                  this.finish(a, 'unconfirmed', 'Work is unsettled and the thread is not listed.');
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
      s.answering = true;
      try {
        const api = await s.process!.ready;
        const outcome = await this.exchange(api, r, view, answers);
        await this.outcome(r.agent, api, outcome);
      } catch (e) {
        if (!(e instanceof HttpError)) {
          await this.problem(r.agent, e);
          throw new HttpError(
            503,
            'Answer exchange interrupted. Refresh the desk; do not repeat the answer.'
          );
        }
        throw e;
      } finally {
        s.answering = false;
        this.notify();
      }
    });
  }
  async state() {
    const views = await Promise.all(
      agents.filter((a) => {
        const s = this.slots[a];
        return !s.answering && s.waiting && s.route && this.db.expectsClosure(s.route);
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
      runs: this.db.runs(),
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

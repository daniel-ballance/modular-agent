// The agent processes, their tool listeners and their presence streams live
// together. Losing the HTTP host must not create a replacement approval route.
import { serve, tool, type ToolContext } from '@modular-agent/core';
import { mkdirSync, existsSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { agents, Store, type Agent } from './store.js';
import { demo, launch, Projects, token } from './processes.js';

process.umask(0o077);
const root = resolve(process.env.DESK_DATA ?? join(demo, '.desk'));
mkdirSync(root, { recursive: true, mode: 0o700 });
if (statSync(root).mode & 0o077) throw Error('Use an owner-only data directory');
const db = new Store(join(root, 'desk.sqlite'), 'station');
const projects = new Projects(root, resolve(process.env.DESK_SAMPLE ?? join(demo, 'sample')));
const processes = new Map<Agent, ReturnType<typeof launch>>();
const services = new Map<Agent, { url: string; close(): Promise<void> }>();
const presence = new Map<string, AbortController>();
// A process being stopped stays in `processes` until it exits; it must not
// answer a start or take a presence stream meanwhile.
const stopping = new WeakSet<ReturnType<typeof launch>>();
let host: Socket | undefined;
function notify(event: object) {
  host?.write(JSON.stringify(event) + '\n');
}
const string = { type: 'string', minLength: 1, maxLength: 4096 } as const;

for (const a of agents) {
  const source = (ctx: ToolContext) => {
    const r = db.activeThread(a, ctx.sessionId);
    if (!r) throw Error('No active route for this agent and session');
    return r;
  };
  const service = await serve(
    {
      name: 'desk',
      setup: (reg) => {
        reg.tool(
          tool({
            name: 'post',
            description: 'Post a summary, change or verdict to the desk.',
            input: {
              type: 'object',
              properties: { kind: { enum: ['summary', 'change', 'verdict'] }, text: string },
              required: ['kind', 'text'],
              additionalProperties: false
            },
            run: ({ text, kind }, ctx) => {
              db.post(source(ctx), ctx.callId, kind, text);
              notify({ event: 'work' });
              return 'Posted.';
            }
          })
        );
        if (a !== 'verifier')
          reg.tool(
            tool({
              name: 'hand_off',
              description: 'Queue a task for another desk agent.',
              input: {
                type: 'object',
                properties: { to: { type: 'string' }, task: string },
                required: ['to', 'task'],
                additionalProperties: false
              },
              run: async ({ to, task }, ctx) => {
                const r = source(ctx);
                db.handOff(r, to, task, projects.revision(a));
                notify({ event: 'work' });
                // Crash check: the route is committed, but the coder has no tool result yet.
                const marker = join(projects.root, 'held-handoff');
                if (a === 'coder' && process.env.DESK_TEST_HOLD_HANDOFF === '1' && !existsSync(marker)) {
                  const child = processes.get('coder')!;
                  writeFileSync(marker, String(child.pid));
                  await child.exited;
                }
                return 'Queued.';
              }
            })
          );
        reg.on('turn.end', ({ sessionId }) => {
          notify({ event: 'ended', agent: a, thread: sessionId });
        });
      }
    },
    { listen: '127.0.0.1:0', tokenFile: token(projects.root, a + '-tools').path }
  );

  services.set(a, service);
}

type Command = { agent: Agent; op: string; thread?: string; approvalMs: number; parent?: string };
async function handle({ agent, op, thread, parent, approvalMs }: Command) {
  if (!agents.includes(agent)) throw Error('Unknown agent');
  let child = processes.get(agent);
  if (op === 'start') {
    if (child && stopping.has(child)) {
      await child.exited; // its exit handler runs first and clears the entry
      child = processes.get(agent);
    }
    if (!child) {
      child = launch(projects, agent, services.get(agent)!.url, approvalMs);
      processes.set(agent, child);
      const started = child;
      void child.exited.then(() => {
        if (processes.get(agent) !== started) return;
        processes.delete(agent);
        for (const [k, p] of presence)
          if (k.startsWith(agent + ':')) {
            p.abort();
            presence.delete(k);
          }
        notify({ event: 'exit', agent });
      });
    }
    return (await child.ready).origin;
  }
  if (op === 'stop') {
    if (child) stopping.add(child);
    await child?.stop();
    return;
  }
  if (!child || stopping.has(child)) throw Error('Agent stopped');
  if (!thread) throw Error('Missing session');
  const key = agent + ':' + thread;
  if (op === 'detach') {
    presence.get(key)?.abort();
    presence.delete(key);
  } else if (op === 'presence') {
    if (presence.has(key)) return; // Keep the original stream. Never re-offer its views.
    const p = new AbortController();
    await (await child.ready).presence({ thread, parent: parent ?? null }, p, () => {
      stopping.add(child!);
      void child!.stop();
    });
    presence.set(key, p);
  } else throw Error('Unknown operation');
}

// Relative socket names also work in a checkout with a long absolute path.
process.chdir(root);
rmSync('station.sock', { force: true }); // the exclusive station lock is held
const server = createServer((socket) => {
  host = socket;
  socket.on('error', () => socket.destroy());
  socket.on('close', () => {
    if (host === socket) host = undefined;
  });
  createInterface({ input: socket }).on('line', async (line) => {
    const { id, ...cmd } = JSON.parse(line);
    let reply;
    try {
      reply = { id, value: await handle(cmd) };
    } catch (e) {
      reply = { id, error: e instanceof Error ? e.message : 'Agent control failed' };
    }
    if (!socket.destroyed) socket.write(JSON.stringify(reply) + '\n');
  });
});
server.listen('station.sock', () => console.log('ready'));
async function close() {
  host?.destroy();
  server.close();
  await Promise.all([...processes.values()].map((p) => p.stop()));
  await Promise.all([...services.values()].map((s) => s.close()));
  db.close();
}
process.once('SIGTERM', () => void close());
process.once('SIGINT', () => void close());

// Keep the agents available while the HTTP host reconnects.
import { coderScope } from './coder-scope.js';
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
// A child being stopped cannot serve a start request.
const stopping = new WeakSet<ReturnType<typeof launch>>();
let host: Socket | undefined;
function notify(event: object) {
  host?.write(JSON.stringify(event) + '\n');
}
const string = { type: 'string', minLength: 1, maxLength: 4096 } as const;

const service = await serve(({ callerId }) => {
  const a = agents.find(agent => agent === callerId);
  if (!a) throw Error('Unknown plugin caller');
  const source = (ctx: ToolContext) => {
    const r = db.activeThread(a, ctx.sessionId);
    if (!r) throw Error('No active route for this agent and session');
    return r;
  };
  return {
    name: 'desk',
    setup: (reg) => {
      if (a === 'coder') reg.on('tool.before', ({ call }) => coderScope(call));
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
      reg.on('turn.end', ({ sessionId, result }) => {
        // A parked script ends its origin turn with an open call.
        if (!result.openToolCalls.length) notify({ event: 'ended', agent: a, thread: sessionId });
      });
    }
  };
}, {
  listen: '127.0.0.1:0',
  callers: agents.map(callerId => ({ callerId, tokenFile: token(root, callerId + '-tools').path }))
});

type Command = { agent: Agent; op: string; approvalMs: number };
async function handle({ agent, op, approvalMs }: Command) {
  if (!agents.includes(agent)) throw Error('Unknown agent');
  let child = processes.get(agent);
  if (op === 'start') {
    if (child && stopping.has(child)) {
      await child.exited; // its exit handler runs first and clears the entry
      child = processes.get(agent);
    }
    if (!child) {
      child = launch(projects, agent, service.url, approvalMs);
      processes.set(agent, child);
      const started = child;
      void child.exited.then(() => {
        if (processes.get(agent) !== started) return;
        processes.delete(agent);
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
  throw Error('Unknown operation');
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
server.listen('station.sock', () => console.log(service.url));
async function close() {
  host?.destroy();
  server.close();
  await Promise.all([...processes.values()].map((p) => p.stop()));
  await service.close();
  db.close();
}
process.once('SIGTERM', () => void close());
process.once('SIGINT', () => void close());

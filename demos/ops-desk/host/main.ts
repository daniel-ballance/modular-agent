import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { HttpError } from './agui.js';
import { Desk } from './desk.js';
import { demo, Projects, token } from './processes.js';
import { Store } from './store.js';
import { operation, startTracing, stopTracing } from './trace.js';

process.umask(0o077);
const root = resolve(process.env.DESK_DATA ?? join(demo, '.desk'));
mkdirSync(root, { recursive: true, mode: 0o700 });
if (statSync(root).mode & 0o077) throw Error('Use an owner-only data directory');
const host = process.env.DESK_BIND ?? '127.0.0.1';
function number(name: string, fallback: number, min: number, max: number) {
  const v = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(v) || v < min || v > max) throw Error('Invalid ' + name);
  return v;
}
const port = number('DESK_PORT', 8080, 0, 65535);
const page = 'Basic ' + Buffer.from('desk:' + token(root, 'page').value).toString('base64'),
  webhook = 'Bearer ' + token(root, 'events').value;
function auth(actual: string | undefined, expected: string) {
  const hash = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(hash(actual ?? ''), hash(expected));
}
async function body(req: IncomingMessage) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json')
    throw new HttpError(415, 'Send application/json');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 65536) throw new HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}
const db = new Store(join(root, 'desk.sqlite'));
const streams = new Set<ServerResponse>();
const changed = () => {
  for (const res of streams) if (!res.write('data: changed\n\n')) res.destroy();
};
startTracing();
const desk = new Desk(
  db,
  new Projects(root, resolve(process.env.DESK_SAMPLE ?? join(demo, 'sample'))),
  number('DESK_IDLE_MS', 60000, 1, 2147483647),
  number('DESK_APPROVAL_MS', 180000, 1, 2147483647),
  changed
);
await desk.start();
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'"
  );
  const json = (status: number, value: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  try {
    const url = req.url;
    if (url === '/events' && req.method === 'POST') {
      if (!auth(req.headers.authorization, webhook)) throw new HttpError(401, 'Webhook token required');
      const ev = await body(req);
      if (
        !ev ||
        typeof ev.id !== 'string' ||
        !ev.id.trim() ||
        ev.id.length > 256 ||
        !['build-failed', 'issue-opened'].includes(ev.kind) ||
        !Object.hasOwn(ev, 'payload')
      )
        throw new HttpError(400, 'Expected id, kind and payload');
      const span = operation('desk.event');
      try {
        const accepted = db.receive(ev.id, ev.kind, ev.payload, span.header);
        json(202, { accepted });
        if (accepted) desk.wake();
      } finally {
        span.end();
      }
      return;
    }
    if (!auth(req.headers.authorization, page)) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Ops desk"');
      throw new HttpError(401, 'Desk login required');
    }
    const file = (
      { '/': 'index.html', '/page.js': 'page.js', '/desk.css': 'desk.css' } as Record<string, string>
    )[url ?? ''];
    if (req.method === 'GET' && typeof file === 'string') {
      res.setHeader(
        'Content-Type',
        file.endsWith('js')
          ? 'text/javascript'
          : file.endsWith('css')
            ? 'text/css'
            : 'text/html; charset=utf-8'
      );
      res.end(readFileSync(join(demo, 'host/public', file)));
      return;
    }
    if (req.method === 'GET' && url === '/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
      res.write('data: changed\n\n');
      streams.add(res);
      res.on('close', () => streams.delete(res));
      return;
    }
    if (req.method === 'GET' && url === '/state') {
      json(200, await desk.state());
      return;
    }
    const snapshot = url?.match(/^\/sessions\/(\d+)$/);
    if (req.method === 'GET' && snapshot) {
      json(200, await desk.debug(Number(snapshot[1])));
      return;
    }
    if (req.method === 'POST' && url === '/answers') {
      if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host)
        throw new HttpError(403, 'Wrong origin');
      const b = await body(req);
      await desk.answer(b.route, b.answers);
      json(200, {});
      return;
    }
    throw new HttpError(404, 'Not found');
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e instanceof Error ? e.message : 'Desk request failed');
    json(e instanceof HttpError ? e.status : 500, {
      error: e instanceof HttpError ? e.message : 'Desk request failed'
    });
  }
});
server.listen(port, host, () => {
  const address = server.address();
  if (typeof address !== 'string') console.log(`http://${host}:${address!.port}`);
});
let stopping = false;
async function close() {
  if (stopping) return;
  stopping = true;
  for (const res of streams) res.end();
  server.close();
  server.closeAllConnections();
  await desk.close();
  db.close();
  await stopTracing();
}
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());

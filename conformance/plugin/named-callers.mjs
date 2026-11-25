// Operator side of the optional named-caller fixture. Only paths, never bearer
// values, go in the table. The launcher must pass it to the real SDK listener.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { endpoint, PLUGIN_PROTOCOL, upgradeStatus } from '../tools/websocket.mjs';

async function guarded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('fixture did not report startup or exit')), 20_000);
  })]); } finally { clearTimeout(timer); }
}

async function launch(command, env, root, config, use) {
  const path = join(root, 'fixture.json'); writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  const log = openSync(join(root, 'launcher.log'), 'a', 0o600);
  const child = spawn(command[0], command.slice(1), { env: { ...env, MA_PLUGIN_FIXTURE: path }, cwd: root, detached: true, stdio: ['ignore', 'pipe', log] });
  closeSync(log);
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  const stop = () => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH' && !(process.platform === 'darwin' && e.code === 'EPERM')) throw e; } };
  let interrupted = false;
  const interrupt = () => { interrupted = true; stop(); };
  process.once('exit', stop); process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const first = new Promise((resolve, reject) => {
    lines.once('line', line => { try { resolve(JSON.parse(line)); } catch { reject(Error('fixture must print a JSON startup result')); } });
    lines.once('close', () => reject(Error('fixture exited without a startup result')));
  });
  try {
    const ready = await guarded(Promise.race([first, exited.then(() => { throw Error('fixture exited before readiness'); })]));
    await use(ready, () => guarded(exited));
  } finally {
    lines.close(); stop();
    process.off('exit', stop); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    await exited;
    if (interrupted) throw Error('named caller fixture interrupted');
  }
}

export async function namedCallers(command, env, check, isolate) {
  assert.ok(isAbsolute(command[0]), 'use an absolute fixture command');
  const root = mkdtempSync(join(tmpdir(), 'ma-named-callers-'));
  try {
    const auditFile = join(root, 'audit.jsonl'); writeFileSync(auditFile, '', { mode: 0o600 });
    const audit = () => readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    const tokens = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')];
    const callers = tokens.map((token, i) => {
      const tokenFile = join(root, i + '.token'); writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
      return { callerId: 'caller-' + randomUUID(), tokenFile };
    });
    const scopes = callers.map(({ callerId }, i) => {
      const project = join(root, 'project-' + i), stateDir = join(root, 'state-' + i);
      mkdirSync(project); mkdirSync(stateDir); return { callerId, project, stateDir };
    });
    const config = { listen: '127.0.0.1:0', callers, scopes, auditFile };
    const copy = join(root, 'copy.token'); writeFileSync(copy, tokens[0] + '\n', { mode: 0o600 });
    for (const [label, bad] of [
      ['duplicate caller ID', { callers: [callers[0], { ...callers[1], callerId: callers[0].callerId }] }],
      ['duplicate token value in distinct files', { callers: [callers[0], { ...callers[1], tokenFile: copy }] }],
      ['single token with callers', { tokenFile: callers[0].tokenFile }],
    ]) await launch(command, env, root, { ...config, ...bad }, async (ready, exit) => {
      const refused = ready.error === 'invalid_composition' && !ready.url && (await exit()).code > 0 && audit().length === 0;
      check(`named callers: refuse ${label} before listening`, refused);
    });
    await launch(command, env, root, config, async ready => {
      const url = endpoint(ready.url);
      assert.ok(url.protocol === 'ws:' && url.hostname === '127.0.0.1' && url.port && !url.search, 'fixture must report the disposable loopback listener');
      for (const [label, bearer] of [['wrong token', randomBytes(32).toString('hex')], ['missing token', undefined]]) {
        const result = await upgradeStatus(url, PLUGIN_PROTOCOL, bearer);
        check(`named callers: ${label} is refused with HTTP 401`, !result.upgraded && result.status === 401);
      }
      check('named callers: refuse unauthenticated upgrades before factory or setup', audit().length === 0);
      const connection = token => ({ url, token, protocol: PLUGIN_PROTOCOL, tiers: {} });
      await isolate(connection(tokens[0]), { second: connection(tokens[1]), projects: scopes.map(s => s.project),
        home: env.HOME, names: callers.map(c => c.callerId), audit });
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

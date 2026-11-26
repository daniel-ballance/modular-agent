import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const runWith = (env, ...args) => exec(process.execPath, [fileURLToPath(new URL('./run.mjs', import.meta.url)), ...args], {
  env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, ...env },
});
const run = (...args) => runWith({}, ...args);

test('a stdio agent receives the kit TMPDIR', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-tmpdir-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const observed = join(dir, 'observed');
  const agent = `require('node:fs').writeFileSync(process.argv[1], process.env.TMPDIR ?? ''); process.exit(45)`;
  await assert.rejects(runWith({ TMPDIR: dir }, '--group', 'covered', '--', process.execPath, '-e', agent, observed),
    e => e.code === 1);
  assert.equal(readFileSync(observed, 'utf8'), dir);
});

test('a selected erasure group needs an HTTP service before launching an agent', async () => {
  await assert.rejects(run('--group', 'erasure', '--', process.execPath, '-e', 'process.exit(45)'),
    e => e.code === 2 && /disposable service settings/.test(e.stderr));
});

test('a failed stdio check reports the tail of agent stderr', async () => {
  const agent = 'require("node:fs").writeSync(2, "old diagnostic\\n" + "x".repeat(9000) + "\\npoint save failed\\n"); process.exit(45)';
  await assert.rejects(run('--group', 'stdio-rights', '--', process.execPath, '-e', agent), e => {
    assert.equal(e.code, 1);
    assert.match(e.stdout, /FAIL  stdio rights/);
    assert.match(e.stderr, /point save failed/);
    assert.doesNotMatch(e.stderr, /old diagnostic/);
    return true;
  });
});
test('erasure reports stderr and exit status when a stdio or managed WebSocket agent dies', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-erasure-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const token = join(dir, 'token');
  writeFileSync(token, 'disposable-test-token', { mode: 0o600 });
  const server = createServer((_req, res) => res.end(JSON.stringify({ pendingErasure: 1 })));
  t.after(() => server.close());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = {
    MODULAR_AGENT_HISTORY_URL: `http://127.0.0.1:${server.address().port}`,
    MODULAR_AGENT_HISTORY_TOKEN_FILE: token,
  };
  const agent = `require("node:fs").writeSync(2, "fixture startup failed\\n"); process.exit(45)`;
  for (const [name, args] of [
    ['stdio', ['--', process.execPath, '-e', agent]],
    ['WebSocket', ['--connect', 'ws://127.0.0.1:1/', '--token-file', token,
      '--service-command', `exec ${JSON.stringify(process.execPath)} -e '${agent}'`]],
  ]) await t.test(name, async () => {
    await assert.rejects(runWith(env, '--group', 'erasure', ...args), e => {
      assert.equal(e.code, 1);
      assert.match(e.stdout, /start writer: .*connection (closed|failed)/i);
      assert.match(e.stdout, /"exitCode":45/);
      assert.match(e.stdout, /fixture startup failed/);
      return true;
    });
  });
});

test('invalid groups and core switches in another group are usage errors', async () => {
  for (const args of [['--group', 'unknown'], ['--group', 'waiting', '--crash-checks']])
    await assert.rejects(run(...args, '--', process.execPath, '-v'), e => e.code === 2);
});
test('WebSocket retries require two distinct credentials and a disposable history service', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-retries-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = join(dir, 'first'), other = join(dir, 'other');
  writeFileSync(first, 'disposable-first-test-token', { mode: 0o600 });
  writeFileSync(other, 'disposable-other-test-token', { mode: 0o600 });
  const args = ['--group', 'websocket-retries', '--connect', 'ws://127.0.0.1:1/',
    '--token-file', first, '--actor', 'writer', '--service-command', 'exit 45'];
  await assert.rejects(run(...args, '--other-token-file', other), e => e.code === 2 && /needs .*--portable-checks/.test(e.stderr));
  await assert.rejects(run(...args, '--portable-checks'), e => e.code === 2 && /needs .*--other-token-file/.test(e.stderr));
  await assert.rejects(run(...args, '--portable-checks', '--other-token-file', first), e => e.code === 2 && /different token/.test(e.stderr));
  await assert.rejects(run(...args, '--portable-checks', '--other-token-file', other), e => e.code === 2 && /disposable service settings/.test(e.stderr));
});

test('a fixture lacking the waiting declaration fails in both ACP bindings', async () => {
  const agent = `require('node:readline').createInterface({input:process.stdin}).on('line', l => {
    const {id, params} = JSON.parse(l); if (id === undefined) return;
    const binding = params?._meta?.['modular-agent']?.binding, declaration = {};
    console.log(JSON.stringify({jsonrpc:'2.0', id, result:{protocolVersion:1, sessionId:'one', configOptions:[],
      _meta:{'modular-agent':{binding, declaration, extensions:[]}}}}));
  })`;
  await assert.rejects(run('--group', 'waiting', '--', process.execPath, '-e', agent), e =>
    e.code === 1 && /FAIL  ACP\/1 waiting approval/.test(e.stdout) && /FAIL  ACP\/2 waiting approval/.test(e.stdout) &&
    /waiting fixture session declaration/.test(e.stdout) && /0\/[1-9]\d* checks passed/.test(e.stdout));
});

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const run = (...args) => exec(process.execPath, [fileURLToPath(new URL('./run.mjs', import.meta.url)), ...args], {
  env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
});

test('a selected erasure group needs an HTTP service before launching an agent', async () => {
  await assert.rejects(run('--group', 'erasure', '--', process.execPath, '-e', 'process.exit(45)'),
    e => e.code === 2 && /disposable service settings/.test(e.stderr));
});
test('invalid groups and core switches in another group are usage errors', async () => {
  for (const args of [['--group', 'unknown'], ['--group', 'waiting', '--crash-checks']])
    await assert.rejects(run(...args, '--', process.execPath, '-v'), e => e.code === 2);
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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { cases as basic } from './cases.mjs';
import { advanced } from './advanced.mjs';
import { fake } from './fake.mjs';
import { at, deadline } from './wire.mjs';

const cases = { ...basic, ...advanced };
const here = name => fileURLToPath(new URL(name, import.meta.url));
const exec = promisify(execFile);

test('runner launches a scripted agent command', async () => {
  const { stdout } = await exec(process.execPath, [here('run.mjs'), '--only', 'history', '--', process.execPath, here('fake-agent.mjs')], { signal: deadline() });
  assert.match(stdout, /1\/1 AG-UI cases passed/);
});

test('runner connects to an existing scripted agent with a token file', async () => {
  const server = await fake();
  const folder = await mkdtemp(join(tmpdir(), 'agui-connect-'));
  const tokenFile = join(folder, 'token');
  try {
    await writeFile(tokenFile, server.tokens.owner + '\n', { mode: 0o600 });
    const { stdout } = await exec(process.execPath, [here('run.mjs'), '--only', 'stock-conversation', '--url', server.origin, '--token-file', tokenFile], { signal: deadline() });
    assert.match(stdout, /1\/1 AG-UI cases passed/);
  } finally {
    await server.close();
    await rm(folder, { recursive: true, force: true });
  }
});

async function run(name, fault) {
  const scenario = cases[name];
  const server = await fake({ model: scenario.model, fault, scenario: scenario.control ? name : undefined });
  const peer = () => ({ ...server, api: at(server.origin, server.tokens.owner), restart });
  const restart = async () => { await server.restart(); return peer(); };
  try { await scenario.run(peer()); }
  finally { await server.close(); }
}

for (const name of Object.keys(cases)) test(`fake passes ${name}`, () => run(name));
for (const [name, fault, diagnosis] of [
  ['listener', 'anonymous', /HTTP status/],
  ['tls', 'tls-client-only', /does not replace bearer/],
  ['listener', 'outside-scope', /HTTP status/],
  ['encoding', 'duplicate-member', /HTTP status/],
  ['encoding', 'echo-input', /must omit input/],
  ['history', 'stale-cursor', /HTTP status/],
  ['history', 'changed-history', /HTTP status/],
  ['history', 'duplicate-run', /HTTP status/],
  ['history', 'sse-id', /no SSE id/],
  ['history', 'unbalanced', /open sequence/],
  ['frontend', 'pending-ids', /terminal pending IDs/],
  ['frontend', 'draft', /actual transformed arguments/],
  ['frontend', 'snapshot-args', /only identity and expiry/],
  ['frontend', 'foreign-wait', /does not inherit wait/],
  ['frontend', 'skip-tool-after', /tool.after output/],
  ['approval-absent', 'approval-without-presence', /run outcome/],
  ['approval-lost', 'keep-presence', /closed approval/],
  ['mixed', 'staged-executable', /in-turn interrupt does not release/],
  ['mixed', 'missing-checkpoint', /same batch/],
  ['release-gate', 'skip-final-authority', /unsafe delivery/],
  ['report-cutoffs', 'lost-expiry', /report is refused/],
  ['state-and-gate', 'stale-state-base', /suppress stale\/gated patches/],
  ['state-and-gate', 'leak-gate', /committed assistant response/],
  ['output-size', 'oversized-event', /encoded SSE event exceeds 64 MiB/],
  ['error-gate', 'leak-error', /sentinel escaped/],
  ['trace', 'untrusted-trace', /untrusted header ignored/],
  ['crash-after-handoff', 'extend-deadline', /without extending it/],
  ['crash-continuation', 'lost-recovery-trace', /authoritative continuation context/],
]) test(`kit rejects ${fault}`, () => assert.rejects(run(name, fault), diagnosis));
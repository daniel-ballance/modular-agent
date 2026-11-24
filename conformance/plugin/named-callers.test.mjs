import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const file = name => fileURLToPath(new URL(name, import.meta.url));
const exec = promisify(execFile);
const run = (...command) => exec(process.execPath, [file('run.mjs'), '--named-callers', ...command]);
const launcher = ['--', process.execPath, file('fake-named.mjs')];

test('a run without a named-caller launcher explains the skip', async () => {
  const { stdout } = await run(); assert.match(stdout, /SKIP .*no named-caller fixture command/);
});
test('one listener isolates the two authenticated callers', async () => {
  const { stdout } = await run(...launcher);
  assert.match(stdout, /different credentials.*other call to settle once/);
  assert.match(stdout, /same credential A.*other call to settle once/);
  assert.match(stdout, /reconnect.*retained state/);
  assert.doesNotMatch(stdout, /FAIL|SKIP/);
});
for (const [fault, diagnosis] of [
  ['allow-duplicate-id', /FAIL .*duplicate caller ID/],
  ['allow-duplicate-token', /FAIL .*duplicate token value/],
  ['allow-mixed-table', /FAIL .*single token with callers/],
  ['wrong-token-status', /FAIL .*wrong token.*401/],
  ['setup-before-auth', /FAIL .*before factory or setup/],
  ['no-factory-audit', /FAIL .*fresh factory/],
  ['trust-config', /FAIL .*credential selects the factory ID/],
  ['trust-input', /FAIL .*credential selects the factory ID/],
  ['shared-home-state', /FAIL .*independent retained state/],
  ['state-by-input', /FAIL .*changed tool claim/],
  ['state-by-config', /FAIL .*reconnect.*retained state/],
  ['state-by-socket', /FAIL .*reconnect.*retained state/],
  ['cross-cancel', /FAIL .*different credentials.*cancel and close/],
  ['same-cancel', /FAIL .*same credential A.*cancel and close/],
  ['cross-callback', /FAIL .*different credentials.*distinct callback routes/],
  ['wrong-project', /FAIL .*cannot read project/],
  ['reconnect-project', /FAIL .*reconnects and reads only its own/],
]) test(`kit rejects ${fault}`, async () => {
  await assert.rejects(run(...launcher, fault), error => error.code === 1 && diagnosis.test(error.stdout));
});

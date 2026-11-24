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

import { waiting } from './waiting.mjs';
import { closures } from './closures.mjs';

import { receipts } from './receipts.mjs';

const cases = { ...basic, ...advanced, ...waiting, ...closures, ...receipts };
const here = name => fileURLToPath(new URL(name, import.meta.url));
const exec = promisify(execFile);

test('runner launches a scripted agent command', async () => {
  const { stdout } = await exec(process.execPath, [here('run.mjs'), '--only', 'history', '--', process.execPath, here('fake-agent.mjs')], { signal: deadline() });
  assert.match(stdout, /1\/1 AG-UI cases passed/);
});

test('managed legacy listener needs no control URL for optional host reads', async () => {
  const { stdout } = await exec(process.execPath, [here('run.mjs'), '--only', 'closure-order,receipt-durable', '--', process.execPath, here('fake-agent.mjs')], { signal: deadline() });
  assert.match(stdout, /SKIP  closure-order \(thread snapshot does not offer waitCursor\)/);
  assert.match(stdout, /SKIP  receipt-durable \(thread snapshot does not offer runReceipts\)/);
  assert.match(stdout, /0\/0 AG-UI cases passed; 2 skipped/);
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

test('undeclared session skips the waiting case before requiring controls or restart', async () => {
  const server = await fake();
  const folder = await mkdtemp(join(tmpdir(), 'agui-no-wait-'));
  try {
    const path = join(folder, 'owner.token');
    await writeFile(path, server.tokens.owner, { mode: 0o600 });
    const { stdout } = await exec(process.execPath, [here('run.mjs'), '--only', 'waiting-restart', '--url', server.origin, '--token-file', path], { signal: deadline() });
    assert.match(stdout, /SKIP  waiting-restart \(session does not declare approvalsOutlastTurns\)/);
    assert.match(stdout, /0\/0 AG-UI cases passed; 1 skipped/);
  } finally { await server.close(); await rm(folder, { recursive: true, force: true }); }
});

test('host reads absent: skip before looking for controls, restart or other credentials', async () => {
  const server = await fake();
  try {
    const peer = { api: at(server.origin, server.tokens.owner) };
    for (const c of Object.values(receipts)) assert.deepEqual(await c.run(peer), { skipped: 'thread snapshot does not offer runReceipts' });
    for (const c of Object.values(closures)) assert.deepEqual(await c.run(peer), { skipped: 'thread snapshot does not offer waitCursor' });
  } finally { await server.close(); }
});

async function run(name, fault) {
  const scenario = cases[name];
  const server = await fake({ model: scenario.model, fault, scenario: scenario.control ? name : undefined });
  const peer = () => ({ ...server, api: at(server.origin, server.tokens.owner), restart });
  const restart = async () => { await server.restart(); return peer(); };
  try { assert.equal((await scenario.run(peer()))?.skipped, undefined, 'fake must exercise this case'); }
  finally { await server.close(); }
}

test('watch loss may reset a feed between complete frames', () => run('closure-buffered', 'reset-on-watch-loss'));
for (const name of Object.keys(cases)) test(`fake passes ${name}`, () => run(name));
for (const [name, fault, diagnosis] of [
  ['approval', 'missing-live-coverage', /approval interrupt declares coversNested/],
  ['waiting-restart', 'missing-waiting-coverage', /waiting interrupt declares coversNested/],
  ['waiting-restart', 'wrong-covering-request', /child start names the covering request/],
  ['waiting-live', 'wait-live-opt-in', /exactly one toolResult/],
  ['waiting-routes', 'wait-accept-without-presence', /report is refused/],
  ['waiting-routes', 'wait-list-grants', /report is refused/],
  ['waiting-routes', 'wait-keep-delivery', /report is refused/],
  ['waiting-routes', 'wait-close-on-loss', /fresh delivery/],
  ['waiting-routes', 'wait-gate', /report is refused/],
  ['waiting-routes', 'wait-watch', /deep-equal/],
  ['waiting-routes', 'wait-sibling-delivery', /report is refused/],
  ['waiting-restart', 'wait-no-presence', /snapshot without presence/],
  ['waiting-restart', 'wait-restore-delivery', /report is refused/],
  ['waiting-restart', 'wait-name', /unchanged prompt/],
  ['waiting-restart', 'wait-args', /unchanged prompt/],
  ['waiting-restart', 'wait-id', /same call ID/],
  ['waiting-restart', 'wait-expiry-view', /original absolute expiry/],
  ['waiting-restart', 'wait-split-batch', /one ordered batch/],
  ['waiting-restart', 'wait-early-start', /parked call has no toolStarted/],
  ['waiting-restart', 'wait-early-effect', /counter is zero/],
  ['waiting-restart', 'wait-triad', /no triad/],
  ['waiting-restart', 'wait-result', /no triad/],
  ['waiting-restart', 'wait-pending-id', /terminal pending IDs/],
  ['waiting-restart', 'wait-offline-interrupt', /run outcome/],
  ['waiting-restart', 'wait-list-needs-presence', /waits are counted/],
  ['waiting-restart', 'wait-list-tool', /waits are counted/],
  ['waiting-restart', 'wait-list-running', /waits are counted/],
  ['waiting-restart', 'wait-snapshot-tool', /not an Interface tool/],
  ['waiting-restart', 'wait-ignore-coverage', /report is refused/],
  ['waiting-restart', 'wait-new-input', /exactly one inputAccepted/],
  ['waiting-restart', 'wait-unlinked', /continuation links/],
  ['waiting-decline', 'wait-decline-runs', /initial dispatch/],
  ['waiting-expiry', 'wait-late-answer', /report is refused/],
  ['waiting-expiry', 'wait-expiry-refused', /notStarted/],
  ['waiting-race', 'wait-double-race', /deep-equal/],
  ['waiting-mixed-report-first', 'wait-early-ready', /first settlement/],
  ['waiting-mixed-answer-first', 'wait-rehandoff', /released exactly once/],
  ['closure-order', 'miss-catchup', /closure in commit order/],
  ['closure-order', 'repeat-cutover', /closure in commit order/],
  ['closure-order', 'repeat-after', /closure in commit order/],
  ['closure-order', 'deadline-is-decline', /closure in commit order/],
  ['closure-order', 'invent-expiry', /committed system timeLimit/],
  ['closure-order', 'lose-revocation', /closure in commit order/],
  ['closure-order', 'unrecorded-revocation', /recorded revocation/],
  ['closure-order', 'answer-in-notice', /closure in commit order/],
  ['closure-order', 'wait-bad-framing', /SSE data line must end with LF LF/],
  ['closure-routes', 'route-is-closure', /closure in commit order/],
  ['closure-routes', 'feed-can-answer', /report is refused/],
  ['closure-presence', 'feed-is-presence', /feed alone is not presence/],
  ['closure-presence', 'mark-loss-revoked', /not a recorded revocation/],
  ['closure-presence', 'guess-revocation', /closure in commit order/],
  ['closure-left-open', 'timeout-is-closure', /closure in commit order/],
  ['closure-left-open', 'no-pending-wait', /actually reached pending/],
  ['closure-interface', 'wrong-settlement', /closure in commit order/],
  ['closure-interface', 'settlement-without-result', /matching terminal result/],
  ['closure-interface', 'other-executor-notice', /closure in commit order/],
  ['closure-buffered', 'skip-source-gate', /closure in commit order/],
  ['closure-buffered', 'skip-decision-gate', /closure in commit order/],
  ['closure-buffered', 'changed-notice', /closure in commit order/],
  ['closure-buffered', 'skip-watch-recheck', /no final notice/],
  ['closure-buffered', 'comment-disclosure', /heartbeat disclosed/],
  ['closure-buffered', 'cursor-disclosure', /cursor disclosed/],
  ['closure-cursor', 'missing-after', /HTTP status/],
  ['closure-cursor', 'stale-wait-cursor', /cursor_expired/],
  ['closure-cursor', 'foreign-wait-cursor', /cursor_expired/],
  ['receipt-before-admission', 'early-link', /HTTP status/],
  ['receipt-before-admission', 'reserve-rejected-id', /run HTTP status/],
  ['receipt-after-admission', 'late-link', /HTTP status/],
  ['receipt-after-admission', 'lose-link', /HTTP status/],
  ['receipt-after-admission', 'infer-error-from-loss', /receipt at this watermark/],
  ['receipt-after-admission', 'latest-turn', /receipt at this watermark/],
  ['receipt-durable', 'assume-transient', /receipt at this watermark/],
  ['receipt-before-terminal', 'infer-success-from-end', /receipt at this watermark/],
  ['receipt-before-terminal', 'early-terminal', /terminal escaped/],
  ['receipt-interrupt', 'exchange-is-work', /receipt at this watermark/],
  ['receipt-interrupt', 'merge-exchanges', /receipt at this watermark/],
  ['receipt-interrupt', 'retry-decision', /reads and retries leave work unchanged/],
  ['receipt-result', 'follow-origin', /receipt at this watermark/],
  ['receipt-result', 'lost-released-error', /receipt at this watermark/],
  ['receipt-result', 'extra-result-input', /one opening input/],
  ['receipt-result', 'read-rehandoff', /reads and retries leave work unchanged/],
  ['receipt-visibility', 'read-admits', /reads and retries leave work unchanged/],
  ['receipt-visibility', 'receipt-body', /receipt at this watermark/],
  ['receipt-visibility', 'accept-used-id', /HTTP status/],
  ['receipt-visibility', 'sibling-receipt', /HTTP status/],
  ['receipt-visibility', 'foreign-receipt', /HTTP status/],
  ['receipt-visibility', 'tenant-receipt', /HTTP status/],
  ['receipt-visibility', 'settlement-as-unknown', /HTTP status/],
  ['receipt-visibility', 'ignore-reply-gate', /HTTP status/],
  ['receipt-visibility', 'redact-terminal', /HTTP status/],
  ['receipt-visibility', 'redact-work', /HTTP status/],
  ['receipt-visibility', 'withheld-oracle', /HTTP status/],
  ['receipt-visibility', 'pending-receipt', /HTTP status/],
  ['receipt-visibility', 'erased-receipt', /HTTP status/],
  ['listener', 'anonymous', /HTTP status/],
  ['tls', 'tls-client-only', /does not replace bearer/],
  ['listener', 'outside-scope', /HTTP status/],
  ['thread-listing', 'list-content', /thread metadata only/],
  ['thread-listing', 'list-scope', /omit threads outside scope/],
  ['thread-listing', 'list-provisional', /only kept sessions/],
  ['thread-listing', 'reverse-list', /most recently changed first/],
  ['thread-listing', 'repeat-page', /second page ends/],
  ['thread-listing', 'unknown-page', /HTTP status/],
  ['frontend', 'list-foreign-call', /counted for this client/],
  ['approval', 'list-foreign-question', /counted for this client/],
  ['crash-before-handoff', 'list-idle', /counted for this client/],
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
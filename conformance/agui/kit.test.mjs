import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cases as basic } from './cases.mjs';
import { advanced } from './advanced.mjs';
const cases = { ...basic, ...advanced };
import { fake } from './fake.mjs';
import { at } from './wire.mjs';

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
  ['listener', 'outside-scope', /HTTP status/],
  ['encoding', 'duplicate-member', /HTTP status/],
  ['encoding', 'echo-input', /must omit input/],
  ['history', 'stale-cursor', /HTTP status/],
  ['history', 'changed-history', /HTTP status/],
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
  ['error-gate', 'leak-error', /sentinel escaped/],
  ['trace', 'untrusted-trace', /untrusted header ignored/],
  ['crash-after-handoff', 'extend-deadline', /without extending it/],
  ['crash-continuation', 'lost-recovery-trace', /authoritative continuation context/],
]) test(`kit rejects ${fault}`, () => assert.rejects(run(name, fault), diagnosis));
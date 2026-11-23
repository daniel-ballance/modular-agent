import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cases } from './cases.mjs';
import { fake } from './fake.mjs';
import { at } from './wire.mjs';

async function run(name, fault) {
  const scenario = cases[name];
  const server = await fake({ model: scenario.model, fault });
  try { await scenario.run({ ...server, api: at(server.origin, server.tokens.owner) }); }
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
]) test(`kit rejects ${fault}`, () => assert.rejects(run(name, fault), diagnosis));
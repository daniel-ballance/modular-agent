import assert from 'node:assert/strict';
import { opts, simple, success } from './cases.mjs';
import { controls, hostRead } from './host-read.mjs';
import { input, json, threadPath, user } from './wire.mjs';

export const erasureRetry = hostRead('waitCursor', simple, async ({ api, ...peer }, view) => {
  const secret = 'Private text while a copy remains pending.';
  const post = input(view, [user(secret)]);
  success(await api.run(post, opts(view)));
  const control = controls(peer, view.threadId);
  const { entries: before } = await control('storedEntries');
  const target = before.find(e => e.kind === 'inputAccepted' && JSON.stringify(e).includes(secret)) ??
    before.find(e => e.kind === 'input' && JSON.stringify(e).includes(secret));
  assert.ok(target, 'the seed input is kept');
  const path = threadPath(view.threadId);
  const entryIds = before.filter(e => JSON.stringify(e).includes(secret)).map(e => e.id);
  await control('markPending', { entryIds });
  for (const suffix of ['/wait-closures?' + new URLSearchParams({ after: view.waitCursor }),
    '/run-receipt?' + new URLSearchParams({ runId: post.runId })]) {
    const response = await api.request(path + suffix, { headers: { Accept: 'text/event-stream' } });
    assert.ok([404, 503].includes(response.status), `lease-free ${suffix} refuses pending history: ${response.status}`);
    assert.ok(!(await response.text()).includes(secret));
    const { entries: kept } = await control('storedEntries');
    assert.ok(!kept.some(e => e.kind === 'erasure'), 'lease-free reads do not retry');
    assert.ok(!kept.find(e => e.id === target.id)?.erased, 'the target remains live in storage');
  }
  assert.deepEqual(await json(await api.request(path + '/settings', { method: 'POST', body: JSON.stringify({ approval: 'off' }) })), { approval: 'off' });
  const { entries: kept } = await control('storedEntries');
  assert.ok(kept.find(e => e.id === target.id)?.erased, 'authorized settings completes pending erasure');
  const erased = kept.findIndex(e => e.kind === 'erasure');
  assert.ok(erased >= 0 && erased < kept.findLastIndex(e => e.kind === 'setting'), 'erasure precedes the setting');
  assert.ok(!JSON.stringify(kept).includes(secret), 'stored history has no private text');
});

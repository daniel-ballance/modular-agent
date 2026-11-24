import assert from 'node:assert/strict';

// Check the offered read on the actual thread snapshot.
export function hostRead(field, model, run, { restart, roles = [], control = true } = {}) {
  return { model, control, restart, async run(peer) {
    const { threadId } = await peer.api.create();
    const view = await peer.api.view(threadId);
    assert.ok(Object.hasOwn(view, field), `thread snapshot does not offer ${field}`);
    if (field === 'waitCursor') assert.ok(typeof view.waitCursor === 'string' && view.waitCursor.length, 'snapshot offers a wait cursor string');
    else assert.equal(view.runReceipts, 1, 'snapshot offers runReceipts: 1');
    if (control) assert.ok(peer.control, `${field} case requires fixture controls`);
    if (restart) assert.ok(peer.restart, 'crash case requires a managed command');
    for (const role of roles) assert.ok(peer.tokens[role], `case requires --${role}-token-file`);
    await run(peer, view);
  } };
}
export const controls = (peer, threadId) => (operation, args) => peer.control(operation, { threadId, ...args });
export const records = (evidence, kind) => evidence.batches.flat().filter(e => e.kind === kind);

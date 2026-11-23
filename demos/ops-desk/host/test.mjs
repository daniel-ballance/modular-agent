import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './dist/store.js';

test('one listener owns a store; a replacement keeps the route, thread and input key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ops-desk-store-')),
    path = join(dir, 'desk.sqlite');
  try {
    const first = new Store(path);
    try {
      assert.throws(() => new Store(path), /Another host/);
      first.receive('build-7', 'build-failed', 'suite', null);
      first.thread(first.next('triage'), 'original-thread');
    } finally {
      first.close();
    }
    const reopened = new Store(path);
    try {
      const r = reopened.next('triage');
      assert.equal(r.thread, 'original-thread');
      assert.equal(r.runKey, 'build-7');
      assert.equal(reopened.cursor(), 0);
      reopened.admitted(r);
      reopened.finish(r, 'done');
      assert.equal(reopened.cursor(), 1);
      assert.equal(reopened.next('triage'), undefined);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only the named agents can queue work; replay and failed verdicts have bounds', () => {
  const s = new Store(':memory:');
  try {
    s.receive('evt', 'issue-opened', 'bad limit', null);
    const triage = s.next('triage');
    assert.throws(() => s.handOff(triage, 'verifier', 'skip review', 'seed'));
    s.handOff(triage, 'coder', 'fix limit', 'seed');
    s.handOff(triage, 'coder', 'duplicate', 'seed');
    const revision = 'a'.repeat(40);
    for (let i = 0; i < 3; i++) {
      const coder = s.next('coder');
      assert.equal(coder.attempt, i);
      s.handOff(coder, 'verifier', 'run tests', revision);
      s.finish(coder, 'done');
      const verifier = s.next('verifier');
      assert.equal(verifier.revision, revision);
      assert.throws(() => s.handOff(verifier, 'coder', 'wrong source', revision));
      assert.throws(() => s.post(verifier, 't', 'change', 'wrong kind'));
      s.post(verifier, 't', 'verdict', 'FAIL: test failed');
      s.post(verifier, 't', 'verdict', 'FAIL: test failed');
      s.finish(verifier, 'done');
    }
    assert.equal(s.next('coder'), undefined);
    assert.equal(s.conversation().filter((x) => x.kind === 'verdict').length, 3);
    assert.equal(s.routes().length, 7);
  } finally {
    s.close();
  }
});

// The listener acknowledges only after the event and its input route are durable.
test('a repeated ID keeps the first event, input key and place in the conversation', () => {
  const s = new Store(':memory:');
  try {
    assert.equal(s.receive('build-1', 'build-failed', { suite: 'limits' }, null), true);
    assert.equal(s.receive('build-1', 'issue-opened', 'different', null), false);
    const route = s.next('triage');
    assert.equal(route.runKey, 'build-1');
    assert.match(route.task, /limits/);
    assert.equal(s.conversation().length, 1);
    assert.equal(s.cursor(), 0);
    s.admitted(route);
    assert.equal(s.cursor(), route.event);
  } finally {
    s.close();
  }
});

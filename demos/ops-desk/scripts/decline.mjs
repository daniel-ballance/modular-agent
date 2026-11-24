// A second AG-UI client process using the disposable desk identity while the HTTP host is down.
import assert from 'node:assert/strict';
import { Control } from '../host/dist/control.js';

const [thread, id] = process.argv.slice(2);
const station = new Control(process.cwd(), () => {});
const presence = new AbortController();
try {
  const api = await station.start('coder', 180000).ready, route = { thread, parent: null };
  await api.presence(route, presence, () => {});
  const view = await api.snapshot(route);
  assert.deepEqual(view.waiting.questions.map(q => q.id), [id]);
  const end = await api.run(route, view, [{ interruptId: id, status: 'resolved', payload: { allow: false } }], () => {});
  assert.equal(end.type, 'success');
} finally {
  presence.abort();
  station.close();
}

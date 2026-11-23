#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [id = randomUUID(), kind = 'build-failed'] = process.argv.slice(2);
if (!['build-failed', 'issue-opened'].includes(kind)) throw Error('Use build-failed or issue-opened.');
const root = process.env.DESK_DATA ?? fileURLToPath(new URL('../.desk/', import.meta.url));
const token = (await readFile(join(root, 'events.token'), 'utf8')).trim();
const host = process.env.DESK_BIND ?? '127.0.0.1';
const port = process.env.DESK_PORT ?? 8080;
const url = new URL(`http://${host}:${port}/events`);
const response = await fetch(url, {
  method: 'POST',
  redirect: 'error',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
  body: JSON.stringify({
    id,
    kind,
    payload: { description: 'percentage(37) should be 37, not zero.', suite: 'percentage' }
  })
});
if (!response.ok) throw Error('Webhook returned HTTP ' + response.status);
const { accepted } = await response.json();
console.log(id + ': ' + (accepted ? 'queued' : 'duplicate, ignored'));

import assert from 'node:assert/strict';
import { request } from 'node:https';
import { PATH, deadline, parse } from './wire.mjs';

// Use the native TLS client so the test can supply just one disposable CA and
// client identity without changing verification for other requests in the kit.
function get(url, options) {
  return new Promise((resolve, reject) => {
    const req = request(url, { ...options, signal: deadline(), agent: false }, res => {
      const chunks = [];
      res.on('data', bytes => chunks.push(bytes));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end();
  });
}

export async function checkTls({ origin, tokens, control }) {
  const tls = await control('tls', {});
  const url = new URL(PATH, origin);
  assert.equal(url.protocol, 'https:', 'fixture must serve TLS');
  const auth = { Authorization: `Bearer ${tokens.owner}` };
  const identity = { cert: tls.cert, key: tls.key, servername: tls.servername };
  await assert.rejects(get(url, { ...identity, headers: auth }), { code: /CERT|ISSUER|SELF_SIGNED|^UNABLE_TO_VERIFY_LEAF_SIGNATURE$/ }, 'unknown CA is rejected');
  await assert.rejects(get(url, { ...identity, ca: tls.ca, servername: 'wrong.fixture.invalid', headers: auth }), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }, 'server name is verified');
  await assert.rejects(get(url, { ca: tls.ca, servername: tls.servername, headers: auth }), { code: /TLS|ECONNRESET/ }, 'configured mutual TLS requires a client certificate');
  const denied = await get(url, { ...identity, ca: tls.ca });
  assert.deepEqual(denied, { status: 401, body: { code: 'unauthenticated' } }, 'TLS client identity does not replace bearer authentication');
  const found = await get(url, { ...identity, ca: tls.ca, headers: auth });
  assert.equal(found.status, 200, 'trusted mTLS client with bearer can discover');
  assert.equal(found.body.binding, 'modular-agent-agui/1');
}

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

export async function disposableTls() {
  const folder = await mkdtemp(join(tmpdir(), 'agui-tls-'));
  const openssl = (...argv) => promisify(execFile)('openssl', argv, { cwd: folder });
  const servername = 'fixture.invalid';
  try {
    await openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', '/CN=fixture CA', '-keyout', 'ca.key', '-out', 'ca.pem');
    for (const name of [servername, 'client']) {
      await openssl('req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-subj', `/CN=${name}`, '-addext', `subjectAltName=DNS:${name}`, '-keyout', `${name}.key`, '-out', `${name}.csr`);
      await openssl('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-copy_extensions', 'copy', '-out', `${name}.pem`);
    }
    const read = file => readFile(join(folder, file), 'utf8');
    const ca = await read('ca.pem');
    return {
      server: { ca, key: await read(`${servername}.key`), cert: await read(`${servername}.pem`), requestCert: true, rejectUnauthorized: true },
      client: { ca, key: await read('client.key'), cert: await read('client.pem'), servername },
    };
  } finally { await rm(folder, { recursive: true, force: true }); }
}

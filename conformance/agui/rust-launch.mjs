#!/usr/bin/env node
// Launch production ma for ordinary conversation. Cases that require operator
// hooks, multiple authorities or crash controls use the separate Rust example.
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { disposableTls } from './tls-fixture.mjs';
const config = JSON.parse(await readFile(process.env.MA_AGUI_FIXTURE, 'utf8'));
const debug = fileURLToPath(new URL('../../rust/target/debug/', import.meta.url));
const ordinary = ['encoding', 'history', 'stock-conversation'].includes(config.name);
if (config.name === 'tls') {
  const { client, server } = await disposableTls();
  for (const [file, content] of Object.entries({ 'ca.pem': client.ca, 'server.pem': server.cert, 'server.key': server.key, 'tls-client.json': JSON.stringify(client) })) {
    await writeFile(join(process.env.MODULAR_AGENT_DATA_DIR, file), content, { mode: 0o600 });
  }
}
const child = ordinary ? spawn(join(debug, 'ma'), ['--agui', ...(config.name === 'encoding' ? [] : ['--acp']), '--listen', process.env.MA_AGUI_LISTEN, '--token-file', config.tokenFiles.owner], { stdio: 'inherit' }) : spawn(join(debug, 'examples/agui_fixture'), [], { stdio: 'inherit' });
child.on('error', () => process.exit(1));
child.on('exit', code => process.exit(code ?? 1));

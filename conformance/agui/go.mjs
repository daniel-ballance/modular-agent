#!/usr/bin/env node
// Launch the stock ma wherever the case needs only its standard composition.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { disposableTls } from './tls-fixture.mjs';

function launch(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const bin = fileURLToPath(new URL('../../go/.bin/', import.meta.url));
const file = process.env.MA_AGUI_FIXTURE;
const cfg = JSON.parse(await readFile(file, 'utf8'));
if (['encoding', 'history', 'stock-conversation'].includes(cfg.name)) {
  const ma = join(bin, 'ma');
  launch(ma, ['--acp', '--agui', '--listen', process.env.MA_AGUI_LISTEN, '--token-file', cfg.tokenFiles.owner]);
} else if (cfg.name === 'listener') {
  const rights = ['input', 'watch', 'tools', 'answer', 'approve'];
  const actors = Object.entries(cfg.tokenFiles).map(([role, tokenFile]) => ({
    tokenFile, clientId: ['owner', 'rotated'].includes(role) ? 'kit-primary' : role,
    actor: { id: role === 'foreign' ? 'kit-foreign' : 'kit-owner', kind: 'user', rights: role === 'watch' ? ['watch'] : rights },
    projects: [role === 'project' ? dirname(file) : cfg.project], tenants: role === 'tenant' ? ['other'] : [null],
  }));
  const policy = join(dirname(file), 'policy.json');
  await writeFile(policy, JSON.stringify({ actors }));
  const ma = join(bin, 'ma');
  launch(ma, ['--acp', '--agui', '--listen', process.env.MA_AGUI_LISTEN, '--policy', policy]);
} else {
  if (cfg.name === 'tls') {
    const { server, client } = await disposableTls();
    for (const key of ['ca', 'cert', 'key']) await writeFile(join(dirname(file), 'tls-' + key), server[key], { mode: 0o600 });
    await writeFile(join(dirname(file), 'tls-client'), JSON.stringify(client), { mode: 0o600 });
  }
  const fixture = join(bin, 'agui-fixture');
  launch(fixture, ['-test.run=^TestAGUIKitProgram$']);
}

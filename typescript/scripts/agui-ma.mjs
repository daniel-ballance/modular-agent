// Launch real ma where the case needs no embedded fixture hooks or controls.
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultAcpActor } from '@modular-agent/core';
const { name, tokenFiles, project } = JSON.parse(await readFile(process.env.MA_AGUI_FIXTURE, 'utf8'));
if (!['listener', 'encoding', 'history', 'stock-conversation'].includes(name)) {
  await import('./agui-fixture.mjs');
} else {
  const args = ['--agui', '--acp', '--listen', process.env.MA_AGUI_LISTEN];
  if (name !== 'listener') args.push('--token-file', tokenFiles.owner);
  else {
    const policy = join(process.env.HOME, 'kit-policy.json');
    const actors = Object.entries(tokenFiles).map(([role, tokenFile]) => ({ tokenFile, actor: { ...defaultAcpActor(), id: role === 'foreign' ? 'kit-foreign' : 'kit-owner',
      rights: role === 'watch' ? ['watch'] : defaultAcpActor().rights }, clientId: ['owner', 'rotated'].includes(role) ? 'kit-primary' : `kit-${role}`,
      projects: role === 'project' ? [] : [project], tenants: role === 'tenant' ? ['other'] : [null] }));
    await writeFile(policy, JSON.stringify({ actors }), { mode: 0o600 }); args.push('--policy', policy);
  }
  const main = fileURLToPath(new URL('../packages/ma/dist/src/main.js', import.meta.url));
  const child = spawn(process.execPath, [main, ...args], { stdio: 'inherit' });
  child.once('exit', code => { process.exitCode = code ?? 1; });
}

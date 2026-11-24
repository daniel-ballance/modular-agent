#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs, promisify } from 'node:util';
import { advanced } from './advanced.mjs';
import { cases as basic, offer } from './cases.mjs';
import { closures } from './closures.mjs';
import { receipts } from './receipts.mjs';
import { waiting } from './waiting.mjs';
import { at, deadline } from './wire.mjs';

const cases = { ...basic, ...advanced, ...waiting, ...closures, ...receipts };
const roles = ['owner', 'rotated', 'sibling', 'foreign', 'watch', 'tenant', 'project'];
const usage = `node run.mjs [--only CASE[,CASE...]] -- /absolute/path/to/fixture [args...]
node run.mjs --only CASE --url ORIGIN --token-file FILE [--ROLE-token-file FILE ...]
             [--control URL --control-token-file FILE]
node run.mjs --list`;
const requiredRoles = { 'thread-listing': ['watch', 'tenant', 'project'], listener: ['watch', 'tenant', 'project'], frontend: ['rotated', 'sibling', 'foreign'], approval: ['sibling'], 'approval-absent': ['sibling'], 'state-and-gate': ['sibling'], 'output-size': ['sibling'], trace: ['foreign'] };

function loopback(host) { return host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host); }
function endpoint(value) {
  const url = new URL(value);
  assert.ok(url.protocol === 'https:' || (url.protocol === 'http:' && loopback(url.hostname)), 'use HTTPS except on loopback');
  assert.ok(!url.username && !url.password && !url.search && !url.hash, 'URL must not contain credentials, query or fragment');
  return url;
}
function origin(value) {
  const url = endpoint(value);
  assert.equal(url.pathname, '/', 'listener URL must be an HTTP origin');
  return url.origin;
}
async function token(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    assert.ok(stat.isFile() && (stat.mode & 0o077) === 0 && stat.uid === process.getuid(), 'use an owner-only disposable token file');
    assert.ok(stat.size <= 4096, 'token file too large');
    const value = (await file.readFile('utf8')).trim();
    assert.ok(/^[!-~]+$/.test(value), 'invalid token file contents');
    return value;
  } finally { await file.close(); }
}
function controls(value, auth) {
  const url = endpoint(value);
  assert.ok(loopback(url.hostname), 'fixture control must be on numeric loopback');
  return async (operation, args) => {
    const response = await fetch(url, {
      method: 'POST', redirect: 'error', signal: deadline(),
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation, ...args }),
    });
    assert.equal(response.status, 200, `fixture control failed: ${operation}`);
    return response.json();
  };
}
const exec = promisify(execFile);
async function waitGroup(pid) {
  // The direct child can exit before descendants killed with the same signal.
  // Wait until no live process remains in the group (a zombie cannot write).
  const signal = deadline();
  for (;;) {
    const { stdout } = await exec('ps', ['-axo', 'pgid=,stat='], { signal });
    const live = stdout.split('\n').some(row => {
      const [group, state] = row.trim().split(/\s+/);
      return Number(group) === pid && state && !state.startsWith('Z');
    });
    if (!live) return;
    await delay(20, undefined, { signal });
  }
}

async function managed(command, name, scenario) {
  const folder = await mkdtemp(join(process.env.TMPDIR ?? join(homedir(), '.cache/ma-std-tmp'), 'agui-'));
  const [home, data, project, tmp] = ['home', 'data', 'project', 'tmp'].map(v => join(folder, v));
  await Promise.all([home, data, project, tmp].map(v => mkdir(v)));
  const model = join(folder, 'model.json');
  const policy = join(folder, 'fixture.json');
  const controlFile = join(folder, 'control.token');
  const tokens = {}, tokenFiles = {};
  for (const role of roles) {
    tokens[role] = randomBytes(32).toString('hex');
    tokenFiles[role] = join(folder, role + '.token');
    await writeFile(tokenFiles[role], tokens[role] + '\n', { mode: 0o600 });
  }
  const controlToken = randomBytes(32).toString('hex');
  await writeFile(controlFile, controlToken + '\n', { mode: 0o600 });
  await writeFile(model, JSON.stringify(scenario.model));
  await writeFile(policy, JSON.stringify({ name, tokenFiles, offer, project, controlTokenFile: controlFile }));
  const env = {
    HOME: home, PATH: process.env.PATH, TMPDIR: tmp, XDG_CONFIG_HOME: join(home, '.config'),
    MODULAR_AGENT_DATA_DIR: data, MODULAR_AGENT_SCRIPT: model, MODULAR_AGENT_SCRIPT_LOG: join(folder, 'model.jsonl'),
    MA_AGUI_FIXTURE: policy, MA_AGUI_LISTEN: '127.0.0.1:0',
  };
  let stop, lines;
  const cleanup = async () => { await stop?.(); };
  async function launch() {
    const child = spawn(command[0], command.slice(1), { cwd: project, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let spawnError;
    const closed = new Promise(resolve => {
      child.once('error', error => { spawnError = error; });
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    stop = async () => {
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      await closed;
      if (child.pid) await waitGroup(child.pid);
    };
    const stdout = createWriteStream(join(folder, 'stdout.log'), { flags: 'a', mode: 0o600 });
    child.stdout.pipe(stdout);
    child.stderr.pipe(createWriteStream(join(folder, 'stderr.log'), { flags: 'a', mode: 0o600 }));
    lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const signal = deadline();
    let line;
    try {
      line = await Promise.race([
        new Promise((resolve, reject) => {
          lines.once('line', resolve);
          signal.addEventListener('abort', () => reject(new Error('fixture did not print its listener URL')), { once: true });
        }),
        closed.then(({ code, signal }) => { throw spawnError ?? new Error(`fixture exited before readiness (${code ?? signal})`); }),
      ]);
    } finally { lines.close(); }
    const ready = line.startsWith('{') ? JSON.parse(line) : { url: line };
    const base = origin(ready.url);
    if (scenario.control) assert.ok(ready.control, 'managed fixture must report its control URL');
    const control = scenario.control ? controls(ready.control, controlToken) : undefined;
    return { origin: base, tokens, api: at(base, tokens.owner), control,
      restart: async () => { await cleanup(); return launch(); } };
  }
  return { launch, cleanup, folder };
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    list: { type: 'boolean' }, only: { type: 'string' }, url: { type: 'string' }, control: { type: 'string' }, 'control-token-file': { type: 'string' },
    'token-file': { type: 'string' }, ...Object.fromEntries(roles.slice(1).map(role => [`${role}-token-file`, { type: 'string' }])),
  } });
  if (values.list) { console.log(Object.keys(cases).join('\n')); return; }
  const names = values.only?.split(',') ?? Object.keys(cases);
  assert.ok(names.every(name => Object.hasOwn(cases, name)) && new Set(names).size === names.length, 'select unique cases from --list');
  const direct = values.url !== undefined;
  assert.ok(direct ? positionals.length === 0 && names.length === 1 && values['token-file'] : positionals.length > 0 && isAbsolute(positionals[0]), usage);
  const tokens = {};
  if (direct) {
    for (const role of roles) {
      const path = values[role === 'owner' ? 'token-file' : `${role}-token-file`];
      if (path) tokens[role] = await token(path);
    }
    for (const role of [...(requiredRoles[names[0]] ?? []), ...(cases[names[0]].roles ?? [])]) assert.ok(tokens[role], `${names[0]} requires --${role}-token-file`);
    assert.equal(new Set(Object.values(tokens)).size, Object.keys(tokens).length, 'fixture credentials must be distinct');
  }
  let passed = 0;
  let current;
  const stop = signal => {
    void (async () => {
      try { await current?.cleanup(); }
      finally { process.exit(signal === 'SIGINT' ? 130 : 143); }
    })();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    for (const name of names) {
      const scenario = cases[name];
      let failed = true;
      try {
        let peer;
        if (direct) {
          assert.ok(!scenario.restart, 'crash cases require a managed fixture command');
          assert.ok(!scenario.control || (values.control && values['control-token-file']), 'case requires --control and --control-token-file');
          const base = origin(values.url);
          peer = { origin: base, tokens, api: at(base, tokens.owner),
            control: scenario.control && values.control ? controls(values.control, await token(values['control-token-file'])) : undefined };
        } else {
          current = await managed(positionals, name, scenario);
          peer = await current.launch();
        }
        await scenario.run(peer);
        failed = false;
        passed++; console.log(`PASS  ${name}`);
      } catch (error) {
        // Never print arbitrary server payloads, assertion actuals, or a token.
        console.error(`FAIL  ${name}: ${error.message.split('\n')[0]}`);
        if (current) console.error(`      fixture logs: ${current.folder}`);
      } finally {
        await current?.cleanup();
        if (!failed && current) await rm(current.folder, { recursive: true, force: true });
        current = undefined;
      }
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
  console.log(`${passed}/${names.length} AG-UI cases passed`);
  if (passed !== names.length) process.exitCode = 1;
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });

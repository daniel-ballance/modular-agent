// Executable fake for the runner's launch-mode self-test. No real Provider is used.
import { readFile } from 'node:fs/promises';
import { fake } from './fake.mjs';

const read = path => readFile(path, 'utf8');
const fixture = JSON.parse(await read(process.env.MA_AGUI_FIXTURE));
const model = JSON.parse(await read(process.env.MODULAR_AGENT_SCRIPT));
const tokens = Object.fromEntries(await Promise.all(Object.entries(fixture.tokenFiles).map(async ([role, path]) => [role, (await read(path)).trim()])));
const server = await fake({ model, tokens });
console.log(server.origin);

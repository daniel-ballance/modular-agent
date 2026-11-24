// Keep the observer and clock outside the writer that a stop step kills.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const [python, kit, directory, path, placement, ...command] = process.argv.slice(2);
const { checkWaitingDeclaration, waitingStep, waitingRecords } = await import(pathToFileURL(kit));
const fixture = JSON.parse(await readFile(path, 'utf8'));
const telemetry = process.env.MODULAR_AGENT_TELEMETRY_RUN && JSON.parse(await readFile(process.env.MODULAR_AGENT_TELEMETRY_RUN, 'utf8'));
let child, lines, exited, sid, declaration, last, stage = 'create';
const state = {}, observations = {};
async function optional(name, fallback) {
  try { return await readFile(join(directory, name), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
async function batches() {
  return (await optional('batches', '')).split('\n').filter(Boolean).map(s => JSON.parse(s)).map(b => b.filter(e => e.sessionId === sid)).filter(b => b.length);
}
function writer() {
  child = spawn(python, ['-m', 'modular_agent._waiting_fixture', directory, path, placement, ...command],
    { stdio: ['pipe', 'pipe', 'inherit'], detached: true });
  lines = createInterface({input: child.stdout})[Symbol.asyncIterator]();
  exited = once(child, 'exit');
}
async function ask(op, args = {}) {
  child.stdin.write(JSON.stringify({op, ...args}) + '\n');
  const {value, done} = await lines.next();
  assert(!done, 'Writer exited before replying to ' + op);
  const reply = JSON.parse(value);
  if (reply.error) throw Object.assign(new Error(reply.message), {code: reply.error});
  return reply.result;
}
async function stop(mode) {
  if (!child) return;
  if (mode === 'close') { await ask('close'); child.stdin.end(); }
  else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
  await exited;
  child = null;
}
const io = {
  questions: (actor, present) => ask('poll', {actor, present}),
  answer: (actor, qid, answer) => ask('decide', {actor, qid, answer}),
  async setClock(ms) {
    await writeFile(join(directory, 'new-clock'), String(ms));
    await rename(join(directory, 'new-clock'), join(directory, 'clock'));
    if (child) await ask('clock');
  },
  barrier: value => ask('barrier', {value}),
  change: value => ask('change', {value}),
  stop,
};
async function run() {
  await io.setClock(1800000000000);
  writer();
  if (fixture.expectCreateError) {
    await assert.rejects(ask('new'), e => e.code === fixture.expectCreateError.code && e.message.includes(fixture.expectCreateError.messageContains ?? ''));
    return;
  }
  ({sessionId: sid, declaration} = await ask('new'));
  checkWaitingDeclaration(fixture, declaration);
  for (const [index, step] of fixture.steps.entries()) {
    stage = 'step ' + index;
    const expect = step.expect ?? {};
    try {
      if (!await waitingStep(step, state, io)) {
        if (step.reopen) { writer(); await ask('reopen', {sid}); }
        else if (step.prompt) last = await ask('prompt', {text: step.prompt, actor: step.as ?? 'user'});
        else if (step.wait) last = await ask('wait');
        else assert.fail('Unknown step');
      }
    } catch(e) { if (expect.error && e.code === expect.error) continue; throw e; }
    assert(!expect.error, 'Expected ' + expect.error);
    if (expect.outcome) assert.equal(last.outcome, expect.outcome);
    if (expect.text) assert.equal(last.text, expect.text);
    if (expect.toolResults) {
      assert.equal(last.toolResults.length, expect.toolResults.length);
      for (const [i, result] of expect.toolResults.entries()) {
        for (const [k,v] of Object.entries(result)) {
          if (k === 'contains') assert(last.toolResults[i].text.includes(v));
          else assert.equal(last.toolResults[i][k], v, k);
        }
      }
    }
    const count = Number(await optional('count', '0'));
    if ('count' in expect) assert.equal(count, expect.count);
    const records = await batches();
    waitingRecords(fixture, expect, state, records, last);
    if (telemetry && expect.parked && !observations.originBatches) {
      observations.originBatches = records;
      observations.counterAtPark = count;
      const work = await ask('parked');
      if (telemetry.sdk) observations.activeWorkAtPark = work;
      assert.equal((await fetch(telemetry.parkedUrl, {method:'POST'})).status, 204);
    }
  }
  if (telemetry) {
    observations.finalBatches = await batches();
    observations.counterAfter = Number(await optional('count', '0'));
    await writeFile(telemetry.reportPath, JSON.stringify({
      scenario: fixture.scenario, placement, passed: true, sessionId: sid, turnId: state.request.turnId,
      historyKinds: observations.finalBatches.flat().map(e => e.kind), outcome: last.outcome,
      declarations: {session: declaration}, waiting: observations,
    }));
  }
  await stop('close');
}
try { await run(); }
catch (e) { console.error(fixture.scenario, placement, stage, e); process.exitCode = 1; }
finally { await stop('kill'); }

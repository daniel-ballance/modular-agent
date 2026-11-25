import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { createAgent, httpHistory, type ProcessPlugin } from '@modular-agent/core';
import { scriptedProvider } from '@modular-agent/core/testing';
import { openai } from '@modular-agent/openai';

const note = 'The ferry leaves at 14:02.';
const prompt = `Use add_note once to add "${note}" Then use search_notes to search for "ferry" and report the matching line.`;
const script = [
  { toolCalls: [{ name: 'add_note', input: { note } }] },
  { toolCalls: [{ name: 'search_notes', input: { query: 'ferry' } }] },
  { text: `Found: ${note}` }
];

const { values } = parseArgs({ options: {
  project: { type: 'string' }, data: { type: 'string' },
  history: { type: 'string' }, 'history-token': { type: 'string' },
  environment: { type: 'string' }, 'environment-token': { type: 'string' },
  tools: { type: 'string' }, model: { type: 'string', default: 'scripted/script' },
  'claude-sidecar': { type: 'string' }, 'pause-after-write': { type: 'boolean' },
  reopen: { type: 'string' }
} });

async function run() {
  const { project, data, history, environment, tools, model, reopen } = values;
  const historyToken = values['history-token'];
  const environmentToken = values['environment-token'];
  if (!project || !data || !history || !historyToken || !environment || !environmentToken || !tools || !isAbsolute(tools)) {
    throw Error('Supply the project, data directory, both service URLs and token files, and an absolute tools path.');
  }
  const processPlugins: ProcessPlugin[] = [{
    command: [tools],
    env: values['pause-after-write'] ? { NOTES_DEMO_PAUSE_AFTER_WRITE: '1' } : {}
  }];
  const providers = [];
  const sidecar = values['claude-sidecar'];
  if (model === 'scripted/script') providers.push(scriptedProvider(script));
  else if (model.startsWith('openai/')) providers.push(openai());
  else if (model.startsWith('claude/') && sidecar && isAbsolute(sidecar)) {
    const { HOME, CLAUDE_CONFIG_DIR } = process.env;
    processPlugins.push({ command: ['node', sidecar], env: {
      ...(HOME ? { HOME } : {}),
      ...(CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR } : {})
    } });
  } else throw Error('Choose scripted/script, openai/ID or claude/ID with a sidecar path.');

  const agent = await createAgent({
    project, dataDir: data, model, providers, processPlugins, durability: 'durable',
    history: httpHistory(history, historyToken),
    servicePlugins: [{ url: environment, tokenFile: environmentToken }]
  });
  try {
    if (!agent.declaration().continuesAfterRestart) throw Error('Agent does not declare durable recovery.');
    const session = reopen ? await agent.openSession(reopen) : await agent.session();
    console.log(session.id);
    if (reopen) await session.waitIdle();
    const turn = reopen ? await session.lastTurn() : await session.prompt(prompt);
    if (turn?.outcome?.kind !== 'completed') throw Error('The turn did not complete.');
    console.log(JSON.stringify({
      outcome: turn.outcome.kind, text: turn.text, turnId: turn.turnId,
      tools: turn.toolResults().map(result => ({ name: result.name, status: result.status, text: result.text() }))
    }));
  } finally {
    await agent.close();
  }
}

try {
  await run();
} catch (error) {
  console.error(values.model === 'scripted/script' ? error : 'Could not run the turn for the requested live model.');
  process.exitCode = 1;
}

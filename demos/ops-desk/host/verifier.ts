import { tool } from '@modular-agent/core';
import { scriptedProvider } from '@modular-agent/core/testing';
import { chatgpt } from '@modular-agent/subscription';
import { modelOptions, serveDeskAgent } from './desk-agent.js';

const command = 'python3 -B test_limits.py';
const verifier = scriptedProvider([]);
verifier.request = (model, request, context) => {
  const result = request.messages.find(message => message.role === 'toolResult' && message.toolName === 'exec');
  const text = result?.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('') ?? '';
  const verdict = result?.role === 'toolResult' && !result.isError && /^(PASS|FAIL): /.test(text)
    ? text : 'FAIL: the test command did not return a result';
  return scriptedProvider([
    { toolCalls: [{ name: 'read', input: { path: 'limits.py' } }] },
    { toolCalls: [{ name: 'exec', input: { command } }] },
    { toolCalls: [{ name: 'post', input: { kind: 'verdict', text: verdict } }] },
    { text: 'Verification finished.' }
  ]).request(model, request, context);
};

const read = tool({
  name: 'read', description: 'Read a sample file.', readOnly: true,
  input: {
    type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false
  },
  async run({ path }, ctx) {
    if (!['limits.py', 'test_limits.py', 'cases.json'].includes(path)) return ctx.refuse('Not a sample file.');
    return Buffer.from(await ctx.environment.read(path)).toString('utf8');
  }
});

const list = tool({
  name: 'list', description: 'List the sample files.', readOnly: true,
  input: { type: 'object', properties: {}, additionalProperties: false },
  run: (_, ctx) => ctx.environment.list('.')
});

const exec = tool({
  name: 'exec', description: 'Run the sample tests.',
  input: {
    type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false
  },
  async run(input, ctx) {
    if (input.command !== command) return ctx.refuse('Only the sample test command is allowed.');
    const result = await ctx.environment.exec(command, { timeout: 5000 });
    return (result.exitCode === 0 && !result.timedOut ? 'PASS: ' : 'FAIL: ') + result.output.trim();
  }
});

await serveDeskAgent({
  ...modelOptions('verifier', verifier, logins => chatgpt({ logins }), `
You verify a coder's commit in a separate checkout. Inspect limits.py with read.
Run the tests with exec using exactly this command: ${command}.
Wait for its result. Call post once with kind verdict and text copied exactly from the command result,
including the PASS: or FAIL: prefix. If the command cannot run, post FAIL: and the reason.
The desk routes failures. Finish after posting.
`, 7),
  tools: [read, list, exec]
});

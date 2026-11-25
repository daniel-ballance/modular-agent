import { createAgent, definePlugin, type AgentOptions, type Provider, type Right } from '@modular-agent/core';
import { subscriptionLogins, type SubscriptionLogins } from '@modular-agent/subscription';
import { startTracing, stopTracing } from './trace.js';

export const rights = ['watch', 'input', 'tools', 'approve', 'answer'] satisfies Right[];

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw Error(`Missing ${name}`);
  return value;
}

export async function serveDeskAgent(options: AgentOptions) {
  const project = requiredEnv('DESK_PROJECT');
  const tokenFile = requiredEnv('DESK_TOKEN_FILE');
  startTracing(process.env.OTEL_SERVICE_NAME);
  try {
    const agent = await createAgent({
      ...options, project, dataDir: requiredEnv('MODULAR_AGENT_DATA_DIR'), durability: 'durable', pluginHost: true
    });
    try {
      const server = await agent.serveAgui({
        listen: '127.0.0.1:0',
        actors: [{
          tokenFile, clientId: 'ops-desk', projects: [project], traceTrusted: true,
          actor: { id: 'desk', kind: 'user', rights }
        }],
        resumeOpen: true,
        onResumeOpen: (id, status) => console.error(`resume-open: ${status} ${id}`)
      });
      await new Promise<void>(resolve => {
        const stop = () => {
          process.removeListener('SIGINT', stop);
          process.removeListener('SIGTERM', stop);
          resolve();
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        console.log(server.url);
      });
    } finally {
      await agent.close();
    }
  } finally {
    await stopTracing();
  }
}

export function modelOptions(
  role: string, scripted: Provider, live: (logins: SubscriptionLogins) => Provider, system: string, maxSteps: number
): AgentOptions {
  const model = process.env.DESK_MODEL;
  if (!model) return { model: 'scripted/script', providers: [scripted] };
  const provider = live(subscriptionLogins(requiredEnv('DESK_LOGINS')));
  const prompt = definePlugin({
    name: role + '-prompt',
    setup(reg) { reg.on('turn.before', () => ({ add: { system } })); }
  });
  return { model, providers: [provider], plugins: [prompt], settings: { reasoning: 'low', maxSteps, maxOutput: 2048 } };
}

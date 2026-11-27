// A process plugin that never starts Claude Code or makes a network request.
const lines = require('node:readline').createInterface({ input: process.stdin });
const model = (id) => ({ provider: 'claude', id, contextWindow: 1000000, maxOutput: 128000, thinking: ['low', 'high'] });
const pending = new Map();
let next = 0;
const send = (obj) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...obj })}\n`);
function hostHook(parentRequestId, hook, payload) {
    const id = `fixture-${++next}`;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ id, method: 'host/hook', params: { parentRequestId, hook, payload } });
    });
}
async function answer(id, method, p) {
    switch (method) {
        case 'plugin/initialize':
            return { binding: p.binding, name: 'fake-claude', providers: [{ id: 'claude', supports: {}, models: [model('claude-haiku-5-5'), model('claude-sonnet-5-5')] }] };
        case 'provider/models': return { models: [model('claude-haiku-5-5')] };
        case 'provider/available':
            if (p.provider !== 'claude') throw new Error('expected the Claude Provider id');
            if (process.argv[2] === 'hang') return new Promise(() => {});
            if (process.argv[2] === 'unavailable') return { available: false, reason: process.argv[3] };
            if (process.argv[2] === 'api-key') {
                return { available: false, reason: 'The fixture is using an API key from ANTHROPIC_API_KEY, not a Claude plan.' };
            }
            return { available: true };
        case 'provider/request': {
            const scope = { sessionId: p.sessionId, provider: p.provider, model: p.model };
            const { request } = await hostHook(id, 'provider.request', { ...scope, request: p.request });
            if (!request.tools?.some(tool => tool.name === 'tide') || !request.systemPrompt?.includes('Host prompt.')) {
                throw new Error('expected the host prompt and tide tool');
            }
            send({ method: 'provider/event', params: { parentRequestId: id, event: { type: 'reasoning', delta: 'Check the tide.' } } });
            const follow = request.messages.some(message => message.role === 'toolResult');
            if (follow) send({ method: 'provider/event', params: { parentRequestId: id, event: { type: 'text', delta: '14:02' } } });
            const message = {
                role: 'assistant', stop: follow ? 'finished' : 'toolUse', model: p.model,
                content: follow ? [{ type: 'text', text: '14:02' }] : [{ type: 'toolCall', id: 'call-tide', name: 'tide', arguments: { harbour: 'Whitby' } }],
            };
            await hostHook(id, 'provider.response', { ...scope, message });
            return message;
        }
        case 'provider/discard':
        case 'plugin/shutdown': return {};
        default: throw new Error(`unexpected method ${method}`);
    }
}
lines.on('line', async (line) => {
    const { id, method, params, result, error } = JSON.parse(line);
    if (!method) {
        const waiter = pending.get(id);
        pending.delete(id);
        if (error) waiter.reject(new Error(error.message));
        else waiter.resolve(result);
    } else if (id !== undefined) {
        try { send({ id, result: await answer(id, method, params) }); }
        catch (e) { send({ id, error: { code: -32603, message: e.message } }); }
    }
});

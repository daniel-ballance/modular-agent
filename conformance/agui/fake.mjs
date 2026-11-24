// This peer exercises the kit, not the Harness. It does not implement an SDK.
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { disposableTls } from './tls-fixture.mjs';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { dispatch, offer, simple, transformed } from './cases.mjs';
import { MAX, PATH, parse } from './wire.mjs';
import { fakeFixture, makeSession } from './fake-fixture.mjs';
import { fakeWaiting } from './fake-waiting.mjs';
import { fakeClosures } from './fake-closures.mjs';
import { fakeReceipts } from './fake-receipts.mjs';

export const fixtureTokens = () => Object.fromEntries(['owner', 'rotated', 'watch', 'sibling', 'foreign', 'tenant', 'project'].map(key => [key, randomUUID()]));

const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const error = (res, status, code) => json(res, status, { code });
const conflict = res => error(res, 409, 'conflict');
const invalid = res => error(res, 400, 'invalid_request');
const forbidden = res => error(res, 403, 'refused');
const missing = res => error(res, 404, 'not_found');
const event = (type, rest) => ({ type, ...rest });
const content = message => typeof message.content === 'string' ? message.content : message.content?.filter(p => p.type === 'text').map(p => p.text).join('') ?? '';
const equal = (a, b) => (a === b) || (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b) &&
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => Object.hasOwn(b, k) && equal(a[k], b[k])));
const known = message => Object.fromEntries(Object.entries(message).filter(([key]) => ['role', 'id', 'content', 'name', 'toolCallId', 'toolCalls', 'error'].includes(key)));

export async function fake({ model = simple, tokens = fixtureTokens(), fault, scenario } = {}) {
  const sessions = new Map(), pages = new Map();
  let clock = Date.now();
  const waits = scenario?.startsWith('waiting-');
  const covers = (waits || scenario?.startsWith('approval')) && fault !== 'no-covered-approvals';
  const fixture = scenario?.startsWith('receipt-') ? fakeReceipts(scenario, fault) : scenario?.startsWith('closure-') ? fakeClosures(scenario, fault, model) : waits ? fakeWaiting(scenario, fault, model, covers) : scenario && fakeFixture(scenario, fault, model, covers);
  const declaration = { interfaceTools: true, telemetry: 1, ...(covers && { approvalCoversNested: true }), ...(waits && { approvalsOutlastTurns: true, portableSessions: true, questionsOutlastTurns: true, lateAnswersStartTurns: true }) };
  const sockets = new WebSocketServer({ noServer: true, handleProtocols: protocols => protocols.has('modular-agent-acp-1') ? 'modular-agent-acp-1' : false });
  const peer = request => Object.keys(tokens).find(key => request.headers.authorization === `Bearer ${tokens[key]}`);
  const tls = scenario === 'tls' ? await disposableTls() : undefined;
  const listenHttp = tls ? handler => createSecureServer(tls.server, handler) : createServer;
  const server = listenHttp(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://test.invalid');
      const auth = peer(req);
      if (!auth && !(['anonymous', 'tls-client-only'].includes(fault) && url.pathname === PATH)) return error(res, 401, 'unauthenticated');
      const client = auth === 'rotated' ? 'owner' : auth;
      const path = url.pathname.slice(PATH.length);
      if (req.method === 'GET' && path === '') {
        if (scenario === 'error-gate') return error(res, 403, 'output_withheld');
        return json(res, 200, { binding: 'modular-agent-agui/1', protocolVersion: '1.0', declaration });
      }
      if (path === '/threads' && req.method === 'GET') {
        const raw = url.searchParams.get('limit') ?? '100', limit = Number(raw);
        if (!/^\d+$/.test(raw) || limit < 1 || limit > 500) return invalid(res);
        const cursor = pages.get(url.searchParams.get('after'));
        if (url.searchParams.has('after') && cursor?.client !== client && fault !== 'unknown-page') return invalid(res);
        const threads = [...sessions.values()].filter(s => (s.messages.length || fault === 'list-provisional') &&
          (!['tenant', 'project'].includes(client) || fault === 'list-scope')).map(s => ({
          threadId:s.threadId, updatedAt:new Date(s.updated ?? s.now).toISOString(),
          waiting:fixture?.waiting(s, client) ?? { questions:0, toolCalls:Number(!!s.open && (client === 'owner' || fault === 'list-foreign-call')), turn:'none' },
          ...(fault === 'list-content' && { messages:s.messages }),
        })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.threadId.localeCompare(b.threadId));
        if (fault === 'reverse-list') threads.reverse();
        const i = fault === 'repeat-page' ? 0 : cursor?.index ?? 0, page = threads.slice(i, i + limit);
        const next = i + limit < threads.length && randomUUID();
        if (next) pages.set(next, {client, index:i + limit});
        return json(res, 200, { threads:page, ...(next && {next}) });
      }
      let data;
      if (req.method === 'POST') {
        if (req.headers['content-type'] !== 'application/json') return invalid(res);
        if (Number(req.headers['content-length']) > MAX) { req.resume(); return error(res, 413, 'result_too_large'); }
        let size = 0;
        const parts = [];
        for await (const bytes of req) {
          size += bytes.length;
          if (size > MAX) { req.resume(); return error(res, 413, 'result_too_large'); }
          parts.push(bytes);
        }
        try {
          const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(parts));
          data = fault === 'duplicate-member' ? JSON.parse(raw) : parse(raw);
        } catch { return invalid(res); }
        if (!data || typeof data !== 'object' || Array.isArray(data)) return invalid(res);
      }
      if (path === '/threads' && req.method === 'POST') {
        if (Object.keys(data).length) return invalid(res);
        if (client === 'watch') return forbidden(res);
        const threadId = randomUUID();
        sessions.set(threadId, { ...makeSession(), threadId, messages: [], views: new Map(), runs: new Set(), presence: new Set() });
        return json(res, 201, { threadId, declaration });
      }
      const threadId = path === '/run' ? data?.threadId : /^\/threads\/([^/]+)(?:\/(?:presence|wait-closures|run-receipt))?$/.exec(path)?.[1];
      const session = sessions.get(threadId);
      if (!session || (['tenant', 'project'].includes(client) && fault !== 'outside-scope' && !(fault === 'tenant-receipt' && path.endsWith('/run-receipt')))) return missing(res);
      if (req.method === 'GET' && path.endsWith('/run-receipt')) return fixture?.receipt ? fixture.receipt(session, client, url, res, json, error) : missing(res);
      fixture?.reopen(session);
      const snapshot = () => {
        const messages = structuredClone(session.messages);
        const cursor = randomUUID();
        const lastMessageId = messages.at(-1)?.id ?? null;
        session.views.set(client, { cursor, messages });
        return { messages, cursor, lastMessageId };
      };
      const sseHeaders = () => res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      if (req.method === 'GET' && path.endsWith('/wait-closures')) return fixture?.feed ? fixture.feed(session, client, url, res, error) : missing(res);
      if (req.method === 'GET' && path.endsWith('/presence')) {
        if (session.presence.has(client)) return conflict(res);
        session.presence.add(client); sseHeaders(); res.write(': presence\n\n');
        const interval = setInterval(() => res.write(': presence\n\n'), 3000);
        res.on('close', () => { session.presence.delete(client); clearInterval(interval); fixture?.disconnect(session, client); });
        return;
      }
      if (req.method === 'GET') {
        const toolCalls = session.open && (client === 'owner' || fault === 'foreign-wait') ? [{ toolCallId: session.open, expiresAt: session.expiresAt,
          ...(fault === 'snapshot-args' ? { args: dispatch } : {}) }] : [];
        if (scenario === 'output-size' && client === 'sibling') return error(res, 413, 'result_too_large');
        if (scenario === 'state-and-gate' && client === 'sibling') return error(res, 403, 'output_withheld');
        if (fault === 'keep-presence' && scenario === 'approval-lost' && client === 'owner') return json(res, 200, { threadId, declaration, ...snapshot(), waiting: { questions: [session.question], toolCalls } });
        if (fault === 'wait-snapshot-tool' && session.question) toolCalls.push({ toolCallId: session.question.toolCallId, expiresAt: session.question.expiresAt });
        const questions = fixture?.questions?.(session, client) ?? (fixture?.eligible(session, client) ? [session.question] : []);
        return json(res, 200, { threadId, declaration, ...snapshot(), ...fixture?.snapshot?.(session, client), waiting: { questions, toolCalls } });
      }
      if (req.method !== 'POST' || path !== '/run') return missing(res);
      const { protocolVersion, runId, messages, tools = [], context = [], resume = [] } = data;
      if (typeof protocolVersion !== 'string' || typeof runId !== 'string' || !runId || !Array.isArray(messages) || !Array.isArray(tools) || !Array.isArray(context) ||
          !Array.isArray(resume) || resume.some(r => typeof r?.interruptId !== 'string')) return invalid(res);
      const version = /^(\d+)\.(\d+)$/.exec(protocolVersion);
      if (version && version[1] !== '1') return error(res, 400, 'not_supported');
      if (tools.some(t => typeof t?.name !== 'string' || typeof t.description !== 'string')) return invalid(res);
      if (tools.length > 1 || tools.some(t => !equal({ name: t.name, description: t.description, parameters: t.parameters ?? {} }, offer))) return forbidden(res);
      const last = session.views.get(client) ?? { messages: [] };
      const cursor = req.headers['ma-history-cursor'];
      const found = session.runs.has(`${client}:${runId}`);
      if ((cursor !== undefined && cursor !== last.cursor && fault !== 'stale-cursor') || (found && fault !== 'duplicate-run' && !fixture?.duplicate?.(session, data)) ||
          (!equal(messages.slice(0, last.messages.length).map(known), last.messages) && fault !== 'changed-history')) return conflict(res);
      const suffix = messages.slice(last.messages.length);
      if (session.invalidated && messages.some(m => m.id?.startsWith('ma:'))) return conflict(res);
      if (fixture) {
        const events = [event('RUN_STARTED', { threadId, runId, protocolVersion: '1.0' })];
        const push = (type, value) => events.push(event(type, value));
        const emit = () => {
          const { messages, ...value } = snapshot();
          push('MESSAGES_SNAPSHOT', { messages });
          push('CUSTOM', { name: 'modular-agent.history', value });
        };
        if (client === 'watch') return forbidden(res);
        const finish = outcome => push('RUN_FINISHED', { threadId, runId, outcome });
        const rejected = await fixture.run({ s: session, suffix, resume, data, offered: Boolean(tools.length), headers: req.headers, client, push, emit, finish, response: res });
        if (rejected) {
          if (rejected[0] !== -1) return error(res, ...rejected);
          return;
        }
        session.runs.add(`${client}:${runId}`);
        sseHeaders();
        if (scenario === 'output-size' && fault === 'oversized-event') {
          res.write('data: {"type":"CUSTOM","name":"modular-agent.event","value":"');
          const chunk = Buffer.alloc(1024 * 1024, 120);
          for (let i = 0; i < 64; i++) {
            if (res.destroyed) return;
            if (!res.write(chunk)) {
              const signaled = await new Promise(resolve => {
                function done(writable) { res.off('close', closed); res.off('drain', drained); resolve(writable); }
                const closed = () => done(false), drained = () => done(true);
                res.once('close', closed); res.once('drain', drained);
              });
              if (!signaled) return;
            }
          }
          return res.end('"}\n\n');
        }
        return res.end(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''));
      }
      if (!suffix.length && resume.length) return conflict(res);
      if (!suffix.length || suffix.some(m => !['user', 'tool'].includes(m?.role) || typeof m.id !== 'string' || m.id.startsWith('ma:'))) return invalid(res);
      if (client === 'watch') return forbidden(res);
      const modelResponse = model[session.messages.filter(m => m.role === 'assistant').length];
      const isReport = suffix[0].role === 'tool';
      if (isReport) {
        if (client !== 'owner' || !session.open || suffix.length !== 1 || suffix[0].toolCallId !== session.open) return conflict(res);
      } else if (suffix.length !== 1 || session.open || resume.length) return invalid(res);
      session.runs.add(`${client}:${runId}`);
      const events = [event('RUN_STARTED', { threadId, runId, protocolVersion: '1.0', ...(fault === 'echo-input' ? { input: data } : {}) })];
      const push = (type, value) => events.push(event(type, value));
      const emitSnapshot = () => {
        const { messages: copy, cursor: next, lastMessageId } = snapshot();
        push('MESSAGES_SNAPSHOT', { messages: copy });
        push('CUSTOM', { name: 'modular-agent.history', value: { cursor: next, lastMessageId } });
      };
      session.updated = ++clock;
      if (isReport) {
        const report = suffix[0];
        session.messages.push({ id: 'ma:tool:' + session.open, role: 'tool', toolCallId: session.open,
          content: report.error ?? (fault === 'skip-tool-after' ? content(report) : transformed), ...(report.error !== undefined ? { error: report.error } : {}) });
        session.open = undefined;
      } else {
        session.messages.push({ id: 'ma:user:' + randomUUID(), role: 'user', content: content(suffix[0]) });
      }
      emitSnapshot();
      const stepName = randomUUID();
      const messageId = 'ma:assistant:' + stepName;
      push('STEP_STARTED', { stepName });
      const turn = modelResponse ?? { text: 'script exhausted' };
      const message = { id: messageId, role: 'assistant', content: turn.text ?? '' };
      session.messages.push(message);
      if (turn.text) {
        push('TEXT_MESSAGE_START', { messageId, role: 'assistant' });
        push('TEXT_MESSAGE_CONTENT', { messageId, delta: turn.text });
        if (fault !== 'unbalanced') push('TEXT_MESSAGE_END', { messageId });
      }
      push('STEP_FINISHED', { stepName });
      let pendingToolCallIds;
      if (turn.toolCalls && tools.length) {
        const toolCallId = session.open = randomUUID();
        session.expiresAt = new Date(Date.now() + 60_000).toISOString();
        push('CUSTOM', { name: 'modular-agent.event', value: { type: 'toolRequested', data: { toolCallId } } });
        push('TOOL_CALL_START', { toolCallId, toolCallName: offer.name, parentMessageId: messageId });
        push('TOOL_CALL_ARGS', { toolCallId, delta: JSON.stringify(fault === 'draft' ? turn.toolCalls[0].input : dispatch) });
        push('TOOL_CALL_END', { toolCallId });
        pendingToolCallIds = fault === 'pending-ids' ? [] : [toolCallId];
      }
      emitSnapshot();
      push('RUN_FINISHED', { threadId, runId, outcome: { type: 'success', ...(pendingToolCallIds === undefined ? {} : { pendingToolCallIds }) } });
      sseHeaders();
      if (fault === 'sse-id') res.write('id: forbidden\n');
      res.end(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''));
    } catch (cause) { res.destroy(cause); }
  });
  server.on('upgrade', (request, socket, head) => {
    if (!peer(request)) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    sockets.handleUpgrade(request, socket, head, ws => {
      ws.on('message', bytes => {
        const msg = JSON.parse(bytes);
        const result = msg.method === '$/ping' ? {} : fixture?.acp?.(ws, peer(request), msg, sessions);
        if (result !== undefined) ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      });
    });
  });
  async function listen() {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  }
  async function close() {
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const ws of sockets.clients) ws.terminate();
    server.closeAllConnections();
    await closed;
  }
  await listen();
  return {
    get origin() { return `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`; }, tokens,
    async control(operation, args) {
      if (operation === 'tls' && tls) return tls.client;
      const session = sessions.get(args.threadId);
      if (!fixture || !session) throw new Error('fixture session unavailable');
      return fixture.control(operation, session, args);
    },
    async restart() {
      await close();
      pages.clear();
      await fixture.restart(sessions);
      await listen();
    },
    close,
  };
}
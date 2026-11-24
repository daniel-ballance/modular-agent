import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HttpAgent } from '@ag-ui/client';
import { EventSchema, MessageSchema } from '@ag-ui/core/schemas';

export const MAX = 64 * 1024 * 1024;
export const VERSION = '1.0';
export const PATH = '/agui/v1';
export const deadline = () => AbortSignal.timeout(20_000);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const user = content => ({ role: 'user', id: randomUUID(), content });
export const tool = (toolCallId, content, error) => ({ role: 'tool', id: randomUUID(), toolCallId, content, ...(error === undefined ? {} : { error }) });
export const input = (view, suffix = [], extra = {}) => ({
  protocolVersion: VERSION, threadId: view.threadId, runId: randomUUID(),
  messages: [...view.messages, ...suffix], tools: [], context: [], state: {}, forwardedProps: {}, ...extra,
});

export function responseType(response, type) {
  assert.equal(response.headers.get('content-type')?.split(';')[0].trim(), type, 'Content-Type');
  assert.match(response.headers.get('cache-control') ?? '', /\bno-(store|cache)\b/, 'response must not be cached');
  for (const key of ['traceparent', 'tracestate', 'baggage', 'set-cookie']) {
    assert.equal(response.headers.has(key), false, `unexpected response header: ${key}`);
  }
}

export function at(origin, token) {
  const request = (path, { method = 'GET', body, headers, signal = deadline(), auth = token } = {}) => fetch(new URL(PATH + path, origin), {
    method, redirect: 'error', signal, body,
    headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
  });
  return {
    request,
    async list(query = '') {
      const page = await json(await request('/threads' + query));
      assert.deepEqual(Object.keys(page).sort(), page.next === undefined ? ['threads'] : ['next', 'threads'], 'listing envelope has no content');
      if ('next' in page) assert.ok(typeof page.next === 'string' && page.next.length, 'opaque next cursor');
      assert.ok(Array.isArray(page.threads), 'threads array');
      for (const row of page.threads) {
        assert.deepEqual(Object.keys(row).sort(), ['threadId', 'updatedAt', 'waiting'], 'thread metadata only');
        assert.ok(typeof row.threadId === 'string' && row.threadId.length, 'listed thread ID');
        assert.ok(typeof row.updatedAt === 'string' && /^\d{4}-\d\d-\d\dT/.test(row.updatedAt) && Number.isFinite(Date.parse(row.updatedAt)), 'ISO 8601 change time');
        assert.deepEqual(Object.keys(row.waiting).sort(), ['questions', 'toolCalls', 'turn'], 'waiting summary has no content');
        for (const key of ['questions', 'toolCalls']) assert.ok(Number.isSafeInteger(row.waiting[key]) && row.waiting[key] >= 0, 'waiting count');
        assert.ok(['none', 'interrupted', 'running'].includes(row.waiting.turn), 'turn state');
      }
      return page;
    },
    async create() {
      const value = await json(await request('/threads', { method: 'POST', body: '{}' }), 201);
      assert.ok(typeof value.threadId === 'string' && value.threadId, 'new thread ID');
      assert.ok(object(value.declaration), 'new thread declaration');
      return value;
    },
    async view(threadId, options) {
      const view = await json(await request(threadPath(threadId), options));
      assert.equal(view.threadId, threadId, 'snapshot thread ID');
      assert.ok(object(view.declaration), 'snapshot declaration');
      history(view.messages, view);
      assert.ok(Array.isArray(view.waiting?.questions) && Array.isArray(view.waiting?.toolCalls), 'snapshot waiting lists');
      for (const call of view.waiting.toolCalls) {
        assert.deepEqual(Object.keys(call).sort(), ['expiresAt', 'toolCallId'], 'pending call snapshot contains only identity and expiry');
        assert.ok(typeof call.toolCallId === 'string' && Number.isFinite(Date.parse(call.expiresAt)), 'pending call identity and expiry');
      }
      return view;
    },
    post(run, { cursor, raw, ...options } = {}) {
      return request('/run', { method: 'POST', body: raw ?? JSON.stringify(run), ...options,
        headers: { Accept: 'text/event-stream', ...(cursor === undefined ? {} : { 'MA-History-Cursor': cursor }), ...options.headers } });
    },
    async run(run, options) { return exchange(await this.post(run, options), run); },
    async presence(threadId) {
      const stop = new AbortController();
      try {
        const response = await request(threadPath(threadId) + '/presence', { signal: AbortSignal.any([stop.signal, deadline()]) });
        assert.equal(response.status, 200, 'presence status');
        responseType(response, 'text/event-stream');
        const frames = sse(response);
        const first = await frames.next();
        assert.ok(!first.done && first.value.comment, 'presence must emit only SSE comments');
        return { frames, close: async () => { stop.abort(); await frames.return(); } };
      } catch (error) { stop.abort(); throw error; }
    },
    stock(threadId) { return new HttpAgent({ threadId, url: new URL(PATH + '/run', origin).href, headers: { Authorization: `Bearer ${token}` } }); },
  };
}
export const threadPath = id => '/threads/' + encodeURIComponent(id);

export async function json(response, status = 200) {
  assert.equal(response.status, status, `HTTP status for ${new URL(response.url).pathname}`);
  responseType(response, 'application/json');
  const bytes = await response.arrayBuffer();
  assert.ok(bytes.byteLength <= MAX, 'JSON response exceeds 64 MiB');
  const value = parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  assert.ok(object(value), 'JSON object reply');
  return value;
}

// JSON.parse alone silently accepts duplicate members. Scan tokens after parsing,
// comparing decoded keys separately for each object (including escaped names).
export function parse(raw) {
  const value = JSON.parse(raw);
  const stack = [];
  const tokens = /"(?:[^"\\]|\\.)*"\s*:?|[{}\[\]]/gs;
  for (const match of raw.matchAll(tokens)) {
    const token = match[0];
    if (token === '{' || token === '[') stack.push(token === '{' ? new Set() : null);
    else if (token === '}' || token === ']') stack.pop();
    else {
      const key = token.endsWith(':');
      const decoded = JSON.parse(key ? token.slice(0, -1) : token);
      assert.ok(decoded.isWellFormed(), 'unpaired surrogate in JSON');
      if (key) {
        const keys = stack.at(-1);
        assert.ok(!keys.has(decoded), 'duplicate JSON member');
        keys.add(decoded);
      }
    }
  }
  return value;
}

export async function refused(response, status, ...codes) {
  const error = await json(response, status);
  assert.deepEqual(Object.keys(error), ['code'], 'HTTP error is content-free');
  assert.ok(codes.includes(error.code), `expected ${codes.join(' or ')}, got ${error.code}`);
}

// Validate framing before JSON decoding. Chunk boundaries can fall anywhere.
export async function* sse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let parts = [], size = 0, ended = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { ended = true; break; }
      const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      let start = 0;
      for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
        const segment = bytes.subarray(start, end);
        start = end + 1;
        if (size === 0 && segment.length === 0) continue;
        if (size < 0) {
          assert.equal(segment.length, 0, 'SSE data line must end with LF LF');
          size = 0;
          continue;
        }
        parts.push(segment);
        assert.ok(size + segment.length <= MAX + 6, 'encoded SSE event exceeds 64 MiB');
        const line = decoder.decode(Buffer.concat(parts));
        parts = [];
        if (line.startsWith(':')) { size = 0; yield { comment: true, text: line.slice(1) }; }
        else {
          assert.ok(line.startsWith('data: '), 'only SSE comments and data lines are allowed (no SSE id)');
          const data = parse(line.slice(6));
          assert.ok(object(data), 'one JSON object per SSE data line');
          size = -1;
          yield { data };
        }
      }
      if (start < bytes.length) {
        assert.notEqual(size, -1, 'SSE data line must end with LF LF');
        const tail = bytes.subarray(start);
        size += tail.length;
        assert.ok(size <= MAX + 6, 'encoded SSE event exceeds 64 MiB');
        parts.push(tail);
      }
    }
    assert.equal(size, 0, 'truncated SSE frame');
  } finally {
    if (!ended) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function history(messages, { cursor, lastMessageId }) {
  assert.ok(Array.isArray(messages), 'messages array');
  const ids = messages.map(message => {
    assert.ok(MessageSchema.safeParse(message).success, 'message matches the AG-UI 1.0 schema');
    assert.ok(['user', 'assistant', 'tool'].includes(message.role), 'only committed conversation roles');
    assert.match(message.id, /^ma:.+$/, 'stable ma: message ID');
    return message.id;
  });
  assert.equal(new Set(ids).size, ids.length, 'duplicate message ID');
  assert.equal(lastMessageId, ids.at(-1) ?? null, 'last message boundary');
  assert.ok(typeof cursor === 'string' && cursor.length, 'snapshot cursor');
}

const sequences = {
  STEP: 'stepName', TEXT_MESSAGE: 'messageId', REASONING_MESSAGE: 'messageId', TOOL_CALL: 'toolCallId',
};

export async function exchange(response, { threadId, runId }) {
  assert.equal(response.status, 200, 'run HTTP status');
  responseType(response, 'text/event-stream');
  const events = [];
  for await (const frame of sse(response)) if (frame.data) events.push(frame.data);
  const start = events[0], terminal = events.at(-1);
  assert.equal(start?.type, 'RUN_STARTED', 'run starts after admission');
  assert.equal(start.protocolVersion, VERSION, 'server AG-UI version');
  for (const key of ['parentRunId', 'input']) assert.ok(!(key in start), `RUN_STARTED must omit ${key}`);
  assert.ok(['RUN_FINISHED', 'RUN_ERROR'].includes(terminal?.type), 'run has a terminal event');
  for (const boundary of [start, ...(terminal.type === 'RUN_FINISHED' ? [terminal] : [])]) {
    assert.equal(boundary.threadId, threadId, 'boundary thread ID');
    assert.equal(boundary.runId, runId, 'boundary run ID');
  }
  let view;
  const open = new Set();
  const calls = new Map();
  const texts = new Map();
  for (const [i, event] of events.entries()) {
    const { type } = event;
    assert.ok(EventSchema.safeParse(event).success, 'event matches the AG-UI 1.0 schema');
    assert.ok(i === 0 || type !== 'RUN_STARTED', 'duplicate RUN_STARTED');
    assert.ok(i === events.length - 1 || !['RUN_FINISHED', 'RUN_ERROR'].includes(type), 'event after terminal');
    assert.ok(!/^(ACTIVITY|SUBAGENT)_|^REASONING_ENCRYPTED_VALUE$/.test(type), 'event outside the binding projection');
    const sequence = Object.keys(sequences).find(key => type.startsWith(key + '_'));
    if (sequence) {
      const id = event[sequences[sequence]];
      const action = type.slice(sequence.length + 1);
      assert.ok(typeof id === 'string' && id, `identity for ${type}`);
      const key = sequence + ':' + id;
      if (action === 'START' || action === 'STARTED') {
        assert.ok(!open.has(key), `duplicate ${sequence} start`);
        open.add(key);
        if (sequence === 'TEXT_MESSAGE') {
          assert.equal(event.role, 'assistant', 'text role');
          assert.match(id, /^ma:/, 'streamed assistant ID');
          assert.ok(!texts.has(id), 'assistant text replayed');
          texts.set(id, '');
        } else if (sequence === 'REASONING_MESSAGE') assert.equal(event.role, 'reasoning', 'reasoning role');
        else if (sequence === 'TOOL_CALL') {
          assert.ok(!calls.has(id), 'tool call replayed in one exchange');
          calls.set(id, { id, start: event, args: '', end: -1 });
        }
      } else if (action === 'RESULT') {
        const call = calls.get(id);
        assert.ok(call?.end === i - 1 && !call.result, 'server tool result must close its contiguous group');
        assert.ok(!('error' in event), 'TOOL_CALL_RESULT has no error field');
        call.result = event;
      } else {
        assert.ok(open.has(key), `${type} without matching start`);
        if (action === 'END' || action === 'FINISHED') open.delete(key);
        if (type === 'TEXT_MESSAGE_CONTENT') texts.set(id, texts.get(id) + event.delta);
        if (type === 'TOOL_CALL_ARGS') calls.get(id).args += event.delta;
        if (type === 'TOOL_CALL_END') {
          const call = calls.get(id);
          call.end = i;
          assert.ok(object(parse(call.args)), 'tool argument deltas encode an object');
        }
      }
    }
    if (type === 'REASONING_START') { assert.ok(!open.has('reasoning')); open.add('reasoning'); }
    if (type === 'REASONING_END') assert.ok(open.delete('reasoning'), 'reasoning end without start');
    if (type === 'MESSAGES_SNAPSHOT') {
      const cursor = events[i + 1];
      assert.equal(cursor?.type, 'CUSTOM', 'cursor follows snapshot');
      assert.equal(cursor.name, 'modular-agent.history', 'cursor extension name');
      history(event.messages, cursor.value);
      view = { threadId, messages: event.messages, ...cursor.value };
    }
    if (type === 'CUSTOM' && event.name === 'modular-agent.history') assert.equal(events[i - 1]?.type, 'MESSAGES_SNAPSHOT', 'cursor without snapshot');
  }
  const pending = [...calls.values()].filter(call => !call.result);
  if (terminal.type === 'RUN_FINISHED') {
    assert.equal(open.size, 0, 'successful terminal leaves an open sequence');
    assert.ok(['success', 'interrupt', 'cancelled'].includes(terminal.outcome?.type), 'explicit run outcome');
    if (terminal.outcome.type === 'success') assert.deepEqual(terminal.outcome.pendingToolCallIds ?? [], pending.map(call => call.id), 'only terminal pending IDs authorize executable handoffs');
    if (terminal.outcome.type === 'cancelled') assert.equal(pending.length, 0, 'cancelled run cannot release a handoff');
  }
  return { events, terminal, pending, calls, texts, view };
}

export function finalView(run) {
  assert.equal(run.events.at(-3)?.type, 'MESSAGES_SNAPSHOT', 'final snapshot at run end');
  return run.view;
}
export function clean(value, ...sentinels) {
  const wire = JSON.stringify(value);
  for (const forbidden of ['"traceparent"', '"tracestate"', '"baggage"', 'modular-agent.interfaceHandoff', '"traceContext"', ...sentinels]) {
    assert.ok(!wire.includes(forbidden), 'private field or fixture sentinel escaped');
  }
}
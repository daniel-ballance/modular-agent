import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentEvent, Harness, HistoryEntry } from "@modular-agent/harness";
import { httpInterface } from "@modular-agent/interface-http";
import { environmentHttp, historyHttp, HttpHistoryStore, providerHttp } from "@modular-agent/services";
import { createAgent } from "../src/index.js";
import type { Scripted } from "./fixtures/faux-provider.js";

// ---------- the services, each a process of its own ----------

const serveJs = fileURLToPath(import.meta.resolve("@modular-agent/services").replace(/index\.js$/, "serve.js"));
const token = () => randomBytes(16).toString("hex");
const services: ChildProcess[] = [];

async function startService(kind: string, settings: Record<string, unknown>): Promise<{ url: string; token: string }> {
	const t = token();
	const child = spawn(process.execPath, [serveJs, kind, JSON.stringify({ ...settings, token: t })], { stdio: ["ignore", "pipe", "inherit"] });
	services.push(child);
	const url = await new Promise<string>((resolve, reject) => {
		child.stdout!.once("data", (d) => resolve(JSON.parse(String(d).split("\n")[0]).url));
		child.once("exit", (code) => reject(new Error(`${kind} service exited with ${code}`)));
	});
	return { url, token: t };
}

const routes: Record<string, Scripted[]> = {
	"read the note and save it": [{ tool: "read", args: { path: "note.txt" } }, { tool: "bash", args: { command: "echo from-sandbox | tee out.txt" } }, { text: "Saved." }],
	"sleep a long time": [{ tool: "bash", args: { command: "sleep 30; echo late > late.txt" } }, { text: "never" }],
	"say hello": [{ text: "hello" }],
	"say goodbye": [{ text: "goodbye" }],
};

let project: string;
let history: { url: string; token: string };
// A lease far shorter than the service default, only for the test of lease expiry. Ordinary turns
// use the default: against an 800 ms lease, scheduling delay alone makes a healthy writer lose it.
let shortLease: { url: string; token: string };
let flakyHistory: { url: string; token: string };
let historyDir: string;
let flakyDir: string;
let environment: { url: string; token: string };
let gateway: { url: string; token: string };

before(async () => {
	project = mkdtempSync(join(tmpdir(), "ma-svc-project-"));
	writeFileSync(join(project, "note.txt"), "a note in the sandbox");
	historyDir = mkdtempSync(join(tmpdir(), "ma-svc-history-"));
	flakyDir = mkdtempSync(join(tmpdir(), "ma-svc-flaky-"));
	[history, shortLease, flakyHistory, environment, gateway] = await Promise.all([
		startService("history", { dir: historyDir }),
		startService("history", { dir: mkdtempSync(join(tmpdir(), "ma-svc-short-")), leaseMs: 800 }),
		startService("history", { dir: flakyDir, dropAppendResponses: 3 }),
		startService("environment", { root: project, runDir: mkdtempSync(join(tmpdir(), "ma-svc-run-")) }),
		startService("provider", { models: { module: new URL("./fixtures/scripted-models.js", import.meta.url).href, export: "scriptedModels", options: { routes } } }),
	]);
});
const agents: Harness[] = [];
after(async () => {
	await Promise.all(agents.map((h) => h.stop().catch(() => undefined)));
	services.forEach((s) => s.kill("SIGTERM"));
});

// ---------- an agent that uses them, served over HTTP ----------

async function agent(options: { history?: { url: string; token: string }; store?: HttpHistoryStore } = {}): Promise<{ h: Harness; url: string; token: string; home: string }> {
	const home = mkdtempSync(join(tmpdir(), "ma-svc-home-"));
	const t = token();
	const web = httpInterface({ token: t });
	const h = await createAgent({ project, home, model: "faux/faux-1", plugins: [historyHttp(options.history ?? history, options.store), environmentHttp(environment), providerHttp(gateway), web] });
	agents.push(h);
	return { h, url: web.http!.url, token: t, home };
}

async function http<T = any>(a: { url: string; token: string }, method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(a.url + path, { method, headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	const json = (await res.json()) as { error?: string };
	if (!res.ok) throw new Error(`${res.status}: ${json.error}`);
	return json as T;
}

/** Follow a session's events over SSE, as a browser would. */
function events(a: { url: string; token: string }, sessionId: string, lastEventId?: string) {
	const seen: (AgentEvent & { eventId?: string })[] = [];
	const abort = new AbortController();
	let wake = () => {};
	let ready!: () => void;
	const following = new Promise<void>(resolve => { ready = resolve; });
	const done = (async () => {
		const res = await fetch(`${a.url}/sessions/${sessionId}/events`, { headers: { authorization: `Bearer ${a.token}`, ...(lastEventId ? { "last-event-id": lastEventId } : {}) }, signal: abort.signal });
		assert.equal(res.status, 200);
		ready();
		let buffer = "";
		for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
			buffer += Buffer.from(chunk).toString("utf8");
			for (let i = buffer.indexOf("\n\n"); i >= 0; i = buffer.indexOf("\n\n")) {
				const block = buffer.slice(0, i);
				buffer = buffer.slice(i + 2);
				const data = /^data: (.*)$/m.exec(block)?.[1];
				if (data) seen.push({ ...JSON.parse(data), eventId: /^id: (.*)$/m.exec(block)?.[1] });
				wake();
			}
		}
	})().catch(() => undefined);
	return {
		seen, following, done,
		async until(check: (e: AgentEvent) => boolean, ms = 10_000) {
			const end = Date.now() + ms;
			while (!seen.some(check)) {
				if (Date.now() > end) throw new Error(`timed out; saw ${seen.map((e) => e.type).join(",")}`);
				await new Promise<void>((r) => ((wake = r), setTimeout(r, 50)));
			}
		},
		close: async () => (abort.abort(), done),
	};
}

const storedEntries = async (sessionId: string, from = history) => (await http<{ entries: HistoryEntry[] }>(from, "GET", `/v1/sessions/${sessionId}`)).entries;

// ---------- the tests ----------

test("services: a turn whose history, sandbox and models are each a service, driven over HTTP", async () => {
	const a = await agent();
	const { sessionId } = await http(a, "POST", "/sessions");
	const stream = events(a, sessionId);
	await http(a, "POST", `/sessions/${sessionId}/input`, { content: "read the note and save it" });
	await stream.until((e) => e.type === "turn.ended");
	assert.equal(readFileSync(join(project, "out.txt"), "utf8").trim(), "from-sandbox", "bash ran in the environment service");
	assert.ok(stream.seen.some((e) => e.type === "model.output"), "the model's output streamed: gateway to agent to client");
	assert.ok(stream.seen.some((e) => e.type === "tool.progress"), "so did bash's output: sandbox to agent to client");
	const stored = await storedEntries(sessionId);
	assert.ok(stored.some((e) => e.kind === "toolResult" && JSON.stringify(e.message).includes("a note in the sandbox")), "the history service keeps the turn");
	assert.ok(!existsSync(join(a.home, "auth.json")), "the agent holds no credentials: only the gateway does");
	await stream.close();
	await a.h.stop();
});

test("services: a second agent can't write to a session another holds; once it is released, the second carries on", async () => {
	const first = await agent();
	const { sessionId } = await http(first, "POST", "/sessions");
	await http(first, "POST", `/sessions/${sessionId}/input`, { content: "say hello" });
	await first.h.api("t").waitForIdle(sessionId);
	const second = await agent();
	await assert.rejects(http(second, "POST", `/sessions/${sessionId}/open`), /409|already open for writing|held by another owner/);
	await first.h.stop();
	await http(second, "POST", `/sessions/${sessionId}/open`);
	await http(second, "POST", `/sessions/${sessionId}/input`, { content: "say goodbye" });
	await second.h.api("t").waitForIdle(sessionId);
	const texts = (await http<HistoryEntry[]>(second, "GET", `/sessions/${sessionId}/history`)).filter((e) => e.kind === "turnEnd").map((e) => (e.data as { result: { text: string } }).result.text);
	assert.deepEqual(texts, ["hello", "goodbye"], "the second agent saw the first agent's turn, and added its own");
	await second.h.stop();
});

test("history service retains exact opaque decimal values and rejects ambiguous JSON atomically", async () => {
	const sid = "opaque-decimals";
	await http(history, "PUT", `/v1/sessions/${sid}`, { project, created: Date.now() });
	const { lease } = await http<{ lease: string }>(history, "POST", `/v1/sessions/${sid}/lease`, { owner: "decimal-fixture" });
	const path = `${history.url}/v1/sessions/${sid}`;
	const request = (entries: string) => fetch(`${path}/entries`, {
		method: "POST", headers: { authorization: `Bearer ${history.token}`, "content-type": "application/json" },
		body: `{"lease":"${lease}","entries":${entries}}`,
	});
	const initial = '[{"id":"e","parentId":null,"value":9007199254740993,"tiny":1e-400}]';
	assert.deepEqual(await (await request(initial)).json(), { kept: 1 });
	assert.deepEqual(await (await request(initial.replace("9007199254740993", "90071992547409930e-1"))).json(), { kept: 0 });
	assert.equal((await request(initial.replace("9007199254740993", "9007199254740992"))).status, 409);
	assert.equal((await request('[{"id":"staged","parentId":null},{"id":"dup","id":"other","parentId":null}]')).status, 400);
	const res = await fetch(path, { headers: { authorization: `Bearer ${history.token}` } });
	assert.match(await res.text(), /"entries":\[\{"id":"e","parentId":null,"value":9007199254740993,"tiny":1e-400\}\]/);
});


test("history service refuses encoded bodies and overlong leases without committing", async () => {
	const sid = "wire-limits";
	await http(history, "PUT", `/v1/sessions/${sid}`, { project, created: Date.now() });
	const { lease } = await http<{ lease: string }>(history, "POST", `/v1/sessions/${sid}/lease`, { owner: "limits-fixture" });
	const path = `${history.url}/v1/sessions/${sid}`;
	const send = (lease: string, encoding?: string) => fetch(`${path}/entries`, {
		method: "POST", headers: { authorization: `Bearer ${history.token}`, "content-type": "application/json",
			...(encoding ? { "content-encoding": encoding } : {}) },
		body: JSON.stringify({ lease, entries: [{ id: "entry", parentId: null }] }),
	});
	assert.equal((await send(lease, "identity")).status, 415);
	assert.equal((await send("a".repeat(129))).status, 400);
	assert.equal((await send("a".repeat(128))).status, 409);
	const res = await fetch(path, { headers: { authorization: `Bearer ${history.token}` } });
	assert.equal(res.headers.get("content-encoding"), null);
	assert.deepEqual((await res.json() as { entries: unknown[] }).entries, []);
	assert.deepEqual(await (await send(lease)).json(), { kept: 1 });
	await http(history, "DELETE", `/v1/sessions/${sid}/lease/${lease}`);
});

test("history service advertises lease expiry and a reopening writer waits for it", async () => {
	const sid = "abandoned-lease";
	await http(shortLease, "PUT", `/v1/sessions/${sid}`, { project, created: Date.now() });
	await http(shortLease, "POST", `/v1/sessions/${sid}/lease`, { owner: "crashed-writer" });
	const held = await fetch(`${shortLease.url}/v1/sessions/${sid}/lease`, {
		method: "POST", headers: { authorization: `Bearer ${shortLease.token}`, "content-type": "application/json" },
		body: JSON.stringify({ owner: "reopening-writer" }),
	});
	assert.equal(held.status, 409);
	const error = await held.json() as { code: string; retryAfterMs: number };
	assert.equal(error.code, "held");
	assert.ok(error.retryAfterMs > 0 && error.retryAfterMs <= 800);
	const client = new HttpHistoryStore(shortLease);
	await assert.rejects(client.openForWriting(sid), /held by another owner/);
	await client.openForWriting(sid, { wait: true });
	await client.close(sid);
});

test("services: when the history service's answers are lost, appends are sent again and kept once", async () => {
	const a = await agent({ history: flakyHistory });
	const { sessionId } = await http(a, "POST", "/sessions");
	await http(a, "POST", `/sessions/${sessionId}/input`, { content: "say hello" });
	await a.h.api("t").waitForIdle(sessionId);
	const stored = await storedEntries(sessionId, flakyHistory);
	assert.equal(new Set(stored.map((e) => e.id)).size, stored.length, "no entry was kept twice");
	assert.ok(stored.some((e) => e.kind === "turnEnd"), "the turn was kept in full");
	assert.equal(stored.filter((e) => e.kind === "turnEnd").length, 1);
	await a.h.stop();
});

test("services: an interrupted writer delivers an unrecorded SSE event and ends the stream", { timeout: 10_000 }, async t => {
	let failAppend = false;
	class FailingStore extends HttpHistoryStore {
		override async append(id: string, batch: HistoryEntry[]) {
			if (failAppend) { failAppend = false; throw new Error("fixture append failure"); }
			await super.append(id, batch);
		}
	}
	const store = new FailingStore(history);
	await store.initialize();
	const a = await agent({ store });
	const { sessionId } = await http(a, "POST", "/sessions");
	const stream = events(a, sessionId);
	t.after(() => stream.close());
	await stream.following;
	await http(a, "POST", `/sessions/${sessionId}/input`, { content: "sleep a long time" });
	await stream.until(e => e.type === "tool.started");
	failAppend = true;
	await assert.rejects(http(a, "POST", `/sessions/${sessionId}/input`, { content: "say goodbye", when: "after" }), /Session was interrupted/);
	await stream.done;
	const interrupted = stream.seen.filter(e => e.type === "session.interrupted");
	assert.equal(interrupted.length, 1);
	assert.deepEqual(interrupted[0].data, { reason: "commitFailed" });
	assert.equal(interrupted[0].eventId, undefined);
	assert.ok(!(await storedEntries(sessionId)).some(e => e.kind === "turnEnd"));
	await http(a, "POST", `/sessions/${sessionId}/open`);
	const recovered = events(a, sessionId, stream.seen.findLast(e => e.eventId)?.eventId);
	t.after(() => recovered.close());
	await recovered.following;
	await http(a, "POST", `/sessions/${sessionId}/input`, { content: "say hello" });
	await recovered.until(e => e.type === "turn.ended" && e.data.outcome.kind === "completed");
	assert.ok(!recovered.seen.some(e => e.type === "session.interrupted"));
	await a.h.stop();
});

test("services: cancelling over HTTP stops the command in the sandbox", async () => {
	const a = await agent();
	const { sessionId } = await http(a, "POST", "/sessions");
	const stream = events(a, sessionId);
	await http(a, "POST", `/sessions/${sessionId}/input`, { content: "sleep a long time" });
	await stream.until((e) => e.type === "tool.started");
	await http(a, "POST", `/sessions/${sessionId}/cancel`);
	await stream.until((e) => e.type === "turn.ended");
	assert.equal(stream.seen.find((e) => e.type === "turn.ended")!.data.outcome.kind, "cancelled");
	await new Promise((r) => setTimeout(r, 300));
	assert.ok(!existsSync(join(project, "late.txt")));
	await stream.close();
	await a.h.stop();
});

test("services: a client that reconnects gets everything recorded while it was away; input resent with its key is taken once", async () => {
	const a = await agent();
	const { sessionId } = await http(a, "POST", "/sessions");
	const first = events(a, sessionId);
	await http(a, "POST", `/sessions/${sessionId}/input`, { content: "say hello", key: "k1" });
	await first.until((e) => e.type === "turn.ended");
	const last = first.seen.filter((e) => e.eventId).at(-1)!;
	const lastId = last.eventId!;
	assert.equal(lastId, last.data.id);
	const unknown = await fetch(`${a.url}/sessions/${sessionId}/events`, { headers: { authorization: `Bearer ${a.token}`, "last-event-id": "missing-entry" } });
	assert.equal(unknown.status, 404);
	await first.close();
	// Away: the client's answer to this input is lost, so it sends it again with the same key.
	const sent = await http(a, "POST", `/sessions/${sessionId}/input`, { content: "say goodbye", key: "k2" });
	await a.h.api("t").waitForIdle(sessionId);
	const resent = await http(a, "POST", `/sessions/${sessionId}/input`, { content: "say goodbye", key: "k2" });
	assert.equal(resent.duplicate, true);
	assert.equal(resent.inputId, sent.inputId);
	const again = events(a, sessionId, lastId);
	await again.until((e) => e.type === "entry" && (e.data as HistoryEntry).kind === "turnEnd");
	const replayed = again.seen.filter((e) => e.type === "entry").map((e) => (e.data as HistoryEntry).kind);
	assert.ok(replayed.includes("input") && replayed.includes("response"), `replayed: ${replayed.join(",")}`);
	assert.equal(replayed.filter((k) => k === "input").length, 1, "only what was recorded after the last entry seen, and the resent input only once");
	await again.close();
	await a.h.stop();
});

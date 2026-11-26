import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fileHistory, serveHistory, type Actor, type Agent, type HistoryEntry } from "@modular-agent/core";
import { composition, recordingStore } from "./fixtures/session-setup.js";

async function httpFixture(root: string, signal: AbortSignal, stage: (name: string) => void,
  onClose: (close: () => Promise<void>) => void) {
  const token = randomBytes(32).toString("hex");
  const tokenFile = join(root, "token");
  stage("write history token");
  await writeFile(tokenFile, token, { mode: 0o600 });
  stage("start history listener");
  const service = await serveHistory(fileHistory(join(root, "service")), { address: "127.0.0.1:0", tokenFile });
  // Observe the real client's mutation boundaries on the wire, forwarding to the real service.
  const writes: { method: string; path: string; body: { entries?: HistoryEntry[] } }[] = [];
  onClose(() => service.close());
  const proxy = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      if (req.method !== "GET") writes.push({ method: req.method!, path: req.url!, body: body ? JSON.parse(body) : {} });
      const response = await fetch(`${service.url}${req.url}`, {
        method: req.method, headers: { authorization: req.headers.authorization ?? "", "content-type": "application/json" },
        body: body || undefined,
      });
      res.writeHead(response.status, { "content-type": "application/json" }).end(await response.text());
    } catch (error) { res.destroy(error as Error); }
  });
  stage("start history recording proxy");
  proxy.listen(0, "127.0.0.1");
  onClose(() => new Promise<void>(resolve => proxy.close(() => resolve())));
  await once(proxy, "listening", { signal });
  const address = proxy.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    read: (id: string) => fetch(`${service.url}/v1/sessions/${id}`, { headers: { authorization: `Bearer ${token}` }, signal }),
    writes: (id: string) => writes.filter(w => w.path === `/v1/sessions/${id}` || w.path.startsWith(`/v1/sessions/${id}/`)),
  };
}

for (const selection of ["file", "http", "custom"] as const) {
  for (const placement of ["local", "served"] as const) {
    test(`${selection}, ${placement} Runtime: persistent setup waits for the first admission`, { timeout: 10_000 }, async t => {
      let pending = "create project directory";
      let since = performance.now();
      const completed: string[] = [];
      function stage(next: string) {
        const now = performance.now();
        completed.push(`${pending} (${(now - since).toFixed(1)} ms)`);
        pending = next;
        since = now;
      }
      t.signal.addEventListener("abort", () => {
        if (pending) t.diagnostic(`pending ${pending} for ${(performance.now() - since).toFixed(1)} ms; completed: ${completed.join(", ") || "none"}`);
      }, { once: true });
      const root = await mkdtemp(join(tmpdir(), "sdk-session-setup-"));
      let dispose = () => rm(root, { recursive: true, force: true });
      function onClose(close: () => Promise<void>) {
        const next = dispose;
        dispose = async () => {
          try { await close(); }
          finally { await next(); }
        };
      }
      t.after(() => dispose());
      await exercise(root);
      pending = "";

      async function exercise(root: string) {
        const http = selection === "http" ? await httpFixture(root, t.signal, stage, onClose) : undefined;
        const custom = selection === "custom" ? recordingStore(join(root, "history")) : undefined;
        const url = http?.url ?? "";
        const worker = fileURLToPath(new URL("./fixtures/session-setup.js", import.meta.url));
        stage("start worker and await its provisional session ID");
        const child = spawn(process.execPath, [worker, root, selection, placement, url], { stdio: ["pipe", "pipe", "inherit"] });
        const exited = once(child, "exit");
        const lines = createInterface({ input: child.stdout });
        let crashed: string;
        try {
          const [id] = await Promise.race([
            once(lines, "line", { signal: t.signal }),
            exited.then(([code, signal]) => { throw new Error(`worker exited before announcing its session (code ${code}, signal ${signal})`); }),
          ]);
          assert.match(id ?? "", /^[\w-]+$/, "worker announced its open session before the kill");
          crashed = id;
        } finally {
          stage("kill and reap provisional worker");
          child.kill("SIGKILL");
          lines.close();
          await exited;
        }

        assert.deepEqual(await exited, [null, "SIGKILL"]);
        stage("build writer agent");
        const agent = await composition(root, selection, placement, url);
        onClose(() => agent.close());
        stage("build reader agent");
        const reader = await composition(root, selection, "local", url);
        onClose(() => reader.close());
        async function unpublished(reader: Agent, id: string) {
          stage("list sessions before admission");
          assert.ok(!(await reader.sessions()).some(row => row.id === id));
          stage("look up provisional session metadata");
          await assert.rejects(reader.sessionInfo(id), { code: "not_found" });
          if (custom) assert.equal(custom.exists(id), false);
          if (http) {
            assert.deepEqual(http.writes(id), [], "there must not even be a metadata PUT");
            stage("read provisional session over HTTP");
            const response = await http.read(id);
            assert.equal(response.status, 404);
            stage("read provisional session error body");
            assert.equal(((await response.json()) as { code: string }).code, "unknown_session");
          }
        }
        const batches = (id: string) => custom?.get(id).batches ??
          http?.writes(id).filter(row => row.path.endsWith("/entries")).map(row => row.body.entries);
        await unpublished(reader, crashed);
        stage("refuse reopening crashed provisional session");
        await assert.rejects(reader.openSession(crashed), { code: "not_found" });
        const actors = [{ id: "guest", kind: "user", rights: ["watch"] }] satisfies Actor[];
        stage("create unused provisional session");
        const unused = await agent.session({ actors });
        stage("set unused provisional session setting");
        await unused.setSetting("maxSteps", 2);
        await unpublished(reader, unused.id);
        stage("close unused provisional session");
        await unused.close();
        await unpublished(reader, unused.id);
        stage("refuse reopening closed provisional session");
        await assert.rejects(reader.openSession(unused.id), { code: "not_found" });

        stage("create tenant session");
        const session = await agent.session({ tenant: "demo", actors });
        stage("set tenant session setting");
        await session.setSetting("maxSteps", 3);
        stage("set tenant session rights limit");
        await session.setLimit(["watch", "input", "settings"]);
        stage("refuse guest input before admission");
        await assert.rejects(session.as("guest").send("refuse this", "now"), { code: "forbidden" });
        await unpublished(reader, session.id);
        stage("read provisional history");
        const setup = await session.history();
        assert.deepEqual(setup.map(e => e.kind), ["tenant", "actorJoined", "setting", "plugins", "actorJoined", "setting", "limit"]);
        stage("admit input and finish prompt");
        assert.equal((await session.prompt("keep this")).text, "done");
        stage("read admitted history");
        const entries = await session.history();
        assert.deepEqual(entries.slice(0, setup.length), setup, "preserve setup IDs, times, order and parent links");
        const accepted = entries[setup.length];
        assert.equal(accepted.kind, "inputAccepted");
        assert.equal(accepted.parentId, setup.at(-1)!.id);
        assert.deepEqual(entries.slice(setup.length + 1, setup.length + 3).map(e => e.kind), ["turnStart", "input"]);
        if (batches(session.id)) assert.deepEqual(batches(session.id)![0], JSON.parse(JSON.stringify([...setup, accepted])));

        stage("fork admitted session");
        const fork = await session.fork();
        stage("read fork history");
        const copied = await fork.history();
        assert.deepEqual(copied.slice(0, entries.length).map(e => e.sources), entries.map(e => [e.id]));
        const fresh = copied.slice(entries.length);
        assert.deepEqual(fresh.map(e => e.kind), ["tenant", "actorJoined", "actorJoined", "setting", "setting", "limit", "plugins"]);
        assert.ok(fresh.every(e => !e.sources?.length));
        if (batches(fork.id)) assert.deepEqual(batches(fork.id), [JSON.parse(JSON.stringify(copied))]);
        stage("close fork");
        await fork.close();
        stage("reopen fork");
        const reopenedFork = await agent.openSession(fork.id);
        stage("read reopened fork history");
        assert.deepEqual((await reopenedFork.history()).map(e => e.id), copied.map(e => e.id));
        stage("close admitted session");
        await session.close();
        stage("reopen admitted session");
        const reopened = await agent.openSession(session.id);
        stage("read reopened session history");
        assert.deepEqual((await reopened.history()).map(e => e.id), entries.map(e => e.id));
      }
    });
  }
}

// The sessions-service reference check: `ma sessions` and `ma -c` over the history service.
// It starts the TypeScript build's service (docs/bindings/history-http.md) on loopback, makes
// sessions with `ma`, then writes copies of them straight to the service with chosen IDs and
// entry times. That gives a session whose newest appended entry has an earlier time than an
// older entry, and two sessions whose last entries have the same time.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const serve = join(repo, "typescript/packages/services/dist/src/serve.js");
const DAY = 86_400_000;

function startService(dir) {
  const token = randomBytes(16).toString("hex");
  const tokenFile = join(dir, "history-token");
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  const child = spawn(process.execPath, [serve, "history", JSON.stringify({ dir: join(dir, "history-store"), token, port: 0 })], { stdio: ["ignore", "pipe", "pipe"] });
  const started = new Promise((ok, fail) => {
    let out = "", err = "";
    const timer = setTimeout(() => fail(new Error(`history service did not start in 30 s: ${err.slice(-300)}`)), 30_000);
    child.stdout.on("data", (d) => {
      out += d;
      const line = out.split("\n").find((l) => l.startsWith("{") && l.endsWith("}"));
      if (line) { clearTimeout(timer); ok(JSON.parse(line).url); }
    });
    child.stderr.on("data", (d) => { err += d; });
    child.on("exit", (code) => { clearTimeout(timer); fail(new Error(`history service exited with ${code}: ${err.slice(-300)}`)); });
  });
  return { started, token, tokenFile, stop: () => { child.kill("SIGKILL"); } };
}

async function wire(url, token, method, path, body) {
  const res = await fetch(url + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  assert.equal(res.status, 200, `history service ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// Read a session's metadata and every entry, in append order.
async function read(url, token, id) {
  let session, entries = [], after;
  do {
    const page = await wire(url, token, "GET", `/v1/sessions/${id}${after ? `?after=${encodeURIComponent(after)}` : ""}`);
    session = page.session;
    entries = entries.concat(page.entries);
    after = page.next;
  } while (after);
  return { session, entries };
}

// Store a copy of a session under a new ID with the given creation time and entry times.
async function copy(url, token, source, id, created, times) {
  const { session, entries } = source;
  assert.equal(times.length, entries.length);
  const swap = (value) => JSON.parse(JSON.stringify(value).replaceAll(session.id, id));
  const { id: _, ...meta } = swap(session);
  await wire(url, token, "PUT", `/v1/sessions/${id}`, { ...meta, created });
  const { lease } = await wire(url, token, "POST", `/v1/sessions/${id}/lease`, { owner: randomBytes(16).toString("hex") });
  await wire(url, token, "POST", `/v1/sessions/${id}/entries`, { lease, entries: entries.map((e, i) => ({ ...swap(e), time: times[i] })) });
  await wire(url, token, "DELETE", `/v1/sessions/${id}/lease/${lease}`);
}

export async function checkSessionsService(command, invoke, skip, t) {
  if (!existsSync(serve)) return skip(`the TypeScript history service is not built (${serve})`, "check");
  const service = startService(t.dir);
  try {
    const url = await service.started;
    const env = { MODULAR_AGENT_HISTORY_URL: url, MODULAR_AGENT_HISTORY_TOKEN_FILE: service.tokenFile };
    const other = join(t.dir, "other");
    mkdirSync(other);
    const project = realpathSync(t.project), otherProject = realpathSync(other);
    const ma = async (...args) => {
      const r = await invoke(command, { args, env });
      assert.equal(r.exit, 0, `ma ${args.join(" ")}: exit status 0; stderr: ${r.stderr.slice(-300)}`);
      return r.stdout;
    };
    const listing = async (args, ids) => {
      const want = ids.map(([id, folder]) => `${id}  ${folder}\n`).join("");
      const got = await ma(...args);
      if (got !== want) throw new Error(`ma ${args.join(" ")}: stdout ${JSON.stringify(want)}: got ${JSON.stringify(got)}`);
    };
    const session = async (...args) => {
      const id = (await ma("--json", ...args)).split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.sessionId)?.sessionId;
      assert.ok(id, `ma --json ${args.join(" ")}: an event names the session`);
      return id;
    };

    // Sessions that ma writes: the list response carries no last activity.
    const first = await session("-p", "first");
    const elsewhere = await session("--project", other, "-p", "second");
    const third = await session("-p", "third");
    await listing(["sessions"], [[third, project], [first, project]]);
    await listing(["sessions", "--all"], [[third, project], [elsewhere, otherProject], [first, project]]);
    assert.equal(await session("--session", first, "-p", "fourth"), first, "--session reopens the first session");
    await listing(["sessions"], [[first, project], [third, project]]);
    await listing(["sessions", "--all"], [[first, project], [third, project], [elsewhere, otherProject]]);

    // Copies with chosen times, all a day ahead of the sessions above.
    const base = Date.now() + DAY;
    const a = await read(url, service.token, first), b = await read(url, service.token, third);
    const n = (s) => s.entries.length;
    assert.ok(n(a) > 1 && n(a) < 500 && n(b) > 1 && n(b) < 500, `sessions of 2 to 499 entries: got ${n(a)} and ${n(b)}`);
    const run = (s, from, last) => s.entries.map((_, i) => (i === n(s) - 1 ? last : from + i));
    // skewed: older entries carry later times than its newest entry (base + 10).
    const skewed = "5".repeat(32), steady = "6".repeat(32), low = "0".repeat(32), high = "f".repeat(32);
    await copy(url, service.token, a, skewed, base + 1, run(a, base + 1000, base + 10));
    await copy(url, service.token, b, steady, base + 2, run(b, base + 100, base + 100 + n(b) - 1));
    // low and high end at the same time. The service lists high after low (it is older), so
    // a build that keeps the last of equal sessions in list order would reopen high.
    await copy(url, service.token, a, low, base + 5000, run(a, base + 2000, base + 5000));
    await copy(url, service.token, b, high, base, run(b, base + 2000, base + 5000));
    const ordered = [[low, project], [high, project], [steady, project], [skewed, project], [first, project], [third, project]];
    await listing(["sessions"], ordered);
    await listing(["sessions", "--all"], [...ordered, [elsewhere, otherProject]]);
    assert.equal(await session("-c", "-p", "fifth"), low, "-c reopens the top listed session");
  } finally {
    service.stop();
  }
}

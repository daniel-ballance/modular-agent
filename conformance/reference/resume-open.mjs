import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

export async function checkResumeOpen(command, t, env) {
  const token = randomBytes(32).toString("hex"), tokenFile = join(t.dir, "service.token");
  writeFileSync(tokenFile, token, { mode:0o600 });
  for (const resume of [false, true]) {
    const project = join(t.project, resume ? "on" : "off");
    mkdirSync(project);
    const signal = AbortSignal.timeout(60_000);
    const effect = join(project, "effect"), release = join(project, "release");
    const children = [];
    async function serve(name, ...args) {
      const stderr = openSync(join(project, name + ".stderr"), "w", 0o600);
      let child;
      try {
        child = spawn(command[0], [...command.slice(1), "--agui", "--listen", "127.0.0.1:0", "--token-file", tokenFile, ...args],
          { cwd:project, env, detached:true, stdio:["ignore", "pipe", stderr] });
      } finally { closeSync(stderr); }
      const exit = once(child, "exit");
      let stopped;
      const stop = () => stopped ??= (async () => {
        if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; }
        await exit;
      })();
      children.push(stop);
      const lines = createInterface({input:child.stdout});
      let origin;
      try {
        const [first] = await Promise.race([once(lines, "line", {signal}), exit.then(() => { throw new Error(name + " exited before readiness"); })]);
        origin = new URL(first);
        assert.ok(origin.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(origin.hostname), "ma prints its loopback origin");
      } finally { lines.close(); }
      const request = (path, data) => fetch(new URL("/agui/v1" + path, origin), {
        signal, redirect:"error", method:data ? "POST" : "GET", headers:{authorization:"Bearer " + token, "content-type":"application/json"},
        body:data && JSON.stringify(data),
      });
      const json = async (path, data) => {
        const res = await request(path, data);
        assert.ok(res.ok, name + ": HTTP " + res.status + " for " + path);
        return res.json();
      };
      return { stop, request, json };
    }

    try {
      const first = await serve("original");
      const {threadId} = await first.json("/threads", {});
      const path = "/threads/" + encodeURIComponent(threadId);
      const snapshot = await first.json(path);
      const run = first.request("/run", { protocolVersion:"1.0", runId:randomUUID(), threadId,
        messages:[...snapshot.messages, {id:"client-message", role:"user", content:"Start the tool."}], tools:[], context:[], state:{}, forwardedProps:{}
      }).then(async res => { await res.arrayBuffer(); return "run ended, HTTP " + res.status; }, () => "run disconnected").catch(() => "run disconnected");
      await Promise.race([run.then(msg => { throw new Error(msg + " before SIGKILL"); }), (async () => {
        while (!existsSync(effect)) await delay(10, undefined, {signal});
      })()]);
      await first.stop(); await run;
      writeFileSync(release, ""); // A repeated call would append again and return.

      const observer = await serve("without-option");
      const state = async () => (await observer.json("/threads")).threads.find(row => row.threadId === threadId)?.waiting.turn;
      assert.equal(await state(), "interrupted", "without the option, listing must leave the turn interrupted");
      if (resume) {
        // Observe through a different, non-opening reader. No connection goes to the restarted writer.
        const writer = await serve("with-option", "--resume-open");
        while (await state() !== "none") await delay(20, undefined, {signal});
        await writer.stop();
      } else {
        await observer.json(path); // An explicit open is needed in the default mode.
        while (await state() !== "none") await delay(20, undefined, {signal});
      }
      const final = await observer.json(path);
      assert.equal(final.messages.at(-1)?.content, "Recovered without a repeated effect.", "the original turn finished");
      assert.equal(final.messages.filter(m => m.role === "user").length, 1, "recovery admitted no new input");
      assert.equal(readFileSync(effect, "utf8"), "once\n", "the interrupted tool ran once");
    } finally {
      writeFileSync(release, "");
      for (const stop of children.reverse()) await stop();
    }
  }
}

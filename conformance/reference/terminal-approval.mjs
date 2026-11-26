import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export async function checkTerminalApproval(command, t, env) {
  const deadline = AbortSignal.timeout(60_000);
  const child = spawn(command[0], [...command.slice(1), "--approval", "ask"], {
    cwd: t.project, env, detached: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  const stderr = createInterface({ input: child.stderr });
  const lines = stderr[Symbol.asyncIterator]();
  let stdout = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  const timeout = once(deadline, "abort").then(() => { throw new Error("terminal approval timed out"); });
  async function expectLine(expected) {
    for (;;) {
      const { value, done } = await Promise.race([lines.next(), closed.then(() => ({ done: true })), timeout]);
      assert.ok(!done, `terminal closed before ${JSON.stringify(expected)}`);
      if (value === expected) return;
    }
  }
  try {
    child.stdin.write("Write both files.\n");
    await expectLine("Allow? (y/n)");
    for (const input of ["", "later", "/answer q allow", "/commands", "/quit", "/cancel later"]) {
      child.stdin.write(`${input}\n`);
      await expectLine("Answer y or n.");
    }
    child.stdin.end("Y\n");
    const [exit] = await Promise.race([closed, timeout]);
    assert.equal(exit, 0);
    assert.equal(stdout, "Done.\n", "slash commands produced no output while approval was shown");
    for (const path of ["first.txt", "second.txt"]) assert.equal(readFileSync(join(t.project, path), "utf8"), "x");
  } finally {
    stderr.close();
    if (child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    await closed;
  }
}

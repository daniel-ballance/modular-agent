import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { type Actor, type ServeAcpOptions } from "@modular-agent/core";
import { testAgent } from "@modular-agent/core/testing";

for (const [label, ceiling, expected] of [
  ["overlap", ["watch", "tools"], ["watch"]],
  ["disjoint", ["tools"], []],
  ["empty ceiling", [], []],
] as const) {
  test(`stdio ACP intersects actor rights and a separate ceiling: ${label}`, { timeout: 10_000 }, async t => {
    const project = await realpath(await mkdtemp(join(tmpdir(), "ma-acp-rights-")));
    t.after(() => rm(project, { recursive: true, force: true }));
    const child = spawn(process.execPath, [fileURLToPath(new URL("../src/bin.js", import.meta.url)), "acp-stdio-rights"], {
      cwd: project, stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, MODULAR_AGENT_PLUGINS: "", MODULAR_AGENT_CONFORMANCE: "1",
        MODULAR_AGENT_DATA_DIR: join(project, "state"), MA_ACP_STDIO_RIGHTS: JSON.stringify(ceiling) },
    });
    t.after(() => { child.kill(); });
    const exited = once(child, "close");
    const { agent } = client({ name: "rights-test" }).connect(ndJsonStream(
      Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ));
    const hello = await agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
    const meta = hello._meta?.["modular-agent"] as { actor?: unknown } | undefined;
    assert.deepEqual(meta?.actor, {
      id: "rights-fixture", kind: "host", rights: expected,
    });
    await assert.rejects(agent.request(methods.agent.session.new, { cwd: project, mcpServers: [] }), {
      data: { code: "forbidden" },
    });
    child.stdin.end();
    const [code] = await exited;
    assert.equal(code, 0);
  });
}

test("stdio ACP validates both rights lists before intersecting and rejects a conflicting actor ID", async () => {
  const actor: Actor = { id: "operator", kind: "host", rights: ["watch"] };
  const cases: ServeAcpOptions[] = [
    { actor: { ...actor, rights: ["unknown" as never] }, rights: ["watch"] },
    { actor, rights: ["unknown" as never] },
    { actor, actorId: "other", rights: ["watch"] },
  ];
  for (const options of cases) {
    const agent = await testAgent({ script: [] });
    await assert.rejects(agent.serveAcp(options), { code: "invalid_composition" });
  }
});

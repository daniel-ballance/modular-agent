import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { definePlugin, fileCredentials, tool } from "../src/index.js";
import { overWire, testAgent } from "../src/testing.js";

const secret = "offline-secret-value";
const name = "answer-slot";
const asker = tool({ name: "ask_secret", description: "Ask for a secret", input: { type: "object" }, async run(_, cx) {
  const answer = await cx.ask({ kind: "secret", credential: name, question: "Secret?" });
  return typeof answer === "object" && "stored" in answer ? answer.stored : "declined";
} });
const script = [{ toolCalls: [{ name: "ask_secret", input: {} }] }, { text: "Done" }];

for (const checkpoint of ["staged", "accepted", "activated", "declined"] as const) {
  test(`secret recovery after SIGKILL at ${checkpoint}`, { timeout: 15_000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), "sdk-secret-"));
    t.after(() => rm(dir, { force: true, recursive: true }));
    const path = join(dir, "credentials.json");
    const source = `
      import { fileCredentials, tool } from ${JSON.stringify(import.meta.resolve("../src/index.js"))};
      import { testAgent } from ${JSON.stringify(import.meta.resolve("../src/testing.js"))};
      const credentials = fileCredentials(${JSON.stringify(path)});
      const checkpoint = ${JSON.stringify(checkpoint)};
      const die = () => { process.kill(process.pid, 'SIGKILL'); return new Promise(() => {}); };
      const { stage, activate, discard } = credentials;
      credentials.stage = async (...args) => {
        const receipt = await stage(...args);
        if (checkpoint === 'staged') await die();
        return receipt;
      };
      credentials.activate = async (...args) => {
        if (checkpoint === 'accepted') await die();
        const result = await activate(...args);
        if (checkpoint === 'activated') await die();
        return result;
      };
      credentials.discard = async (...args) => {
        if (checkpoint === 'declined') await die();
        return discard(...args);
      };
      const agent = await testAgent({ dataDir: ${JSON.stringify(dir)}, durability: 'kept', credentials,
        script: ${JSON.stringify(script)}, tools: [tool({ name: 'ask_secret', description: 'Ask for a secret', input: {type:'object'},
          async run(_, cx) { await cx.ask({kind:'secret', credential:${JSON.stringify(name)}, question:'Secret?'}); } })],
        async onQuestion(q) {
          process.stdout.write(JSON.stringify({sessionId:q.sessionId, requestId:q.id}) + '\\n');
          if (checkpoint === 'declined') {
            await credentials.stage({ deployment: ${JSON.stringify(dir)}, sessionId:q.sessionId, requestId:q.id,
              credential:${JSON.stringify(name)}, actorId:'user' }, ${JSON.stringify(secret)});
            return 'decline';
          }
          return {value:${JSON.stringify(secret)}};
        },
      });
      await agent.session().then(s => s.prompt('Ask.'));
      process.exitCode = 2;
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: ["ignore", "pipe", "inherit"] });
    t.after(() => { child.kill("SIGKILL"); });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", part => { out += part; });
    assert.deepEqual(await once(child, "close"), [null, "SIGKILL"]);
    const { sessionId, requestId } = JSON.parse(out);
    const credentials = fileCredentials(path);
    assert.equal(await credentials.read(name), checkpoint === "activated" ? secret : undefined);
    const agent = await testAgent({ dataDir: dir, durability: "kept", credentials, tools: [asker], script });
    t.after(() => agent.close());
    const session = await agent.openSession(sessionId);
    assert.deepEqual(await session.questions(), []);
    const history = await session.history();
    assert.ok(!JSON.stringify(history).includes(secret));
    const accepted = checkpoint === "accepted" || checkpoint === "activated";
    assert.equal(await credentials.read(name), accepted ? secret : undefined);
    assert.equal(history.filter(e => e.kind === "secretAnswerAccepted" && e.requestId === requestId).length, Number(accepted));
    const answers = history.filter(e => e.kind === "inputAnswer" && e.requestId === requestId);
    assert.equal(answers.length, 1);
    assert.equal((answers[0].data as { stored?: string }).stored, accepted ? name : undefined);
    assert.equal(await credentials.stage!({ deployment: dir, sessionId, requestId, credential: name, actorId: "user" }, "duplicate"), undefined);
    await agent.close();
  });
}

test("a served tool gets only the stored name; generations prevent stale activation", async t => {
  const dir = await mkdtemp(join(tmpdir(), "sdk-secret-"));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const credentials = fileCredentials(join(dir, "credentials.json"));
  const scope = { deployment: dir, sessionId: "example", requestId: "old", credential: name, actorId: "user" };
  await credentials.stage!(scope, "old");
  await credentials.modify(name, async () => "new");
  assert.equal(await credentials.activate!(scope), "superseded");
  assert.equal(await credentials.read(name), "new");
  const agent = await testAgent({ credentials, script, onQuestion: () => ({ value: secret }),
    plugins: [overWire(definePlugin({ name: "asker", tools: [asker] }))] });
  try {
    const session = await agent.session();
    const turn = await session.prompt("Ask.");
    assert.equal(turn.toolResults()[0].text(), name);
    assert.equal(await credentials.read(name), secret);
    assert.ok(!JSON.stringify(await session.history()).includes(secret));
  } finally { await agent.close(); }
});

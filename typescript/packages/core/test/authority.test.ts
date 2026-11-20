import assert from "node:assert/strict";
import { test } from "node:test";
import { type Actor } from "../src/index.js";
import { testAgent } from "../src/testing.js";

const viewer: Actor = { id: "viewer", kind: "user", rights: ["watch"] };

test("actor, tenant and limit APIs are opt-in", async () => {
  const agent = await testAgent({ script: [] });
  try {
    const session = await agent.session();
    assert.equal(session.as("user"), session);
    assert.throws(() => session.as("viewer"), { code: "not_supported" });
    await assert.rejects(session.join(viewer), { code: "not_supported" });
    await assert.rejects(session.leave(viewer.id), { code: "not_supported" });
    await assert.rejects(session.send("Propose this", "propose"), { code: "not_supported" });
    await assert.rejects(session.setLimit(), { code: "not_supported" });
    await assert.rejects(agent.session({ tenant: "one" }), { code: "not_supported" });
  } finally { await agent.close(); }
});

test("actor views respect grant, departure, tenant and session ceilings", { timeout: 5000 }, async () => {
  const agent = await testAgent({ severalActors: true, sessionLimits: true,
    tenants: { one: { rights: ["watch", "input", "grant", "administer"] } }, script: [{ text: "Hello." }] });
  try {
    const declaration = agent.declaration();
    assert.equal(declaration.severalActors, true);
    assert.equal(declaration.sessionLimits, true);
    assert.equal(declaration.tenants, true);
    await assert.rejects(agent.session({ tenant: "absent" }), { code: "invalid_params" });
    const session = await agent.session({ tenant: "one", actors: [viewer] });
    const view = session.as(viewer.id);
    await assert.rejects(view.prompt("Denied."), { code: "forbidden" });
    await assert.rejects(view.fork(), { code: "forbidden" });
    await assert.rejects(session.join({ ...viewer, id: "outside", rights: ["tools"] }), { code: "forbidden" });
    const contributor: Actor = { id: "contributor", kind: "program", rights: ["watch", "input"] };
    await session.join(contributor);
    const contributed = session.as(contributor.id);
    assert.equal((await contributed.prompt("Hi.")).text, "Hello.");
    const input = (await session.history()).find(e => e.kind === "input");
    assert.equal(input?.actorId, contributor.id);
    assert.equal((input?.data as { delegatedBy: string }).delegatedBy, "user");
    await session.setLimit(["watch"]);
    await assert.rejects(contributed.prompt("Denied by the limit."), { code: "forbidden" });
    await session.setLimit(["watch", "input"]); // administer is not removed by the ceiling
    await contributed.leave(contributor.id);
    await assert.rejects(contributed.history(), { code: "forbidden" });
    await view.close(); // membership suffices when nothing would be cancelled
  } finally { await agent.close(); }
});

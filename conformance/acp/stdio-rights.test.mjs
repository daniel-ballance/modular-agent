import assert from "node:assert/strict";
import { test } from "node:test";
import { stdioRights } from "./stdio-rights.mjs";

const broad = ["watch", "input", "settings"];
const actor = rights => ({ id: "rights-fixture", kind: "host", rights });
const forbidden = () => { throw { data: { code: "forbidden" } }; };

async function transcript({ advertised = rights => rights, rewriteGrant = false } = {}) {
  const sessions = new Map(), results = [];
  let next = 0;
  await stdioRights({
    project: "/project", command: ["fixture"],
    connect(_command, env) {
      const ceiling = env.MA_ACP_STDIO_RIGHTS && JSON.parse(env.MA_ACP_STDIO_RIGHTS);
      const rights = ceiling ? broad.filter(right => ceiling.includes(right)) : broad;
      return { rights, ctx: { async request(method, params) {
        if (method === "initialize") return { _meta: { "modular-agent": { actor: actor(advertised(rights, ceiling)) } } };
        if (method === "session/new") {
          if (!rights.includes("input")) forbidden();
          const sessionId = String(++next);
          sessions.set(sessionId, [{ kind: "actorJoined", data: { actor: actor([...rights]) } }]);
          return { sessionId };
        }
        if (method === "session/load") {
          if (rewriteGrant && ceiling) sessions.get(params.sessionId)[0].data.actor.rights = [...rights];
          return {};
        }
        if (method === "_modular-agent/input") forbidden();
        throw new Error(`unexpected method: ${method}`);
      } } };
    },
    stop: async () => {},
    within: async (_ms, promise) => promise,
    check: (label, ok) => results.push({ label, ok }),
    attempt: async (_label, fn) => fn(),
    history: async (_peer, id) => ({ entries: structuredClone(sessions.get(id)) }),
    prompt: async (peer, id) => {
      if (!peer.rights.includes("input")) forbidden();
      sessions.get(id).push({ kind: "inputAccepted", id: `input-${next++}` });
      return { stopReason: "end_turn" };
    },
    closeSession: async () => {},
  });
  return results;
}

test("stdio rights accepts intersected metadata, absent and empty ceilings, and unchanged grants", async () => {
  const results = await transcript();
  assert.equal(results.length, 20);
  assert.deepEqual(results.filter(result => !result.ok), []);
});

test("stdio rights rejects uncapped actor rights and ceiling-only metadata", async () => {
  for (const advertised of [() => broad, (rights, ceiling) => ceiling ?? rights]) {
    const results = await transcript({ advertised });
    const failed = results.filter(result => !result.ok);
    assert.ok(failed.some(result => result.label === "reopen: initialize advertises the connection's effective rights"));
    assert.ok(failed.every(result => result.label.includes("initialize advertises")));
  }
});

test("stdio rights rejects applying the ceiling by rewriting a recorded grant", async () => {
  const results = await transcript({ rewriteGrant: true });
  assert.deepEqual(results.filter(result => !result.ok).map(result => result.label), [
    "restored: a narrow reopen does not change grants or admit denied input",
  ]);
});

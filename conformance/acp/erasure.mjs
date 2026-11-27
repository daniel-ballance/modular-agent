import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const leases = new Map();
export async function erasureTriggers(kit, peer, approvalOff) {
	const { store, project, prompt, history, check } = kit;
	const rpc = (method, params) => peer.ctx.request(method, params).catch(error => { throw Object.assign(new Error(`${method}: ${error.message}`, { cause: error }), { data: error.data }); });
	for (const trigger of ["settings", "fork", "move", "release", "answer", "history"]) await kit.attempt(`erasure trigger: ${trigger}`, async () => {
		const sessionId = await approvalOff(peer, await rpc("session/new", { cwd: project, mcpServers: [] }));
		const path = store.path(sessionId);
		const ext = (name, params = {}) => rpc(`_modular-agent/${name}`, { sessionId, ...params });
		const key = randomUUID(), secret = `trigger-private-${key}`;
		await prompt(peer, sessionId, trigger === "answer" ? "Seed the recorded questions." : secret, key);
		await prompt(peer, sessionId, "Keep this independent position.");
		const before = await store.pages(sessionId);
		const end = before.findLast(e => e.kind === "turnEnd");
		const entryId = end.id;
		let target = before.find(e => e.kind === "inputAccepted" && e.data?.key === key).id;
		let affected, unaffected;
		if (trigger === "answer") {
			// Import two recorded questions while there is no agent writer. Resume
			// without replay and poll both before erasure changes the delivered view.
			await kit.closeSession(peer, sessionId);
			const { lease } = await store.json(`${path}/lease`, "POST", { owner: "question-fixture" });
			affected = randomUUID(); unaffected = randomUUID(); target = randomUUID();
			const question = (requestId, id, parentId, text) => ({ id, parentId, sessionId, actorId: "kit-policy-actor", writer: "fixture", time: Date.now(),
				turnId: end.turnId, requestId, kind: "inputRequest", modelVisible: false,
				data: { request: { id: requestId, sessionId, kind: "text", question: text, answerers: ["kit-policy-actor"], answerable: true } } });
			try {
				await store.json(`${path}/entries`, "POST", { lease, entries: [question(affected, target, before.at(-1).id, secret),
					question(unaffected, randomUUID(), target, "An independent question")] });
			} finally { await store.json(`${path}/lease/${lease}`, "DELETE"); }
			await rpc("session/resume", { sessionId, cwd: project, mcpServers: [] });
			const { requests } = await ext("requests");
			assert.ok([affected, unaffected].every(id => requests.some(q => q.id === id && q.answerable)));
		}
		const entryIds = trigger === "answer" ? [target] : [...new Set([target, ...before.filter(e => JSON.stringify(e).includes(secret)).map(e => e.id)])];
		const { revision } = await store.json(`${path}/pending-erasure`);
		const intentId = randomUUID(), recordId = randomUUID();
		const lease = leases.get(`${path}/lease`);
		assert.ok(lease, "capture the active fixture writer's lease");
		await store.json(`${path}/pending-erasure`, "POST", { revision, lease, intentId, entryIds, copies: [{ sessionId, recordId, entryIds }] });
		const plans = async () => (await store.json(`${path}/pending-erasure`)).plans.find(p => p.intentId === intentId);
		if (trigger === "settings") {
			const listing = await rpc("session/list", {});
			check("erasure triggers: session/list hides pending sessions without retrying", !listing.sessions.some(s => s.sessionId === sessionId) &&
				!JSON.stringify(listing).includes(secret) && !(await plans()).copies[0].complete);
		}
		let reply;
		switch (trigger) {
			case "settings": reply = await rpc("session/set_config_option", { sessionId, configId: "approval", value: "off" }); break;
			case "fork": reply = await ext("fork", { entryId }); break;
			case "move": reply = await ext("move", { entryId }); break;
			case "release": {
				// Stock ma can release parked work but does not offer creation of
				// ordinary multi-actor proposals. A missing proposal still checks
				// authority and retries before the proposal lookup.
				const error = await ext("release", { inputId: randomUUID(), when: "after", declined: true }).catch(e => e);
				assert.ok(["not_found", "conflict"].includes(error.data?.code), `unknown release: ${error.data?.code}`);
				reply = error.data;
				break;
			}
			case "answer": {
				reply = await ext("answer", { requestId: affected, value: "Must not be rebound" });
				check("erasure triggers: changed delivered question is refused and settled", reply.accepted === false &&
					!(await ext("requests")).requests.some(q => q.id === affected && q.answerable));
				check("erasure triggers: an unaffected question remains answerable", (await ext("answer", { requestId: unaffected, value: "Accepted" })).accepted === true);
				break;
			}
			case "history": reply = await history(peer, sessionId, { all: true }); break;
		}
		const after = await store.pages(sessionId);
		check(`erasure triggers: ${trigger} completes before exposing or using history`, (await plans()).copies[0].complete &&
			after.find(e => e.id === target)?.erased === true && after.filter(e => e.id === recordId && e.kind === "erasure").length === 1 &&
			![after, reply].some(value => JSON.stringify(value).includes(secret)));
		if (trigger === "fork") {
			const copied = await store.pages(reply.sessionId);
			check("erasure triggers: fork copies tombstones without source links", copied.some(e => e.kind === "inputAccepted" && e.erased && !e.sources?.length) && !JSON.stringify(copied).includes(secret));
		}
	});
	leases.clear();
}
erasureTriggers.capture = ({ path, lease }) => { if (lease) leases.set(path, lease); };

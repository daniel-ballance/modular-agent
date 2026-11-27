import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const leases = new Map();
export async function erasureTriggers(kit, peer, approvalOff, stockMa) {
	const { store, project, prompt, history, check } = kit;
	const rpc = (method, params) => peer.ctx.request(method, params).catch(error => { throw Object.assign(new Error(`${method}: ${error.message}`, { cause: error }), { data: error.data }); });
	const triggers = ["rewind", "settings", "fork", "move", "release", "answer", "history", "attach"];
	if (stockMa) triggers.push("approval", "command");
	for (const trigger of triggers) await kit.attempt(`erasure trigger: ${trigger}`, async () => {
		const opened = await rpc("session/new", { cwd: project, mcpServers: [] });
		const sessionId = await approvalOff(peer, opened);
		const path = store.path(sessionId);
		const ext = (name, params = {}) => rpc(`_modular-agent/${name}`, { sessionId, ...params });
		const key = randomUUID(), secret = `trigger-private-${key}`;
		const marker = join(project, `rewind-${key}.txt`);
		let rewindTarget;
		if (trigger === "rewind") {
			assert.equal(opened._meta?.["modular-agent"]?.declaration?.rewinding, true);
			writeFileSync(marker, "saved point");
			await prompt(peer, sessionId, "Save the working environment.");
			rewindTarget = (await store.pages(sessionId)).findLast(e => e.kind === "turnEnd").id;
		}
		await prompt(peer, sessionId, ["answer", "fork", "approval"].includes(trigger) ? "Seed the retained history." : secret, key);
		await prompt(peer, sessionId, "Keep this independent position.");
		if (trigger === "rewind") writeFileSync(marker, "current point");
		const before = await store.pages(sessionId);
		const end = before.findLast(e => e.kind === "turnEnd");
		let entryId = end.id;
		let target = before.find(e => e.kind === "inputAccepted" && e.data?.key === key).id;
		let affected, unaffected, affectedCall;
		if (trigger === "approval") {
			// Let stock ma write the pending call, request, and completed origin.
			// This exercises the actual wait schema in both implementations.
			await rpc("session/set_config_option", { sessionId, configId: "approval", value: "all" });
			await rpc("session/set_config_option", { sessionId, configId: "approvalWait", value: "untilDeadline" });
			for (const name of ["unaffected", "affected"])
				await prompt(peer, sessionId, `tool:bash ${JSON.stringify({ command: `printf ${name}` })}`);
			const { requests } = await ext("requests");
			const waits = requests.filter(q => q.kind === "approval" && q.approvalWait === "untilDeadline" && q.answerable);
			assert.equal(waits.length, 2, JSON.stringify(requests));
			[affected, unaffected] = ["affected", "unaffected"].map(name => waits.find(q => q.call?.input.command === `printf ${name}`).id);
			const request = (await store.pages(sessionId)).find(e => e.kind === "inputRequest" && e.requestId === affected);
			target = request.id;
			affectedCall = request.toolCallId;
		}
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
		if (trigger === "fork") {
			// Seed a private, non-model record so the single-copy plan is
			// complete without depending on either Runtime's turn graph.
			await kit.closeSession(peer, sessionId);
			const { lease } = await store.json(`${path}/lease`, "POST", { owner: "fork-fixture" });
			entryId = target = randomUUID();
			try {
				await store.json(`${path}/entries`, "POST", { lease, entries: [{ id: target, parentId: before.at(-1).id,
					sessionId, kind: "fixture.note", time: Date.now(), writer: "fixture", modelVisible: false, data: { secret } }] });
			} finally { await store.json(`${path}/lease/${lease}`, "DELETE"); }
			await rpc("session/resume", { sessionId, cwd: project, mcpServers: [] });
		}
		const entryIds = ["answer", "fork", "approval"].includes(trigger) ? [target] : [...new Set([target, ...before.filter(e => JSON.stringify(e).includes(secret)).map(e => e.id)])];
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
		assert.equal((await plans()).copies[0].complete, false);
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
			case "attach": {
				const start = peer.updates.length;
				reply = await rpc("session/resume", { sessionId, cwd: project, mcpServers: [] });
				reply = { reply, updates: peer.updates.slice(start).filter(u => u.sessionId === sessionId) };
				assert.equal(leases.get(`${path}/lease`), lease, "reuse the already-open writer");
				break;
			}
			case "approval": reply = await ext("answer", { requestId: affected, value: "allow" }); break;
			case "command": {
				const skill = `erasure-kit-${key}`;
				const dir = join(project, ".agents", "skills", skill);
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, "SKILL.md"), `---\nname: ${skill}\ndescription: Erasure kit command fixture\n---\n`);
				const start = peer.updates.length;
				reply = await prompt(peer, sessionId, "/skills", randomUUID());
				const output = peer.updates.slice(start).filter(u => u.sessionId === sessionId && u.update.sessionUpdate === "agent_message_chunk")
					.map(u => u.update.content?.text).join("");
				assert.ok(output.includes(skill), "stock /skills ran rather than echoing a model prompt");
				reply = { reply, output };
				break;
			}
			case "rewind":
				reply = await ext("move", { entryId: rewindTarget, rewind: true });
				assert.equal(readFileSync(marker, "utf8"), "saved point");
				break;
			case "history": reply = await history(peer, sessionId, { all: true }); break;
		}
		const after = await store.pages(sessionId);
		check(`erasure triggers: ${trigger} completes before exposing or using history`, (await plans()).copies[0].complete &&
			after.find(e => e.id === target)?.erased === true && after.filter(e => e.kind === "erasure").length === 1 && after.some(e => e.id === recordId && e.kind === "erasure") &&
			![after, reply].some(value => JSON.stringify(value).includes(secret)));
		if (trigger === "rewind") assert.ok(after.findIndex(e => e.kind === "position" && e.data?.to === rewindTarget) > after.findIndex(e => e.id === recordId));
		if (trigger === "command") {
			assert.equal(after.filter(e => e.kind === "turnStart").length, before.filter(e => e.kind === "turnStart").length);
			const command = after.findIndex(e => e.kind === "command" && !before.some(previous => previous.id === e.id));
			if (command >= 0) assert.ok(command > after.findIndex(e => e.id === recordId));
		}
		if (trigger === "approval") {
			const results = after.filter(e => e.kind === "toolResult" && e.toolCallId === affectedCall);
			check("erasure triggers: changed delivered approval is refused and settled", reply.accepted === false &&
				results.length === 1 && (results[0].erased || results[0].data?.status === "refused") &&
				!after.some(e => (e.kind === "inputAnswer" && e.requestId === affected && e.data?.value === "allow") ||
					(e.kind === "toolStarted" && e.toolCallId === affectedCall)) &&
				(await ext("answer", { requestId: affected, value: "allow" })).accepted === false);
			check("erasure triggers: an unaffected approval keeps its delivered route",
				(await ext("answer", { requestId: unaffected, value: "allow" })).accepted === true &&
				!(await ext("requests")).requests.some(q => q.id === affected && q.answerable));
		}
		if (trigger === "fork") {
			const copied = await store.pages(reply.sessionId);
			check("erasure triggers: fork copies tombstones without source links", copied.some(e => e.erased && !e.sources?.length) && !JSON.stringify(copied).includes(secret), JSON.stringify(copied.map(e => [e.kind, !!e.erased, e.sources?.length ?? 0])));
		}
	});
	leases.clear();
}
erasureTriggers.capture = ({ path, lease }) => { if (lease) leases.set(path, lease); };

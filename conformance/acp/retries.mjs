import { validActor } from "./portable.mjs";

const NS = "modular-agent";
const meta = (reply) => reply?._meta?.[NS];

export async function retryAsDifferentPrincipal({ init, writer, firstInputId, check, grant, load, send }) {
	const peer = meta(init)?.actor;
	if (grant) {
		if (!check("WebSocket: the other token has a different principal", !!writer && validActor(peer) && writer !== peer.id)) return;
		await grant(peer);
	}
	await load();
	const reply = await send().catch((error) => error);
	const receipt = meta(reply);
	check("Input admission: a different principal gets a new admission, not the old receipt",
		!!firstInputId && receipt?.duplicate !== true && typeof receipt?.inputId === "string" && receipt.inputId !== firstInputId && receipt?.outcome?.kind === "completed",
		JSON.stringify(receipt ?? { code: reply?.code, data: reply?.data, message: reply?.message }));
	return receipt?.inputId;
}

export async function websocketRetries(kit) {
	const { check, within, connect, prompt, closeSession, setOption, stop, crash, actor, otherToken, store, project, reopenWatchdog } = kit;
	const peers = [];
	const start = (token) => {
		const peer = connect(undefined, {}, token);
		peers.push(peer);
		return peer;
	};
	const initialize = (peer) => within(15000, peer.ctx.request("initialize", { protocolVersion: 1, clientCapabilities: {} }), "initialize retry fixture");
	const projectParams = { cwd: project, mcpServers: [] };
	const load = async (peer, sessionId) => within(await reopenWatchdog(), peer.ctx.request("session/load", { sessionId, ...projectParams }), "reopen keyed input session");
	const key = "kit-websocket-retry";
	const send = (peer, sessionId) => within(15000, prompt(peer, sessionId, "hello", key), "keyed input");
	try {
		const writer = start();
		const principal = meta(await initialize(writer))?.actor;
		if (!check("WebSocket: the supplied token selects the expected actor", validActor(principal) && principal.id === actor)) return;
		const opened = await within(15000, writer.ctx.request("session/new", projectParams), "create retry fixture");
		const { sessionId } = opened;
		await setOption(writer, sessionId, "model", "conformance/echo");
		const first = meta(await send(writer, sessionId));
		check("Input admission: the writer gets a completed admission", typeof first?.inputId === "string" && first.outcome?.kind === "completed" && first.duplicate !== true);
		await closeSession(writer, sessionId);
		await crash(writer);

		const reopener = start();
		const reconnected = meta(await initialize(reopener))?.actor;
		check("WebSocket: reconnecting with the same token selects the same actor", reconnected?.id === actor);
		const loaded = await load(reopener, sessionId);
		check("portable: writer and reopener declare portableSessions", [opened, loaded].every(r => meta(r)?.declaration?.portableSessions === true));
		const same = meta(await send(reopener, sessionId));
		check("Input admission: the same principal gets the original receipt after reopen", same?.duplicate === true && same.inputId === first?.inputId, JSON.stringify(same));
		await closeSession(reopener, sessionId);

		const other = start(otherToken);
		const init = await initialize(other);
		const denied = await load(other, sessionId).catch(error => error);
		check("WebSocket: the other token alone does not grant session access", denied?.code === -32602 && denied?.data?.code === "forbidden");
		const newInputId = await retryAsDifferentPrincipal({
			init, writer: actor, firstInputId: first?.inputId, check,
			grant: (peer) => store.grantRecordedActor(sessionId, actor, peer),
			load: () => load(other, sessionId), send: () => send(other, sessionId),
		});
		await closeSession(other, sessionId);
		const kept = (await store.pages(sessionId)).filter(e => e.kind === "inputAccepted" && e.data?.key === key);
		check("portable: the shared store keeps one admission per principal for the key", kept.length === 2 &&
			kept[0].actorId === actor && kept[0].inputId === first?.inputId &&
			kept[1].actorId === meta(init)?.actor?.id && kept[1].inputId === newInputId);
	} finally { for (const peer of peers.reverse()) await stop(peer); }
}

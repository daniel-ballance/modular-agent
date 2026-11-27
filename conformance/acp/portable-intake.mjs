import { isDeepStrictEqual } from "node:util";

export async function malformedHistoryChecks({ store, s, canConfigure, connect, project, seed, within, reopenWatchdog, check, closeSession, stop }) {
	// Do these last: a corrupt retained log can also block a deployment-wide
	// reservation or erasure scan. Watch the actual writes as well as the view.
	const writes = [];
	const tap = await store.observe({ onRequest: ({ method, path }) => {
		if (method === "PUT" || method === "POST" && !/\/lease(?:\/|$)/.test(path)) writes.push(path);
	} });
	const bad = canConfigure ? connect({ MODULAR_AGENT_HISTORY_URL: tap.url }) : s;
	try {
		if (bad !== s) await bad.ctx.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
		for (const mode of ["incomplete-report", "nested-id", "missing-ceiling", "missing-disposition", "failed-position"]) {
			const sid = await seed(mode), before = await store.pages(sid);
			const updates = bad.updates.length;
			writes.length = 0;
			const reply = await within(await reopenWatchdog(), bad.ctx.request("session/load", { sessionId: sid, cwd: project, mcpServers: [] }), "malformed portable load").catch(e => e);
			check(`portable: refuse ${mode} without scheduling work or rewriting history`, Number.isInteger(reply?.code) &&
				writes.length === 0 && bad.updates.length === updates && isDeepStrictEqual(await store.pages(sid), before),
				JSON.stringify({ code: reply?.code, data: reply?.data, message: reply?.message, writes }));
			if (!reply?.code && !(reply instanceof Error)) await closeSession(bad, sid).catch(() => undefined);
		}
	} finally {
		if (bad !== s) await stop(bad);
		tap.stop();
	}
}

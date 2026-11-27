import { isDeepStrictEqual as equal } from "node:util";

const namespace = "modular-agent";
const actor = { id: "rights-fixture", kind: "host" };
const broad = ["watch", "input", "settings"];
const forbidden = (promise) => promise.then(() => false, error => error.data?.code === "forbidden");

export async function stdioRights({ project, connect, stop, check, within, history, prompt, closeSession, attempt, command }) {
	const open = (rpc) => rpc("session/new", { cwd: project, mcpServers: [] });
	const load = (rpc, sessionId) => rpc("session/load", { sessionId, cwd: project, mcpServers: [] });
	const grants = (entries) => entries.filter(entry => entry.kind === "actorJoined" || entry.kind === "actorLeft");
	const sameRights = (actual, expected) => Array.isArray(actual) && equal([...actual].sort(), [...expected].sort());
	async function withPeer(label, ceiling, fn) {
		const peer = connect(command, ceiling === undefined ? {} : { MA_ACP_STDIO_RIGHTS: JSON.stringify(ceiling) });
		const rpc = async (method, params) => {
			try { return await within(15000, peer.ctx.request(method, params), method); }
			catch (error) {
				if (error.data?.code === "forbidden") throw error;
				throw new Error(`${method}: ${error.message} ${JSON.stringify(error.data ?? {})}`, { cause: error });
			}
		};
		try {
			const hello = await rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
			const principal = hello._meta?.[namespace]?.actor;
			check(`${label}: initialize identifies the configured actor`, principal?.id === actor.id && principal.kind === actor.kind);
			const expected = ceiling === undefined ? broad : broad.filter(right => ceiling.includes(right));
			check(`${label}: initialize advertises the connection's effective rights`, sameRights(principal?.rights, expected));
			await fn(peer, rpc);
		} finally { await stop(peer); }
	}

	await attempt("stdio rights: prospective grant", () => withPeer("prospective", ["watch", "input", "tools"], async (peer, rpc) => {
		const { sessionId } = await open(rpc);
		const { entries } = await within(15000, history(peer, sessionId, { all: true }), "read prospective grant");
		const [grant] = grants(entries);
		check("prospective: creation records only intersected rights", grant?.data.actor.id === actor.id && sameRights(grant.data.actor.rights, ["watch", "input"]));
	}));
	await attempt("stdio rights: disjoint lists", () => withPeer("disjoint", ["tools"], async (_peer, rpc) => {
		check("disjoint: an empty intersection forbids creation", await forbidden(open(rpc)));
	}));
	await attempt("stdio rights: empty ceiling", () => withPeer("empty", [], async (_peer, rpc) => {
		check("empty: an explicit empty ceiling forbids creation", await forbidden(open(rpc)));
	}));
	await attempt("stdio rights: recorded grant on reopen", async () => {
		let id, before;
		await withPeer("broad", undefined, async (peer, rpc) => {
			id = (await open(rpc)).sessionId;
			const reply = await within(15000, prompt(peer, id, "Record this session."), "seed recorded session");
			check("broad: input completes a turn", reply.stopReason === "end_turn");
			before = (await within(15000, history(peer, id, { all: true }), "read original grant")).entries;
			const [grant] = grants(before);
			check("broad: the original grant includes input", sameRights(grant?.data.actor.rights, broad));
			await within(15000, closeSession(peer, id), "close original session");
		});
		await withPeer("reopen", ["watch", "tools"], async (peer, rpc) => {
			await load(rpc, id);
			check("reopen: recorded input cannot exceed the new ceiling", await forbidden(rpc(`_${namespace}/input`, {
				sessionId: id, content: "denied", key: "rights-ceiling", when: "now",
			})));
			await within(15000, closeSession(peer, id), "close narrowed session");
		});
		await withPeer("restored", undefined, async (peer, rpc) => {
			await load(rpc, id);
			const { entries } = await within(15000, history(peer, id, { all: true }), "read original grant after reopen");
			const admissions = (rows) => rows.filter(entry => entry.kind === "inputAccepted");
			check("restored: a narrow reopen does not change grants or admit denied input", equal(grants(before), grants(entries)) &&
				equal(admissions(before), admissions(entries)));
			const reply = await within(15000, prompt(peer, id, "Use the original input right."), "prompt with original grant");
			check("restored: input works again under the original grant", reply.stopReason === "end_turn", JSON.stringify(reply));
		});
	});
}

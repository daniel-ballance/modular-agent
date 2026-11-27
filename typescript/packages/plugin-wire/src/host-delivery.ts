import { AsyncLocalStorage } from "node:async_hooks";
import type { Authority, PluginApi } from "@modular-agent/harness";
import type { Delivery } from "./outbound.js";
import { WireError, type WirePeer } from "./wire.js";

type Scope = { sessionId?: string; actors?: string[]; jobs?: string[]; signal?: AbortSignal; delivery?: (right: Authority) => Delivery | undefined };
const scopeOf = (p: any): string | undefined => p?.sessionId ?? p?.turn?.sessionId ?? p?.payload?.sessionId;
const rightFor = (method: string): Authority => /^(?:host\/)?tools\/call$|^host\/(?:tools\/list|env\/|ask$)/.test(method) ? "tools" : "watch";

export function deliveryFor(api: PluginApi, sessionId: string, actors: string[], jobs: string[]) {
	// Both the authority ceiling and the freshness witness belong to the work,
	// not to whichever request first started the writer's drain loop.
	const inScope = AsyncLocalStorage.snapshot();
	const witness = api.deliveryWitness(sessionId);
	return (right: Authority): Delivery => async send => {
		await inScope(async () => {
			let allowed = false;
			try { allowed = await witness() && api.workMay(sessionId, "watch", actors, jobs) && (right === "watch" || api.workMay(sessionId, right, actors, jobs)); }
			catch { /* unavailable authority is not a grant */ }
			if (!allowed) throw new WireError("withheld", "Plugin delivery is no longer available");
			send();
		});
	};
}

export function configureHostDelivery(peer: WirePeer, api: PluginApi, parents: ReadonlyMap<string | number, Scope>): void {
	peer.configureDelivery((method, params) => {
		// These control requests must be able to clean up the very state that
		// is now unavailable to ordinary session RPCs.
		if (method === "provider/discard" || method === "env/sessionEnded") return;
		const session = scopeOf(params);
		if (session) return deliveryFor(api, session, [...api.workActors(session), ...(typeof params.actorId === "string" ? [params.actorId] : [])], api.workJobs(session))(rightFor(method));
	}, (method, params) => {
		const parent = parents.get(params?.parentRequestId);
		if (parent?.delivery) return parent.delivery(rightFor(method));
		const session = scopeOf(params);
		if (session) return deliveryFor(api, session, parent?.actors ?? [], parent?.jobs ?? [])(rightFor(method));
	});
}
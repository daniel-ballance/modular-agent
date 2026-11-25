import { AsyncLocalStorage } from "node:async_hooks";
import type { QueuedInput } from "./session.js";
import type { Authority } from "./types.js";

export type ConnectionRights = NonNullable<QueuedInput["connectionRights"]>;
export const connectionRights = new AsyncLocalStorage<ConnectionRights>();
export function intersectConnectionRights(...scopes: (ConnectionRights | undefined)[]): ConnectionRights | undefined {
	const rights = new Map<string, Authority[]>();
	for (const scope of scopes) for (const [actor, ceiling] of Object.entries(scope ?? {})) {
		const prior = rights.get(actor);
		rights.set(actor, prior ? prior.filter(right => ceiling.includes(right)) : ceiling);
	}
	return rights.size ? Object.fromEntries(rights) : undefined;
}

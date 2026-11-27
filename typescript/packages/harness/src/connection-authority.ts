import { AsyncLocalStorage } from "node:async_hooks";
import type { QueuedInput } from "./session.js";
import type { Authority } from "./types.js";

export type ConnectionRights = NonNullable<QueuedInput["connectionRights"]>;
export const connectionRights = new AsyncLocalStorage<ConnectionRights>();
// Trusted binding policy for this one open, not a grant or a work ceiling.
export interface SessionOpenPolicy {
	sessionId: string;
	joinOnOpen: boolean;
	severalActors: boolean;
	allows(project: string, tenant?: string): boolean;
	required?: readonly Authority[];
}
export const sessionOpenPolicy = new AsyncLocalStorage<SessionOpenPolicy>();
export function withSessionOpenPolicy<T>(policy: SessionOpenPolicy, run: () => T): T {
	return sessionOpenPolicy.run(policy, run);
}
export function intersectConnectionRights(...scopes: (ConnectionRights | undefined)[]): ConnectionRights | undefined {
	const rights = new Map<string, Authority[]>();
	for (const scope of scopes) for (const [actor, ceiling] of Object.entries(scope ?? {})) {
		const prior = rights.get(actor);
		rights.set(actor, prior ? prior.filter(right => ceiling.includes(right)) : ceiling);
	}
	return rights.size ? Object.fromEntries(rights) : undefined;
}

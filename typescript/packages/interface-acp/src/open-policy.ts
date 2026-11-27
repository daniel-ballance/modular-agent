import { ALL_AUTHORITY, type Actor } from "@modular-agent/harness";
import type { AcpOptions } from "./index.js";
export { withSessionOpenPolicy } from "@modular-agent/harness";

export function localAcpActor(id = "acp-user"): Actor & { kind: "host" } {
	return { id, kind: "host", authority: [...ALL_AUTHORITY] };
}

export function openPolicy(sessionId: string, cwd: string, options: AcpOptions, severalActors: boolean | undefined, tools: boolean) {
	return { sessionId, joinOnOpen: options.joinOnOpen ?? (options.actor === undefined), severalActors: severalActors ?? false,
		required: tools ? ["tools" as const] : undefined,
		allows: (project: string, tenant?: string) => project === cwd && (options.allowAttached?.(project, tenant) ?? true) };
}

import type { parseModel } from "./settings.js";
import type { Command, PluginApi } from "./plugin-api.js";
import { SessionAuthority } from "./authority.js";
import { SessionLifecycle } from "./session-lifecycle.js";
import { TurnExecution } from "./turn-execution.js";
import { TurnModelAccess } from "./model-access.js";
import { InterfaceToolRoutes } from "./interface-tool-routes.js";
import { InputRequests } from "./input-requests.js";
import { SessionErasure } from "./session-erasure.js";
import { failure } from "./failure.js";
import { Reservations, resourceBytes } from "./reservations.js";
import { isDeepStrictEqual } from "node:util";
import { Session } from "./session.js";
import { type ModelAccess, type Provider, type ToolDefinition, type WorkingEnvironment } from "./types.js";

interface CommandsOperations {
	lifecycle(): Pick<SessionLifecycle, "session" | "checkWriter">;
	erasure(): Pick<SessionErasure, "reconcilePending" | "checkPending">;
	authority(): Pick<SessionAuthority, "requireAuthority" | "rightsOf" | "turnAuthority">;
	commandTable(): ReadonlyMap<string, Command & { plugin: string }>;
	newId(): string;
	reservations(): Reservations;
	api(pluginName: string): PluginApi;
	providerFor(s: Session, ref?: ReturnType<typeof parseModel> | null): Provider | undefined;
	modelAccess(s: Session, ref?: ReturnType<typeof parseModel> | null): ModelAccess | undefined;
	toolDefinitions(s?: Session): ToolDefinition[];
	interfaceTools(): Pick<InterfaceToolRoutes, "interfaceSources">;
	turns(): Pick<TurnExecution, "turnSettings">;
	turnModels(): Pick<TurnModelAccess, "turnModel">;
	questions(): Pick<InputRequests, "ask">;
	environmentFor(s: Session): Promise<WorkingEnvironment | undefined>;
	scopedEnvironment(env: WorkingEnvironment, check: () => void): WorkingEnvironment;
}

export class Commands {
	constructor(private readonly operations: CommandsOperations) {}

	async runCommand(sessionId: string, line: string, actorId: string): Promise<string | void> {
		const match = /^\/(\S+)\s?([\s\S]*)$/.exec(line.trimStart());
		if (!match) throw failure("invalid_params", "Not a command");
		const session = this.operations.lifecycle().session(sessionId);
		await this.operations.erasure().reconcilePending(session);
		this.operations.authority().requireAuthority(session, actorId, "input");
		this.operations.lifecycle().checkWriter(session);
		const command = this.operations.commandTable().get(match[1]);
		if (!command) throw failure("not_found", `Unknown command /${match[1]}`);
		const stepId = this.operations.newId();
		const commandReservation = `command:${stepId}`;
		if (!this.operations.reservations().reserve(session, commandReservation, { calls: 1, bufferedBytes: resourceBytes(line),
			storageBytes: this.operations.reservations().limits.settlementBytes })) throw failure("busy", "No capacity for command");
		const authority = { startingRights: this.operations.authority().rightsOf(session, actorId) };
		const scope = { sessionId, actors: new Set([actorId]), jobs: new Set<string>(), state: authority };
		const abort = new AbortController();
		const signal = AbortSignal.any([abort.signal, session.interruption.signal]);
		const live = () => {
			if (abort.signal.aborted || session.closed || session.closing || session.suspended) {
				throw Object.assign(new Error("Command context has settled"), { code: "invalid_request" });
			}
			signal.throwIfAborted();
			this.operations.erasure().checkPending(session);
			this.operations.lifecycle().checkWriter(session);
			this.operations.authority().requireAuthority(session, actorId, "input");
		};
		let tail = Promise.resolve();
		try {
			return await this.operations.authority().turnAuthority.run(scope, () => command.run(match[2], { sessionId, actorId, stepId, signal, api: this.operations.api(command.plugin),
				requestModel: async (request) => {
					live();
					if (!command.usesModel) throw Object.assign(new Error("Command did not declare usesModel"), { code: "not_supported" });
					const snapshot = structuredClone(request);
					const pending = tail.then(async () => {
						live();
						await this.operations.providerFor(session)?.refreshModels?.();
						const model = this.operations.modelAccess(session);
						if (!model) throw Object.assign(new Error("The selected model is not offered"), { code: "invalid_request" });
						const allowed = this.operations.authority().rightsOf(session, actorId).includes("tools") ? this.operations.toolDefinitions(session) : [];
						const offered = session.settings.modelTools;
						const tools = snapshot.tools.filter(tool => (!tool.callers || tool.callers.includes("model")) && !this.operations.interfaceTools().interfaceSources.has(tool.name) &&
							(offered == null || Array.isArray(offered) && offered.includes(tool.name)) && allowed.some(t => isDeepStrictEqual(t, tool)));
						const settings = this.operations.turns().turnSettings(session, model.model);
						const maxOutput = Math.min(settings.maxOutput ?? Infinity, snapshot.settings.maxOutput ?? Infinity);
						const request = { ...snapshot, tools, providerTools: "none" as const, settings: { ...snapshot.settings,
							reasoning: snapshot.settings.reasoning ?? settings.reasoning, maxOutput: Number.isFinite(maxOutput) ? maxOutput : undefined } };
						return this.operations.turnModels().turnModel(session, undefined, { ...authority, sources: new Map(), actors: scope.actors, jobs: scope.jobs }, model, live)
							.request(request, { signal, stepId });
					});
					tail = pending.then(() => {}, () => {});
					return pending;
				},
				ask: async request => { live(); return this.operations.questions().ask(session, request, command.plugin, signal); },
				environment: async () => {
					live();
					const authorize = () => {
						if (!this.operations.authority().rightsOf(session, actorId).includes("tools")) throw failure("invalid_request", "Command cannot use the environment");
					};
					authorize();
					const environment = await this.operations.environmentFor(session);
					live();
					authorize();
					if (!environment) throw Object.assign(new Error("No working environment"), { code: "not_supported" });
					return this.operations.scopedEnvironment(environment, () => { live(); authorize(); });
				},
			}));
		} finally {
			abort.abort();
			await tail;
			this.operations.reservations().release(session, commandReservation);
		}
	}
}

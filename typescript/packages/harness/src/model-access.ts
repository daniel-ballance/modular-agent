import type { TurnState } from "./turn-state.js";
import { SessionErasure } from "./session-erasure.js";
import { failure, turnLimit } from "./failure.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { activeOperation, conversation, observeInference, type Operation } from "./telemetry.js";
import { Reservations, resourceBytes } from "./reservations.js";
import { isDeepStrictEqual } from "node:util";
import { modelView, withoutProviderData } from "./view.js";
import { HookRegistry } from "./hooks.js";
import { Session } from "./session.js";
import { type AgentEvent, type AssistantMessage, type Authority, type EntryDraft, type HistoryEntry, type ModelAccess, isToolCall } from "./types.js";

interface TurnModelAccessOperations {
	newId(): string;
	turnAuthority(): Pick<AsyncLocalStorage<{ sessionId: string; actors: Set<string>; jobs: Set<string>; state?: Pick<TurnState, "connectionRights" | "startingRights"> }>, "run">;
	tenantBudgetReached(s: Session): Promise<boolean>;
	erasure(): Pick<SessionErasure, "admitHistory" | "reconcileProviderErasure" | "checkProviderErasure" | "httpErasure" | "pendingRegistry">;
	reservations(): Reservations;
	checkScopedWork(s: Session, right: Authority): void;
	checkWriter(s: Session): void;
	hooks(): HookRegistry;
	commit(s: Session, drafts: EntryDraft[], pluginRecord?: boolean, guard?: () => boolean | Promise<boolean>): Promise<HistoryEntry[]>;
	emit(session: string | Session, type: string, data: any, source: string, ids?: Partial<AgentEvent>): void;
	reserveCall(s: Session, id: string, rebuilding?: boolean): boolean;
	step(s: Session, turnId: string, steps: Map<string, Operation>, stepId: string): Operation;
}

export class TurnModelAccess {
	constructor(private readonly operations: TurnModelAccessOperations) {}

	turnModel(s: Session, turnId: string | undefined, state: Pick<TurnState, "sources" | "actors" | "jobs" | "tenantLimit" | "capacityLimit" | "connectionRights" | "startingRights">,
		model: ModelAccess, authorize?: () => void): ModelAccess {
		const turn = activeOperation();
		const steps = "steps" in state ? (state as TurnState).steps : undefined;
		return { ...model, request: async (request, options) => {
			const stepId = options.stepId ?? [...state.sources.keys()].at(-1) ?? this.operations.newId();
			const work = () => this.operations.turnAuthority().run({ sessionId: s.id, actors: state.actors, jobs: state.jobs, state }, async () => {
				options.signal.throwIfAborted();
				if (state.tenantLimit || await this.operations.tenantBudgetReached(s)) { state.tenantLimit = true; throw turnLimit("tenantTokens"); }
				const freshness = await this.operations.erasure().admitHistory(s);
				await this.operations.erasure().reconcileProviderErasure(s, model.model.provider);
				this.operations.erasure().checkProviderErasure(s, model.model.provider);
				if (this.operations.erasure().httpErasure() && freshness !== "[]" && model.supports.keepsState !== false) {
					throw failure("unavailable", "The history registry cannot verify deletion of kept Provider state");
				}
				const attempt = `model:${stepId}`;
				const bounds = this.operations.reservations().limits;
				const requestBytes = resourceBytes(request);
				if (state.capacityLimit || requestBytes + 2048 > bounds.entryBytes ||
					!this.operations.reservations().reserve(s, attempt, { calls: 1, bufferedBytes: requestBytes, storageBytes: requestBytes + 3 * bounds.settlementBytes })) {
					state.capacityLimit = true;
					throw turnLimit("capacity");
				}
				const scope = { sessionId: s.id, turnId, stepId, provider: model.model.provider, model: { provider: model.model.provider, id: model.model.id } };
				const safeToRepeat = !!turnId && (model.supports.safeToRepeat === true || (model.supports.keepsState === false && model.supports.runsTools === false));
				let intentId: string | undefined;
				const finalCheck = async () => {
					if (await this.operations.erasure().admitHistory(s) !== freshness) throw failure("unavailable", "Erasure changed the model view");
					options.signal.throwIfAborted();
					authorize?.();
					this.operations.checkScopedWork(s, "watch");
					this.operations.erasure().checkProviderErasure(s, model.model.provider);
					this.operations.checkWriter(s);
				};
				const check = async () => {
					options.signal.throwIfAborted();
					if (await this.operations.tenantBudgetReached(s)) { state.tenantLimit = true; throw turnLimit("tenantTokens"); }
					await finalCheck();
				};
				const handoff = async (send: () => void) => {
					const publish = async () => { await finalCheck(); send(); };
					const registry = this.operations.erasure().pendingRegistry();
					if (registry) await registry.exclusive(publish); else await publish();
				};
				const prepareDispatch = async () => {
					await check();
					const input = { ...scope, request };
					const prepared = options.exactReplay ? input : (await this.operations.hooks().transform("provider.request", input)).value;
					if (!prepared || !isDeepStrictEqual(prepared.model, scope.model) || prepared.provider !== scope.provider || prepared.sessionId !== scope.sessionId ||
						!Array.isArray(prepared.request?.tools) || prepared.request.tools.some((tool) => !request.tools.some((offered) => isDeepStrictEqual(offered, tool))) ||
						!isDeepStrictEqual(prepared.request.providerTools, request.providerTools)) throw new Error("Invalid provider.request transform");
					await check();
					// A hook sees readable context. Restore opaque data only to unmodified,
					// unambiguously matched messages belonging to the selected Provider.
					const originals = options.exactReplay || !turnId ? [] : modelView(s.branch(), turnId, scope.provider)
						.map(message => ({ message, readable: withoutProviderData(message) }));
					const readable = options.exactReplay ? [] : prepared.request.messages.map(withoutProviderData);
					const unchanged = readable.length === originals.length && readable.every((message, i) => isDeepStrictEqual(message, originals[i].readable));
					const dispatched = options.exactReplay ? prepared.request : { ...prepared.request,
						messages: unchanged ? originals.map(({ message }) => message) : readable.map(message => {
							if (message.role !== "assistant") return message;
							const matches = originals.filter(candidate => isDeepStrictEqual(candidate.readable, message));
							return matches.length === 1 ? matches[0].message : message;
						}),
					};
					const size = resourceBytes(dispatched);
					if (size + 2048 > bounds.entryBytes || model.supports.runsTools !== false && dispatched.providerTools !== "none" ||
						!this.operations.reservations().resize(s, attempt, { calls: 1, bufferedBytes: size, storageBytes: size + 3 * bounds.settlementBytes })) {
						state.capacityLimit = true;
						throw turnLimit("capacity");
					}
					const [intent] = await this.operations.commit(s, [{
						kind: "modelRequest", writer: "harness", turnId, stepId, modelVisible: false,
						actorId: turnId ? undefined : [...state.actors][0],
						data: { model: scope.model, ...(model.supports.keepsState === true ? { keepsState: true } : {}), safeToRepeat, tools: prepared.request.tools.map((t) => t.name), ...(safeToRepeat ? { request: dispatched } : {}) },
						sources: state.sources.get(stepId),
					}]);
					try { await check(); }
					catch (error) {
						if (intent && !s.suspended) {
							await this.operations.commit(s, [{ kind: "response", writer: "harness", turnId, stepId, modelVisible: false,
								message: { role: "assistant", stop: "aborted", content: [] }, sources: [intent.id], data: { recovery: true } }]);
						}
						throw error;
					}
					intentId = intent?.id;
					options.onEffectiveRequest?.(prepared.request);
					return dispatched;
				};
				const attributes = { ...conversation(s.id), "modular_agent.turn.id": turnId, "modular_agent.step.id": stepId };
				let observed = Promise.resolve();
				const onEvent = (event: import("./types.js").ModelStreamEvent) => {
					observed = observed.then(() => this.operations.hooks().observe("provider.piece", { ...scope, turnId, stepId, piece: structuredClone(event) }));
					if (turnId) this.operations.emit(s, "model.output", event, "harness", { turnId, stepId });
					options.onEvent?.(event);
				};
				try {
					let message: AssistantMessage;
					try {
						if (model.prepareOnWire) {
							const work = { sessionId: s.id, actors: state.actors, jobs: state.jobs, state };
							message = await observeInference(scope.provider, scope.model.id, attributes, !!options.onEvent, () => model.request(request, { ...options, onEvent,
								prepareDispatch: () => this.operations.turnAuthority().run(work, prepareDispatch),
								handoff: send => this.operations.turnAuthority().run(work, () => handoff(send)) }));
						} else {
							const dispatched = await prepareDispatch();
							let result!: Promise<AssistantMessage>;
							await handoff(() => {
								result = observeInference(scope.provider, scope.model.id, attributes, !!options.onEvent,
									() => model.request(dispatched, { ...options, requestPrepared: true, onEvent }), model.inProcessInference !== true);
								void result.catch(() => {});
							});
							message = await result;
						}
					} catch (error) {
						if (turnId || !intentId) throw error;
						message = options.signal.aborted ? { role: "assistant", stop: "aborted", content: [] }
							: { role: "assistant", stop: "failed", content: [], error: { kind: "other", message: String(error) } };
					}
					const reserved: string[] = [];
					const calls = message.content.filter(isToolCall);
					const size = resourceBytes(message);
					const replace = !!turnId && calls.length > 0;
					let fits = size + 2048 <= bounds.entryBytes && this.operations.reservations().resize(s, attempt, {
						calls: replace ? 0 : 1, bufferedBytes: size, storageBytes: size + 2 * bounds.settlementBytes,
					});
					if (fits && turnId) for (const call of calls) {
						if (!this.operations.reserveCall(s, call.id)) { fits = false; break; }
						reserved.push(call.id);
					}
					if (!fits) {
						for (const id of reserved) this.operations.reservations().release(s, `call:${id}`);
						state.capacityLimit = true;
						message = { role: "assistant", content: [], usage: message.usage, stop: "failed",
							error: { kind: "other", message: "Response exceeds reserved capacity" } };
					}
					if (!model.prepareOnWire) await this.operations.hooks().observe("provider.response", { ...scope, message: withoutProviderData(message) });
					if (!turnId && intentId) await this.operations.commit(s, [{ kind: "response", writer: "harness", stepId,
						actorId: [...state.actors][0], message, modelVisible: false, sources: [intentId] }]);
					return message;
				} finally {
					if (!turnId || !intentId) this.operations.reservations().release(s, attempt);
					await observed;
					if (turnId) this.operations.emit(s, "model.streamEnd", {}, "harness", { turnId, stepId }); }
			});
			if (!turnId || !steps) return work();
			const step = () => this.operations.step(s, turnId, steps, stepId);
			return (turn ? turn.run(step) : step()).run(work);
		} };
	}
}

import { normalizeSetting } from "./harness.js";
import type { Transaction, InputOptions } from "./plugin-api.js";
import { SessionLifecycle } from "./session-lifecycle.js";
import { InputAdmission } from "./input-admission.js";
import { InputRequests } from "./input-requests.js";
import { SessionErasure } from "./session-erasure.js";
import { ApprovalReconciliation } from "./approval-reconciliation.js";
import { failure } from "./failure.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { conversation, startOperation, TURN_TRACE, type Operation } from "./telemetry.js";
import { Reservations, resourceBytes } from "./reservations.js";
import { RunReceipts, type ReceiptOperation } from "./run-receipts.js";
import { INTERFACE_HANDOFF } from "./interface-tools.js";
import { inputIdOf, Session } from "./session.js";
import { type AgentEvent, type EntryDraft, type HistoryEntry, type HistoryStore, type InputRequest, type ToolCall, isToolCall } from "./types.js";

const PROVISIONAL_SETUP = new Set(["tenant", "actorJoined", "actorLeft", "setting", "limit", "plugins", "harness.parentAuthority"]);

const STANDARD_ENTRY_KINDS = new Set("limit tenant actorJoined actorLeft setting inputAccepted inputHandedBack input turnStart modelRequest response toolStarted toolPending modular-agent.interfaceHandoff toolResult inputRequest secretAnswerAccepted inputAnswer resultFeedback modular-agent.stepAfter turnEnd summary position erasure jobStarted jobCleanupUnconfirmed jobEnded plugins".split(" "));

interface HistoryCommitOperations {
	erasure(): Pick<SessionErasure, "pendingRegistry">;
	receiptOperation(): Pick<AsyncLocalStorage<ReceiptOperation>, "getStore">;
	receipts(): RunReceipts;
	newId(): string;
	now(): number;
	approvals(): Pick<ApprovalReconciliation, "maximum">;
	reservations(): Reservations;
	lifecycle(): Pick<SessionLifecycle, "interruptSession" | "write" | "watchWriter" | "checkWriter">;
	use<T>(capability: string): T | undefined;
	questions(): Pick<InputRequests, "recordedOpenRequests" | "hasQuestionRoute">;
	emit(session: string | Session, type: string, data: any, source: string, ids?: Partial<AgentEvent>): void;
	admission(): Pick<InputAdmission, "input">;
}

export class HistoryCommit {
	constructor(private readonly operations: HistoryCommitOperations) {}

	commit(s: Session, drafts: EntryDraft[], pluginRecord = false, guard?: () => boolean | Promise<boolean>): Promise<HistoryEntry[]> {
		// A suspended session's process has stopped: nothing more is recorded for it here.
		const run = s.committing.then(() => {
			const registry = this.operations.erasure().pendingRegistry();
			const write = async () => guard && !await guard() ? [] : this.commitNow(s, drafts, pluginRecord);
			return registry ? registry.exclusive(write) : write();
		});
		s.committing = run.catch(() => undefined);
		return run;
	}

	async observeCommit<T>(s: Session, count: number, work: (span: Operation) => Promise<T>): Promise<T> {
		const span = startOperation("modular_agent.history.commit", { ...conversation(s.id), "modular_agent.history.entry.count": count });
		try {
			const result = await span.run(() => work(span));
			span.set("modular_agent.history.commit.status", s.suspended ? "failed" : "committed");
			return result;
		} catch (error) {
			const status = (error as { code?: string }).code === "lost" ? "uncertain" : "failed";
			span.set("modular_agent.history.commit.status", status);
			span.fail(status);
			throw error;
		} finally { span.end(); }
	}

	commitNow(s: Session, drafts: EntryDraft[], pluginRecord = false): Promise<HistoryEntry[]> {
		return this.observeCommit(s, drafts.length, span => this.commitBatch(s, drafts, pluginRecord, span));
	}

	private async commitBatch(s: Session, drafts: EntryDraft[], pluginRecord: boolean, span: Operation): Promise<HistoryEntry[]> {
		s.interruption.signal.throwIfAborted();
		if (s.suspended) return [];
		const op = this.operations.receiptOperation().getStore();
		const first = !pluginRecord && op && !op.bound && op.thread === s.id && drafts.find(d => d.actorId === op.actor && (
			d.kind === "inputAccepted" && (d.data as {key?:string})?.key === op.key ||
			d.kind === "inputAnswer" && op.answers.has(d.requestId!) || d.kind === "toolResult" && op.reports.has(d.toolCallId!)));
		if (first) {
			if (s.entries.has(op.id)) throw failure("conflict", "Run already accepted");
			// Use the operation's own entry as the commit witness, including in a mixed batch.
			const previous = first.id;
			first.id = op.id;
			if (previous) for (const d of drafts) if (d.sources) d.sources = d.sources.map(id => id === previous ? op.id : id);
			this.operations.receipts().reserve(s.id, op.id);
		}
		const firstAdmission = s.provisional && drafts.some(d => d.kind === "inputAccepted");
		if (s.provisional && !firstAdmission && drafts.some(d => !PROVISIONAL_SETUP.has(d.kind))) {
			throw failure("invalid_request", "Session has not admitted its first input");
		}
		let position = s.position;
		const entries: HistoryEntry[] = drafts.map((d) => {
			const entry: HistoryEntry = { ...d, id: d.id ?? this.operations.newId(), parentId: position, sessionId: s.id, time: this.operations.now() };
			if (entry.kind === "setting") {
				const setting = normalizeSetting(entry.data as { key: string; value: unknown });
				const changes = setting.key === "settings" ? setting.value : { [setting.key]: setting.value };
				if (changes && typeof changes === "object" && "approvalWait" in changes) {
					if (!this.operations.approvals().maximum) throw failure("not_supported", "Waiting approvals are not enabled");
					if (changes.approvalWait !== "live" && changes.approvalWait !== "untilDeadline") throw failure("invalid_params", "Invalid approvalWait setting");
				}
				entry.data = setting;
			}
			if (pluginRecord && (entry.kind === "toolPending" || entry.kind === INTERFACE_HANDOFF)) throw failure("invalid_request", "Only the Harness records pending calls");
			if (entry.kind === "inputRequest") {
				const request = (entry.data as { request?: InputRequest })?.request;
				if (pluginRecord && request?.coversNested !== undefined) throw failure("invalid_request", "Only the approval gate sets coverage");
				if (request?.approvalWait !== undefined) {
					if (pluginRecord || request.approvalWait !== "untilDeadline") throw failure("invalid_request", "Only the approval gate can park a call");
				}
				if (request?.timeLimitMs !== undefined) {
					request.deadlineAt = entry.time + request.timeLimitMs;
					if (!Number.isSafeInteger(request.timeLimitMs) || request.timeLimitMs < 0 || !Number.isSafeInteger(request.deadlineAt)) throw failure("invalid_request", "Unrepresentable question deadline");
				}
			}
			if (pluginRecord && entry.kind === "inputAnswer" && entry.data && typeof entry.data === "object" && "approvalView" in entry.data) throw failure("invalid_request", "Only the Harness can attest to delivery");
			if (!STANDARD_ENTRY_KINDS.has(entry.kind) && !entry.kind.includes(".")) entry.kind = `${entry.writer}.${entry.kind}`;
			position = entry.kind === "position" ? (entry.data as { to: string | null }).to : entry.id;
			return entry;
		});
		const bytes = entries.reduce((sum, entry) => sum + resourceBytes(entry), 0);
		const bounds = this.operations.reservations().limits;
		if (entries.some(entry => resourceBytes(entry) > bounds.entryBytes) || bytes > bounds.batchBytes) {
			const error = failure("result_too_large", "History batch or entry exceeds the write size limit");
			if (entries.some(entry => ["turnEnd", "toolResult", "inputAnswer", "inputHandedBack", "jobEnded", "response"].includes(entry.kind))) {
				this.operations.lifecycle().interruptSession(s, "commitFailed", error);
				throw failure("lost", "Required history record did not fit");
			}
			throw error;
		}
		const inputId = entries.find(e => e.kind === "input" && e.turnId)?.inputId;
		const allocations = entries.map(entry => {
			const control = !pluginRecord && ["actorLeft", "limit", "erasure", "jobCleanupUnconfirmed", "inputHandedBack"].includes(entry.kind);
			const keys: string[] = [];
			const add = (kind: string, id: string | undefined) => { if (id) keys.push(`${kind}:${id}`); };
			if (!pluginRecord) switch (entry.kind) {
				case "input": case "inputAccepted": case "inputHandedBack":
					add("input", inputIdOf(entry)); add("job", entry.jobId); break;
				case "turnStart": add("input", inputId); add("turn", entry.turnId); break;
				case TURN_TRACE: add("turn", entry.turnId); break;
				case "turnEnd":
					add("turn", entry.turnId); break;
				case "modelRequest": case "response":
					add("model", entry.stepId); break;
				case "jobStarted": case "jobEnded": case "jobCleanupUnconfirmed":
					add("job", entry.jobId); break;
				case "toolStarted": case "toolResult": case "toolPending": case INTERFACE_HANDOFF: case "modular-agent.nestedCall":
					add("call", entry.toolCallId); break;
				case "inputRequest": case "inputAnswer": case "secretAnswerAccepted":
					add("question", entry.requestId); break;
			}
			return { bytes: resourceBytes(entry), keys, control };
		});
		if (!this.operations.reservations().writeBatch(s, allocations)) {
			const error = failure("busy", "No history capacity for this write");
			if (entries.some(e => ["turnEnd", "toolResult", "inputAnswer", "inputHandedBack", "jobEnded", "response"].includes(e.kind))) {
				this.operations.lifecycle().interruptSession(s, "commitFailed", error);
				throw failure("lost", "Required history write could not be covered");
			}
			throw error;
		}
		if (firstAdmission) {
			const store = this.operations.use<HistoryStore>("history-store")!;
			const initial = [...s.order.map(id => s.entries.get(id)!), ...entries];
			span.set("modular_agent.history.entry.count", initial.length);
			await this.operations.lifecycle().write(s, async () => {
				await store.create(s.meta);
				await store.openForWriting(s.id);
				s.provisional = false;
				this.operations.lifecycle().watchWriter(s);
				this.operations.lifecycle().checkWriter(s);
				await store.append(s.id, initial);
			});
		} else if (!s.ephemeral && !s.provisional) {
			const store = this.operations.use<HistoryStore>("history-store");
			await this.operations.lifecycle().write(s, () => store?.append(s.id, entries));
		}
		if (first) op.bound = true;
		for (const e of entries) {
			// Attribute a closure to revocation only when this authority commit
			// actually removes the last eligible route. Presence changes are not grants.
			const routes = ["actorJoined","actorLeft","limit"].includes(e.kind)
				? this.operations.questions().recordedOpenRequests(s).map(r => [r,this.operations.questions().hasQuestionRoute(s,r)] as const) : [];
			s.apply(e);
			for (const [r, previouslyEligible] of routes) {
				if (this.operations.questions().hasQuestionRoute(s,r)) s.revokedQuestions.delete(r.id);
				else if (previouslyEligible) s.revokedQuestions.add(r.id);
			}
			if (e.kind === "inputAnswer") s.revokedQuestions.delete(e.requestId!);
			const inputId = inputIdOf(e);
			if (inputId && e.kind === "input" && e.turnId) {
				const unit = this.operations.reservations().limits.settlementBytes;
				if (this.operations.reservations().has(s, `turn:${e.turnId}`)) this.operations.reservations().release(s, `input:${inputId}`);
				else this.operations.reservations().transfer(s, `input:${inputId}`, `turn:${e.turnId}`, { storageBytes: 2 * unit });
			}
			if (inputId && e.kind === "inputHandedBack") this.operations.reservations().release(s, `input:${inputId}`);
			if (e.kind === "turnEnd" && e.turnId) {
				this.operations.reservations().release(s, `turn:${e.turnId}`);
				for (const id of s.order) {
					const kept = s.entries.get(id)!;
					if (kept.turnId === e.turnId && kept.stepId && kept.kind === "modelRequest") this.operations.reservations().release(s, `model:${kept.stepId}`);
				}
			}
			if (e.kind === "response" && e.stepId) this.operations.reservations().release(s, `model:${e.stepId}`);
			if (e.kind === "inputAnswer" && e.requestId) this.operations.reservations().release(s, `question:${e.requestId}`);
			if (e.kind === "toolResult" && e.toolCallId) this.operations.reservations().release(s, `call:${e.toolCallId}`);
			const ids = { turnId: e.turnId, stepId: e.stepId, toolCallId: e.toolCallId, actorId: e.actorId };
			this.operations.emit(s, "entry.added", e, e.writer, ids);
			if (e.kind === "response" && e.turnId && e.modelVisible && e.message?.role === "assistant") {
				for (const part of e.message.content.filter(isToolCall)) {
					const call: ToolCall = { id: part.id, name: part.name, input: part.arguments, startedBy: "model", stepId: e.stepId };
					this.operations.emit(s, "tool.call", { call }, e.writer, { ...ids, toolCallId: part.id });
				}
			}
			if (e.kind === "toolResult" && e.toolCallId && e.message?.role === "toolResult") {
				const data = e.data as { status?: string; value?: unknown } | undefined;
				this.operations.emit(s, "tool.result.delivered", { status: data?.status ?? "failed", content: e.message.content,
					...(data && "value" in data ? { value: data.value } : {}) }, "harness", ids);
			}
		}
		return entries;
	}

	async transaction(s: Session, plugin: string, fn: (tx: Transaction) => void | Promise<void>): Promise<void> {
		const drafts: EntryDraft[] = [];
		const inputs: InputOptions[] = [];
		await fn({
			append: (d) => drafts.push({ ...d, writer: d.writer ?? plugin }),
			setSetting: (key, value, actorId) => drafts.push({ kind: "setting", writer: plugin, actorId, modelVisible: false, data: { key, value } }),
			input: (o) => inputs.push(o),
		});
		// Nothing is kept unless the callback finished; then the entries are kept together.
		if (drafts.length) await this.commit(s, drafts, true);
		for (const o of inputs) await this.operations.admission().input(s.id, o);
	}
}

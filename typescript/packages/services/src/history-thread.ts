import type { HistoryStore } from "@modular-agent/harness";
import { parentPort, Worker, workerData } from "node:worker_threads";
import { ArchiveRecords } from "./history-archive-records.js";
import { BindingError, UncertainCommit, unavailable } from "./history-binding.js";
import { HistoryLeases, leaseClock } from "./history-leases.js";
import { Records, type HistoryTestControls } from "./history-records.js";
import { historyRequest, type HistoryRequest } from "./history-request.js";

type ThreadOptions = { dir?: string; restoreWitness?: string; controls?: HistoryTestControls } & (
	{ archive: true; exclusion?: { epoch: number; until: number } } |
	{ archive: false; ttl: number; retention: number | null; quota: number; profile: boolean });
type LocalMethods = Pick<HistoryStore, "create" | "openForWriting" | "close" | "append" | "load" | "erasureTenant" | "list" | "erase">;
type LocalCall = { [K in keyof LocalMethods]-?: [K, ...Parameters<NonNullable<LocalMethods[K]>>] }[keyof LocalMethods];
type HistoryJob = { kind: "ready" | "detach" | "close" } |
	{ kind: "attach"; ttl: number } |
	{ kind: "http"; request: HistoryRequest } |
	{ kind: "local"; owner: number; call: LocalCall };
type Reply = { id: number } & (
	{ value: unknown } | { uncertain: true } |
	{ failure: { status: number; code: string; message: string; retryAfterMs?: number } });

export class HistoryThread {
	private worker: Worker;
	private waiting = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
	private serial = 0;
	private failure?: Error;
	private failedState = new Int32Array(new SharedArrayBuffer(4));

	constructor(config: ThreadOptions) {
		this.worker = new Worker(new URL("./history-thread.js", import.meta.url), {
			// An SDK host can start with --input-type=module, which rejects a file entry point.
			execArgv: [],
			workerData: { config, failedState: this.failedState },
		});
		const fail = (error: Error) => {
			this.failure ??= error;
			Atomics.store(this.failedState, 0, 1);
			for (const { reject } of this.waiting.values()) reject(new UncertainCommit(error.message, { cause: error }));
			this.waiting.clear();
		};
		this.worker.on("error", fail);
		this.worker.on("exit", code => fail(new Error(`History storage thread exited (${code})`)));
		this.worker.on("message", (reply: Reply) => {
			const pending = this.waiting.get(reply.id)!;
			this.waiting.delete(reply.id);
			if (!this.waiting.size) this.worker.unref();
			if ("uncertain" in reply) pending.reject(new UncertainCommit());
			else if ("failure" in reply) {
				const { status, code, message, retryAfterMs } = reply.failure;
				pending.reject(new BindingError(status, code, message, retryAfterMs));
			} else pending.resolve(reply.value);
		});
		this.worker.unref();
	}

	get available() { return Atomics.load(this.failedState, 0) === 0; }
	async run<T>(job: HistoryJob): Promise<T> {
		if (this.failure) throw unavailable();
		const id = ++this.serial;
		const transfer = job.kind === "http" ? [job.request.raw.buffer as ArrayBuffer] : [];
		return await new Promise<T>((resolve, reject) => {
			this.worker.ref();
			this.waiting.set(id, { resolve: value => resolve(value as T), reject });
			try { this.worker.postMessage({ id, job }, transfer); }
			catch (error) {
				this.waiting.delete(id);
				if (!this.waiting.size) this.worker.unref();
				reject(error);
			}
		});
	}
	terminate() { return this.worker.terminate(); }
}

function serveThread(config: ThreadOptions, failedState: Int32Array<SharedArrayBuffer>) {
	const archive = config.archive ? new ArchiveRecords(config.dir, config.exclusion, config.controls, failedState, config.restoreWitness) : undefined;
	let records = config.archive ? undefined : new Records(config.dir, config.ttl, config.retention, config.quota, config.controls, failedState, config.restoreWitness);
	const nowUs = leaseClock(config.controls?.leaseClock);
	let leases = config.archive ? undefined : new HistoryLeases(config.ttl, nowUs);
	let ttl = config.archive ? 0 : config.ttl;
	let attached: ReturnType<ArchiveRecords["attach"]> | undefined;
	const profile = config.archive ? config.dir !== undefined : config.profile;
	async function run(job: HistoryJob) {
		switch (job.kind) {
			case "ready": return;
			case "attach":
				ttl = job.ttl;
				leases = new HistoryLeases(ttl, nowUs);
				attached = archive!.attach(id => leases!.current(id) !== undefined, ttl);
				return;
			case "detach":
				attached!.detach();
				attached = undefined;
				leases = undefined;
				return;
			case "close": records!.close(); records = undefined; return;
			case "http": return historyRequest(job.request, ttl, profile, undefined, attached?.records ?? records!, leases!, attached?.localHeld);
			case "local": {
				if (Atomics.load(failedState, 0) && job.call[0] !== "close") throw unavailable();
				const store = archive!.store(job.owner);
				const [method, first, second] = job.call;
				switch (method) {
					case "append": return store.append(first, second);
					case "erase": return store.erase!(first, second);
					case "create": return store.create(first);
					case "list": return store.list(first);
					case "load": return store.load(first);
					case "erasureTenant": return store.erasureTenant!(first);
					case "openForWriting": return store.openForWriting(first);
					case "close": return store.close(first);
				}
			}
		}
	}
	let tail = Promise.resolve();
	parentPort!.on("message", ({ id, job }: { id: number; job: HistoryJob }) => {
		tail = tail.then(async () => {
			let reply: Reply;
			try { reply = { id, value: await run(job) }; }
			catch (error) {
				if (error instanceof UncertainCommit) reply = { id, uncertain: true };
				else {
					const e = error instanceof BindingError ? error : unavailable();
					reply = { id, failure: { status: e.status, code: e.code, message: e.message, retryAfterMs: e.retryAfterMs } };
				}
			}
			parentPort!.postMessage(reply);
		});
	});
}

if (parentPort && workerData?.failedState instanceof Int32Array && workerData.config) {
	serveThread(workerData.config, workerData.failedState);
}

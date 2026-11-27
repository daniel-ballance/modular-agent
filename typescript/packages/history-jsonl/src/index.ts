import { randomUUID } from "node:crypto";
import { createReadStream, appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { erasedEntry, filePendingErasure, type HistoryEntry, type HistoryStore, type Plugin, type StoredSession } from "@modular-agent/harness";

type Line =
	| { type: "session"; meta: StoredSession }
	| { type: "entry"; batch: string; last?: true; entry: HistoryEntry };

function slug(project: string): string {
	return project.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "root";
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Entries that alone don't make a session worth keeping. */
const SETUP_KINDS = new Set(["setting", "actorJoined", "plugins"]);

/**
 * Session history as one JSONL file per session. A new session is written only
 * once something happens in it beyond setup, such as its first input, so a
 * session started just to look, as a host does to read the model list, leaves
 * nothing behind. Each batch of entries is
 * appended in one write and ends with a marker, so a torn write is dropped
 * on load: a batch is kept whole or not at all.
 */
export class JsonlHistoryStore implements HistoryStore {
	readonly supports = { erasure: true, retention: false, persistent: true };
	private paths = new Map<string, string>();
	private held = new Set<string>();
	/** New sessions not yet worth a file: their header and batches so far. */
	private unsaved = new Map<string, { meta: StoredSession; batches: HistoryEntry[][] }>();
	private registry?: ReturnType<typeof filePendingErasure>;
	get pendingErasure() {
		return this.registry ??= filePendingErasure(this.dir, { requireExisting: this.hasRecords() });
	}
	private hasRecords(): boolean {
		return existsSync(this.dir) && readdirSync(this.dir, { withFileTypes: true }).some(folder =>
			folder.isDirectory() && readdirSync(join(this.dir, folder.name)).some(file => file.endsWith(".jsonl")));
	}
	constructor(private dir: string) {}

	private fileFor(meta: { id: string; project: string }): string {
		const folder = join(this.dir, slug(meta.project));
		mkdirSync(folder, { recursive: true });
		return join(folder, `${meta.id}.jsonl`);
	}

	private find(id: string): string {
		const known = this.paths.get(id);
		if (known) return known;
		if (existsSync(this.dir)) {
			for (const { name: folder } of readdirSync(this.dir, { withFileTypes: true }).filter(d => d.isDirectory())) {
				const candidate = join(this.dir, folder, `${id}.jsonl`);
				if (existsSync(candidate)) {
					this.paths.set(id, candidate);
					return candidate;
				}
			}
		}
		throw Object.assign(new Error(`Session ${id} not found`), { code: "not_found" });
	}

	async create(meta: StoredSession): Promise<void> {
		this.unsaved.set(meta.id, { meta, batches: [] });
	}

	/** Write a new session's file, with what it has so far, and take its lock. */
	private save(id: string): void {
		const pending = this.unsaved.get(id)!;
		const path = this.fileFor(pending.meta);
		writeFileSync(path, JSON.stringify({ type: "session", meta: pending.meta } satisfies Line) + "\n", { flag: "wx" });
		this.paths.set(id, path);
		this.unsaved.delete(id);
		if (this.held.has(id)) writeFileSync(`${path}.lock`, String(process.pid));
		for (const batch of pending.batches) this.write(id, batch);
	}

	writerActive(id: string): boolean {
		try {
			const pid = Number(readFileSync(`${this.find(id)}.lock`, "utf8"));
			return Number.isSafeInteger(pid) && pid > 0 && alive(pid);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return false;
		}
	}

	async openForWriting(id: string): Promise<void> {
		this.pendingErasure.check();
		if (this.held.has(id)) return;
		if (this.unsaved.has(id)) {
			this.held.add(id);
			return;
		}
		const lock = `${this.find(id)}.lock`;
		if (existsSync(lock)) {
			const pid = Number(readFileSync(lock, "utf8"));
			if (!pid || alive(pid)) throw Object.assign(new Error(`Session ${id} is already open for writing by process ${pid}`), { code: "held", data: { retryAfterMs: 100 } });
			rmSync(lock, { force: true });
		}
		writeFileSync(lock, String(process.pid), { flag: "wx" });
		this.held.add(id);
	}

	async close(id: string): Promise<void> {
		if (!this.held.delete(id)) return;
		// Closed before anything happened in it: nothing to keep.
		if (this.unsaved.delete(id)) return;
		rmSync(`${this.find(id)}.lock`, { force: true });
	}

	async append(id: string, batch: HistoryEntry[]): Promise<void> {
		this.pendingErasure.check();
		if (!batch.length) return;
		if (!this.held.has(id)) throw Object.assign(new Error(`Session ${id} is not open for writing`), { code: "lost" });
		const pending = this.unsaved.get(id);
		if (pending) {
			pending.batches.push(batch);
			if (pending.meta.forkedFrom || batch.some((e) => !SETUP_KINDS.has(e.kind))) this.save(id);
			return;
		}
		this.write(id, batch);
	}

	private write(id: string, batch: HistoryEntry[]): void {
		const batchId = randomUUID();
		const lines = batch.map((entry, i) => JSON.stringify({ type: "entry", batch: batchId, ...(i === batch.length - 1 ? { last: true } : {}), entry } satisfies Line));
		appendFileSync(this.find(id), lines.join("\n") + "\n");
	}

	private read(path: string): { meta: StoredSession; entries: HistoryEntry[] } {
		let meta: StoredSession | undefined;
		const entries: HistoryEntry[] = [];
		let pending: HistoryEntry[] = [];
		let pendingBatch: string | undefined;
		for (const raw of readFileSync(path, "utf8").split("\n")) {
			if (!raw.trim()) continue;
			let line: Line;
			try {
				line = JSON.parse(raw);
			} catch {
				break; // a torn last line
			}
			if (line.type === "session") {
				meta = line.meta;
				continue;
			}
			if (pendingBatch !== line.batch) {
				pending = [];
				pendingBatch = line.batch;
			}
			pending.push(line.entry);
			if (line.last) {
				entries.push(...pending);
				pending = [];
				pendingBatch = undefined;
			}
		}
		if (!meta) throw Object.assign(new Error(`${path} has no session header`), { code: "lost" });
		return { meta, entries };
	}

	async load(id: string): Promise<{ meta: StoredSession; entries: HistoryEntry[] }> {
		this.pendingErasure.check();
		const pending = this.unsaved.get(id);
		if (pending) return { meta: pending.meta, entries: pending.batches.flat() };
		return this.read(this.find(id));
	}

	private async prefix(path: string, count: number): Promise<Line[]> {
		const input = createReadStream(path, { encoding: "utf8" });
		const reader = createInterface({ input, crlfDelay: Infinity });
		const rows: Line[] = [];
		try {
			for await (const line of reader) {
				rows.push(JSON.parse(line) as Line);
				if (rows.length === count) break;
			}
		} finally { reader.close(); input.destroy(); }
		return rows;
	}
	async erasureTenant(id: string): Promise<string | undefined> {
		this.pendingErasure.check();
		const [, first] = await this.prefix(this.find(id), 2);
		if (first?.type !== "entry" || first.entry.kind !== "tenant") return;
		const tenant = (first.entry.data as { tenant?: unknown } | undefined)?.tenant;
		if (first.entry.erased || typeof tenant !== "string") throw Object.assign(new Error("Invalid tenant setup record"), { code: "unavailable" });
		return tenant;
	}
	async list(filter?: { project?: string }): Promise<StoredSession[]> {
		this.pendingErasure.check();
		if (!existsSync(this.dir)) return [];
		const folders = filter?.project ? [slug(filter.project)] : readdirSync(this.dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
		const out: StoredSession[] = [];
		for (const folder of folders) {
			const path = join(this.dir, folder);
			if (!existsSync(path)) continue;
			for (const file of readdirSync(path).filter((f) => f.endsWith(".jsonl"))) {
				try {
					const [line] = await this.prefix(join(path, file), 1);
					if (line?.type === "session") out.push(line.meta);
				} catch {
					/* skip unreadable files */
				}
			}
		}
		return out.sort((a, b) => b.created - a.created);
	}

	/** Erase the content of these entries in every line that holds it, and rewrite the file. */
	async erase(id: string, entryIds: string[]): Promise<void> {
		this.pendingErasure.check();
		const pending = this.unsaved.get(id);
		if (pending) {
			const targets = new Set(entryIds);
			pending.batches = pending.batches.map((b) => b.map((e) => (targets.has(e.id) ? erasedEntry(e) : e)));
			return;
		}
		const path = this.find(id);
		if (!this.held.has(id) && existsSync(`${path}.lock`) && alive(Number(readFileSync(`${path}.lock`, "utf8")))) throw Object.assign(new Error(`Session ${id} is already open for writing`), { code: "held", data: { retryAfterMs: 100 } });
		const targets = new Set(entryIds);
		const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
		const rewritten = lines.map((raw) => {
			const line = JSON.parse(raw) as Line;
			if (line.type === "entry" && targets.has(line.entry.id)) {
				line.entry = erasedEntry(line.entry);
			}
			return JSON.stringify(line);
		});
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, rewritten.join("\n") + "\n");
		renameSync(tmp, path);
	}
}

export function jsonlHistory(options: { dir?: string } = {}): Plugin {
	return {
		name: "history-jsonl",
		setup(api) {
			api.provide("history-store", new JsonlHistoryStore(options.dir ?? join(api.home, "sessions")));
		},
	};
}

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HistoryEntry, HistoryStore, Plugin, StoredSession } from "@modular-agent/harness";

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

/**
 * Session history as one JSONL file per session. Each batch of entries is
 * appended in one write and ends with a marker, so a torn write is dropped
 * on load: a batch is kept whole or not at all.
 */
export class JsonlHistoryStore implements HistoryStore {
	readonly supports = { erasure: true, retention: false };
	private paths = new Map<string, string>();
	private held = new Set<string>();
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
			for (const folder of readdirSync(this.dir)) {
				const candidate = join(this.dir, folder, `${id}.jsonl`);
				if (existsSync(candidate)) {
					this.paths.set(id, candidate);
					return candidate;
				}
			}
		}
		throw new Error(`Session ${id} not found`);
	}

	async create(meta: StoredSession): Promise<void> {
		const path = this.fileFor(meta);
		writeFileSync(path, JSON.stringify({ type: "session", meta } satisfies Line) + "\n", { flag: "wx" });
		this.paths.set(meta.id, path);
	}

	async openForWriting(id: string): Promise<void> {
		if (this.held.has(id)) return;
		const lock = `${this.find(id)}.lock`;
		if (existsSync(lock)) {
			const pid = Number(readFileSync(lock, "utf8"));
			if (pid && pid !== process.pid && alive(pid)) throw new Error(`Session ${id} is already open for writing by process ${pid}`);
		}
		writeFileSync(lock, String(process.pid));
		this.held.add(id);
	}

	async close(id: string): Promise<void> {
		if (!this.held.delete(id)) return;
		rmSync(`${this.find(id)}.lock`, { force: true });
	}

	async append(id: string, batch: HistoryEntry[]): Promise<void> {
		if (!batch.length) return;
		if (!this.held.has(id)) throw new Error(`Session ${id} is not open for writing`);
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
		if (!meta) throw new Error(`${path} has no session header`);
		return { meta, entries };
	}

	async load(id: string): Promise<{ meta: StoredSession; entries: HistoryEntry[] }> {
		return this.read(this.find(id));
	}

	async list(filter?: { project?: string }): Promise<StoredSession[]> {
		if (!existsSync(this.dir)) return [];
		const folders = filter?.project ? [slug(filter.project)] : readdirSync(this.dir);
		const out: StoredSession[] = [];
		for (const folder of folders) {
			const path = join(this.dir, folder);
			if (!existsSync(path)) continue;
			for (const file of readdirSync(path).filter((f) => f.endsWith(".jsonl"))) {
				try {
					const first = readFileSync(join(path, file), "utf8").split("\n", 1)[0];
					const line = JSON.parse(first) as Line;
					if (line.type === "session") out.push(line.meta);
				} catch {
					/* skip unreadable files */
				}
			}
		}
		return out.sort((a, b) => b.created - a.created);
	}

	/** Erase the content of these entries in every line that holds it, and rewrite the file. */
	async erase(id: string, entryIds: string[]): Promise<void> {
		const path = this.find(id);
		const targets = new Set(entryIds);
		const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
		const rewritten = lines.map((raw) => {
			const line = JSON.parse(raw) as Line;
			if (line.type === "entry" && targets.has(line.entry.id)) {
				line.entry = { ...line.entry, message: undefined, data: { erased: true }, modelVisible: false };
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

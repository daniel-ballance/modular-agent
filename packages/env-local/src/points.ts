import { constants } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

const copy = { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, mode: constants.COPYFILE_FICLONE };

/** Points are private to this environment instance. Never follow links out of a project. */
export class SavedPoints {
	private folder?: Promise<string>;
	private points = new Map<string, { project: string; path: string; sessionId?: string }>();

	constructor(private home?: string) {}

	private excluded(project: string, candidate: string): boolean {
		if (!this.home) return false;
		const home = resolve(this.home);
		if (home === project) {
			// When state and the project share a folder, leave the agent's own state alone.
			return /^(?:run|sessions|history|credentials\.json|settings\.json|trust\.json)(?:\/|$)/.test(relative(project, candidate));
		}
		return candidate === home || candidate.startsWith(home + sep);
	}

	async save(cwd: string, sessionId?: string): Promise<string> {
		const project = await realpath(cwd);
		const id = randomUUID();
		const path = join(await (this.folder ??= mkdtemp(join(tmpdir(), "ma-points-"))), id);
		try {
			await cp(project, path, { ...copy, filter: (src) => !this.excluded(project, src) });
		} catch (error) {
			await rm(path, { recursive: true, force: true }).catch(() => undefined);
			throw error;
		}
		this.points.set(id, { project, path, sessionId });
		return id;
	}

	async has(cwd: string, id: string): Promise<boolean> {
		const saved = this.points.get(id);
		return !!saved && saved.project === await realpath(cwd);
	}

	async restore(cwd: string, id: string): Promise<void> {
		const saved = this.points.get(id);
		const project = await realpath(cwd);
		if (!saved || saved.project !== project) throw Object.assign(new Error("Saved point not found in this environment"), { code: "ENOENT" });
		const stage = await mkdtemp(join(dirname(project), ".ma-restore-"));
		const next = join(stage, "next");
		const old = join(stage, "old");
		const moved: [string, string][] = [];
		let clean = true;
		const move = async (from: string, to: string) => {
			await rename(from, to);
			moved.push([to, from]);
		};
		// Handle a state directory nested more than one level down without replacing its ancestors.
		const replace = async (target: string, desired: string, backup: string) => {
			const current = await readdir(target);
			const wanted = await readdir(desired);
			const home = this.home && resolve(this.home);
			for (const name of new Set([...current, ...wanted])) {
				const path = join(target, name);
				if (this.excluded(project, path)) continue;
				const from = join(desired, name);
				const prior = join(backup, name);
				if (home && home.startsWith(path + sep) && current.includes(name) && wanted.includes(name)) {
					await mkdir(prior);
					await replace(path, from, prior);
				} else {
					if (current.includes(name)) await move(path, prior);
					if (wanted.includes(name)) await move(from, path);
				}
			}
		};
		try {
			await cp(saved.path, next, copy);
			await mkdir(old);
			await replace(project, next, old);
		} catch (error) {
			for (const [from, to] of moved.reverse()) {
				try { await rename(from, to); } catch { clean = false; }
			}
			if (!clean) throw new Error(`Could not roll back rewind; backup kept at ${stage}`, { cause: error });
			throw error;
		} finally {
			if (clean) await rm(stage, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	async closeSession(sessionId: string): Promise<void> {
		await Promise.all([...this.points].filter(([, p]) => p.sessionId === sessionId).map(async ([id, p]) => {
			this.points.delete(id);
			await rm(p.path, { recursive: true, force: true });
		}));
	}

	async stop(): Promise<void> {
		if (this.folder) await rm(await this.folder, { recursive: true, force: true });
	}
}

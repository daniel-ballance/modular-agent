import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { copyFile, lstat, mkdtemp, rm, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const argsAt = (cwd: string, args: string[]) => ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "core.splitIndex=false", "-c", "core.fsmonitor=false", ...args];
function gitEnv(index?: string): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"]) delete env[key];
	return Object.assign(env, {
		GIT_TERMINAL_PROMPT: "0", LC_ALL: "C",
		GIT_AUTHOR_NAME: "modular-agent", GIT_AUTHOR_EMAIL: "points@modular-agent.invalid",
		GIT_COMMITTER_NAME: "modular-agent", GIT_COMMITTER_EMAIL: "points@modular-agent.invalid",
		...(index ? { GIT_INDEX_FILE: index } : {}),
	});
}

function git(top: string, args: string[], index?: string, input?: Buffer | string): Promise<Buffer> {
	return new Promise((done, fail) => {
		const child = spawn("git", argsAt(top, args), { env: gitEnv(index), stdio: ["pipe", "pipe", "pipe"] });
		const out: Buffer[] = [], err: Buffer[] = [];
		child.stdout.on("data", chunk => out.push(chunk));
		child.stderr.on("data", chunk => err.push(chunk));
		child.on("error", fail);
		child.stdin.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") fail(error); });
		child.on("close", code => code === 0 ? done(Buffer.concat(out)) : fail(new Error(`git ${args[0]} failed: ${Buffer.concat(err).toString().trim()}`)));
		child.stdin.end(input);
	});
}

function contains(parent: string, path: string): boolean {
	const rel = relative(parent, path);
	return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep);
}

interface Repo { top: string; project: string; spec: string; prefix: string }
function repository(cwd: string): Repo | undefined {
	try {
		const project = realpathSync(cwd);
		const out = execFileSync("git", argsAt(project, ["rev-parse", "--is-inside-work-tree", "--show-toplevel"]), { env: gitEnv(), stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
		if (!out.startsWith("true\n")) return;
		const top = realpathSync(out.slice(5, -1));
		if (!contains(top, project)) return;
		const prefix = relative(top, project);
		return { top, project, prefix, spec: `:(literal)${prefix || "."}` };
	} catch { return; }
}

const text = (data: Buffer) => data.toString().replace(/\n$/, "");
const paths = (data: Buffer) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data).split("\0").filter(Boolean);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
function ref(session: string, point: string): string {
	if (![session, point].every(id => id.length > 0 && !/[^a-zA-Z0-9_-]/.test(id))) throw new Error("Invalid session or point id");
	return `refs/modular-agent/points/${session}/${point}`;
}

async function snapshot(repo: Repo, scratch: string): Promise<string> {
	const index = join(scratch, "index");
	await rm(index, { force: true });
	const real = text(await git(repo.top, ["rev-parse", "--path-format=absolute", "--git-path", "index"]));
	await copyFile(real, index).catch(error => { if (!missing(error)) throw error; });
	await git(repo.top, ["add", "-A", "--", repo.spec], index);
	if (repo.prefix) {
		const outside = await git(repo.top, ["ls-files", "-z", "--", `:(exclude,literal)${repo.prefix}`], index);
		if (outside.length) await git(repo.top, ["update-index", "--force-remove", "-z", "--stdin"], index, outside);
	}
	return text(await git(repo.top, ["write-tree"], index));
}

async function commit(repo: Repo, tree: string, session: string): Promise<string> {
	return text(await git(repo.top, ["commit-tree", tree], undefined, `modular-agent point\n\nsession: ${session}\nproject: ${repo.project}\n`));
}

async function find(repo: Repo, session: string, point: string): Promise<string | undefined> {
	const name = ref(session, point);
	const saved = await git(repo.top, ["rev-parse", "--verify", "-q", `${name}^{commit}`]).then(text, () => undefined);
	if (!saved) return;
	const body = (await git(repo.top, ["cat-file", "commit", saved])).toString();
	return body.includes(`\nproject: ${repo.project}\n`) ? saved : undefined;
}

async function apply(repo: Repo, scratch: string, current: string, target: string): Promise<void> {
	const diff = (filter: string, from: string, to: string) => git(repo.top, ["diff-tree", "-r", "-z", "--no-renames", "--name-only", `--diff-filter=${filter}`, from, to, "--", repo.spec]).then(paths);
	// Remove only paths in the current tree, pruning empty parents inside the project.
	for (const name of await diff("A", target, current)) {
		const full = join(repo.top, name);
		const meta = await lstat(full).catch(error => { if (!missing(error)) throw error; });
		if (meta && !meta.isDirectory()) await unlink(full);
		for (let dir = dirname(full); dir !== repo.project && contains(repo.project, dir); dir = dirname(dir)) {
			if (!await rmdir(dir).then(() => true, () => false)) break;
		}
	}
	// An ignored file or directory may have appeared where the target needs a file.
	// Do not let checkout-index overwrite it or replace a symlink ancestor.
	for (const name of await diff("A", current, target)) {
		const full = join(repo.top, name);
		for (let path = full; path !== repo.project && contains(repo.project, path); path = dirname(path)) {
			const meta = await lstat(path).catch(error => { if (!missing(error) && error.code !== "ENOTDIR") throw error; });
			if (meta && (path === full || !meta.isDirectory())) throw new Error(`Cannot restore over ${path}`);
		}
	}
	const index = join(scratch, "target");
	await git(repo.top, ["read-tree", target], index);
	const files = await git(repo.top, ["ls-files", "-z", "--", repo.spec], index);
	if (files.length) await git(repo.top, ["checkout-index", "-f", "-z", "--stdin"], index, files);
}

/** Git-backed points own no process-local state and survive session/agent exit. */
export class GitPoints {
	constructor(private home?: string) {}

	private available(repo: Repo): boolean {
		if (!this.home) return true;
		let state = resolve(this.home);
		try { state = realpathSync(state); } catch { /* State may not have been created yet. */ }
		return !contains(repo.project, state);
	}

	keepsPoints(cwd: string): boolean {
		const repo = repository(cwd);
		return !!repo && this.available(repo);
	}

	async save(cwd: string, session = "standalone"): Promise<string> {
		const repo = repository(cwd);
		if (!repo || !this.available(repo)) throw new Error("Project does not support Git rewind points");
		const point = randomUUID(), name = ref(session, point);
		const scratch = await mkdtemp(join(tmpdir(), "ma-git-points-"));
		try {
			const saved = await commit(repo, await snapshot(repo, scratch), session);
			await git(repo.top, ["update-ref", name, saved]);
			return point;
		} finally { await rm(scratch, { recursive: true, force: true }); }
	}

	async has(cwd: string, point: string, session = "standalone"): Promise<boolean> {
		const repo = repository(cwd);
		return !!repo && this.available(repo) && !!await find(repo, session, point);
	}

	async restore(cwd: string, point: string, session = "standalone"): Promise<void> {
		const repo = repository(cwd);
		const saved = repo && this.available(repo) && await find(repo, session, point);
		if (!repo || !saved) throw Object.assign(new Error("Saved point not found in this environment"), { code: "ENOENT" });
		const target = text(await git(repo.top, ["rev-parse", `${saved}^{tree}`]));
		const scratch = await mkdtemp(join(tmpdir(), "ma-git-points-"));
		try {
			const current = await snapshot(repo, scratch);
			const recovery = `refs/modular-agent/recovery/${session}/${randomUUID()}`;
			await git(repo.top, ["update-ref", recovery, await commit(repo, current, session)]);
			const forget = () => git(repo.top, ["update-ref", "-d", recovery]).catch(() => undefined);
			try {
				await apply(repo, scratch, current, target);
			} catch (error) {
				try { await apply(repo, scratch, await snapshot(repo, scratch).catch(() => target), current); }
				catch (rollback) { throw new AggregateError([error, rollback], `Restore and rollback failed; backup kept at ${recovery}`); }
				await forget();
				throw error;
			}
			await forget();
		} finally { await rm(scratch, { recursive: true, force: true }); }
	}

	async stop(): Promise<void> { /* The repository owns the saved points. */ }
}

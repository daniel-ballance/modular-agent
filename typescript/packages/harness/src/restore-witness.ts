import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

const unavailable = (cause?: unknown) => Object.assign(new Error("History restore witness is unavailable or does not match", { cause }), { code: "unavailable" });

/** One independent component of a store's restore witness. The caller holds its storage lock. */
export class RestoreWitness {
	private readonly path: string;
	constructor(root: string, path: string) {
		this.path = join(realpathSync(dirname(path)), basename(path));
		const fromRoot = relative(realpathSync(root), this.path);
		if (isAbsolute(fromRoot) || fromRoot.startsWith(`..${sep}`)) return;
		throw unavailable();
	}
	reserve() {
		try { closeSync(openSync(this.path, "wx", 0o600)); }
		catch (error) { throw unavailable(error); }
	}
	check(stamp: string) {
		try {
			if (!lstatSync(this.path).isFile() || readFileSync(this.path, "utf8") !== stamp) throw unavailable();
		} catch (error) { throw unavailable(error); }
	}
	// Publish before committing SQLite. A crash between these writes leaves the
	// witness ahead of the store, never an older state that can pass the check.
	publish(stamp: string) {
		const dir = dirname(this.path), tmp = join(dir, `.history-${randomUUID()}.tmp`);
		try {
			writeFileSync(tmp, stamp, { mode: 0o600, flag: "wx", flush: true });
			renameSync(tmp, this.path);
			const fd = openSync(dir, "r");
			try { fsyncSync(fd); } finally { closeSync(fd); }
		} catch (error) { throw unavailable(error); }
		finally { rmSync(tmp, { force: true }); }
	}
}

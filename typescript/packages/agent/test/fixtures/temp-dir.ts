import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

type Cleanup = () => void | Promise<void>;
const resourceCleanups = new WeakMap<TestContext, Cleanup[]>();

function cleanupsFor(t: TestContext): Cleanup[] {
	const registered = resourceCleanups.get(t);
	if (registered) return registered;
	const cleanups: Cleanup[] = [];
	resourceCleanups.set(t, cleanups);
	// Keep teardown in one hook so every cleanup runs even if an earlier one fails.
	t.after(async () => {
		const errors: unknown[] = [];
		for (const cleanup of cleanups) {
			try { await cleanup(); } catch (error) { errors.push(error); }
		}
		if (errors.length) throw new AggregateError(errors, "Test resource cleanup failed");
	});
	return cleanups;
}

export function beforeTempDirCleanup(t: TestContext, cleanup: Cleanup): void {
	// Stop dependent resources in reverse setup order, before removing their directories.
	cleanupsFor(t).unshift(cleanup);
}

export function testTempDir(t: TestContext, prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanupsFor(t).push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

export function testDirs(t: TestContext): { project: string; home: string } {
	return { project: testTempDir(t, "ma-p-"), home: testTempDir(t, "ma-h-") };
}

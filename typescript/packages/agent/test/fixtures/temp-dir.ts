import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

export function testTempDir(t: TestContext, prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

export function testDirs(t: TestContext): { project: string; home: string } {
	return { project: testTempDir(t, "ma-p-"), home: testTempDir(t, "ma-h-") };
}

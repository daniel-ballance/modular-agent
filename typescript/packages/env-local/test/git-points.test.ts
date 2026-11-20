import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { GitPoints } from "../src/git-points.js";

function git(dir: string, ...args: string[]): string {
	return execFileSync("git", ["-C", dir, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgSign=false", ...args], { encoding: "utf8" }).trim();
}
function write(path: string, value: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, value);
}
function fixture(t: TestContext, init = true) {
	const root = mkdtempSync(join(tmpdir(), "ma-points-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const top = join(root, "repo"), state = join(root, "state");
	mkdirSync(top);
	mkdirSync(state);
	if (init) {
		git(top, "init", "-q");
		write(join(top, ".gitignore"), "target/\n");
		write(join(top, "tracked.txt"), "one\n");
		git(top, "add", "-A");
		git(top, "commit", "-qm", "first");
		write(join(top, "staged.txt"), "staged\n");
		git(top, "add", "staged.txt");
		write(join(top, "notes/untracked.txt"), "draft\n");
		write(join(top, "target/build.bin"), "old build\n");
	}
	return { top, state, points: new GitPoints(state) };
}

test("outside Git there are no points", async t => {
	const { top, points } = fixture(t, false);
	assert.equal(points.keepsPoints(top), false);
	await assert.rejects(points.save(top, "s1"));
	assert.equal(await points.has(top, "p1", "s1"), false);
});

test("restore brings back working files without changing HEAD, index or ignored files", async t => {
	const { top, points } = fixture(t);
	assert.equal(points.keepsPoints(top), true);
	const head = git(top, "rev-parse", "HEAD"), index = readFileSync(join(top, ".git/index"));
	const point = await points.save(top, "s1");
	write(join(top, "tracked.txt"), "changed\n");
	rmSync(join(top, "notes/untracked.txt"));
	write(join(top, "new/created.txt"), "new\n");
	write(join(top, "target/build.bin"), "new build\n");
	await points.restore(top, point, "s1");
	assert.equal(readFileSync(join(top, "tracked.txt"), "utf8"), "one\n");
	assert.equal(readFileSync(join(top, "staged.txt"), "utf8"), "staged\n");
	assert.equal(readFileSync(join(top, "notes/untracked.txt"), "utf8"), "draft\n");
	assert.equal(existsSync(join(top, "new")), false);
	assert.equal(readFileSync(join(top, "target/build.bin"), "utf8"), "new build\n");
	assert.equal(git(top, "rev-parse", "HEAD"), head);
	assert.deepEqual(readFileSync(join(top, ".git/index")), index);
	assert.equal(git(top, "rev-list", "--count", "HEAD"), "1");
	assert.equal(git(top, "for-each-ref", "refs/modular-agent/recovery/"), "");
});

test("a subfolder point saves and restores only that project", async t => {
	const { top, points } = fixture(t);
	const project = join(top, "notes"), point = await points.save(project, "s1");
	assert.equal(git(top, "ls-tree", "-r", "--name-only", `refs/modular-agent/points/s1/${point}`), "notes/untracked.txt");
	write(join(project, "untracked.txt"), "changed\n");
	write(join(top, "tracked.txt"), "outside change\n");
	await points.restore(project, point, "s1");
	assert.equal(readFileSync(join(project, "untracked.txt"), "utf8"), "draft\n");
	assert.equal(readFileSync(join(top, "tracked.txt"), "utf8"), "outside change\n");
});

test("a point belongs to its session and project and survives gc", async t => {
	const { top, state, points } = fixture(t);
	const point = await points.save(top, "s1");
	git(top, "gc", "-q", "--prune=now");
	const reopened = new GitPoints(state);
	assert.equal(await reopened.has(top, point, "s1"), true);
	assert.equal(await reopened.has(top, point, "s2"), false);
	assert.equal(await reopened.has(join(top, "notes"), point, "s1"), false);
	assert.equal(await reopened.has(top, "no-such-point", "s1"), false);
	await assert.rejects(points.save(top, "../escape"));
});

test("a project containing agent state has no points", async t => {
	const { top } = fixture(t);
	const state = join(top, "state");
	mkdirSync(state);
	const points = new GitPoints(state);
	assert.equal(points.keepsPoints(top), false);
	await assert.rejects(points.save(top, "s1"));
});

test("restore rolls back when a new ignored file blocks a saved path", async t => {
	const { top, points } = fixture(t);
	const point = await points.save(top, "s1");
	write(join(top, ".gitignore"), "target/\nnotes/\n");
	write(join(top, "notes/untracked.txt"), "now ignored\n");
	write(join(top, "new/created.txt"), "new\n");
	await assert.rejects(points.restore(top, point, "s1"), /Cannot restore over/);
	assert.equal(readFileSync(join(top, "notes/untracked.txt"), "utf8"), "now ignored\n");
	assert.equal(readFileSync(join(top, "new/created.txt"), "utf8"), "new\n");
	assert.equal(git(top, "for-each-ref", "refs/modular-agent/recovery/"), "");
});

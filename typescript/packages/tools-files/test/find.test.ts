import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import type { ToolEnvironment } from "@modular-agent/core";
import { findFiles } from "../src/find.js";

async function project(t: TestContext, files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "ma-find-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  const env: ToolEnvironment = {
    read: path => readFile(resolve(root, path)),
    exists: async path => !!await lstat(resolve(root, path)).catch(() => undefined),
    list: async path => (await readdir(resolve(root, path), { withFileTypes: true })).map(entry => ({
      name: entry.name, kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
    })),
    write: async () => assert.fail("find does not write"),
    exec: async () => assert.fail("find does not run a shell in the environment"),
  };
  return { root, env, find: (path: string, pattern = "*.txt") => findFiles(env, t.signal, path, pattern) };
}

test("find consults parent rules and uses Rust ignore-source precedence", async t => {
  const { find } = await project(t, {
    ".git/info/exclude": "/sub/local-only.dat\nallowed.txt\n",
    ".gitignore": "*.txt\n!allowed.txt\n!hidden.txt\n/root-only.txt\n",
    ".ignore": "/sub/hidden.txt\n!/sub/kept.txt\n",
    "sub/.gitignore": "hidden.txt\n!sub-only.txt\n!root-only.txt\n",
    "sub/allowed.txt": "", "sub/dropped.txt": "", "sub/hidden.txt": "", "sub/kept.txt": "",
    "sub/local-only.dat": "", "sub/sub-only.txt": "", "sub/root-only.txt": "",
  });
  assert.deepEqual(await find("sub", "*"), [".gitignore", "allowed.txt", "kept.txt", "root-only.txt", "sub-only.txt"]);
});

test("find matches entries, not their ancestors, and does not descend into pruned directories", async t => {
  const { find } = await project(t, {
    ".gitignore": "/sub/\n/sub/top.txt\ncache/\n!cache/keep.txt\n/sub/*/one.txt\n/sub/**/series-*.txt\n*.LOG\n",
    "sub/cache/keep.txt": "", "sub/cache-file/cache": "", "sub/top.txt": "", "sub/a/top.txt": "",
    "sub/a/one.txt": "", "sub/a/b/one.txt": "", "sub/series-a.txt": "", "sub/a/b/series-b.txt": "",
    "sub/case.LOG": "", "sub/case.log": "", "visible.txt": "",
  });
  assert.deepEqual(await find("."), ["visible.txt"]);
  assert.deepEqual(await find("sub"), ["a/b/one.txt", "a/top.txt"]);
  assert.deepEqual(await find("sub", "a/*.txt"), ["a/top.txt"]);
  assert.deepEqual(await find("sub", "a/**/*.txt"), ["a/b/one.txt", "a/top.txt"]);
  assert.deepEqual(await find("sub", "cache"), ["cache-file/cache"]);
  assert.deepEqual(await find("sub", "*.log"), ["case.log"]);
});

test("find reads a linked worktree's common exclude file", async t => {
  const { root, find } = await project(t, {
    ".git": "gitdir: git/worktrees/linked\n", "git/worktrees/linked/commondir": "../..\n",
    "git/info/exclude": "/sub/hidden.txt\n", "sub/hidden.txt": "", "sub/visible.txt": "",
  });
  assert.deepEqual(await find(join(root, "sub")), ["visible.txt"]);
});

test("find stops before accessing the environment when cancelled", async t => {
  const { env } = await project(t, {});
  const signal = AbortSignal.abort(new Error("stopped"));
  await assert.rejects(findFiles({ ...env, list: async () => assert.fail("aborted before listing") }, signal, ".", "*"), /stopped/);
});

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const checker = "scripts/check-maintainability.mjs";
const baselineFile = "scripts/maintainability-baseline.json";

function checkout(t, branch = "main") {
  const cwd = mkdtempSync(join(tmpdir(), "maintainability-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", [
    "-c", "user.name=Test", "-c", "user.email=test@example.com",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args,
  ], { cwd });
  const write = (file, content) => {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), content);
  };
  const baseline = (entries) => write(baselineFile, JSON.stringify(entries));
  git("init", "-q", "-b", branch);
  baseline({});
  copyFileSync(new URL("check-maintainability.mjs", import.meta.url), join(cwd, checker));
  return {
    git, write, baseline,
    remove: (file) => rmSync(join(cwd, file)),
    read: (file) => readFileSync(join(cwd, file), "utf8"),
    track: (...files) => git("add", "-f", "--", ...files),
    commit: (subject) => git("commit", "-q", "--allow-empty", "-m", subject),
    check: (...args) => spawnSync(process.execPath, [checker, ...args], { cwd, encoding: "utf8" }),
  };
}

test("a file over the limit fails, including a final line without a newline", (t) => {
  const repo = checkout(t);
  repo.write("at limit.ts", "x\r\n".repeat(1000));
  repo.write("too long.ts", "x\n".repeat(1000) + "x");
  repo.track("at limit.ts", "too long.ts");
  const result = repo.check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^"too long\.ts": 1001 lines\..*1000-line limit/m);
  assert.match(result.stdout, /2 tracked source files checked\. Failures: 1\./);
});

test("a baselined file that grew fails", (t) => {
  const repo = checkout(t);
  repo.write("large.rs", "x\n".repeat(1003));
  repo.track("large.rs");
  repo.baseline({ "large.rs": 1002 });
  const result = repo.check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /large\.rs.*1003 lines\..*1002-line baseline/);
});

test("a baselined file that shrank passes with a note", (t) => {
  const repo = checkout(t);
  repo.write("large.py", "x\n".repeat(1001));
  repo.track("large.py");
  repo.baseline({ "large.py": 1002 });
  const result = repo.check();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /large\.py.*Lower its entry .* to 1001/);
});

test("baseline entries for deleted files or files back within the limit fail", (t) => {
  const repo = checkout(t);
  repo.write("removed.go", "x\n".repeat(1002));
  repo.write("short.go", "x\n".repeat(1000));
  repo.track("removed.go", "short.go");
  repo.remove("removed.go");
  repo.baseline({ "removed.go": 1002, "short.go": 1002 });
  const result = repo.check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /removed\.go.*Remove its entry/);
  assert.match(result.stderr, /short\.go.*Remove its entry/);
});

test("baseline generation lists only tracked source files over the limit", (t) => {
  const repo = checkout(t);
  const tracked = ["large.tsx", "monty.pb.go", "types.d.ts", "package-lock.json",
    "nested/node_modules/pkg/index.js", "typescript/packages/ma/vendor/monty/client.ts"];
  for (const file of [...tracked, "untracked.mjs"]) repo.write(file, "x\n".repeat(1002));
  repo.track(...tracked);
  const result = repo.check("--write-baseline");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(repo.read(baselineFile)), { "large.tsx": 1002 });
  const check = repo.check();
  assert.equal(check.status, 0, check.stderr);
  assert.doesNotMatch(check.stdout, /Lower its entry/);
});

test("only WIP subjects after the merge base fail, regardless of case", (t) => {
  const repo = checkout(t);
  repo.commit("WIP already on main");
  repo.git("switch", "-q", "-c", "topic");
  repo.commit("Discuss WIP");
  repo.commit("wIp: finish the split");
  repo.git("switch", "-q", "main");
  repo.commit("WIP only on main");
  repo.git("switch", "-q", "topic");
  const result = repo.check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /wIp: finish the split.*Rewrite the commit subject/);
  assert.doesNotMatch(result.stderr, /WIP (already|only) on main|Discuss WIP/);
});

test("origin/main is used when there is no local main", (t) => {
  const repo = checkout(t, "topic");
  repo.commit("Start");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  repo.commit("WIP: finish the split");
  const result = repo.check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /WIP: finish the split/);
});

test("HEAD on main has no subjects to check", (t) => {
  const repo = checkout(t);
  repo.commit("WIP already on main");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const result = repo.check();
  assert.equal(result.status, 0, result.stderr);
});

test("origin/main wins over a local main that is behind it or ahead of it", (t) => {
  const repo = checkout(t);
  repo.commit("Start");
  repo.commit("WIP landed long ago");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  repo.git("switch", "-q", "-c", "topic");
  repo.git("update-ref", "refs/heads/main", "HEAD~1");
  assert.equal(repo.check().status, 0, "a local main behind origin/main does not flag landed commits");
  repo.commit("WIP: finish the split");
  repo.git("update-ref", "refs/heads/main", "HEAD");
  const result = repo.check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /WIP: finish the split/);
  assert.doesNotMatch(result.stderr, /WIP landed long ago/);
});

test("a WIP subject after leading blank lines fails", (t) => {
  const repo = checkout(t);
  repo.commit("Start");
  repo.git("switch", "-q", "-c", "topic");
  repo.git("commit", "-q", "--allow-empty", "--cleanup=verbatim", "-m", "\n\nWIP: finish the split\n\nThe rest.");
  const result = repo.check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /WIP: finish the split: Rewrite the commit subject/);
});

test("a subject that only begins with the letters wip passes", (t) => {
  const repo = checkout(t);
  repo.commit("Start");
  repo.git("switch", "-q", "-c", "topic");
  repo.commit("Wipe the stale cache");
  const result = repo.check();
  assert.equal(result.status, 0, result.stderr);
});

test("a closing keyword anywhere in a branch commit message fails", (t) => {
  const repo = checkout(t);
  repo.commit("Fixes #3 on main already");
  repo.git("switch", "-q", "-c", "topic");
  repo.commit("Closes #12");
  repo.commit("Split the module\n\nThe old one was too long.\nRESOLVED: owner/repo#13");
  repo.commit("Tidy\n\nfixed https://github.com/owner/repo/issues/14");
  repo.commit("Split the parser\n\nfix\t#15 and more");
  const result = repo.check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Closes #12: "Closes #12"\. Put Closes #N in the pull request body, not the commit message\./);
  assert.match(result.stderr, /Split the module: "RESOLVED: owner\/repo#13"/);
  assert.match(result.stderr, /Tidy: "fixed https:\/\/github\.com\/owner\/repo\/issues\/14"/);
  assert.match(result.stderr, /Split the parser: "fix\t#15"/);
  assert.doesNotMatch(result.stderr, /on main already/);
  assert.match(result.stdout, /Failures: 4\./);
});

test("a keyword not followed by an issue reference passes", (t) => {
  const repo = checkout(t);
  repo.commit("Start");
  repo.git("switch", "-q", "-c", "topic");
  repo.commit("Part of #12\n\nThe flake was fixed in #12 already.\nA prefix #3, an unfixed #4, closes the gap in #5.");
  repo.commit("Closes the file before #6 opens it");
  repo.commit("Link the tracker\n\nfixed https://github.com/owner/repo/issues/12abc and fix #7x");
  const result = repo.check();
  assert.equal(result.status, 0, result.stderr);
});

test("a control character in a commit message does not hide a later keyword", (t) => {
  const repo = checkout(t);
  repo.commit("Start");
  repo.git("switch", "-q", "-c", "topic");
  repo.commit("Quote the log\n\nunit\x1fsep record\x1esep\nFixes #12");
  const result = repo.check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Quote the log: "Fixes #12"/);
});

test("after a criss-cross merge only commits missing from main are checked", (t) => {
  const repo = checkout(t);
  repo.commit("Start");
  repo.git("switch", "-q", "-c", "topic");
  repo.commit("Fixes #1 on the branch, landed through main");
  repo.git("switch", "-q", "main");
  repo.commit("Fixes #2 on main");
  repo.git("merge", "-q", "--no-edit", "--no-ff", "topic~0");
  repo.git("switch", "-q", "topic");
  repo.git("merge", "-q", "--no-edit", "--no-ff", "main~1");
  assert.equal(repo.git("merge-base", "--all", "main", "HEAD").toString().trim().split("\n").length, 2);
  const result = repo.check();
  assert.equal(result.status, 0, result.stderr);
});

test("no main ref skips the subject check", (t) => {
  const repo = checkout(t, "topic");
  repo.commit("WIP: finish the split");
  const result = repo.check();
  assert.equal(result.status, 0, result.stderr);
});

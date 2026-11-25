import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const library = fileURLToPath(new URL("point-refs.sh", import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));

// The guard runs in `repo`, which snapshots, then `action` saves points, then the guard checks.
const harness = String.raw`
  . "$0"
  point() { # git-dir trailer-body ref
    local tree commit
    tree=$(git -C "$1" mktree </dev/null) &&
      commit=$(printf 'modular-agent point\n\nsession: s\n%s\n' "$2" | git -C "$1" -c user.name=p -c user.email=p@p commit-tree "$tree") &&
      git -C "$1" update-ref "$3" "$commit"
  }
  own() { point "$repo" "project: $1" "refs/modular-agent/points/$2"; }
  cd "$repo" && point_refs >"$logs/refs-before" && worktree_roots >"$logs/worktrees-before" || exit 9
  eval "$1" || exit 8
  check_test_refs`;

function machine(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "point-refs-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync("git", args, { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const main = join(home, "main");
  git("init", "-q", main);
  git("-C", main, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-q", "--allow-empty", "-m", "init");
  mkdirSync(join(main, "python"));
  const guard = (action, repo = main) => {
    const logs = mkdtempSync(join(home, "logs-"));
    const result = spawnSync("bash", ["-c", harness, library, action], {
      env: { ...env, repo, logs, home, main }, encoding: "utf8",
    });
    assert.ok(result.status === 0 || result.status === 1, `${result.status}: ${result.stderr}`);
    return result.status;
  };
  return { home, main, git, guard };
}

test("points saved for a project in this checkout fail the guard", (t) => {
  const box = machine(t);
  assert.equal(box.guard("true"), 0);
  assert.equal(box.guard('own "$main/python" a/1'), 1);
  assert.equal(box.guard('own "$main" a/2'), 1);
  assert.equal(box.guard('own "$main/gone/tmp" a/3'), 1, "a deleted subfolder is still this checkout's");
  box.git("-C", box.main, "update-ref", "refs/modular-agent/points/b/1", "HEAD");
  assert.equal(box.guard('own "$main/python" b/1'), 1, "a rewritten ref counts as new");
});

test("points from other worktrees, other folders and odd trailers are not this run's", (t) => {
  const box = machine(t);
  box.git("-C", box.main, "worktree", "add", "-q", join(box.home, "sib"));
  box.git("-C", box.main, "worktree", "add", "-q", "--detach", join(box.main, ".worktrees", "nested"));
  mkdirSync(`${box.main}x`);
  mkdirSync(join(box.home, "norepo"));
  assert.equal(box.guard('point "$home/sib" "project: $home/sib/go" refs/modular-agent/points/c/1'), 0);
  assert.equal(box.guard('own "$main/.worktrees/nested/go" c/2'), 0);
  assert.equal(box.guard('own "${main}x/python" c/3'), 0);
  assert.equal(box.guard('own "$home/norepo" c/4'), 0);
  assert.equal(box.guard('point "$main" "session: none" refs/modular-agent/points/c/5'), 0);
  assert.equal(box.guard('point "$main" "project: $main/python\nproject: $home/sib" refs/modular-agent/points/c/6'), 0);
  assert.equal(box.guard('point "$main" "project: $main\n\nsession: t\nproject: $home/sib" refs/modular-agent/points/c/7'), 0,
    "a body line is not the trailer");
});

test("trailer settings in the repository do not hide this checkout's points", (t) => {
  const box = machine(t);
  box.git("-C", box.main, "config", "trailer.separators", "=");
  box.git("-C", box.main, "config", "trailer.project.key", "X-Project:");
  assert.equal(box.guard('own "$main/python" d/1'), 1);
});

test("a nested worktree removed before the scan keeps its points; a reused old path does not", (t) => {
  const box = machine(t);
  const nested = join(box.main, ".worktrees", "nested");
  const odd = join(box.main, ".worktrees", "g*?[lob");
  box.git("-C", box.main, "worktree", "add", "-q", "--detach", nested);
  box.git("-C", box.main, "worktree", "add", "-q", "--detach", odd);
  assert.equal(box.guard(`own "${nested}/go" e/1; git worktree remove --force "${nested}"`), 0);
  assert.equal(box.guard(`own "${odd}/go" e/2; git worktree remove --force "${odd}"; mkdir -p "$main/.worktrees/glob"`), 0);
  box.git("-C", box.main, "worktree", "add", "-q", "--detach", nested);
  assert.equal(
    box.guard(`git worktree move "${nested}" "$home/moved" && mkdir -p "${nested}" && own "${nested}/go" e/3`), 1,
    "after a worktree moves away, its old path is a folder of this checkout");
});

test("the checkout's own path is read through symlinks and odd characters", (t) => {
  const box = machine(t);
  const alias = join(box.home, "alias");
  symlinkSync(box.main, alias);
  assert.equal(box.guard('own "$main/python" f/1', alias), 1);
  const escaped = join(box.home, "esc\\troot");
  box.git("-C", box.main, "worktree", "add", "-q", "--detach", escaped);
  assert.equal(box.guard(`point "$repo" "project: $repo/go" refs/modular-agent/points/f/2`, escaped), 1);
  assert.equal(box.guard(`point "$main" "project: ${escaped}/go" refs/modular-agent/points/f/3`), 0);
});

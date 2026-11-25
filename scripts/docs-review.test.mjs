import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const script = "scripts/docs-review.mjs";

function checkout(t, branch = "main") {
  const cwd = mkdtempSync(join(tmpdir(), "docs-review-"));
  t.after(() => rmSync(cwd, { force: true, recursive: true }));
  const git = (...args) => execFileSync("git", [
    "-c", "user.name=Test", "-c", "user.email=test@example.com",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args,
  ], { cwd });
  const write = (file, content) => {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), Array.isArray(content) ? content.join("\n") : content);
  };
  git("init", "-q", "-b", branch);
  mkdirSync(join(cwd, "scripts"));
  copyFileSync(new URL("docs-review.mjs", import.meta.url), join(cwd, script));
  write("docs/adr/0007-accepted.md", "---\nstatus: accepted\n---\n\n# Accepted\n");
  write("docs/adr/0008-proposed.md", "---\nstatus: proposed\n---\n\n# Proposed\n");
  git("add", "-f", "--", "docs/adr");
  return {
    git,
    write,
    track(file, content) {
      write(file, content);
      git("add", "-f", "--", file);
    },
    commit: (subject) => {
      git("add", "-f", "--", ".");
      git("commit", "-q", "--allow-empty", "-m", subject);
    },
    run(...args) {
      const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
      const found = result.stdout.split("\n").filter((line) => /^\S+:\d+: /.test(line));
      return { ...result, found, at: found.map((line) => line.split(": ")[0]) };
    },
  };
}

test("status and open-work words are candidates, with the reason they were picked", (t) => {
  const repo = checkout(t);
  repo.track("README.md", [
    "# Notes", "",
    "This rule is proposed.", "Support is planned for 0.4.", "Go does not yet stream.", "The types will be generated later.",
    "Still to do: hide secrets.", "TODO: write the guide.", "From SDK draft 0.1.", "The spec is still draft.", "Release pending review.",
    "", "## Behaviour", "",
    "A known gap in Go.", "Findings from the builds.", "Resume is not implemented.", "Streaming is unsupported.", "The cache is missing.",
    "Leave it as a follow-up.", "A follow-up issue covers it.", "",
  ]);
  const result = repo.run("--all");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.at, Array.from({ length: 9 }, (_, i) => `README.md:${i + 3}`).concat(Array.from({ length: 7 }, (_, i) => `README.md:${i + 15}`)));
  assert.match(result.stdout, /^README\.md:3: status "proposed"\.\n {4}This rule is proposed\.$/m);
  assert.match(result.stdout, /^README\.md:15: open work "gap" with no issue in its section\.$/m);
  assert.match(result.stdout, /^16 candidates in 1 files of tracked Markdown\./m);
});

test("words this specification uses for behaviour are not candidates", (t) => {
  const repo = checkout(t);
  repo.track("docs/contracts.md", [
    "The Harness keeps proposed input until an actor releases it.",
    "A pending call waits for its result, and pending erasure blocks reads.",
    "It rejects the model's draft and a missing field.",
    "If the binding is missing, the Harness MUST refuse the call.",
    "The parent sends a follow-up to a finished child.",
    "An agent started to do a task.",
    "The Project shows Todo, In progress and Done.",
  ]);
  const result = repo.run("--all");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.found, []);
});

test("fenced code, HTML comments, inline code, link targets and tags are not read", (t) => {
  const repo = checkout(t);
  repo.track("README.md", [
    "```md", "This rule is proposed.", "```",
    "<!--", "TODO: write it.", "-->",
    "Run `planned --gap` first. <!-- proposed -->",
    "See [the schema](data.md#pending-review-gap).",
    '<a id="findings"></a>',
    "~~~", "```", "A gap.", "~~~",
    "Write `<!--` to start a comment; this gap is open.",
  ]);
  const result = repo.run("--all");
  assert.deepEqual(result.at, ["README.md:14"]);
});

test("an issue in the same section tracks open work but not a status word", (t) => {
  const repo = checkout(t);
  repo.track("README.md", [
    "## Known gaps", "", "Tracked in #30.", "", "- A gap in Go.", "- Go does not yet stream.",
    "## Other", "", "- A gap in Rust ([issue](https://github.com/example/project/issues/12)).", "- A gap in Python.",
    "### Child", "", "- A gap in TypeScript.",
    "## Examples", "", "- A gap like `#5`, or [an anchor](notes.md#5).",
    "## Later", "Tracked in #40.", "#", "- A gap after an empty heading.",
  ]);
  const result = repo.run("--all");
  assert.deepEqual(result.at, ["README.md:6", "README.md:13", "README.md:16", "README.md:20"]);
  assert.match(result.stdout, /README\.md:6: status "not yet"\./);
});

test("each candidate lists the ADRs its paragraph links or names, with their status", (t) => {
  const repo = checkout(t);
  repo.track("docs/notes.md", [
    "See [the waiting rule](adr/0008-proposed.md#rule), now",
    "accepted. This rule is proposed.",
    "",
    "- [ADR 0007](adr/0007-accepted.md) is accepted.",
    "- The proposed rule in ADR 0008.",
    "- The [missing record](adr/0009-gone.md) is proposed.",
    "",
    "| [ADR 0007](adr/0007-accepted.md) | Accepted |",
    "| Planned | Later |",
  ]);
  const result = repo.run("--all");
  assert.deepEqual(result.found, [
    'docs/notes.md:2: status "proposed". Links ADR 0008 proposed.',
    'docs/notes.md:5: status "proposed". Links ADR 0008 proposed.',
    'docs/notes.md:6: status "proposed".',
    'docs/notes.md:9: status "planned".',
  ]);
});

test("the default scope is lines changed since the merge base with origin/main", (t) => {
  const repo = checkout(t);
  repo.track("README.md", ["Support is planned.", "", "A stable line.", ""]);
  repo.commit("Start");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  repo.git("switch", "-q", "-c", "topic");
  repo.track("README.md", ["Support is planned.", "", "A stable line.", "Streaming is not implemented.", ""]);
  repo.track("docs/new.md", "This rule is proposed.\n");
  repo.commit("Change docs");
  repo.write("go/README.md", "An untracked gap.\n");
  const result = repo.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.at, ["README.md:4", "docs/new.md:1"]);
  assert.match(result.stdout, /2 candidates in 2 files of Markdown changed since the merge base with origin\/main\./);
});

test("--base picks another merge base, and main is used without origin/main", (t) => {
  const repo = checkout(t);
  repo.track("README.md", "First gap.\n");
  repo.commit("Start");
  repo.git("switch", "-q", "-c", "stack");
  repo.track("README.md", "First gap.\nSecond gap.\n");
  repo.commit("Stack");
  repo.git("switch", "-q", "-c", "topic");
  repo.track("README.md", "First gap.\nSecond gap.\nThird gap.\n");
  repo.commit("Topic");
  assert.deepEqual(repo.run().at, ["README.md:2", "README.md:3"]);
  assert.deepEqual(repo.run("--base", "stack").at, ["README.md:3"]);
});

test("historical folders are skipped", (t) => {
  const repo = checkout(t);
  for (const file of ["docs/adr/README.md", "docs/research/a.md", "docs/pressure-test/b.md", "go/docs/clean-room/c.md", "docs/status.md"]) {
    repo.track(file, "This rule is proposed.\n");
  }
  assert.deepEqual(repo.run("--all").at, ["docs/status.md:1"]);
});

test("a usage or git error exits 2; candidates never fail the run", (t) => {
  const repo = checkout(t, "topic");
  repo.track("README.md", "A gap.\n");
  repo.commit("Start");
  for (const args of [["--bogus"], ["--base"], ["--all", "--base", "main"]]) {
    const result = repo.run(...args);
    assert.equal(result.status, 2, args.join(" "));
    assert.match(result.stderr, /^scripts\/docs-review\.mjs: Use node scripts\/docs-review\.mjs \[--all \| --base REF\]\.$/m);
  }
  const missing = repo.run();
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Cannot find origin\/main or main/);
  assert.equal(repo.run("--base", "nowhere").status, 2);
  assert.equal(repo.run("--all").status, 0);
});

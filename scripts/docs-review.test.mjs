import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = "scripts/docs-review.mjs";
const modules = ["docs-review.mjs", "markdown.mjs"];
// A submodule's commit lives in its own repository, so this one has no object to read for it.
const submodule = "5".repeat(40);

function checkout(t, branch = "main") {
  const outside = mkdtempSync(join(tmpdir(), "docs-review-"));
  t.after(() => rmSync(outside, { force: true, recursive: true }));
  // The parsers resolve from above the repository, so no fixture commit includes them.
  symlinkSync(fileURLToPath(new URL("node_modules", import.meta.url)), join(outside, "node_modules"));
  const cwd = join(outside, "repo");
  mkdirSync(cwd);
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
  for (const module of modules) copyFileSync(new URL(module, import.meta.url), join(cwd, "scripts", module));
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
      const found = result.stdout.split("\n").filter((line) => /^[^ ].*?:\d+: /.test(line));
      return { ...result, found, at: found.map((line) => line.match(/^(.*?:\d+): /)[1]) };
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
  repo.commit("Docs");
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
  repo.commit("Docs");
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
  repo.commit("Docs");
  const result = repo.run("--all");
  assert.deepEqual(result.at, ["README.md:14"]);
});

test("the parser decides what is prose: indented code, HTML blocks and code spans across lines are not; text after an escaped comment opener is", (t) => {
  const repo = checkout(t);
  repo.track("README.md", [
    "Intro.", "",
    "    Support is planned.", "",
    "<details>", "<summary>Planned work</summary>", "</details>", "",
    "Use `a", "planned` here.", "",
    "\\<!-- Resume is planned.", "",
    "Support is planned.", "",
  ]);
  repo.commit("Docs");
  assert.deepEqual(repo.run("--all").at, ["README.md:12", "README.md:14"]);
});

test("an underlined (Setext) heading starts a section", (t) => {
  const repo = checkout(t);
  repo.track("README.md", ["## Known gaps", "", "Tracked in #30.", "", "Other work", "----------", "", "- A gap in Go.", ""]);
  repo.commit("Docs");
  assert.deepEqual(repo.run("--all").at, ["README.md:8"]);
});

test("front matter is not read, and the lines after it keep their numbers", (t) => {
  const repo = checkout(t);
  repo.track("docs/guide.md", "---\r\ntitle: Planned gaps\r\nstatus: proposed\r\n---\r\n\r\nSupport is planned.\r\n");
  repo.commit("Docs");
  assert.deepEqual(repo.run("--all").found, ['docs/guide.md:6: status "planned".']);
});

test("missing parser dependencies give a one-line install instruction", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "docs-review-no-deps-"));
  t.after(() => rmSync(cwd, { force: true, recursive: true }));
  for (const module of modules) copyFileSync(new URL(module, import.meta.url), join(cwd, module));
  const result = spawnSync(process.execPath, [join(cwd, "docs-review.mjs"), "--all"], { cwd, encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "scripts/docs-review.mjs: Missing parser dependencies. Run npm ci --prefix scripts.\n");
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
  repo.commit("Docs");
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
    "| Record | Status |",
    "| --- | --- |",
    "| [ADR 0007](adr/0007-accepted.md) | Accepted |",
    "| Planned | Later |",
  ]);
  repo.commit("Docs");
  const result = repo.run("--all");
  assert.deepEqual(result.found, [
    'docs/notes.md:2: status "proposed". Links ADR 0008 proposed.',
    'docs/notes.md:4: status "accepted". Links ADR 0007 accepted.',
    'docs/notes.md:5: status "proposed". Links ADR 0008 proposed.',
    'docs/notes.md:6: status "proposed".',
    'docs/notes.md:11: status "planned".',
  ]);
});

test("status wording beside a named or linked ADR is a candidate", (t) => {
  const repo = checkout(t);
  repo.track("README.md", [
    "[ADR 0007](docs/adr/0007-accepted.md) proposes `serve(factory)` for a service.", "",
    "ADR 0007 proposes a separate rule.", "",
    "Built on the [edition 4 draft](docs/adr/0007-accepted.md).", "",
    "Its [owner decisions](docs/adr/0007-accepted.md#owner-decisions) are still open.", "",
    "A draft of the reply is open in the editor.", "",
  ]);
  repo.commit("Docs");
  const result = repo.run("--all");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.at, ["README.md:1", "README.md:3", "README.md:5", "README.md:7"]);
  assert.match(result.stdout, /^README\.md:1: status "proposes"\. Links ADR 0007 accepted\.$/m);
});

test("a statement that limits remain is open work", (t) => {
  const repo = checkout(t);
  repo.track("README.md", ["The desk drove three agents. These limits remain.", "", "Two limits still remain in Go.", "", "The call remains open until its deadline.", ""]);
  repo.commit("Docs");
  const result = repo.run("--all");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.at, ["README.md:1", "README.md:3"]);
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
  repo.write("README.md", ["Support is planned.", "", "A stable line.", "Streaming is not implemented.", "An uncommitted gap.", ""].join("\n"));
  const result = repo.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.at, ["README.md:4", "docs/new.md:1"]);
  assert.match(result.stdout, /2 candidates in 2 files of Markdown changed since the merge base with origin\/main\./);
});

test("changed lines are found in a file whose name has a space", (t) => {
  const repo = checkout(t);
  repo.track("README.md", "Start.\n");
  repo.commit("Start");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  repo.track("docs/review space.md", "Support is planned.\n");
  repo.track("docs/review-control.md", "Support is planned.\n");
  repo.commit("Docs");
  assert.deepEqual(repo.run().at, ["docs/review space.md:1", "docs/review-control.md:1"]);
});

test("completion wording beside a named ADR is a candidate", (t) => {
  const repo = checkout(t);
  repo.track("README.md", [
    "[ADR 0008](docs/adr/0008-proposed.md) is accepted.", "",
    "The work in ADR 0008 is done.", "",
    "ADR 0008 is now implemented in Go.", "",
    "The migration is done.", "",
  ]);
  repo.commit("Docs");
  const result = repo.run("--all");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.at, ["README.md:1", "README.md:3", "README.md:5"]);
  assert.match(result.stdout, /^README\.md:1: status "accepted"\. Links ADR 0008 proposed\.$/m);
});

test("file names that look like pathspec magic are read literally, and a rename counts only its edited lines", (t) => {
  const repo = checkout(t);
  const stable = Array.from({ length: 20 }, (_, i) => `Stable line ${i + 1} of the guide.`);
  repo.track("docs/old.md", ["Support is planned.", "", ...stable, ""]);
  repo.commit("Start");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  repo.write(":(glob)magic.md", "Resume is planned.\n");
  repo.git("--literal-pathspecs", "add", "--", ":(glob)magic.md");
  repo.git("mv", "docs/old.md", "docs/new.md");
  repo.track("docs/new.md", ["Support is planned.", "", ...stable, "Streaming is not implemented.", ""]);
  repo.commit("Docs");
  assert.deepEqual(repo.run().at, [":(glob)magic.md:1", "docs/new.md:23"]);
});

test("diff attributes and large files never hide a changed line", (t) => {
  const repo = checkout(t);
  repo.track("README.md", "Start.\n");
  repo.track("no-diff.md", "Start.\n");
  repo.track("large.md", "Start.\n");
  repo.track(".gitattributes", "no-diff.md -diff\n");
  repo.commit("Start");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  repo.track("no-diff.md", "Support is planned.\n");
  repo.track("large.md", "Support is planned.\n\n```text\n" + "A stable line of filler text.\n".repeat(40000) + "```\n");
  repo.commit("Docs");
  assert.deepEqual(repo.run().at, ["large.md:1", "no-diff.md:1"]);
});

test("a valid name with U+FFFD, an undecodable non-Markdown name and a Markdown submodule do not stop the review", (t) => {
  const repo = checkout(t);
  repo.track("README.md", "Start.\n");
  repo.commit("Start");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const top = repo.git("rev-parse", "--show-toplevel").toString().trim();
  repo.track("valid-\uFFFD.md", "Support is planned.\n");
  writeFileSync(Buffer.concat([Buffer.from(`${top}/notes-`), Buffer.from([0xff]), Buffer.from(".txt")]), "Not Markdown.\n");
  repo.git("add", "-f", "--", ".");
  repo.git("update-index", "--add", "--cacheinfo", `160000,${submodule},vendored.md`);
  repo.git("commit", "-q", "-m", "Docs");
  assert.equal(repo.git("ls-tree", "HEAD", "vendored.md").toString(), `160000 commit ${submodule}\tvendored.md\n`);
  for (const args of [[], ["--all"]]) {
    const result = repo.run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.at, ["valid-\uFFFD.md:1"]);
  }
});

test("a name that starts with a byte-order mark is read as written", (t) => {
  const repo = checkout(t);
  repo.track("README.md", "Start.\n");
  repo.track("review-bom.md", "A stable line.\n");
  repo.commit("Start");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  repo.track("\uFEFFreview-bom.md", "Support is planned.\n");
  repo.commit("Docs");
  for (const args of [[], ["--all"]]) {
    const result = repo.run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.at, ["\uFEFFreview-bom.md:1"]);
  }
});

test("names that are not UTF-8 stop the review only when it must read them", (t) => {
  const repo = checkout(t);
  const top = repo.git("rev-parse", "--show-toplevel").toString().trim();
  const bad = (stem) => Buffer.concat([Buffer.from(`${stem}-`), Buffer.from([0xff]), Buffer.from(".md")]);
  const filler = Array.from({ length: 30 }, (_, i) => `Stable line ${i + 1}.`).join("\n\n");
  repo.track("README.md", "Start.\n");
  writeFileSync(Buffer.concat([Buffer.from(`${top}/`), bad("unchanged")]), "Support is planned.\n");
  writeFileSync(Buffer.concat([Buffer.from(`${top}/`), bad("rename")]), `${filler}\n`);
  repo.git("add", "-A");
  repo.commit("Start");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  renameSync(Buffer.concat([Buffer.from(`${top}/`), bad("rename")]), join(top, "review-renamed.md"));
  writeFileSync(join(top, "review-renamed.md"), `${filler}\nResume is planned.\n`);
  repo.write("review-control.md", "Support is planned.\n");
  repo.git("add", "-A");
  execFileSync("git", ["update-index", "--index-info"], { cwd: top, input: Buffer.concat([Buffer.from(`160000 commit ${submodule}\t`), bad("vendored"), Buffer.from("\n")]) });
  repo.git("commit", "-q", "-m", "Docs");
  assert.ok(repo.git("ls-tree", "-z", "HEAD").includes(Buffer.concat([Buffer.from(`160000 commit ${submodule}\t`), bad("vendored"), Buffer.from([0])])));
  const result = repo.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.at, ["review-control.md:1", "review-renamed.md:60"]);
});

test("a version or edition number before draft is a status word", (t) => {
  const repo = checkout(t);
  repo.track("README.md", ["It wraps the edition 4 draft's nested calls.", "", "Version 0.1 draft rules apply.", "", "Write the draft reply.", ""]);
  repo.commit("Docs");
  assert.deepEqual(repo.run("--all").at, ["README.md:1", "README.md:3"]);
});

test("a changed file name that is not UTF-8 is an error, not a clean review", (t) => {
  const repo = checkout(t);
  repo.track("README.md", "Start.\n");
  repo.commit("Start");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const top = repo.git("rev-parse", "--show-toplevel").toString().trim();
  writeFileSync(Buffer.concat([Buffer.from(`${top}/bad-`), Buffer.from([0xff]), Buffer.from(".md")]), "Support is planned.\n");
  repo.commit("Docs");
  const result = repo.run();
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Cannot read the file name .* as UTF-8/);
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
  repo.commit("Docs");
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

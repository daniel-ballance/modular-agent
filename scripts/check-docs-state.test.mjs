import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("check-docs-state.mjs", import.meta.url));
const sdk = "docs/sdk/README.md";
const workspace = "rust/Cargo.toml";
const crate = "rust/crates/sdk/Cargo.toml";
const demoCrate = "demos/project-notes/history/Cargo.toml";
const node = "typescript/packages/core/package.json";
const adrIndex = "docs/adr/README.md";
const accepted = "docs/adr/0033-interface-tools-and-ag-ui.md";
const proposed = "docs/adr/0034-approvals-that-wait.md";

function checkout(t) {
  const cwd = mkdtempSync(join(tmpdir(), "docs-state-"));
  t.after(() => rmSync(cwd, { force: true, recursive: true }));
  const git = (...args) => execFileSync("git", args, { cwd, env: gitEnv() });
  const write = (file, content) => {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), content);
  };
  git("init", "-q");
  write("CHANGELOG.md", "# Changelog\n\n## Unreleased\n\n## 0.3.2\n\n## 0.2.0\n");
  write(sdk, "# The SDK specification\n\n**Status: 0.3, accepted.**\n");
  write(workspace, '[workspace]\n\n[workspace.package]\nversion = "0.3.2"\n');
  write(crate, '[package]\nname = "sdk"\nversion.workspace = true # use the workspace release\n');
  write(demoCrate, '[package]\nname = "demo"\nversion = "0.3.2"\n');
  write(node, '{\n  "version": "0.3.2",\n  "dependencies": { "@modular-agent/demo": "0.3.2", "outside": "^1.0.0" }\n}\n');
  git("add", "-f", "--", ".");
  return {
    write,
    track(file, content) {
      write(file, content);
      git("add", "-f", "--", file);
    },
    index(...rows) {
      this.track(adrIndex, ["| ADR | Decision | Status | Rule |", "| --- | --- | --- | --- |", ...rows].join("\n"));
    },
    check(failures = [], { timeout = 0, nodeArgs = [] } = {}) {
      const result = spawnSync(process.execPath, [...nodeArgs, checker, "--root", cwd], { cwd, env: gitEnv(), encoding: "utf8", timeout });
      const diagnostics = result.stderr.trim().split("\n").filter(Boolean);
      assert.equal(result.status, Number(failures.length > 0), result.stderr);
      assert.match(result.stdout, new RegExp(`Failures: ${failures.length}\\.$`, "m"));
      assert.equal(diagnostics.length, failures.length, result.stderr);
      for (const failure of failures) {
        assert.ok(diagnostics.some((line) => line.startsWith(failure)), `Expected ${failure} in:\n${result.stderr}`);
      }
    },
  };
}

test("missing parser dependencies give a one-line install instruction", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "docs-state-no-deps-"));
  t.after(() => rmSync(cwd, { force: true, recursive: true }));
  for (const module of ["check-docs-state.mjs", "markdown.mjs"]) copyFileSync(new URL(module, import.meta.url), join(cwd, module));
  const result = spawnSync(process.execPath, [join(cwd, "check-docs-state.mjs")], { cwd, env: gitEnv(), encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "scripts/check-docs-state.mjs:1: Missing parser dependencies. Run npm ci --prefix scripts.\n");
});

function record(repo, file, status) {
  repo.track(file, `---\nstatus: ${status}\n---\n\n# Decision\n`);
}

function row(file, status, rule = "Rule") {
  const name = file.split("/").at(-1);
  return `| [${name.slice(0, 4)}](${name}) | Decision | ${status} | ${rule} |`;
}

test("a heading needs an issue in its own body, not in its title, child, comment or example", (t) => {
  const repo = checkout(t);
  repo.track("README.md", [
    "# README", "## Known gaps (#1)", "<!--", "Tracked in #2.", "-->",
    "~~~md", "Tracked in #3.", "~~~", "`#4` is inline code.", "[Not an issue](example.md#5).",
    "### Child", "Tracked in #6.",
    "## Remaining", "Nothing here.", "## Findings for the SDK specification", "", "## Proposed binding text (not implemented)",
  ].join("\n"));
  repo.check([2, 13, 15, 17].map((line) => `README.md:${line}: Gap or finding has no issue. Link an issue below the heading`));
});

test("a literal <!-- in a fence or inline code does not hide the text after it", (t) => {
  const repo = checkout(t);
  repo.track("README.md", [
    "## Known gaps", "```md", "<!--", "```", "Tracked in #31.",
    "## Known gaps", "Write `<!--` to start a comment.", "",
    "## Findings", "```md", "<!--", "```",
    "## Gaps <!-- note --> in the core", "Tracked in #32.",
  ].join("\n"));
  repo.check([6, 9].map((line) => `README.md:${line}: Gap or finding has no issue`));
});

test("ATX headings follow CommonMark: an empty heading ends a section, and # only closes after a space", (t) => {
  const repo = checkout(t);
  repo.track("README.md", [
    "## Known gaps", "##", "Tracked in #31.",
    "## Production gaps###", "Not a gap heading.",
    "## Production gaps ##", "Tracked in #32.",
  ].join("\n"));
  repo.check(["README.md:1: Gap or finding has no issue"]);
});

test("code spans, fences and comments follow CommonMark around gap headings", (t) => {
  const repo = checkout(t);
  repo.track("README.md", [
    "## Known gaps", "Use ``a ``` b ` #31 only as an example``.",
    "```js`example", "## Known gaps",
    "~~~", "``` \u00a0", "## Known gaps", "~~~",
    "```", "``` \u00a0", "## Known gaps", "```",
    "##<!-- note --> Known gaps",
    "## Known gaps <!-- note -->", "Tracked in #33.",
  ].join("\n"));
  repo.check([1, 4].map((line) => `README.md:${line}: Gap or finding has no issue`));
});

test("comments follow CommonMark: short forms close at once, and a masked comment neither hides an issue nor closes a heading", (t) => {
  const repo = checkout(t);
  repo.track("README.md", [
    "## Known gaps", "Tracked in <!-- note -->#31.",
    "## Known gaps", "Tracked in <!--> #32.",
    "## Known gaps", "Tracked in <!---> #33.",
    "## Production gaps <!-- note -->###", "Ordinary prose.",
    "## Known gaps", "<!-- Tracked in #34. -->",
  ].join("\n"));
  repo.check(["README.md:9: Gap or finding has no issue"]);
});

test("issue numbers and URLs satisfy gap headings; history and untracked files are skipped", (t) => {
  const repo = checkout(t);
  repo.track("README.md", [
    "## Remaining ADR 0030 work", "Tracked in #19.",
    "### Known gaps", "See [the issue](https://github.com/example/project/issues/12).",
    "## Proposed, not yet written", "See https://github.com/example/project/issues/30.",
    "## Findings", "Tracked in [#21](https://example.org/project/issues/21).",
    "## Finding the fixture programs", "These are instructions.",
    "## Computing the remaining budget", "Add the limits.",
    "## Remaining time budget", "Subtract the elapsed time.",
    "## Proposed timeouts", "Ten seconds.",
    "## Known gaps and open problems", "Tracked in #22.",
    "## Production gaps", "Tracked in #23.",
    "````md", "```", "## Known gaps", "````",
  ].join("\n"));
  for (const path of ["docs/adr/example.md", "docs/research/example.md", "docs/pressure-test/example.md", "rust/docs/clean-room/example.md"]) {
    repo.track(path, "## Findings\n\nHistorical evidence.\n");
  }
  repo.write("untracked.md", "## Known gaps\n");
  repo.check();
});

test("an escaped comment opener leaves an issue visible", (t) => {
  const repo = checkout(t);
  repo.track("README.md", "## Known gaps\n\\<!-- Tracked in #31.\n");
  repo.check();
});

test("an escaped backtick does not start an inline code span", (t) => {
  const repo = checkout(t);
  repo.track("README.md", "## Known gaps\n\\` Tracked in #31. `\n");
  repo.check();
});

test("Setext gap headings start a section and any heading ends it", (t) => {
  const repo = checkout(t);
  repo.track("README.md", "Known gaps\n----------\n\n# Next\n\nTracked in #31.\n");
  repo.check(["README.md:1: Gap or finding has no issue"]);
});

test("front matter is not read as a heading, and the lines after it keep their numbers", (t) => {
  const repo = checkout(t);
  repo.track("README.md", "---\ntitle: Known gaps\n---\n\n## Findings\n\nNo issue yet.\n");
  repo.check(["README.md:5: Gap or finding has no issue"]);
});

test("an indented code block does not supply an issue", (t) => {
  const repo = checkout(t);
  repo.track("README.md", "## Findings\n\n    Tracked in #31.\n");
  repo.check(["README.md:1: Gap or finding has no issue"]);
});

test("only visible link labels and URLs supply issues", (t) => {
  const repo = checkout(t);
  repo.track("README.md", [
    "## Known gaps", "See [the issue][tracked].", "", "[tracked]: https://example.org/repo/issues/31", "",
    "## Findings", "See [the docs](README.md \"Tracked in #32\").", "", "[unused]: https://example.org/repo/issues/33", "",
    "<div>Tracked in #34.</div>",
    "", "## Other gaps", "See [#35](README.md).",
  ].join("\n"));
  repo.check(["README.md:6: Gap or finding has no issue"]);
});

test("ADR index rejects a wrong status or superseding record number", (t) => {
  const repo = checkout(t);
  record(repo, accepted, "accepted");
  record(repo, proposed, "superseded by 0033");
  repo.index(row(accepted, "Proposed"), row(proposed, "Superseded by [0035](0035-other.md)"));
  repo.check([
    "docs/adr/README.md:3: Index status does not match",
    "docs/adr/README.md:4: Index status does not match",
  ]);
});

test("every ADR needs an index row, with or without a leading pipe", (t) => {
  const repo = checkout(t);
  record(repo, accepted, "accepted");
  record(repo, proposed, "accepted");
  repo.index(row(accepted, "Accepted").slice(1), row(proposed, "Proposed").replace(/^\| /, ""));
  repo.check(["docs/adr/README.md:4: Index status does not match"]);
  repo.index(row(accepted, "Accepted"));
  repo.check(["docs/adr/README.md:1: No index row for docs/adr/0034-approvals-that-wait.md"]);
});

test("an escaped pipe stays inside its ADR index cell", (t) => {
  const repo = checkout(t);
  record(repo, accepted, "accepted");
  repo.index(`| [0033](${accepted.split("/").at(-1)}) | Host tools \\| AG-UI | Accepted | Rule |`);
  repo.check();
});

test("an escaped pipe does not disappear from the status text", (t) => {
  const repo = checkout(t);
  record(repo, accepted, "accepted");
  repo.index(row(accepted, "Accep\\|ted"));
  repo.check(["docs/adr/README.md:3: Index status does not match"]);
});

test("ADR rows use the link URL rather than its title or label", (t) => {
  const repo = checkout(t);
  record(repo, accepted, "accepted");
  repo.index(`| [Host tools](${accepted.split("/").at(-1)} "wrong.md") | Decision | Accepted | Rule |`);
  repo.check();
});

test("ADR index allows annotations and calls accepted experiments historical", (t) => {
  const repo = checkout(t);
  const experiment = "docs/adr/0014-experiment.md";
  record(repo, accepted, "accepted");
  record(repo, proposed, "superseded by 0033");
  record(repo, experiment, "accepted");
  repo.index(row(accepted, "Accepted; amended later"), row(proposed, "Superseded by [0033](0033-interface-tools-and-ag-ui.md)"), row(experiment, "Historical experiment"));
  repo.check();
  record(repo, experiment, "proposed");
  repo.check(["docs/adr/README.md:5: Index status does not match"]);
});

test("release versions agree across package manifests and major.minor in the SDK status", (t) => {
  const repo = checkout(t);
  repo.check();
});

test("each release version source reports drift with a line and fix", (t) => {
  const repo = checkout(t);
  repo.write(sdk, "# SDK\n\n**Status: 0.2, accepted**\n");
  repo.write(workspace, '[workspace]\n\n[workspace.package]\nversion = "0.2.0"\n');
  repo.write(demoCrate, '[package]\nname = "demo"\nversion = "0.2.0"\n');
  repo.write(node, '{\n  "version": "0.2.0",\n  "dependencies": { "@modular-agent/demo": "*" },\n  "devDependencies": { "@modular-agent/demo": "0.2.0" }\n}\n');
  repo.check([
    `${sdk}:3: SDK specification version`,
    `${workspace}:4: Cargo workspace version`,
    `${demoCrate}:3: Cargo package version`,
    `${node}:2: Package version`,
    `${node}:3: Dependency @modular-agent/demo`,
    `${node}:4: Dependency @modular-agent/demo`,
  ]);
});

test("one Node pin in two dependency groups is reported at each group's line", (t) => {
  const repo = checkout(t);
  repo.write(node, '{\n  "version": "0.3.2",\n  "devDependencies": { "@modular-agent/demo": "0.2.0" },\n  "dependencies": { "@modular-agent/demo": "0.2.0" }\n}\n');
  repo.check([`${node}:3: Dependency @modular-agent/demo`, `${node}:4: Dependency @modular-agent/demo`]);
});

test("a Node pin with an escaped key or value is reported at its own group's line", (t) => {
  const repo = checkout(t);
  repo.write(node, [
    "{",
    '  "version": "0.3.2",',
    '  "dependencies": { "@modular-agent\\/demo": "\\u0030.2.0" },',
    '  "devDependencies": { "@modular-agent/demo": "0.2.0" },',
    '  "peerDependencies": { "@modular-agent\\u002fdemo": "0.2.0" }',
    "}",
    "",
  ].join("\n"));
  repo.check([`${node}:3: Dependency @modular-agent/demo`, `${node}:4: Dependency @modular-agent/demo`, `${node}:5: Dependency @modular-agent/demo`]);
});

test("a Node pin written twice in one group is reported at the effective, last key", (t) => {
  const repo = checkout(t);
  repo.write(node, [
    "{",
    '  "version": "0.3.2",',
    '  "dependencies": {',
    '    "@modular-agent/demo": "0.3.2",',
    '    "@modular-agent/demo": "0.2.0"',
    "  }",
    "}",
    "",
  ].join("\n"));
  repo.check([`${node}:5: Dependency @modular-agent/demo`]);
});

test("a key that decodes to the probe marker does not move a Node pin's line", (t) => {
  const repo = checkout(t);
  repo.write(node, [
    "{",
    '  "version": "0.2.0",',
    '  "\\u005fdocs_state_probe_version": "metadata",',
    '  "description": "demo"',
    "}",
    "",
  ].join("\n"));
  repo.check([`${node}:2: Package version`]);
});

test("a deeply nested package.json value does not stop the Node pin check", (t) => {
  const repo = checkout(t);
  const deep = "[".repeat(10000) + "0" + "]".repeat(10000);
  repo.write(node, `{\n  "version": "0.2.0",\n  "metadata": ${deep}\n}\n`);
  repo.check([`${node}:2: Package version`]);
});

test("deeply nested objects after a stale Node version are read in one pass", (t) => {
  const repo = checkout(t);
  const deep = '{"k": '.repeat(20000) + "0" + "}".repeat(20000);
  repo.write(node, `{\n  "version": "0.2.0",\n  "metadata": ${deep}\n}\n`);
  repo.check([`${node}:2: Package version`], { timeout: 10_000 });
});

test("a long key with many children outside the pin groups costs no more than its text", (t) => {
  const repo = checkout(t);
  const children = Array.from({ length: 20000 }, (_, i) => `"k${i}": 0`).join(", ");
  repo.write(node, `{\n  "version": "0.2.0",\n  "${"x".repeat(8192)}": { ${children} }\n}\n`);
  repo.check([`${node}:2: Package version`], { timeout: 10_000, nodeArgs: ["--max-old-space-size=128"] });
});

test("many unrelated top-level keys and superseded dependency groups are not kept in memory", (t) => {
  const repo = checkout(t);
  const keys = Array.from({ length: 750000 }, (_, i) => `"k${i}": 0`).join(", ");
  repo.write(node, `{\n  "version": "0.2.0",\n  ${keys}\n}\n`);
  repo.check([`${node}:2: Package version`], { timeout: 20_000, nodeArgs: ["--max-old-space-size=128"] });
  const pins = (group) => Array.from({ length: 10000 }, (_, i) => `"@modular-agent/p${group}-${i}": "0.2.0"`).join(", ");
  const groups = Array.from({ length: 128 }, (_, group) => `  "dependencies": { ${pins(group)} },`).join("\n");
  repo.write(node, `{\n  "version": "0.3.2",\n${groups}\n  "dependencies": { "@modular-agent/demo": "0.2.0" }\n}\n`);
  repo.check([`${node}:131: Dependency @modular-agent/demo`], { timeout: 20_000, nodeArgs: ["--max-old-space-size=128"] });
});

test("a manifest nested two million levels deep is checked within a small heap", (t) => {
  const repo = checkout(t);
  const deep = "[".repeat(2_000_000) + "0" + "]".repeat(2_000_000);
  const cap = { timeout: 30_000, nodeArgs: ["--max-old-space-size=128"] };
  repo.write(node, `{"metadata": ${deep}}\n`);
  repo.check([`${node}:1: Package version`], cap);
  repo.write(node, `{\n  "version": "0.2.0",\n  "metadata": ${deep}\n}\n`);
  repo.check([`${node}:2: Package version`], cap);
});

test("a huge unrelated key or group name is skipped without being copied", (t) => {
  const repo = checkout(t);
  const cap = { timeout: 30_000, nodeArgs: ["--max-old-space-size=128"] };
  const huge = "x".repeat(45 * 1024 * 1024);
  repo.write(node, `{\n  "version": "0.2.0",\n  "${huge}": 0\n}\n`);
  repo.check([`${node}:2: Package version`], cap);
  repo.write(node, `{\n  "version": "0.3.2",\n  "${huge}": { "@modular-agent/demo": "0.1.0" },\n  "dependencies": { "@modular-agent/demo": "0.2.0" }\n}\n`);
  repo.check([`${node}:4: Dependency @modular-agent/demo`], cap);
});

test("Cargo reads quoted and dotted keys and locates the value, not a matching comment", (t) => {
  const repo = checkout(t);
  repo.write(workspace, '# workspace.package.version = "0.2.0"\nworkspace."package" . "version" = "0.2.0"\n');
  repo.write(crate, '[package]\nname = "sdk"\n"version" = { workspace = true }\n');
  repo.write(demoCrate, '[package]\nname = "demo"\nversion = { workspace = false }\n');
  repo.check([`${workspace}:2: Cargo workspace version`, `${demoCrate}:3: Cargo package version`]);
});

test("a malformed newest changelog release cannot fall back to an older release", (t) => {
  const repo = checkout(t);
  repo.write("CHANGELOG.md", "# Changelog\n\n## 0.4\n\n## 0.3.2\n");
  repo.check(["CHANGELOG.md:3: No valid top release heading. Use a heading with the current major.minor.patch release"]);
});

function gitEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
}

function repositoryState(repo) {
  const git = (args) => execFileSync("git", ["-C", repo, ...args], { env: gitEnv(), encoding: "utf8" });
  const gitDir = git(["rev-parse", "--absolute-git-dir"]).trim();
  return {
    head: git(["rev-parse", "HEAD"]),
    refs: git(["for-each-ref", "--format=%(refname) %(objectname)"]),
    config: git(["config", "--local", "--list"]),
    bare: git(["config", "--get", "core.bare"]),
    index: createHash("sha256").update(readFileSync(join(gitDir, "index"))).digest("hex"),
  };
}

function makeWitness(t, prefix) {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (args) => execFileSync("git", args, { env: gitEnv() });
  git(["init", "-q", "-b", "topic", repo]);
  mkdirSync(join(repo, "docs/adr"), { recursive: true });
  writeFileSync(join(repo, "docs/adr/keep.md"), "keep\n");
  const identity = ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
  git([...identity, "add", "docs/adr/keep.md"]);
  git([...identity, "commit", "-q", "-m", "witness"]);
  return repo;
}

function withGitDir(repo, run) {
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = join(repo, ".git");
  process.env.GIT_WORK_TREE = repo;
  try {
    return run();
  } finally {
    for (const key of ["GIT_DIR", "GIT_WORK_TREE"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("a fixture leaves the repository named by GIT_DIR and GIT_WORK_TREE unchanged", (t) => {
  const witness = makeWitness(t, "docs-state-git-dir-");
  const before = repositoryState(witness);
  let thrown;
  try {
    withGitDir(witness, () => {
      const repo = checkout(t);
      repo.check();
    });
  } catch (error) {
    thrown = error;
  }
  assert.deepEqual(repositoryState(witness), before);
  if (thrown) throw thrown;
});

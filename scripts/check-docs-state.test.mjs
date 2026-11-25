import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("check-docs-state.mjs", import.meta.url));
const sdk = "docs/sdk/README.md";
const go = "go/api/api.go";
const workspace = "rust/Cargo.toml";
const crate = "rust/crates/sdk/Cargo.toml";
const demoCrate = "demos/project-notes/history/Cargo.toml";
const node = "typescript/packages/core/package.json";
const python = "python/pyproject.toml";
const pythonPackage = "python/packages/demo/pyproject.toml";
const adrIndex = "docs/adr/README.md";
const accepted = "docs/adr/0033-interface-tools-and-ag-ui.md";
const proposed = "docs/adr/0034-approvals-that-wait.md";

function checkout(t) {
  const cwd = mkdtempSync(join(tmpdir(), "docs-state-"));
  t.after(() => rmSync(cwd, { force: true, recursive: true }));
  const git = (...args) => execFileSync("git", args, { cwd });
  const write = (file, content) => {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), content);
  };
  git("init", "-q");
  write("CHANGELOG.md", "# Changelog\n\n## Unreleased\n\n## 0.3.2\n\n## 0.2.0\n");
  write(sdk, "# The SDK specification\n\n**Status: 0.3, accepted.**\n");
  write(go, 'package api\n\nconst ImplementationVersion = "0.3.2"\n');
  write(workspace, '[workspace]\n\n[workspace.package]\nversion = "0.3.2"\n');
  write(crate, '[package]\nname = "sdk"\nversion.workspace = true # use the workspace release\n');
  write(demoCrate, '[package]\nname = "demo"\nversion = "0.3.2"\n');
  write(node, '{\n  "version": "0.3.2",\n  "dependencies": { "@modular-agent/demo": "0.3.2", "outside": "^1.0.0" }\n}\n');
  write(python, '[project]\nname = "modular-agent"\nversion = "0.3.2"\n\n[dependency-groups]\ndev = ["demo-sdk[test]==0.3.2", "outside==1.0.0"]\n');
  write(pythonPackage, '[project]\nname = "demo_sdk"\nversion = "0.3.2"\ndependencies = ["modular-agent", "outside==1.0.0"]\n');
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
    check(failures = []) {
      const result = spawnSync(process.execPath, [checker, "--root", cwd], { cwd, encoding: "utf8" });
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
  const result = spawnSync(process.execPath, [join(cwd, "check-docs-state.mjs")], { cwd, encoding: "utf8" });
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
  for (const path of ["docs/adr/example.md", "docs/research/example.md", "docs/pressure-test/example.md", "go/docs/clean-room/example.md"]) {
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
  repo.write(go, 'package api\n\nconst ImplementationVersion = "0.2.0"\n');
  repo.write(workspace, '[workspace]\n\n[workspace.package]\nversion = "0.2.0"\n');
  repo.write(demoCrate, '[package]\nname = "demo"\nversion = "0.2.0"\n');
  repo.write(node, '{\n  "version": "0.2.0",\n  "dependencies": { "@modular-agent/demo": "*" },\n  "devDependencies": { "@modular-agent/demo": "0.2.0" }\n}\n');
  repo.write(pythonPackage, '[project]\nname = "demo_sdk"\nversion = "0.2.0"\ndependencies = ["modular-agent == 0.2.0"]\n');
  repo.write(python, '[project]\nname = "modular-agent"\nversion = "0.3.2"\n\n[dependency-groups]\ndev = ["demo-sdk[test]==0.2.0"]\n');
  repo.check([
    `${sdk}:3: SDK specification version`,
    `${go}:3: Go implementation version`,
    `${workspace}:4: Cargo workspace version`,
    `${demoCrate}:3: Cargo package version`,
    `${node}:2: Package version`,
    `${node}:3: Dependency @modular-agent/demo`,
    `${node}:4: Dependency @modular-agent/demo`,
    `${pythonPackage}:3: Python project version`,
    `${pythonPackage}:4: Dependency modular-agent`,
    `${python}:6: Dependency demo-sdk`,
  ]);
});

test("Python pins are read from dependency arrays, not from other project strings", (t) => {
  const repo = checkout(t);
  repo.write(python, [
    "[project]", 'name = "modular-agent"', 'version = "0.3.2"',
    'description = "demo-sdk==0.2.0 was the old example"',
    "dependencies = [", '  "outside==1.0.0",', '  "demo-sdk==0.2.0",', "]",
    'readme = "demo-sdk==0.1.0"',
  ].join("\n") + "\n");
  repo.check([`${python}:7: Dependency demo-sdk`]);
});

test("a bracket in a dependency marker does not end the TOML array", (t) => {
  const repo = checkout(t);
  repo.write(python, [
    "[project]", 'name = "modular-agent"', 'version = "0.3.2"', "dependencies = [",
    String.raw`  "outside==1.0.0; platform_release == \"]\"",`,
    '  "demo-sdk==0.2.0",', "]",
  ].join("\n"));
  repo.check([`${python}:6: Dependency demo-sdk`]);
});

test("a quoted dependencies key still holds Python pins", (t) => {
  const repo = checkout(t);
  repo.write(python, '[project]\nname = "modular-agent"\nversion = "0.3.2"\n"dependencies" = ["demo-sdk==0.2.0"]\n');
  repo.check([`${python}:4: Dependency demo-sdk`]);
});

test("Python pin locations distinguish identical prose and grouped requirements", (t) => {
  const repo = checkout(t);
  const pin = "  DEMO.Sdk [test] (>=0, === 0.2.0); python_version >= '3.13'";
  repo.write(python, [
    "[project]", 'name = "modular-agent"', 'version = "0.3.2"', `description = "${pin}"`,
    "[project.optional-dependencies]", `dev = ["${pin}"]`, "[dependency-groups]",
    `dev = [{include-group = "test"}, "${pin}"]`, 'test = ["demo-sdk @ https://example.org/demo-sdk==0.2.0"]',
  ].join("\n"));
  repo.check([`${python}:6: Dependency DEMO.Sdk`, `${python}:8: Dependency DEMO.Sdk`]);
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

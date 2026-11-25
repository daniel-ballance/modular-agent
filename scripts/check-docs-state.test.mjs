import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const checker = "scripts/check-docs-state.mjs";
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
  mkdirSync(join(cwd, "scripts"));
  copyFileSync(new URL("check-docs-state.mjs", import.meta.url), join(cwd, checker));
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
    check(failures = []) {
      const result = spawnSync(process.execPath, [checker], { cwd, encoding: "utf8" });
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

test("ADR index rejects a wrong status or superseding record number", (t) => {
  const repo = checkout(t);
  record(repo, accepted, "accepted");
  record(repo, proposed, "superseded by 0033");
  repo.track(adrIndex, [row(accepted, "Proposed"), row(proposed, "Superseded by [0035](0035-other.md)")].join("\n"));
  repo.check([
    "docs/adr/README.md:1: Index status does not match",
    "docs/adr/README.md:2: Index status does not match",
  ]);
});

test("ADR index allows annotations and calls accepted experiments historical", (t) => {
  const repo = checkout(t);
  const experiment = "docs/adr/0014-experiment.md";
  record(repo, accepted, "accepted");
  record(repo, proposed, "superseded by 0033");
  record(repo, experiment, "accepted");
  repo.track(adrIndex, [row(accepted, "Accepted; amended later"), row(proposed, "Superseded by [0033](0033-interface-tools-and-ag-ui.md)"), row(experiment, "Historical experiment")].join("\n"));
  repo.check();
  record(repo, experiment, "proposed");
  repo.check(["docs/adr/README.md:3: Index status does not match"]);
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

test("a malformed newest changelog release cannot fall back to an older release", (t) => {
  const repo = checkout(t);
  repo.write("CHANGELOG.md", "# Changelog\n\n## 0.4\n\n## 0.3.2\n");
  repo.check(["CHANGELOG.md:3: No valid top release heading. Use a heading with the current major.minor.patch release"]);
});

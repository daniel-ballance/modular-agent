#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const adrIndex = "docs/adr/README.md";
const sdkIndex = "docs/sdk/README.md";
const goVersion = "go/api/api.go";
const adrFile = /^docs\/adr\/\d{4}-[^/]+\.md$/;
const gapHeading = /\b(?:gaps?|remaining|findings)\b|\bfinding$|\bspecification was silent\b|\bproposed\b.*\btext\b|^proposed, not yet written$/i;
const historicalGaps = /^(?:docs\/(?:adr|research|pressure-test)\/)|\/docs\/clean-room\//;
const issueUrl = /https?:\/\/[^\s<>()[\]]+\/issues\/[1-9]\d*\b/;
const issueNumber = /(?:^|[\s(\[]|[\w.-]+\/[\w.-]+)#\d*[1-9]\d*\b/;
const release = /^v?(\d+\.\d+\.\d+)$/;
const link = /\[([^\]\n]+)\]\(<?([^\s)>]+)>?(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\)/g;
const ruleAliases = new Map([
  ["docs/contracts.md#interface-run-tools", "0033"],
  ["docs/bindings/agui.md", "0033"],
  ["docs/sdk/placement.md#serving-ag-ui", "0033"],
  ["docs/contracts.md#approvals-that-wait", "0034"],
  ["docs/contracts.md#approvals-that-cover-nested-calls", "0034"],
  ["docs/sdk/api.md#questions", "0034"],
]);
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const linesOf = (text) => text.split(/\r?\n/);
const read = (file) => {
  try {
    return readFileSync(join(root, file), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return "";
  }
};
let bad = 0;

function fail(file, line, problem, fix) {
  console.error(`${file}:${line}: ${problem}. ${fix}.`);
  bad++;
}

function markdownLines(text) {
  let fence;
  return linesOf(text.replace(/<!--[^]*?(?:-->|$)/g, (comment) => comment.replace(/[^\n]/g, " "))).map((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker?.[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return "";
    }
    if (marker) {
      fence = marker[1];
      return "";
    }
    return line;
  });
}

function checkGaps(file, lines) {
  let heading;
  const finish = () => {
    if (heading && !heading.tracked) fail(file, heading.line, "Gap or finding has no issue", "Link an issue below the heading, before the next heading");
  };
  for (const [i, line] of lines.entries()) {
    const title = line.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/)?.[1];
    if (title) {
      finish();
      heading = gapHeading.test(title) ? { line: i + 1, tracked: false } : undefined;
    } else if (heading) {
      const prose = line.replace(/(`+).*?\1/g, "");
      heading.tracked ||= issueUrl.test(prose) || issueNumber.test(prose.replace(link, "$1"));
    }
  }
  finish();
}

function adrStatus(text) {
  return text.match(/^---\r?\n(.*?)\r?\n---(?:\r?\n|$)/s)?.[1].match(/^status:[ \t]*([^\r\n]+)/m)?.[1].trim().toLowerCase();
}

function checkAdrIndex(lines, statuses, rules) {
  for (const [i, line] of lines.entries()) {
    const row = line.match(/^ {0,3}\|\s*\[\d{4}\]\(([^)]+)\)\s*\|[^|]*\|([^|]*)\|([^|]*)/);
    if (!row) continue;
    const file = posix.join("docs/adr", row[1]);
    const status = statuses.get(file);
    const cell = row[2].trim().toLowerCase().replace(link, "$1");
    // Historical describes applicability, not a change to the original accepted decision.
    if (status === "accepted" && /^historical\b/.test(cell)) continue;
    if (!status) fail(adrIndex, i + 1, `No front matter status for ${file}`, "Restore the record and its status");
    else if (!cell.startsWith(status) || /^[\w-]/.test(cell.slice(status.length))) {
      fail(adrIndex, i + 1, `Index status does not match ${file}`, `Start the status cell with "${status}"`);
    } else if (status === "accepted") {
      for (const [, , target] of row[3].matchAll(link)) {
        const local = localTarget(adrIndex, target);
        // A whole document linked in the index can contain rules from many decisions.
        if (local?.includes("#") && !rules.has(local)) rules.set(local, file);
      }
    }
  }
}

function localTarget(file, target) {
  const prefix = "https://github.com/daniel-ballance/modular-agent/blob/";
  if (target.startsWith(prefix)) return target.slice(prefix.length).replace(/^.*?\/(?=docs\/)/, "");
  if (/^[a-z][a-z0-9+.-]*:|^\//i.test(target)) return;
  return target.startsWith("#") ? file + target : posix.join(posix.dirname(file), target);
}

function checkAdrProse(file, lines, statuses, rules) {
  const text = lines.join("\n");
  if (!/\bproposed\b/i.test(text)) return;
  const prose = text.replace(/(`+)[^\n]*?\1/g, (code) => " ".repeat(code.length));
  for (const { 0: span, 1: label, 2: target, index } of prose.matchAll(link)) {
    const local = localTarget(file, target);
    if (!local) continue;
    const direct = local.split("#")[0];
    const adr = adrFile.test(direct) ? direct : rules.get(local);
    if (statuses.get(adr) !== "accepted") continue;
    // Match status wording attached to the link, not e.g. "proposed changes to" an accepted rule.
    const before = prose.slice(0, index).match(/\bproposed[*_]*(?:[ \t\n]+(?:in|by))?[ \t\n]+[*_]*$/i);
    const after = prose.slice(index + span.length).match(/^[*_ \t)]*(?:\n[ \t]*)?(?:is|are|remains?)[ \t\n]+(?:(?:still|currently)[ \t\n]+)?proposed\b/i);
    const phrase = before?.[0] ?? after?.[0];
    if (!/^proposed\s/i.test(label) && (!phrase || /\n[ \t]*\n/.test(phrase))) continue;
    // A wrapped line joins a sentence; a table row does not join the next row.
    if (phrase?.includes("\n") && /\|/.test(lineAround(prose, before ? before.index : index + span.length))) continue;
    const line = linesOf(text.slice(0, before?.index ?? index)).length;
    fail(file, line, `Prose calls an accepted decision in ${adr} proposed`, "Describe the accepted rule instead");
  }
}

function lineAround(text, at) {
  const start = text.lastIndexOf("\n", at - 1) + 1;
  const next = text.indexOf("\n", text.indexOf("\n", at) + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

function first(lines, pattern) {
  for (const [i, line] of lines.entries()) {
    const match = line.match(pattern);
    if (match) return { line: i + 1, value: match[1] };
  }
  return { line: 1 };
}

function section(lines, name) {
  const table = (line) => line.match(/^\s*\[\[?([\w][\w.-]*)\]\]?\s*(?:#.*)?$/)?.[1];
  const start = lines.findIndex((line) => table(line) === name);
  if (start === -1) return { lines: [], offset: 0 };
  const end = lines.findIndex((line, i) => i > start && table(line));
  return { lines: lines.slice(start + 1, end === -1 ? undefined : end), offset: start + 1 };
}

const quotedVersion = /^\s*version\s*=\s*["']([^"']+)["']/;

function tomlValue(lines, table, pattern) {
  const part = section(lines, table);
  const match = first(part.lines, pattern);
  return { ...match, line: part.offset + match.line };
}

function checkVersion(file, { line, value }, version, field) {
  if (value !== version) fail(file, line, `${field} is ${value === undefined ? "missing" : JSON.stringify(value)}`, `Set it to ${version} to match CHANGELOG.md`);
}

function checkCargo(file, lines, version) {
  if (file === "rust/Cargo.toml" || section(lines, "workspace.package").offset) {
    checkVersion(file, tomlValue(lines, "workspace.package", quotedVersion), version, "Cargo workspace version");
  }
  const pkg = section(lines, "package");
  if (pkg.offset && !pkg.lines.some((line) => /^\s*version\s*(?:\.\s*workspace\s*=\s*true|=\s*\{\s*workspace\s*=\s*true\s*\})\s*(?:#.*)?$/.test(line))) {
    checkVersion(file, tomlValue(lines, "package", quotedVersion), version, "Cargo package version");
  }
}

function checkNodePackage(file, text, version) {
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch {
    fail(file, 1, "Invalid package JSON", "Restore a valid package manifest");
    return;
  }
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const check = (key, value) => {
    const entry = new RegExp(`${escape(JSON.stringify(key))}\\s*:\\s*${escape(JSON.stringify(value) ?? "")}`);
    const index = value === undefined ? 0 : text.search(entry);
    const line = linesOf(text.slice(0, Math.max(index, 0))).length;
    checkVersion(file, { line, value }, version, key === "version" ? "Package version" : `Dependency ${key}`);
  };
  check("version", pkg?.version);
  for (const group of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [name, pin] of Object.entries(pkg?.[group] ?? {})) {
      if (name.startsWith("@modular-agent/")) check(name, pin);
    }
  }
}

const pythonName = (name) => name.toLowerCase().replace(/[-_.]+/g, "-");

function checkPython(packages, version) {
  const names = new Set([...packages.values()].map((lines) => tomlValue(lines, "project", /^\s*name\s*=\s*["']([^"']+)["']/).value).filter(Boolean).map(pythonName));
  for (const [file, lines] of packages) {
    checkVersion(file, tomlValue(lines, "project", quotedVersion), version, "Python project version");
    for (const table of ["project", "project.optional-dependencies", "dependency-groups"]) {
      const part = section(lines, table);
      for (const [i, line] of part.lines.entries()) {
        for (const token of line.matchAll(/"[^"\n]*"|'[^'\n]*'|#.*/g)) {
          const pin = token[0].slice(1, -1).match(/^([\w.-]+)(?:\[[^\]]+\])?\s*===?\s*([^\s;,]+)/);
          if (pin && names.has(pythonName(pin[1]))) {
            checkVersion(file, { line: part.offset + i + 1, value: pin[2] }, version, `Dependency ${pin[1]}`);
          }
        }
      }
    }
  }
}

function checkVersions(files) {
  const heading = first(markdownLines(read("CHANGELOG.md")), /^ {0,3}##\s+(\[?v?\d+\S*)/);
  const version = heading.value?.replace(/^\[([^\]]+)\]$/, "$1").match(release)?.[1];
  if (!version) {
    fail("CHANGELOG.md", heading.line, "No valid top release heading", "Use a heading with the current major.minor.patch release");
    return;
  }
  checkVersion(sdkIndex, first(linesOf(read(sdkIndex)), /^\*\*Status:\s*([^,\s*]+)/), version.split(".").slice(0, 2).join("."), "SDK specification version");
  checkVersion(goVersion, first(linesOf(read(goVersion)), /^\s*const\s+ImplementationVersion\s*=\s*"([^"]+)"/), version, "Go implementation version");
  const python = new Map();
  for (const file of files) {
    if (file.endsWith("Cargo.toml")) checkCargo(file, linesOf(read(file)), version);
    else if (file.endsWith("package.json")) checkNodePackage(file, read(file), version);
    else if (file.endsWith("pyproject.toml")) python.set(file, linesOf(read(file)));
  }
  checkPython(python, version);
}

try {
  const files = git("ls-files", "-z", "--", "*.md", "Cargo.toml", "*/Cargo.toml", ":(glob)typescript/packages/*/package.json", ":(glob)python/**/pyproject.toml")
    .split("\0").filter(Boolean);
  const markdown = files.filter((file) => file.endsWith(".md"));
  const statuses = new Map(markdown.filter((file) => adrFile.test(file)).map((file) => [file, adrStatus(read(file))]));
  const byNumber = new Map([...statuses.keys()].map((file) => [posix.basename(file).slice(0, 4), file]));
  const rules = new Map();
  for (const [target, number] of ruleAliases) {
    const file = byNumber.get(number);
    if (statuses.get(file) === "accepted") rules.set(target, file);
  }
  checkAdrIndex(markdownLines(read(adrIndex)), statuses, rules);
  for (const file of markdown) {
    const lines = markdownLines(read(file));
    if (!historicalGaps.test(file)) checkGaps(file, lines);
    if (!file.startsWith("docs/adr/")) checkAdrProse(file, lines, statuses, rules);
  }
  checkVersions(files);
  console.log(`${markdown.length} tracked Markdown files and ${files.length - markdown.length} package manifests checked. Failures: ${bad}.`);
  process.exitCode = bad ? 1 : 0;
} catch (error) {
  console.error(`scripts/check-docs-state.mjs:1: ${error.message.split("\n")[0]}. Run the check in a Git checkout with readable tracked files.`);
  process.exitCode = 1;
}

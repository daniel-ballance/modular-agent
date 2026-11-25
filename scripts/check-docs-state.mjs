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
const gapHeading = /^(?:known gaps|gaps|findings)\b|\b(?:gaps|findings)$|^remaining$|^remaining\b.*\b(?:work|gaps)$|^proposed\b.*\btext\b|^proposed, not yet written$/i;
const historicalGaps = /^(?:docs\/(?:adr|research|pressure-test)\/)|\/docs\/clean-room\//;
const issueUrl = /https?:\/\/[^\s<>()[\]]+\/issues\/[1-9]\d*\b/;
const issueNumber = /(?:^|[\s(\[]|[\w.-]+\/[\w.-]+)#\d*[1-9]\d*\b/;
const release = /^v?(\d+\.\d+\.\d+)$/;
const link = /\[([^\]\n]+)\]\(<?([^\s)>]+)>?(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*\)/g;
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

// CommonMark code span: a backtick run closed by a run of the same length.
const codeSpan = /(?<!`)(`+)(?!`).*?(?<!`)\1(?!`)/g;
// CommonMark fences: a backtick opener's info string has no backtick; a closer has only spaces or tabs after it.
const fenceOpen = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;
const fenceClose = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

// Blank fenced code and mask HTML comments with NUL, keeping line numbers.
// NUL is not a space, so a masked comment cannot complete an ATX opener.
// A fence or a code span can hold a literal "<!--"; it does not open a comment.
function markdownLines(text) {
  let fence;
  let comment = false;
  return linesOf(text).map((line) => {
    if (fence) {
      const close = line.match(fenceClose)?.[1];
      if (close?.[0] === fence[0] && close.length >= fence.length) fence = undefined;
      return "";
    }
    const open = !comment && line.match(fenceOpen)?.[1];
    if (open) {
      fence = open;
      return "";
    }
    const code = line.replace(codeSpan, (span) => " ".repeat(span.length));
    let out = "";
    let at = 0;
    while (at < line.length) {
      const next = comment ? line.indexOf("-->", at) : code.indexOf("<!--", at);
      if (next === -1) {
        out += comment ? "\0".repeat(line.length - at) : line.slice(at);
        break;
      }
      const end = comment ? next + 3 : next + 4;
      out += comment ? "\0".repeat(end - at) : line.slice(at, next) + "\0\0\0\0";
      at = end;
      comment = !comment;
    }
    return out;
  });
}

// CommonMark ATX heading: a closing run of # counts only after a space, and an empty heading is still a heading.
function atxTitle(line) {
  const match = line.match(/^ {0,3}#{1,6}(?:[ \t]+(.*?))?[ \t]*$/);
  return match ? (match[1] ?? "").replace(/\0/g, "").replace(/(?:^|[ \t]+)#+$/, "").trim() : undefined;
}

function checkGaps(file, lines) {
  let heading;
  const finish = () => {
    if (heading && !heading.tracked) fail(file, heading.line, "Gap or finding has no issue", "Link an issue below the heading, before the next heading");
  };
  for (const [i, line] of lines.entries()) {
    const title = atxTitle(line);
    if (title !== undefined) {
      finish();
      heading = gapHeading.test(title) ? { line: i + 1, tracked: false } : undefined;
    } else if (heading) {
      const prose = line.replace(codeSpan, "");
      heading.tracked ||= issueUrl.test(prose) || issueNumber.test(prose.replace(link, "$1"));
    }
  }
  finish();
}

function adrStatus(text) {
  return text.match(/^---\r?\n(.*?)\r?\n---(?:\r?\n|$)/s)?.[1].match(/^status:[ \t]*([^\r\n]+)/m)?.[1].trim().toLowerCase();
}

function checkAdrIndex(lines, statuses) {
  const indexed = new Set();
  for (const [i, line] of lines.entries()) {
    const row = line.match(/^ {0,3}\|?\s*\[\d{4}\]\(([^)]+)\)\s*\|[^|]*\|([^|]*)(?:\||$)/);
    if (!row) continue;
    const file = posix.join("docs/adr", row[1]);
    indexed.add(file);
    const status = statuses.get(file);
    const cell = row[2].replace(/\0/g, "").trim().toLowerCase().replace(link, "$1");
    // Historical describes applicability, not a change to the original accepted decision.
    if (status === "accepted" && /^historical\b/.test(cell)) continue;
    if (!status) fail(adrIndex, i + 1, `No front matter status for ${file}`, "Restore the record and its status");
    else if (!cell.startsWith(status) || /^[\w-]/.test(cell.slice(status.length))) {
      fail(adrIndex, i + 1, `Index status does not match ${file}`, `Start the status cell with "${status}"`);
    }
  }
  for (const file of statuses.keys()) {
    if (!indexed.has(file)) fail(adrIndex, 1, `No index row for ${file}`, "Add a row whose first cell links the record");
  }
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
  checkAdrIndex(markdownLines(read(adrIndex)), statuses);
  for (const file of markdown) {
    const lines = markdownLines(read(file));
    if (!historicalGaps.test(file)) checkGaps(file, lines);
  }
  checkVersions(files);
  console.log(`${markdown.length} tracked Markdown files and ${files.length - markdown.length} package manifests checked. Failures: ${bad}.`);
  process.exitCode = bad ? 1 : 0;
} catch (error) {
  console.error(`scripts/check-docs-state.mjs:1: ${error.message.split("\n")[0]}. Run the check in a Git checkout with readable tracked files.`);
  process.exitCode = 1;
}

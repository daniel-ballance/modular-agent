#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const parsers = await Promise.all([import("./markdown.mjs"), import("smol-toml")]).catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  console.error("scripts/check-docs-state.mjs:1: Missing parser dependencies. Run npm ci --prefix scripts.");
  process.exit(1);
});
const [{ adrStatus, parseMarkdown, walk }, { parse, TomlError }] = parsers;

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--root" || !args[1])) {
  console.error("Usage: node scripts/check-docs-state.mjs [--root DIR]");
  process.exit(1);
}
const root = args.length ? resolve(args[1]) : fileURLToPath(new URL("..", import.meta.url));
const adrIndex = "docs/adr/README.md";
const sdkIndex = "docs/sdk/README.md";
const goVersion = "go/api/api.go";
const adrFile = /^docs\/adr\/\d{4}-[^/]+\.md$/;
const gapHeading = /^(?:known gaps|gaps|findings)\b|\b(?:gaps|findings)$|^remaining$|^remaining\b.*\b(?:work|gaps)$|^proposed\b.*\btext\b|^proposed, not yet written$/i;
const historicalGaps = /^(?:docs\/(?:adr|research|pressure-test)\/)|\/docs\/clean-room\//;
const issueUrl = /https?:\/\/[^\s<>()[\]]+\/issues\/[1-9]\d*\b/;
const issueNumber = /(?:^|[\s(\[]|[\w.-]+\/[\w.-]+)#\d*[1-9]\d*\b/;
const release = /^v?(\d+\.\d+\.\d+)$/;
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

function inlineText(node, includeCode = false) {
  if (node?.type === "text" || (includeCode && node?.type === "inlineCode")) return node.value;
  if (node?.type === "break") return "\n";
  return (node?.children ?? []).map((child) => inlineText(child, includeCode)).join("");
}

function linkUrls(tree) {
  const definitions = new Map();
  for (const node of walk(tree)) {
    if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
  }
  return (node) => node.type === "link" ? node.url : node.type === "linkReference" ? definitions.get(node.identifier) : undefined;
}

function checkGaps(file, tree) {
  const urlOf = linkUrls(tree);
  let heading;
  const finish = () => {
    if (heading && !heading.tracked) fail(file, heading.line, "Gap or finding has no issue", "Link an issue below the heading, before the next heading");
  };
  const inlineBlocks = ["heading", "paragraph", "tableCell"];
  for (const node of walk(tree, inlineBlocks)) {
    if (node.type === "heading") {
      finish();
      heading = gapHeading.test(inlineText(node, true).trim()) ? { line: node.position.start.line, tracked: false } : undefined;
    } else if (heading && !heading.tracked && inlineBlocks.includes(node.type)) {
      const text = inlineText(node);
      heading.tracked = issueUrl.test(text) || issueNumber.test(text);
      if (heading.tracked) continue;
      for (const inline of walk(node)) {
        const url = urlOf(inline);
        if (url !== undefined && (issueUrl.test(url) || issueNumber.test(inlineText(inline)))) {
          heading.tracked = true;
          break;
        }
      }
    }
  }
  finish();
}

const adrBase = new URL("https://repository.invalid/docs/adr/");

function adrTarget(href) {
  const target = href && URL.parse(href, adrBase);
  if (target?.origin !== adrBase.origin) return;
  const file = target.pathname.slice(1);
  if (adrFile.test(file)) return file;
}

function checkAdrIndex(tree, statuses) {
  const indexed = new Set();
  const urlOf = linkUrls(tree);
  for (const node of walk(tree)) {
    if (node.type !== "tableRow") continue;
    const [firstCell, , statusCell] = node.children;
    const cell = inlineText(statusCell, true).trim().toLowerCase();
    const line = node.position.start.line;
    for (const link of walk(firstCell)) {
      const file = adrTarget(urlOf(link));
      if (!file) continue;
      indexed.add(file);
      const status = statuses.get(file);
      if (status === "accepted" && /^historical\b/.test(cell)) continue;
      if (!status) fail(adrIndex, line, `No front matter status for ${file}`, "Restore the record and its status");
      else if (!cell.startsWith(status) || /^[\w-]/.test(cell.slice(status.length))) {
        fail(adrIndex, line, `Index status does not match ${file}`, `Start the status cell with "${status}"`);
      }
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

function checkVersion(file, { line, value }, version, field) {
  if (value === version) return;
  const found = value === undefined ? "missing" : JSON.stringify(value, (_, item) => typeof item === "bigint" ? String(item) : item);
  fail(file, line, `${field} is ${found}`, `Set it to ${version} to match CHANGELOG.md`);
}

const tomlOptions = { integersAsBigInt: "asNeeded" };
const atPath = (data, path) => path.reduce((value, key) => value?.[key], data);

function parseManifest(file) {
  const source = read(file);
  try {
    return { source, data: parse(source, tomlOptions) };
  } catch (error) {
    if (!(error instanceof TomlError)) throw error;
    fail(file, error.line, error.message.split("\n")[0], "Restore a valid TOML manifest");
  }
}

function tomlLine({ source, data }, path, value) {
  let marker = "_docs_state_probe_";
  while (source.includes(marker)) marker += "_";
  const probe = (offset, matches) => {
    try {
      return matches(parse(source.slice(0, offset) + marker + source.slice(offset), tomlOptions));
    } catch (error) {
      if (!(error instanceof TomlError)) throw error;
      return false;
    }
  };
  // smol-toml has no value positions. Reparse a marked candidate to distinguish a value from identical prose or pins elsewhere.
  if (typeof value === "string") {
    for (const quote of source.matchAll(/"""|'''|["']/g)) {
      const offset = quote.index + quote[0].length;
      const newline = quote[0].length === 3 ? source.slice(offset, offset + 2).match(/^\r?\n/)?.[0].length ?? 0 : 0;
      if (probe(offset + newline, (marked) => atPath(marked, path) === marker + value)) {
        return linesOf(source.slice(0, quote.index)).length;
      }
    }
  }
  if (value !== undefined && path.at(-1) === "version") {
    const markedPath = [...path.slice(0, -1), `${marker}version`];
    if (atPath(data, markedPath) === undefined) {
      for (const key of source.matchAll(/\bversion\b|["']/g)) {
        const offset = key.index + (key[0] === "version" ? 0 : 1);
        if (probe(offset, (marked) => atPath(marked, path) === undefined && atPath(marked, markedPath) !== undefined)) {
          return linesOf(source.slice(0, key.index)).length;
        }
      }
    }
  }
  return 1;
}

function checkTomlVersion(file, manifest, path, version, field) {
  const value = atPath(manifest.data, path);
  if (value !== version) checkVersion(file, { line: tomlLine(manifest, path, value), value }, version, field);
}

function checkCargo(file, manifest, version) {
  const { data } = manifest;
  if (file === "rust/Cargo.toml" || data.workspace?.package !== undefined) {
    checkTomlVersion(file, manifest, ["workspace", "package", "version"], version, "Cargo workspace version");
  }
  const packageVersion = data.package?.version;
  const inherited = packageVersion?.workspace === true && Object.keys(packageVersion).length === 1;
  if (data.package !== undefined && !inherited) {
    checkTomlVersion(file, manifest, ["package", "version"], version, "Cargo package version");
  }
}

// JSON.parse has no positions, so one pass over the text it accepted records the line of each
// wanted key: a top-level key, or a key directly inside a dependency group. JSON.parse decodes each
// key, so "\/" and "\u002f" match "/", and the last of duplicate keys wins, as in JSON.parse. The
// pass keeps a depth count and the state of the top two levels only. A JSON string spends at most six
// characters per decoded one, so a key longer than that bound for every wanted name and group is
// skipped undecoded. The pass then holds no copy of a key or value it does not need.
const nodeGroups = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

function keyLines(text, paths) {
  const wanted = new Set(paths.map((path) => JSON.stringify(path)));
  let longest = 0;
  for (const name of [...nodeGroups, ...paths.flat()]) longest = Math.max(longest, name.length);
  const limit = 6 * longest + 2;
  const lines = new Map();
  const isObject = [false, false, false];
  let depth = 0;
  let topKey = null;
  let group = null;
  let line = 1;
  let expectKey = false;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === "\n") line++;
    else if (char === "{" || char === "[") {
      depth++;
      if (depth <= 2) isObject[depth] = char === "{";
      if (depth === 2) group = topKey;
      expectKey = depth <= 2 && char === "{";
    } else if (char === "}" || char === "]") {
      depth--;
      expectKey = false;
    } else if (char === ",") expectKey = depth <= 2 && isObject[depth];
    else if (char === '"') {
      let end = at + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      if (expectKey && end + 1 - at > limit) {
        if (depth === 1) topKey = null;
      } else if (expectKey && (depth === 1 || nodeGroups.includes(group))) {
        const key = JSON.parse(text.slice(at, end + 1));
        if (depth === 1) topKey = key;
        const path = JSON.stringify(depth === 1 ? [key] : [group, key]);
        if (wanted.has(path)) lines.set(path, line);
      }
      expectKey = false;
      at = end;
    }
  }
  return lines;
}

function checkNodePackage(file, text, version) {
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch {
    fail(file, 1, "Invalid package JSON", "Restore a valid package manifest");
    return;
  }
  const stale = [];
  const check = (path, value) => {
    if (value !== version) stale.push({ path, value });
  };
  check(["version"], pkg?.version);
  for (const group of nodeGroups) {
    for (const [name, pin] of Object.entries(pkg?.[group] ?? {})) {
      if (name.startsWith("@modular-agent/")) check([group, name], pin);
    }
  }
  // A missing value is reported at line 1, so only present values need the scan.
  const located = stale.filter(({ value }) => value !== undefined);
  const lines = located.length === 0 ? new Map() : keyLines(text, located.map(({ path }) => path));
  for (const { path, value } of stale) {
    const field = path.length === 1 ? "Package version" : `Dependency ${path[1]}`;
    checkVersion(file, { line: value === undefined ? 1 : lines.get(JSON.stringify(path)) ?? 1, value }, version, field);
  }
}

const pythonName = (name) => name.toLowerCase().replace(/[-_.]+/g, "-");

function* pythonPins(requirement) {
  if (typeof requirement !== "string") return;
  const match = requirement.split(";", 1)[0].trim().match(/^([a-z\d](?:[a-z\d._-]*[a-z\d])?)(?:\s*\[[^\]]*\])?\s*(.*)$/is);
  if (!match || match[2].startsWith("@")) return;
  const [, name, specifiers] = match;
  for (const specifier of specifiers.replace(/^\((.*)\)$/s, "$1").split(",")) {
    const pin = specifier.trim().match(/^===?\s*([^=\s]\S*)$/);
    if (pin) yield { name, value: pin[1] };
  }
}

function checkPython(packages, version) {
  const names = new Set([...packages.values()].map(({ data }) => data.project?.name).filter((name) => typeof name === "string").map(pythonName));
  for (const [file, manifest] of packages) {
    checkTomlVersion(file, manifest, ["project", "version"], version, "Python project version");
    const { data } = manifest;
    const optionals = Object.keys(data.project?.["optional-dependencies"] ?? {});
    const groups = Object.keys(data["dependency-groups"] ?? {});
    const arrays = [["project", "dependencies"], ...optionals.map((group) => ["project", "optional-dependencies", group]), ...groups.map((group) => ["dependency-groups", group])];
    for (const path of arrays) {
      const dependencies = atPath(data, path);
      if (!Array.isArray(dependencies)) continue;
      for (const [i, requirement] of dependencies.entries()) {
        for (const { name, value } of pythonPins(requirement)) {
          if (value !== version && names.has(pythonName(name))) {
            const line = tomlLine(manifest, [...path, i], requirement);
            checkVersion(file, { line, value }, version, `Dependency ${name}`);
          }
        }
      }
    }
  }
}

function checkVersions(files) {
  const changelog = read("CHANGELOG.md");
  const releaseLine = /^ {0,3}##\s+(\[?v?\d+[^\s]*)/;
  const lines = linesOf(changelog);
  const heading = parseMarkdown(changelog).children.find((node) => node.type === "heading" && node.depth === 2 && releaseLine.test(lines[node.position.start.line - 1]));
  const line = heading?.position.start.line ?? 1;
  const version = lines[line - 1].match(releaseLine)?.[1].replace(/^\[([^\]]+)\]$/, "$1").match(release)?.[1];
  if (!heading || !version) {
    fail("CHANGELOG.md", line, "No valid top release heading", "Use a heading with the current major.minor.patch release");
    return;
  }
  checkVersion(sdkIndex, first(linesOf(read(sdkIndex)), /^\*\*Status:\s*([^,\s*]+)/), version.split(".").slice(0, 2).join("."), "SDK specification version");
  checkVersion(goVersion, first(linesOf(read(goVersion)), /^\s*const\s+ImplementationVersion\s*=\s*"([^"]+)"/), version, "Go implementation version");
  const python = new Map();
  for (const file of files) {
    if (file.endsWith("package.json")) checkNodePackage(file, read(file), version);
    else if (!file.endsWith(".md")) {
      const manifest = parseManifest(file);
      if (!manifest) continue;
      if (file.endsWith("Cargo.toml")) checkCargo(file, manifest, version);
      else python.set(file, manifest);
    }
  }
  checkPython(python, version);
}

try {
  const files = git("ls-files", "-z", "--", "*.md", "Cargo.toml", "*/Cargo.toml", ":(glob)typescript/packages/*/package.json", ":(glob)python/**/pyproject.toml")
    .split("\0").filter(Boolean);
  const markdown = files.filter((file) => file.endsWith(".md"));
  const statuses = new Map(markdown.filter((file) => adrFile.test(file)).map((file) => [file, adrStatus(read(file))]));
  checkAdrIndex(parseMarkdown(read(adrIndex)), statuses);
  for (const file of markdown) {
    if (!historicalGaps.test(file)) checkGaps(file, parseMarkdown(read(file)));
  }
  checkVersions(files);
  console.log(`${markdown.length} tracked Markdown files and ${files.length - markdown.length} package manifests checked. Failures: ${bad}.`);
  process.exitCode = bad ? 1 : 0;
} catch (error) {
  console.error(`scripts/check-docs-state.mjs:1: ${error.message.split("\n")[0]}. Run the check in a Git checkout with readable tracked files.`);
  process.exitCode = 1;
}

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

// JSON.parse keeps every value, and it has no positions. The capped test's source string is
// external memory; the old-space cost was the parse. On Node 26.13.1 (V8 14.6) 750,000 unrelated
// keys left about 80 MB of the V8 heap live, and 128 superseded dependency groups promoted
// short-lived key strings until the committed heap passed 200 MB. A full GC dropped that case
// back to the source string, so the groups were not retained. Under load the promotion still
// reached the 128 MB old-space cap before that GC ran. This pass keeps only the last "version"
// span and the last span of each dependency group, and skips every other value without copying
// it. A superseded group is never parsed. On the same Node the capped checker stays within
// 17 MB of committed heap, about 110 MB under the cap. The line pass compares a raw key in
// place and decodes only an escaped key short enough to be a wanted name, so "\/" and "\u002f"
// still match "/". Duplicate keys keep the last value, as in JSON.parse. The line pass keeps
// a depth count and the state of the top two levels only.
const nodeGroups = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const groupKeyLimit = 6 * "optionalDependencies".length;

function invalidPackage() {
  throw new SyntaxError("Invalid package JSON");
}

function isHex(char) {
  return (char >= "0" && char <= "9") || (char >= "a" && char <= "f") || (char >= "A" && char <= "F");
}

function skipWs(text, at) {
  while (text[at] === " " || text[at] === "\n" || text[at] === "\r" || text[at] === "\t") at++;
  return at;
}

function skipString(text, at) {
  if (text[at] !== '"') invalidPackage();
  let i = at + 1;
  while (i < text.length) {
    const char = text[i];
    if (char === '"') return i + 1;
    if (char === "\\") {
      const next = text[i + 1];
      if (next === '"' || next === "\\" || next === "/" || next === "b" || next === "f" || next === "n" || next === "r" || next === "t") {
        i += 2;
        continue;
      }
      if (next === "u" && isHex(text[i + 2]) && isHex(text[i + 3]) && isHex(text[i + 4]) && isHex(text[i + 5])) {
        i += 6;
        continue;
      }
      invalidPackage();
    }
    if (char < " ") invalidPackage();
    i++;
  }
  invalidPackage();
}

function skipWord(text, at, word) {
  for (let i = 0; i < word.length; i++) if (text[at + i] !== word[i]) invalidPackage();
  return at + word.length;
}

function skipDigits(text, i) {
  while (text[i] >= "0" && text[i] <= "9") i++;
  return i;
}

function skipNumber(text, at) {
  let i = at;
  if (text[i] === "-") i++;
  if (text[i] === "0") i++;
  else if (text[i] >= "1" && text[i] <= "9") i = skipDigits(text, i + 1);
  else invalidPackage();
  if (text[i] === ".") {
    i++;
    if (text[i] < "0" || text[i] > "9") invalidPackage();
    i = skipDigits(text, i + 1);
  }
  if (text[i] === "e" || text[i] === "E") {
    i++;
    if (text[i] === "+" || text[i] === "-") i++;
    if (text[i] < "0" || text[i] > "9") invalidPackage();
    i = skipDigits(text, i + 1);
  }
  return i;
}

// One byte per nesting level, reused so a value nested millions deep does not allocate a frame
// per level. 1 array value or end, 8 value required, 2 comma or end; 3 object key or end,
// 7 key required, 5 value, 6 comma or end.
let nest = new Uint8Array(64);

function growNest() {
  const grown = new Uint8Array(nest.length * 2);
  grown.set(nest);
  nest = grown;
}

function closeContainer(text, at, depth) {
  depth--;
  at = skipWs(text, at + 1);
  if (depth === 0) return { at, depth };
  const parent = nest[depth - 1];
  nest[depth - 1] = parent === 1 || parent === 8 ? 2 : 6;
  return { at, depth };
}

// End index of one JSON value. Throws the same SyntaxError on text JSON.parse rejects.
function skipValue(text, at) {
  let depth = 0;
  at = skipWs(text, at);
  for (;;) {
    const state = depth === 0 ? 0 : nest[depth - 1];
    if ((state === 1 && text[at] === "]") || (state === 3 && text[at] === "}")) {
      ({ at, depth } = closeContainer(text, at, depth));
      if (depth === 0) return at;
      continue;
    }
    if (state === 2 || state === 6) {
      if (text[at] === (state === 2 ? "]" : "}")) {
        ({ at, depth } = closeContainer(text, at, depth));
        if (depth === 0) return at;
        continue;
      }
      if (text[at] !== ",") invalidPackage();
      at = skipWs(text, at + 1);
      nest[depth - 1] = state === 2 ? 8 : 7;
      continue;
    }
    if (state === 3 || state === 7) {
      at = skipString(text, at);
      at = skipWs(text, at);
      if (text[at] !== ":") invalidPackage();
      at = skipWs(text, at + 1);
      nest[depth - 1] = 5;
      continue;
    }
    const char = text[at];
    if (char === "{" || char === "[") {
      if (depth === nest.length) growNest();
      nest[depth++] = char === "[" ? 1 : 3;
      at = skipWs(text, at + 1);
      continue;
    }
    if (char === '"') at = skipString(text, at);
    else if (char === "t") at = skipWord(text, at, "true");
    else if (char === "f") at = skipWord(text, at, "false");
    else if (char === "n") at = skipWord(text, at, "null");
    else if (char === "-" || (char >= "0" && char <= "9")) at = skipNumber(text, at);
    else invalidPackage();
    at = skipWs(text, at);
    if (depth === 0) return at;
    const parent = nest[depth - 1];
    if (parent !== 1 && parent !== 8 && parent !== 5) invalidPackage();
    nest[depth - 1] = parent === 5 ? 6 : 2;
  }
}

function rawKeyEquals(text, open, close, name) {
  if (close - open - 1 !== name.length) return false;
  for (let i = 0; i < name.length; i++) if (text[open + 1 + i] !== name[i]) return false;
  return true;
}

function classifyKey(text, open, close) {
  const raw = close - open - 1;
  if (raw > groupKeyLimit) return { group: "", version: false };
  let escaped = false;
  if (raw >= "version".length) {
    for (let i = open + 1; i < close; i++) if (text[i] === "\\") { escaped = true; break; }
  }
  if (escaped) {
    const key = JSON.parse(text.slice(open, close + 1));
    return { group: nodeGroups.includes(key) ? key : "", version: key === "version" };
  }
  let group = "";
  for (const name of nodeGroups) {
    if (raw === name.length && rawKeyEquals(text, open, close, name)) { group = name; break; }
  }
  return { group, version: !group && raw === "version".length && rawKeyEquals(text, open, close, "version") };
}

function pinsIn(slice) {
  const pins = Object.create(null);
  for (const [name, pin] of Object.entries(JSON.parse(slice) ?? {})) {
    if (name.startsWith("@modular-agent/")) pins[name] = pin;
  }
  return pins;
}

function nodeManifest(text) {
  let at = skipWs(text, 0);
  if (text[at] !== "{") {
    if (at >= text.length) invalidPackage();
    at = skipValue(text, at);
    if (skipWs(text, at) !== text.length) invalidPackage();
    return Object.create(null);
  }
  const spans = Object.create(null);
  let versionAt = -1;
  let versionEnd = -1;
  at = skipWs(text, at + 1);
  if (text[at] !== "}") {
    for (;;) {
      if (text[at] !== '"') invalidPackage();
      const open = at;
      at = skipString(text, at);
      const { group, version } = classifyKey(text, open, at - 1);
      at = skipWs(text, at);
      if (text[at] !== ":") invalidPackage();
      at = skipWs(text, at + 1);
      const start = at;
      at = skipValue(text, at);
      if (group) {
        const span = spans[group] ?? { start: 0, end: 0 };
        span.start = start;
        span.end = at;
        spans[group] = span;
      } else if (version) {
        versionAt = start;
        versionEnd = at;
      }
      at = skipWs(text, at);
      if (text[at] === "}") { at++; break; }
      if (text[at] !== ",") invalidPackage();
      at = skipWs(text, at + 1);
    }
  } else at++;
  if (skipWs(text, at) !== text.length) invalidPackage();
  const pkg = Object.create(null);
  if (versionAt >= 0) pkg.version = JSON.parse(text.slice(versionAt, versionEnd));
  for (const group of nodeGroups) {
    const span = spans[group];
    if (span) pkg[group] = pinsIn(text.slice(span.start, span.end));
  }
  return pkg;
}

function keyLines(text, paths) {
  const top = new Map();
  const pinsOf = new Map();
  let longest = 0;
  for (const name of nodeGroups) longest = Math.max(longest, name.length);
  for (const path of paths) {
    for (const name of path) longest = Math.max(longest, name.length);
    const id = JSON.stringify(path);
    if (path.length === 1) top.set(path[0], id);
    else {
      let pins = pinsOf.get(path[0]);
      if (!pins) pinsOf.set(path[0], pins = new Map());
      pins.set(path[1], id);
    }
  }
  const limit = 6 * longest + 2;
  const lines = new Map();
  const isObject = [false, false, false];
  let depth = 0;
  let pendingGroup = null;
  let group = null;
  let line = 1;
  let expectKey = false;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === "\n") line++;
    else if (char === "{" || char === "[") {
      depth++;
      if (depth <= 2) isObject[depth] = char === "{";
      if (depth === 2) group = pendingGroup;
      expectKey = depth <= 2 && char === "{";
    } else if (char === "}" || char === "]") {
      depth--;
      expectKey = false;
    } else if (char === ",") expectKey = depth <= 2 && isObject[depth];
    else if (char === '"') {
      let end = at + 1;
      let escaped = false;
      while (end < text.length && text[end] !== '"') {
        if (text[end] === "\\") { escaped = true; end += 2; }
        else end++;
      }
      if (expectKey && depth === 1) {
        pendingGroup = null;
        if (end < text.length && end + 1 - at <= limit) {
          if (!escaped) {
            for (const name of nodeGroups) if (rawKeyEquals(text, at, end, name)) { pendingGroup = name; break; }
            for (const [name, id] of top) if (rawKeyEquals(text, at, end, name)) lines.set(id, line);
          } else {
            const key = JSON.parse(text.slice(at, end + 1));
            if (nodeGroups.includes(key)) pendingGroup = key;
            const id = top.get(key);
            if (id) lines.set(id, line);
          }
        }
      } else if (expectKey && depth === 2 && group && end < text.length && end + 1 - at <= limit) {
        const wanted = pinsOf.get(group);
        if (wanted) {
          if (!escaped) {
            for (const [name, id] of wanted) if (rawKeyEquals(text, at, end, name)) lines.set(id, line);
          } else {
            const id = wanted.get(JSON.parse(text.slice(at, end + 1)));
            if (id) lines.set(id, line);
          }
        }
      }
      expectKey = false;
      if (end < text.length) at = end;
    }
  }
  return lines;
}

function checkNodePackage(file, text, version) {
  let pkg;
  try {
    pkg = nodeManifest(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
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
  for (const file of files) {
    if (file.endsWith("package.json")) checkNodePackage(file, read(file), version);
    else if (file.endsWith("Cargo.toml")) {
      const manifest = parseManifest(file);
      if (manifest) checkCargo(file, manifest, version);
    }
  }
}

try {
  const files = git("ls-files", "-z", "--", "*.md", "Cargo.toml", "*/Cargo.toml", ":(glob)typescript/packages/*/package.json")
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

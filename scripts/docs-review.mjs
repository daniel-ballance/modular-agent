#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

const { adrStatus, parseMarkdown, walk, withoutFrontMatter } = await import("./markdown.mjs").catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  console.error("scripts/docs-review.mjs: Missing parser dependencies. Run npm ci --prefix scripts.");
  process.exit(2);
});
const root = fileURLToPath(new URL("..", import.meta.url));
const usage = "Use node scripts/docs-review.mjs [--all | --base REF]";
const adrFile = /^docs\/adr\/(\d{4})-[^/]+\.md$/;
const historical = /^(?:docs\/(?:adr|research|pressure-test)\/)|\/docs\/clean-room\//;
// Words this specification also uses for behaviour (proposed input, a pending
// call, a model's draft, a missing field, unsupported versions, a follow-up to a
// child session) count only in the phrases that state a status. A normative
// line saying what happens when something is missing states a rule, not a gap.
const statusWords = /\b(?:proposed(?! input)|planned|not yet|will be|drafts?(?= \d)|(?<=\b(?:edition|version|revision) \d+(?:\.\d+)* )drafts?|(?<=\b(?:is|are|still|in) )drafts?|pending(?= (?:review|decision|implementation)\b))\b/gi;
const todo = /\bTODO\b|(?<=\b(?:[Ss]till|[Ll]eft|[Yy]et) )to do\b/g;
const openWords = /\b(?:(?:limits?|gaps?)(?: still)? remains?|gaps?|findings?|not implemented|follow-ups?(?= (?:issues?|work|changes?|fix|pull request|PR)\b)|(?<=\bas a )follow-up)\b/gi;
// Beside a named or linked ADR, these state the decision's status, in either direction.
const adrStatusWords = /\b(?:propos(?:es?|ing)|drafts?|(?<=\bstill )open|(?<=\b(?:is|are|was|were|been|now) )(?:accepted|done|complete(?:d)?|implemented|shipped))\b/gi;
const absentWords = /(?<=\b(?:is|are|still|remains?) )(?:missing|unsupported)\b/gi;
const normative = /\b(?:MUST|SHOULD|MAY)\b/;
const issueUrl = /https?:\/\/[^\s<>()[\]]+\/issues\/[1-9]\d*\b/;
const issueNumber = /(?:^|[\s(\[]|[\w.-]+\/[\w.-]+)#\d*[1-9]\d*\b/;
const link = /\[([^\]\n]+)\]\(<?([^\s)>]+)>?(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*\)/g;
const adrName = /\bADR[ -]?(\d{4})\b/g;
const git = (...args) => execFileSync("git", ["-c", "core.quotePath=false", ...args], { cwd: root, encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] });
const gitBytes = (...args) => execFileSync("git", args, { cwd: root, maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] });
// ignoreBOM keeps a leading U+FEFF, which is part of a valid name.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
// Split -z output into raw names. A name is decoded only when the review reads it, so a name
// that is not UTF-8 stops the review only if it is a Markdown file the review must read.
function fields(output) {
  const parts = [];
  for (let at = 0; at < output.length;) {
    const end = output.indexOf(0, at);
    const bytes = output.subarray(at, end === -1 ? output.length : end);
    if (bytes.length) parts.push(bytes);
    at = end === -1 ? output.length : end + 1;
  }
  return parts;
}
const isMarkdown = (bytes) => bytes.subarray(-3).toString("latin1") === ".md";
function name(bytes) {
  try {
    return utf8.decode(bytes);
  } catch {
    const shown = [...bytes].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, "0")}`)).join("");
    throw new Error(`Cannot read the file name "${shown}" as UTF-8. Rename it to review it`);
  }
}
const key = (bytes) => bytes.toString("latin1");
// Markdown files committed at HEAD as blobs, keyed by raw path bytes; a gitlink (submodule)
// named *.md has no text to read.
function committedMarkdown() {
  const blobs = new Map();
  for (const entry of fields(gitBytes("ls-tree", "-r", "-z", "HEAD"))) {
    const tab = entry.indexOf(9);
    const path = entry.subarray(tab + 1);
    if (isMarkdown(path) && entry.subarray(0, tab).toString("latin1").split(" ")[1] === "blob") blobs.set(key(path), path);
  }
  return blobs;
}
function decodable(bytes) {
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
}
const linesOf = (text) => text.split(/\r?\n/);
// The review reads the committed head, the same snapshot the diff compares, not the working tree.
// Every file read is in HEAD, so a failed read is an error, never an empty file.
const read = (file) => git("show", `HEAD:${file}`);

const unread = ["code", "inlineCode", "html"];
const blocks = ["heading", "paragraph", "tableRow"];

// Code, inline code, HTML and front matter are blanked in place, not removed, so each line keeps its number.
function markdown(source) {
  const text = withoutFrontMatter(source);
  let shown = "";
  let at = 0;
  const headings = [];
  const blockOf = new Map();
  for (const node of walk(parseMarkdown(text))) {
    const { start, end } = node.position;
    if (unread.includes(node.type)) {
      shown += text.slice(at, start.offset) + text.slice(start.offset, end.offset).replace(/[^\r\n]/g, " ");
      at = end.offset;
    }
    if (node.type === "heading") headings.push(start.line - 1);
    if (blocks.includes(node.type)) for (let i = start.line - 1; i < end.line; i++) blockOf.set(i, [start.line - 1, end.line]);
  }
  const lines = linesOf(shown + text.slice(at));
  return {
    lines,
    paragraph: (i) => lines.slice(...(blockOf.get(i) ?? [i, i + 1])).join("\n"),
    section: (i) => lines.slice(headings.findLast((line) => line <= i) ?? 0, headings.find((line) => line > i)).join("\n"),
  };
}

function adrsIn(file, text, adrs) {
  const found = new Set();
  for (const [, , target] of text.matchAll(link)) {
    const path = posix.normalize(posix.join(posix.dirname(file), target.split("#")[0]));
    const number = path.match(adrFile)?.[1];
    if (number && adrs.has(number)) found.add(number);
  }
  for (const [, number] of text.matchAll(adrName)) if (adrs.has(number)) found.add(number);
  return found;
}

function words(text, pattern) {
  return [...new Set([...text.matchAll(pattern)].map((match) => match[0].toLowerCase()))];
}

const prose = (text) => text.replace(/(`+).*?\1|<[^>\n]*>/g, (span) => " ".repeat(span.length));
const tracked = (text) => issueUrl.test(prose(text)) || issueNumber.test(prose(text).replace(link, "$1"));

function candidates(file, wanted, adrs) {
  const source = read(file);
  const raw = linesOf(source);
  const { lines, paragraph, section } = markdown(source);
  const found = [];
  for (const [i, line] of lines.entries()) {
    if (wanted && !wanted.has(i + 1)) continue;
    const text = prose(line).replace(link, "$1");
    const reasons = [];
    const named = adrsIn(file, prose(line), adrs).size > 0;
    const status = [...new Set([...words(text, statusWords), ...words(text, todo), ...(named ? words(text, adrStatusWords) : [])])];
    if (status.length) reasons.push(`status ${status.map((word) => `"${word}"`).join(", ")}`);
    const open = [...words(text, openWords), ...(normative.test(text) ? [] : words(text, absentWords))];
    if (open.length && !tracked(section(i))) {
      reasons.push(`open work ${open.map((word) => `"${word}"`).join(", ")} with no issue in its section`);
    }
    if (!reasons.length) continue;
    const linked = [...adrsIn(file, paragraph(i), adrs)].sort().map((number) => `ADR ${number} ${adrs.get(number) ?? "has no status"}`);
    found.push(`${file}:${i + 1}: ${reasons.join("; ")}${linked.length ? `. Links ${linked.join(", ")}` : ""}.\n    ${raw[i].trim()}`);
  }
  return found;
}

function changedLines(base, committed) {
  let merge;
  try {
    merge = git("merge-base", base, "HEAD").trim();
  } catch {
    throw new Error(`Cannot find a merge base with ${base}. Fetch it, or pass --base REF`);
  }
  const changed = new Map();
  // -z names each file exactly; patch headers quote or pad some paths, such as one with a space.
  // A file at least 90% like a deleted one is a rename, diffed against its old path so only its
  // edited lines count. Below that every line counts: a loose pairing could hide new lines.
  const status = fields(gitBytes("diff", "--name-status", "-z", "-M90%", "--diff-filter=d", merge, "HEAD", "--", "*.md"));
  for (let i = 0; i < status.length;) {
    const kind = status[i++].toString("latin1");
    const source = kind.startsWith("R") || kind.startsWith("C") ? status[i++] : undefined;
    const target = status[i++];
    if (!isMarkdown(target) || !committed.has(key(target)) || historical.test(key(target))) continue;
    const file = name(target);
    // Only an edited rename (R090 to R099) of a file the review reads keeps its unedited lines out.
    // An exact pair (R100) shows no edit, and Git pairs any identical add and delete; a file moved
    // out of a historical folder was never reviewed; a source that is not UTF-8 cannot be named to
    // Git. Each counts every line: more candidates, never a hidden one.
    const moved = source && kind.startsWith("R") && kind !== "R100" && !historical.test(key(source));
    const from = moved ? decodable(source) : undefined;
    const lines = new Set();
    // Literal pathspecs: a file name such as ":(glob)x.md" is a name, not pathspec magic.
    const paths = from ? [from, file] : [file];
    for (const line of git("--literal-pathspecs", "diff", "--unified=0", "--no-color", "--no-ext-diff", "--text", "--no-textconv", "-M90%", merge, "HEAD", "--", ...paths).split("\n")) {
      const hunk = line.match(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/);
      if (!hunk) continue;
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let n = Number(hunk[1]); n < Number(hunk[1]) + count; n++) lines.add(n);
    }
    changed.set(file, lines);
  }
  return changed;
}

function defaultBase() {
  const refs = git("for-each-ref", "--format=%(refname)", "refs/heads/main", "refs/remotes/origin/main").split("\n");
  const ref = ["refs/remotes/origin/main", "refs/heads/main"].find((name) => refs.includes(name));
  if (!ref) throw new Error("Cannot find origin/main or main. Fetch it, or pass --base REF");
  return ref.replace(/^refs\/(?:heads|remotes)\//, "");
}

function parse(args) {
  if (args.length === 0) return {};
  if (args.length === 1 && args[0] === "--all") return { all: true };
  if (args.length === 2 && args[0] === "--base" && args[1] && !args[1].startsWith("-")) return { base: args[1] };
  throw new Error(usage);
}

try {
  const options = parse(process.argv.slice(2));
  const committed = committedMarkdown();
  const adrs = new Map([...committed.values()].map(decodable).filter((path) => path && adrFile.test(path)).map((path) => [path.match(adrFile)[1], adrStatus(read(path))]));
  const base = options.all ? undefined : options.base ?? defaultBase();
  const scope = options.all
    ? new Map([...committed].filter(([path]) => !historical.test(path)).map(([, bytes]) => [name(bytes), undefined]))
    : changedLines(base, committed);
  const files = [...scope.keys()].sort();
  const found = files.flatMap((file) => candidates(file, scope.get(file), adrs));
  if (found.length) console.log(found.join("\n"));
  const where = options.all ? "tracked Markdown" : `Markdown changed since the merge base with ${base}`;
  console.log(`${found.length} candidates in ${files.length} files of ${where}. Judge each one as CONTRIBUTING.md "How work is tracked" says.`);
} catch (error) {
  console.error(`scripts/docs-review.mjs: ${error.message.split("\n")[0]}.`);
  process.exitCode = 2;
}

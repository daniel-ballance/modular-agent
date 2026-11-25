#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const usage = "Use node scripts/docs-review.mjs [--all | --base REF]";
const adrFile = /^docs\/adr\/(\d{4})-[^/]+\.md$/;
const historical = /^(?:docs\/(?:adr|research|pressure-test)\/)|\/docs\/clean-room\//;
// Words this specification also uses for behaviour (proposed input, a pending
// call, a model's draft, a missing field, unsupported versions, a follow-up to a
// child session) count only in the phrases that state a status. A normative
// line saying what happens when something is missing states a rule, not a gap.
const statusWords = /\b(?:proposed(?! input)|planned|not yet|will be|drafts?(?= \d)|(?<=\b(?:is|are|still|in) )drafts?|pending(?= (?:review|decision|implementation)\b))\b/gi;
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
const heading = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const blockStart = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|\||[-*+]\s|\d+[.)]\s|>)/;
const git = (...args) => execFileSync("git", ["-c", "core.quotePath=false", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const linesOf = (text) => text.split(/\r?\n/);
// The review reads the committed head, the same snapshot the diff compares, not the working tree.
const read = (file) => {
  try {
    return git("show", `HEAD:${file}`);
  } catch {
    return "";
  }
};

// Copied from check-docs-state.mjs rather than shared: the two scripts stay
// standalone files that their tests copy into a scratch repository.
function markdownLines(text) {
  let fence;
  let comment = false;
  return linesOf(text).map((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker?.[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return "";
    }
    if (marker && !comment) {
      fence = marker[1];
      return "";
    }
    const code = line.replace(/(`+)[^`]*?\1/g, (span) => " ".repeat(span.length));
    let out = "";
    let at = 0;
    while (at < line.length) {
      const next = comment ? line.indexOf("-->", at) : code.indexOf("<!--", at);
      if (next === -1) {
        out += comment ? " ".repeat(line.length - at) : line.slice(at);
        break;
      }
      const end = comment ? next + 3 : next + 4;
      out += comment ? " ".repeat(end - at) : line.slice(at, next) + "    ";
      at = end;
      comment = !comment;
    }
    return out;
  });
}

function adrStatus(text) {
  return text.match(/^---\r?\n(.*?)\r?\n---(?:\r?\n|$)/s)?.[1].match(/^status:[ \t]*([^\r\n]+)/m)?.[1].trim().toLowerCase();
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

// A paragraph is the run of lines around a line up to a blank line. A heading,
// table row, list item or quote starts a new one, so one table or list does not
// lend every row's links to every other row.
function paragraph(lines, i) {
  let start = i;
  while (start > 0 && lines[start - 1].trim() && !blockStart.test(lines[start])) start--;
  let end = i + 1;
  while (end < lines.length && lines[end].trim() && !blockStart.test(lines[end])) end++;
  return lines.slice(start, end).join("\n");
}

function section(lines, i) {
  let start = i;
  while (start > 0 && !heading.test(lines[start])) start--;
  let end = i + 1;
  while (end < lines.length && !heading.test(lines[end])) end++;
  return lines.slice(start, end).join("\n");
}

function words(text, pattern) {
  return [...new Set([...text.matchAll(pattern)].map((match) => match[0].toLowerCase()))];
}

const prose = (text) => text.replace(/(`+).*?\1|<[^>\n]*>/g, (span) => " ".repeat(span.length));
const tracked = (text) => issueUrl.test(prose(text)) || issueNumber.test(prose(text).replace(link, "$1"));

function candidates(file, wanted, adrs) {
  const source = read(file);
  const raw = linesOf(source);
  const lines = markdownLines(source);
  const found = [];
  for (const [i, line] of lines.entries()) {
    if (wanted && !wanted.has(i + 1)) continue;
    const text = prose(line).replace(link, "$1");
    const block = paragraph(lines, i);
    const reasons = [];
    const named = adrsIn(file, prose(line), adrs).size > 0;
    const status = [...new Set([...words(text, statusWords), ...words(text, todo), ...(named ? words(text, adrStatusWords) : [])])];
    if (status.length) reasons.push(`status ${status.map((word) => `"${word}"`).join(", ")}`);
    const open = [...words(text, openWords), ...(normative.test(text) ? [] : words(text, absentWords))];
    if (open.length && !tracked(section(lines, i))) {
      reasons.push(`open work ${open.map((word) => `"${word}"`).join(", ")} with no issue in its section`);
    }
    if (!reasons.length) continue;
    const linked = [...adrsIn(file, block, adrs)].sort().map((number) => `ADR ${number} ${adrs.get(number) ?? "has no status"}`);
    found.push(`${file}:${i + 1}: ${reasons.join("; ")}${linked.length ? `. Links ${linked.join(", ")}` : ""}.\n    ${raw[i].trim()}`);
  }
  return found;
}

function changedLines(base) {
  let merge;
  try {
    merge = git("merge-base", base, "HEAD").trim();
  } catch {
    throw new Error(`Cannot find a merge base with ${base}. Fetch it, or pass --base REF`);
  }
  const changed = new Map();
  // -z names each file exactly; patch headers quote or pad some paths, such as one with a space.
  const files = git("diff", "--name-only", "-z", "--diff-filter=d", merge, "HEAD", "--", "*.md").split("\0").filter(Boolean);
  for (const file of files) {
    const lines = new Set();
    for (const line of git("diff", "--unified=0", "--no-color", "--no-ext-diff", merge, "HEAD", "--", file).split("\n")) {
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
  const markdown = git("ls-tree", "-r", "-z", "--name-only", "HEAD").split("\0").filter((file) => file.endsWith(".md"));
  const adrs = new Map(markdown.filter((file) => adrFile.test(file)).map((file) => [file.match(adrFile)[1], adrStatus(read(file))]));
  const base = options.all ? undefined : options.base ?? defaultBase();
  const scope = options.all ? new Map(markdown.map((file) => [file, undefined])) : changedLines(base);
  const files = [...scope.keys()].filter((file) => !historical.test(file)).sort();
  const found = files.flatMap((file) => candidates(file, scope.get(file), adrs));
  if (found.length) console.log(found.join("\n"));
  const where = options.all ? "tracked Markdown" : `Markdown changed since the merge base with ${base}`;
  console.log(`${found.length} candidates in ${files.length} files of ${where}. Judge each one as CONTRIBUTING.md "How work is tracked" says.`);
} catch (error) {
  console.error(`scripts/docs-review.mjs: ${error.message.split("\n")[0]}.`);
  process.exitCode = 2;
}

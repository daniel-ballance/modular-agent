#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const limit = 1000;
const baselineFile = "scripts/maintainability-baseline.json";
const sources = ["*.rs", "*.ts", "*.tsx", "*.go", "*.py", "*.mjs", "*.js"];
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function sourceSizes() {
  const files = git("ls-files", "-z", "--", ...sources).split("\0").filter(Boolean);
  const sizes = new Map();
  for (const file of files) {
    if (file.startsWith("typescript/packages/ma/vendor/") || file.split("/").includes("node_modules")) continue;
    if (file.endsWith(".pb.go") || file.endsWith(".d.ts")) continue;
    try {
      const text = readFileSync(join(root, file), "utf8");
      const lines = (text.match(/\n/g)?.length ?? 0) + Number(text.length > 0 && !text.endsWith("\n"));
      sizes.set(file, lines);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return sizes;
}

function readBaseline() {
  try {
    const baseline = JSON.parse(readFileSync(join(root, baselineFile), "utf8"));
    if (baseline && typeof baseline === "object" && !Array.isArray(baseline)) {
      return new Map(Object.entries(baseline));
    }
  } catch (error) {
    if (!(error instanceof SyntaxError) && error.code !== "ENOENT") throw error;
  }
  throw new Error(`Restore ${baselineFile} as a JSON object mapping paths to line counts.`);
}

function checkSizes(sizes, baseline) {
  let bad = 0;
  for (const [file, lines] of sizes) {
    if (lines <= limit) continue;
    const path = JSON.stringify(file);
    const allowed = baseline.get(file);
    if (!baseline.has(file)) {
      console.error(`${path}: ${lines} lines. Split the file by concern to meet the ${limit}-line limit.`);
      bad++;
    } else if (!Number.isSafeInteger(allowed) || allowed <= limit) {
      console.error(`${path}: invalid allowance. Use an integer above ${limit} in ${baselineFile}.`);
      bad++;
    } else if (lines > allowed) {
      console.error(`${path}: ${lines} lines. Split the file by concern to meet its ${allowed}-line baseline.`);
      bad++;
    } else if (lines < allowed) {
      console.log(`${path}: ${lines} lines, down from ${allowed}. Lower its entry in ${baselineFile} to ${lines}.`);
    }
  }
  for (const file of baseline.keys()) {
    if ((sizes.get(file) ?? 0) > limit) continue;
    const reason = sizes.has(file) ? `at or below ${limit} lines` : "not a tracked source file on disk";
    console.error(`${JSON.stringify(file)}: ${reason}. Remove its entry from ${baselineFile}.`);
    bad++;
  }
  return bad;
}

// GitHub's closing keywords, which also act in a squash merge's commit message.
const closingKeyword = new RegExp(
  String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?[ \t]+` +
    String.raw`(?:(?:[\w.-]+/[\w.-]+)?#\d+|https?://github\.com/[\w.-]+/[\w.-]+/issues/\d+)\b`,
  "i",
);

function checkCommits() {
  const refs = git("for-each-ref", "--format=%(refname)", "refs/heads/main", "refs/remotes/origin/main").split("\n");
  const main = ["refs/remotes/origin/main", "refs/heads/main"].find((ref) => refs.includes(ref));
  if (!main) return 0;

  try {
    git("merge-base", main, "HEAD");
  } catch {
    throw new Error(`Cannot find a merge base with ${main}. Fetch the shared history and retry.`);
  }
  let bad = 0;
  // A commit message cannot hold a NUL byte, so -z separates the records exactly.
  for (const record of git("log", "-z", "--format=%h%n%B", `${main}..HEAD`).split("\0")) {
    if (!record) continue;
    const [hash, ...lines] = record.split("\n");
    const commit = `${hash} ${lines[0]}`;
    if (/^WIP\b/i.test(lines[0])) {
      console.error(`${commit}: Rewrite the commit subject before merging into main.`);
      bad++;
    }
    const keyword = lines.join("\n").match(closingKeyword);
    if (keyword) {
      console.error(`${commit}: "${keyword[0]}". Put Closes #N in the pull request body, not the commit message.`);
      bad++;
    }
  }
  return bad;
}

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--write-baseline") {
    const entries = [...sourceSizes()].filter(([, lines]) => lines > limit);
    writeFileSync(join(root, baselineFile), `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`);
    console.log(`Wrote ${entries.length} entries to ${baselineFile}`);
  } else if (args.length === 0) {
    const sizes = sourceSizes();
    const bad = checkSizes(sizes, readBaseline()) + checkCommits();
    console.log(`${sizes.size} tracked source files checked. Failures: ${bad}.`);
    process.exitCode = bad ? 1 : 0;
  } else {
    throw new Error("Use node scripts/check-maintainability.mjs [--write-baseline].");
  }
} catch (error) {
  console.error(`maintainability: ${error.message.split("\n")[0]}`);
  process.exitCode = 1;
}

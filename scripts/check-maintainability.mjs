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

function checkSubjects() {
  const refs = git("for-each-ref", "--format=%(refname)", "refs/heads/main", "refs/remotes/origin/main").split("\n");
  const main = ["refs/remotes/origin/main", "refs/heads/main"].find((ref) => refs.includes(ref));
  if (!main) return 0;

  let base;
  try {
    base = git("merge-base", main, "HEAD").trim();
  } catch {
    throw new Error(`Cannot find a merge base with ${main}. Fetch the shared history and retry.`);
  }
  let bad = 0;
  for (const commit of git("log", "--format=%h %s", `${base}..HEAD`).split("\n")) {
    if (!/^\S+ WIP\b/i.test(commit)) continue;
    console.error(`${commit}: Rewrite the commit subject before merging into main.`);
    bad++;
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
    const bad = checkSizes(sizes, readBaseline()) + checkSubjects();
    console.log(`${sizes.size} tracked source files checked. Failures: ${bad}.`);
    process.exitCode = bad ? 1 : 0;
  } else {
    throw new Error("Use node scripts/check-maintainability.mjs [--write-baseline].");
  }
} catch (error) {
  console.error(`maintainability: ${error.message.split("\n")[0]}`);
  process.exitCode = 1;
}

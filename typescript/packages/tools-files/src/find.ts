import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { posix } from "node:path";
import { promisify } from "node:util";
import type { ToolEnvironment } from "@modular-agent/core";
import { Minimatch } from "minimatch";

type Matcher = (path: string) => boolean;
type Rule = { matches: Matcher; directoryOnly: boolean; exclude: boolean };
type Source = { base: string; rules: Rule[]; global?: true };
const git = promisify(execFile);
const opts = { dot: true, nocomment: true, nonegate: true, noext: true, optimizationLevel: 0, preserveMultipleSlashes: true } as const;

function glob(pattern: string, byPath: boolean): Matcher {
  const matcher = new Minimatch(pattern, opts);
  return path => matcher.match(byPath ? path : posix.basename(path));
}

function parseRules(contents: string): Rule[] {
  const rules: Rule[] = [];
  for (let line of contents.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line.endsWith("\\ ")) line = line.trimEnd();
    if (!line || line.startsWith("#")) continue;
    const exclude = !line.startsWith("!");
    if (!exclude) line = line.slice(1);
    const anchored = line.startsWith("/"), directoryOnly = line.endsWith("/");
    if (anchored) line = line.slice(1);
    if (directoryOnly) line = line.replace(/\\?\/$/, "");
    if (!line) continue;
    try { rules.push({ matches: glob(line, anchored || line.includes("/")), directoryOnly, exclude }); }
    catch { /* An invalid rule doesn't disable the rest of the file. */ }
  }
  return rules;
}

// Match each entry itself. The walk prunes ignored directories; matching the
// entry's ancestors again would wrongly apply rules to an explicit search root.
function decision({ base, rules, global }: Source, path: string, isDir: boolean) {
  let name = posix.relative(base, path);
  if (outside(name)) {
    if (!global) return undefined;
    name = path; // Outside the base, a global basename rule still applies.
  }
  return rules.findLast(r => (!r.directoryOnly || isDir) && r.matches(name))?.exclude;
}

const outside = (path: string) => path === ".." || path.startsWith("../");

function ignored(sources: Source[], path: string, isDir: boolean) {
  for (const source of sources) {
    const result = decision(source, path, isDir);
    if (result !== undefined) return result;
  }
  return false;
}

async function readOptional(env: ToolEnvironment, path: string) {
  try { return (await env.read(path)).toString(); }
  catch { return ""; } // Ignore files can be absent or unreadable without stopping the walk.
}

async function globalExcludes(signal: AbortSignal) {
  // Read only the user's Git configuration, never a checkout's local config.
  // Let Git expand configured paths, including ~, and respect isolated homes.
  for (const scope of ["--global", "--system"]) {
    if (scope === "--system" && process.env.GIT_CONFIG_NOSYSTEM === "1") continue;
    try {
      const { stdout } = await git("git", ["config", scope, "--includes", "--null", "--path", "--get", "core.excludesFile"], { signal });
      if (stdout.length > 1) return stdout.slice(0, -1);
    } catch { signal.throwIfAborted(); }
  }
  return posix.join(process.env.XDG_CONFIG_HOME || posix.join(homedir(), ".config"), "git/ignore");
}

async function excludeFile(env: ToolEnvironment, base: string, gitKind: string | undefined) {
  if (gitKind === undefined) return "";
  const marker = posix.join(base, ".git");
  if (gitKind !== "file") return readOptional(env, posix.join(marker, "info/exclude"));
  // A linked worktree keeps info/exclude in the common Git directory.
  const pointer = /^gitdir: ([^\r\n]+)/.exec(await readOptional(env, marker))?.[1];
  if (!pointer) return "";
  const gitdir = posix.resolve(base, pointer);
  const common = (await readOptional(env, posix.join(gitdir, "commondir"))).split(/\r?\n/, 1)[0];
  return common ? readOptional(env, posix.resolve(gitdir, common, "info/exclude")) : "";
}

type Entries = Awaited<ReturnType<ToolEnvironment["list"]>>;
type Rules = { ignore: Source[]; gitignore: Source[]; exclude: Source[] };

export async function findFiles(
  env: ToolEnvironment, signal: AbortSignal, path: string, pattern: string, project?: string,
) {
  signal.throwIfAborted();
  const root = project ? posix.resolve(project, path) : posix.normalize(path);
  const files: string[] = [];
  const matches = glob(pattern.replace(/^\.\//, ""), pattern.includes("/"));
  // Like Rust's WalkBuilder, anchor global patterns and relative config paths
  // to the agent's working directory, not the selected project's directory.
  let global: Source | undefined;
  if (project) {
    const file = posix.resolve(await globalExcludes(signal));
    global = { base: process.cwd(), rules: parseRules(await readOptional(env, file)), global: true };
  }

  async function extend(base: string, entries: Entries, parent: Rules): Promise<Rules> {
    signal.throwIfAborted();
    const [ignore, gitignore, exclude] = await Promise.all([
      entries.some(e => e.name === ".ignore") ? readOptional(env, posix.join(base, ".ignore")) : "",
      entries.some(e => e.name === ".gitignore") ? readOptional(env, posix.join(base, ".gitignore")) : "",
      excludeFile(env, base, entries.find(e => e.name === ".git")?.kind),
    ]);
    const push = (sources: Source[], contents: string) => contents ? [{ base, rules: parseRules(contents) }, ...sources] : sources;
    return { ignore: push(parent.ignore, ignore), gitignore: push(parent.gitignore, gitignore), exclude: push(parent.exclude, exclude) };
  }

  const rootEntries = await env.list(root);
  let parents: Rules = { ignore: [], gitignore: [], exclude: [] };
  const ancestors = [];
  for (let dir = root; ; ) {
    const parent = posix.dirname(dir);
    if (parent === dir || outside(posix.relative(parent, dir))) break;
    ancestors.push(parent);
    dir = parent;
  }
  for (const parent of ancestors.reverse()) {
    // A scoped/custom environment may not allow access above its project.
    const entries = await env.list(parent).catch(() => []);
    parents = await extend(parent, entries, parents);
  }

  async function visit(relative: string, dir: string, entries: Entries, parents: Rules) {
    const rules = await extend(dir, entries, parents);
    // Rust's ignore walker orders by source kind first, then nearest directory.
    const sources = [...rules.ignore, ...rules.gitignore, ...rules.exclude, ...(global ? [global] : [])];
    for (const item of entries) {
      signal.throwIfAborted();
      if (item.name === ".git") continue;
      const name = posix.join(relative, item.name), full = posix.join(dir, item.name);
      const isDir = item.kind === "directory";
      if (ignored(sources, full, isDir)) continue;
      if (isDir) await visit(name, full, await env.list(full), rules);
      else if (matches(name)) files.push(name);
    }
  }
  await visit("", root, rootEntries, parents);
  return files.sort();
}

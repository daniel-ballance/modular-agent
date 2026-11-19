import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import ignore from "ignore";
import { minimatch } from "minimatch";
import { definePlugin, tool, type ToolContext, type ToolOutput, type TextPart } from "@modular-agent/core";
import { definitions } from "./standard-definitions.js";
import { applyEdits, cut, formatSize, listing, MAX_BYTES, readWindow } from "./standard-text.js";

const text = (text: string): TextPart => ({ type: "text", text });
const clean = (path: string) => path.replace(/^@/, "").replace(/^~(?=\/|$)/, homedir());
const number = (name: string, n?: number) => {
  if (n !== undefined && (!Number.isFinite(n) || n < 0)) throw new Error(`${name} must be a number, zero or more`);
  return n;
};
const limitOf = (n: number | undefined, fallback: number) => Math.max(1, Math.trunc(number("limit", n) ?? fallback));
const missing = (error: unknown) => (error as { code?: string; cause?: { code?: string } }).code === "ENOENT" ||
  (error as { cause?: { code?: string } }).cause?.code === "ENOENT";
function imageMime(b: Buffer) {
  if (b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "image/png";
  if (b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (b.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  if (b.length > 26 && b.toString("ascii", 0, 2) === "BM") return "image/bmp";
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
}

async function walk(ctx: ToolContext, root: string, pattern: string) {
  const files: string[] = [];
  type Rules = { prefix: string; filter: ReturnType<typeof ignore> };
  async function visit(rel: string, parents: Rules[]) {
    ctx.cancelled.throwIfAborted();
    const dir = posix.join(root, rel), rules = [...parents];
    const file = posix.join(dir, ".gitignore");
    if (await ctx.environment.exists(file)) rules.push({ prefix: rel ? rel + "/" : "", filter: ignore().add((await ctx.environment.read(file)).toString()) });
    for (const item of await ctx.environment.list(dir)) {
      if (item.name === ".git") continue;
      const name = posix.join(rel, item.name);
      const test = name + (item.kind === "directory" ? "/" : "");
      let ignored = false;
      for (const { prefix, filter } of rules) {
        const result = filter.test(test.slice(prefix.length));
        if (result.ignored || result.unignored) ignored = result.ignored;
      }
      if (ignored) continue;
      if (item.kind === "directory") await visit(name, rules);
      if (item.kind === "file" && minimatch(pattern.includes("/") ? name : item.name, pattern.replace(/^\.\//, ""), { nocomment: true, nonegate: true, noext: true, dot: true })) files.push(name);
    }
  }
  await visit("", []);
  return files.sort();
}

export function standardFileTools({ spill }: { spill: string }) {
  const make = <const N extends keyof typeof definitions>(name: N,
    run: (input: { path?: string; limit?: number } & Record<string, unknown>, ctx: ToolContext) => Promise<string | ToolOutput>) => {
    const { description, input, readOnly } = definitions[name];
    return tool({ name, description, input, readOnly, destructive: !readOnly, openWorld: name === "exec", safeToRepeat: readOnly, parallel: readOnly,
      async run(raw, ctx) {
        const args = raw as Parameters<typeof run>[0];
        try { return await run(args, ctx); }
        catch (error) {
          const note = missing(error) ? `File not found: ${args.path ?? "."}` : error instanceof Error ? error.message : String(error);
          return { status: "failed", content: [text(note)] };
        }
      } });
  };
  return definePlugin({ name: "tools.files.standard", tools: [
    make("read", async ({ path, offset, limit }, ctx) => {
      const file = clean(path!);
      const begin = number("offset", offset as number | undefined), count = number("limit", limit);
      const bytes = await ctx.environment.read(file), mimeType = imageMime(bytes);
      if (!mimeType) return readWindow(bytes.toString(), file, begin === undefined ? begin : Math.trunc(begin), count === undefined ? count : Math.trunc(count));
      const max = 4_718_592;
      if (bytes.length > max) return `Read image file [${mimeType}], ${formatSize(bytes.length)}. It is over the ${formatSize(max)} limit for images, so it was not attached.`;
      return { content: [text(`Read image file [${mimeType}]`), { type: "image", mimeType, data: bytes.toString("base64") }] };
    }),
    make("exec", async ({ command, timeout }, ctx) => {
      const seconds = number("timeout", timeout as number | undefined), started = performance.now();
      const result = await ctx.environment.exec(command as string, { timeout: seconds ? seconds * 1000 : undefined });
      const { content: output, truncated, byBytes, total, kept } = cut(result.output, true);
      const value = { output, truncated, exit_code: result.exitCode, wall_time_seconds: Math.round(performance.now() - started) / 1000,
        ...(result.timedOut ? { timed_out: true } : {}) } as Record<string, unknown>;
      let note = output;
      if (truncated) {
        note += `\n\n[Showing lines ${total - kept + 1}-${total} of ${total}${byBytes ? ` (${formatSize(MAX_BYTES)} limit)` : ""}`;
        const file = join(spill, `exec-${randomUUID()}.log`);
        try { await mkdir(spill, { recursive: true, mode: 0o700 }); await writeFile(file, result.output, { mode: 0o600 }); value.full_output_path = file; note += `. Full output: ${file}`; }
        catch { /* The cut result is still useful if the spill could not be saved. */ }
        note += "]";
      }
      note ||= "(no output)";
      if (result.timedOut) note += `\n\nCommand timed out after ${seconds} seconds`;
      else if (result.exitCode !== 0) note += result.exitCode === null ? "\n\nCommand was ended by a signal" : `\n\nCommand exited with code ${result.exitCode}`;
      return { status: result.exitCode === 0 && !result.timedOut ? "completed" : "failed", content: [text(note)], value };
    }),
    make("edit", async ({ path, edits }, ctx) => {
      const file = clean(path!), bytes = await ctx.environment.read(file);
      let original: string;
      try { original = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new Error(`${file} is not UTF-8 text`); }
      const replacements = edits as Parameters<typeof applyEdits>[1];
      await ctx.environment.write(file, applyEdits(original, replacements, file));
      return `Successfully replaced ${replacements.length} block(s) in ${file}.`;
    }),
    make("write", async ({ path, content }, ctx) => {
      const file = clean(path!);
      await ctx.environment.write(file, content as string);
      return `Successfully wrote ${Buffer.byteLength(content as string)} bytes to ${file}`;
    }),
    make("find", async ({ path = ".", pattern, limit }, ctx) => {
      const max = limitOf(limit, 1000), files = await walk(ctx, clean(path), pattern as string);
      return files.length ? listing(files, max, "results") : "No files found matching pattern";
    }),
    make("list", async ({ path = ".", limit }, ctx) => {
      const max = limitOf(limit, 500), entries = await ctx.environment.list(clean(path));
      const names = entries.map(e => e.name + (e.kind === "directory" ? "/" : "")).sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0);
      return names.length ? listing(names, max, "entries") : "(empty directory)";
    }),
  ] });
}

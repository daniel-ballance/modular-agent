#!/usr/bin/env node
// Check that relative links and their anchors resolve in the repository's Markdown.
// The clean-room builds' own notes are skipped: their links are relative to the
// repositories they were written in.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const files = execFileSync("git", ["ls-files", "*.md"], { cwd: root, encoding: "utf8" })
  .split("\n").filter(Boolean).filter((f) => !f.includes("/docs/clean-room/"));
const slug = (h) => h.trim().toLowerCase().replace(/[`*_]/g, "").replace(/[^\p{L}\p{N} -]/gu, "").replace(/ /g, "-");
const anchors = new Map();
const anchorsOf = (file) => {
  if (!anchors.has(file)) {
    const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
    anchors.set(file, new Set([...[...text.matchAll(/^#+ (.*)$/gm)].map((m) => slug(m[1])), ...[...text.matchAll(/<a (?:id|name)="([^"]+)"/g)].map((m) => m[1])]));
  }
  return anchors.get(file);
};
let bad = 0;
for (const file of files) {
  const path = resolve(root, file);
  const text = readFileSync(path, "utf8").replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const link = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(link)) continue;
    const [target, anchor] = link.split("#");
    const full = target ? resolve(dirname(path), decodeURIComponent(target)) : path;
    if (!existsSync(full)) { console.log(`missing: ${file} -> ${link}`); bad++; continue; }
    if (anchor && full.endsWith(".md") && statSync(full).isFile() && !anchorsOf(full).has(anchor)) {
      console.log(`anchor:  ${file} -> ${link}`); bad++;
    }
  }
}
console.log(bad ? `${bad} broken links in ${files.length} files` : `all links resolve in ${files.length} files`);
process.exit(bad ? 1 : 0);

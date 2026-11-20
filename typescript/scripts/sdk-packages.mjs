#!/usr/bin/env node
// Print the folders to `npm install` for one or more packages of this workspace,
// with every workspace package they depend on. The packages are not on npm, so an
// app installs them from a built checkout:
//
//   (cd typescript && npm ci && npm run build)
//   npm install $(node /path/to/typescript/scripts/sdk-packages.mjs core tools-files tools-mcp)
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packages = resolve(dirname(fileURLToPath(import.meta.url)), "../packages");
const byName = new Map();
for (const dir of readdirSync(packages)) {
  try { byName.set(JSON.parse(readFileSync(join(packages, dir, "package.json"), "utf8")).name, join(packages, dir)); } catch {}
}
const wanted = process.argv.slice(2);
if (!wanted.length) { console.error("usage: sdk-packages.mjs PACKAGE... (for example: core tools-files tools-mcp)"); process.exit(2); }
const found = new Set();
const visit = (name) => {
  const dir = byName.get(name);
  if (!dir || found.has(dir)) return;
  found.add(dir);
  for (const dep of Object.keys(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dependencies ?? {})) visit(dep);
};
for (const w of wanted) {
  const name = w.startsWith("@") ? w : `@modular-agent/${w}`;
  if (!byName.has(name)) { console.error(`no workspace package named ${name}`); process.exit(1); }
  visit(name);
}
console.log([...found].join(" "));

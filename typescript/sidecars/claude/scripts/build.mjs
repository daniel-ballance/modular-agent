import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("../../../", import.meta.url));
if (process.argv.includes("--install")) {
  const npm = process.env.npm_execpath;
  execFileSync(process.execPath, [npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd, stdio: "inherit" });
  execFileSync(process.execPath, [npm, "run", "build", "--workspace=@modular-agent/claude"], { cwd, stdio: "inherit" });
}
const dist = new URL("../dist/", import.meta.url);
mkdirSync(dist, { recursive: true });
writeFileSync(new URL("main.js", dist), '#!/usr/bin/env node\nimport "../../../packages/claude/dist/src/main.js";\n', { mode: 0o755 });

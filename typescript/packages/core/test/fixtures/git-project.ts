import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

export async function gitProject(t: TestContext): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "ma-test-project-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", project]);
  return project;
}

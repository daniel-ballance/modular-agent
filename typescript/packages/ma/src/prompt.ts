import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { definePlugin } from "@modular-agent/core";
import { catalog } from "./catalog.js";
import { skillsFor, type Paths } from "./configuration.js";
import { expandSkill, skillPrompt } from "./skills.js";
import { PREAMBLE, RULES } from "./prompt-text.js";

const localDate = (d: Date) => [d.getFullYear(), d.getMonth() + 1, d.getDate()].map(n => String(n).padStart(2, "0")).join("-");

export function standardPrompt(paths: Paths) {
  return definePlugin({ name: "system.prompt.standard", setup(r) {
    r.on("input", async ({ content }, ctx) => {
      const input = content.length === 1 && content[0].type === "text" ? content[0].text : undefined;
      if (typeof input !== "string" || !input.startsWith("/skill:")) return;
      const { skills } = await skillsFor(paths, ctx.session!().project);
      const expansion = await expandSkill(skills, input);
      if (expansion) return { change: [{ type: "text", text: expansion }] };
    }, "first", { inProcessOnly: true });
    r.command("skills", "List the skills found for this folder", async (_args, ctx) => {
      const { skills, problems } = await skillsFor(paths, ctx.session!().project);
      return [...skills.map(s => `${s.name.padEnd(28)} ${s.description}\n${" ".repeat(29)}${s.file}`), ...problems.map(p => `skipped ${p}`)].join("\n") || "No skills found.";
    }, { inProcessOnly: true });
    r.on("turn.before", async ({ project, tools }) => {
      if (!project || !tools) throw new Error("The prompt needs an in-process session snapshot");
      const files: [string, string][] = [];
      const global = join(paths.config, "AGENTS.md"), standing = await readFile(global, "utf8").catch(() => "");
      if (standing.trim()) files.push([global, standing]);
      const dirs = [project];
      while (dirname(dirs.at(-1)!) !== dirs.at(-1)) dirs.push(dirname(dirs.at(-1)!));
      for (const dir of dirs.reverse()) for (const name of ["AGENTS.md", "CLAUDE.md"]) {
        const file = join(dir, name);
        try {
          const content = await readFile(file, "utf8");
          if (content.trim()) files.push([file, content]);
          break;
        } catch (err) {
          if (!["ENOENT", "ENOTDIR", "EACCES", "EISDIR", "ENOTSUP"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
        }
      }
      const parts = [PREAMBLE, RULES];
      if (files.length) parts.push("<project_context>\nProject-specific instructions and guidelines:" + files.map(([path, content]) => `\n\n<project_instructions path="${path}">\n${content.trimEnd()}\n</project_instructions>`).join("") + "\n</project_context>");
      const skills = skillPrompt((await skillsFor(paths, project)).skills);
      if (skills) parts.push(`<skills>\n${skills}\n</skills>`);
      parts.push(catalog(tools).prompt(), `<cwd>\n${project}\n</cwd>`, `<date>\n${localDate(new Date())}\n</date>`);
      return { add: { system: parts.join("\n\n") } };
    }, "first", { inProcessOnly: true });
  } });
}

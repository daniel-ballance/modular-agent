import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface Skill { name: string; description: string; file: string; manualOnly: boolean }
function frontmatter(text: string) {
  const head = /^---[\t ]*\r?\n([\s\S]*?)\n---(?=\r?\n|$)/.exec(text);
  if (!head) return;
  const fields = new Map<string, string>(), lines = head[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const pair = /^([^\s#:][^:]*):(.*)$/.exec(lines[i]);
    if (!pair) continue;
    let value = pair[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const block = [];
      while (i + 1 < lines.length && (/^[\t ]/.test(lines[i + 1]) || !lines[i + 1].trim())) block.push(lines[++i].trim());
      value = block.join(value.startsWith(">") ? " " : "\n").trim();
    } else if (value.length >= 2 && ["'", '"'].includes(value[0]) && value[0] === value.at(-1)) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/''/g, "'");
    }
    fields.set(pair[1].trim(), value);
  }
  return { fields, body: text.slice(head[0].length).replace(/^[\r\n]+/, "") };
}
async function walk(dir: string, depth: number): Promise<string[]> {
  const file = join(dir, "SKILL.md");
  if ((await stat(file).catch(() => undefined))?.isFile()) return [file];
  if (!depth) return [];
  const names = await readdir(dir).catch(() => []);
  const files = [];
  for (const name of names.sort()) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const path = join(dir, name);
    if ((await stat(path).catch(() => undefined))?.isDirectory()) files.push(...await walk(path, depth - 1));
  }
  return files;
}
export async function discover(folders: string[]) {
  const skills = new Map<string, Skill>(), problems: string[] = [];
  for (const folder of folders) for (const file of await walk(folder, 6)) {
    try {
      const matter = frontmatter(await readFile(file, "utf8"));
      if (!matter) throw new Error("no front matter");
      const name = matter.fields.get("name") ?? basename(dirname(file));
      if (!/^[a-z0-9-]{1,64}$/.test(name)) throw new Error("the name must be lowercase letters, digits and hyphens, at most 64 long");
      const description = matter.fields.get("description") ?? "";
      if (!description.trim()) throw new Error("no description");
      if (Buffer.byteLength(description) > 1024) throw new Error("the description is over 1024 characters");
      const first = skills.get(name);
      if (first) throw new Error(`skill ${name} is already defined by ${first.file}`);
      skills.set(name, { name, file, description, manualOnly: matter.fields.get("disable-model-invocation") === "true" });
    } catch (err) { problems.push(`${file}: ${(err as Error).message}`); }
  }
  return { skills: [...skills.values()], problems };
}
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
export function skillPrompt(skills: Skill[]) {
  const listed = skills.filter(s => !s.manualOnly);
  if (!listed.length) return "";
  return "The following skills provide specialized instructions for specific tasks.\nUse tools.read in codemode to load a skill's file when the task matches its description.\nResolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.\n\n<available_skills>\n" +
    listed.map(s => `  <skill>\n    <name>${escape(s.name)}</name>\n    <description>${escape(s.description)}</description>\n    <location>${escape(s.file)}</location>\n  </skill>\n`).join("") + "</available_skills>";
}
export async function expandSkill(skills: Skill[], input: string) {
  const match = /^\/skill:([^\s]*)([\s\S]*)$/.exec(input);
  if (!match) return;
  const [, name, args] = match, skill = skills.find(s => s.name === name);
  if (!skill) throw new Error(`no skill named ${name}`);
  const source = await readFile(skill.file, "utf8"), body = frontmatter(source)?.body ?? source;
  return `<skill name="${escape(name)}" location="${escape(skill.file)}">\nReferences are relative to ${dirname(skill.file)}.\n\n${body.trimEnd()}\n</skill>` + (args.trim() ? `\n\n${args.trim()}` : "");
}

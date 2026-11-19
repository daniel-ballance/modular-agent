"""Project instructions, skill discovery and prompt assembly."""

from dataclasses import dataclass
from datetime import date
from pathlib import Path
import re
from typing import cast
from xml.sax.saxutils import escape as xml_escape

from modular_agent import CommandContext, JsonObject, Plugin, Registrar

from . import code

PREAMBLE = "You are a coding assistant running inside Modular Agent, a coding agent harness. Help users inspect files, run commands, and modify code."
RULES = """<rules>
- Do your work through codemode, with the functions on `tools`.
- Use tools.read to examine files instead of cat or sed, and tools.find and tools.list to look for them. Use tools.exec for everything else, such as rg and git.
- Use tools.edit for targeted changes. Batch changes to one file in a single call.
- Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions.
- Use tools.write only for new files or complete rewrites.
- Be concise in your responses
- Show file paths clearly when working with files
</rules>"""
SKILL_INTRO = (
    "The following skills provide specialized instructions for specific tasks.\n"
    "Use tools.read in codemode to load a skill's file when the task matches its description.\n"
    "Resolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.\n\n<available_skills>\n"
)


@dataclass(frozen=True)
class Skill:
    name: str
    description: str
    file: Path
    manual_only: bool


def frontmatter(text: str) -> tuple[dict[str, str], str] | None:
    header = re.match(r"^---[ \t]*\r?\n(.*?)\n---(?:\r?\n|$)", text, flags=re.S)
    if not header:
        return None
    lines = iter(header[1].splitlines())
    line = next(lines, None)
    fields: dict[str, str] = {}
    while line is not None:
        raw, line = line, next(lines, None)
        if raw.startswith((" ", "\t", "#")) or ":" not in raw:
            continue
        key, value = (part.strip() for part in raw.split(":", 1))
        if value in {">", ">-", ">+", "|", "|-", "|+"}:
            block = []
            while line is not None and (not line.strip() or line.startswith((" ", "\t"))):
                block.append(line.strip())
                line = next(lines, None)
            value = (" " if value.startswith(">") else "\n").join(block).strip()
        elif len(value) >= 2 and value[0] in "\"'" and value[-1] == value[0]:
            value = value[1:-1].replace('\\"', '"').replace("''", "'")
        fields[key] = value
    return fields, text[header.end() :].lstrip("\r\n")


def folders(config: Path, project: Path) -> list[Path]:
    return [
        config / "skills",
        Path.home() / ".agents/skills",
        project / ".agents/skills",
        project / ".modular-agent/skills",
    ]


def _walk(folder: Path, depth: int) -> list[Path]:
    file = folder / "SKILL.md"
    if file.is_file():
        return [file]
    if not depth:
        return []
    try:
        children = sorted(folder.iterdir())
    except OSError:
        return []
    return [
        file
        for child in children
        if child.is_dir() and not child.name.startswith(".") and child.name != "node_modules"
        for file in _walk(child, depth - 1)
    ]


def discover(config: Path, project: Path) -> tuple[list[Skill], list[str]]:
    skills: dict[str, Skill] = {}
    problems: list[str] = []
    for folder in folders(config, project):
        for file in _walk(folder, 6):
            try:
                parsed = frontmatter(file.read_text(encoding="utf-8"))
                if parsed is None:
                    raise ValueError("no front matter")
                fields, _ = parsed
                name = fields.get("name", file.parent.name)
                if not re.fullmatch(r"[a-z0-9-]{1,64}", name):
                    raise ValueError(
                        "the name must be lowercase letters, digits and hyphens, at most 64 long"
                    )
                description = fields.get("description", "")
                if not description.strip():
                    raise ValueError("no description")
                if len(description.encode()) > 1024:
                    raise ValueError("the description is over 1024 characters")
                if name in skills:
                    raise ValueError(f"skill {name} is already defined by {skills[name].file}")
                skills[name] = Skill(
                    name, description, file, fields.get("disable-model-invocation") == "true"
                )
            except (OSError, ValueError) as exc:
                problems.append(f"{file}: {exc}")
    return list(skills.values()), problems


def _escape(text: str) -> str:
    return xml_escape(text, {'"': "&quot;", "'": "&apos;"})


def skill_listing(skills: list[Skill]) -> str:
    lines = [
        f"  <skill>\n    <name>{_escape(s.name)}</name>\n    <description>{_escape(s.description)}</description>\n    <location>{_escape(str(s.file))}</location>\n  </skill>\n"
        for s in skills
        if not s.manual_only
    ]
    return SKILL_INTRO + "".join(lines) + "</available_skills>" if lines else ""


def expand(skills: list[Skill], text: str) -> str | None:
    if not text.startswith("/skill:"):
        return None
    name, *args = re.split(r"\s", text.removeprefix("/skill:"), maxsplit=1)
    skill = next((s for s in skills if s.name == name), None)
    if not skill:
        raise ValueError(f"no skill named {name}")
    raw = skill.file.read_text(encoding="utf-8")
    parsed = frontmatter(raw)
    body = parsed[1] if parsed else raw
    text = (
        f'<skill name="{_escape(name)}" location="{_escape(str(skill.file))}">\n'
        f"References are relative to {skill.file.parent}.\n\n{body.rstrip()}\n</skill>"
    )
    return text + ("\n\n" + args[0].strip() if args and args[0].strip() else "")


def _instructions(config: Path, project: Path) -> str:
    files: list[tuple[Path, str]] = []
    for group in [
        [config / "AGENTS.md"],
        *[
            [folder / "AGENTS.md", folder / "CLAUDE.md"]
            for folder in [*reversed(project.parents), project]
        ],
    ]:
        for path in group:
            try:
                text = path.read_text(encoding="utf-8")
            except (FileNotFoundError, PermissionError, NotADirectoryError, IsADirectoryError):
                continue
            if text.strip():
                files.append((path, text.rstrip()))
            break
    if not files:
        return ""
    return (
        "<project_context>\nProject-specific instructions and guidelines:"
        + "".join(
            f'\n\n<project_instructions path="{path}">\n{text}\n</project_instructions>'
            for path, text in files
        )
        + "\n</project_context>"
    )


def prompt_plugin(config: Path, project: Path) -> Plugin:
    def prompt(payload: JsonObject) -> JsonObject:
        cwd = Path(str(payload.get("project", project)))
        skills, _ = discover(config, cwd)
        listed = skill_listing(skills)
        sections = [PREAMBLE, RULES, _instructions(config, cwd)]
        if listed:
            sections.append(f"<skills>\n{listed}\n</skills>")
        sections.append(
            code.prompt(
                code.functions(cast(list[JsonObject], payload.get("nestedTools", [])))
            ).rstrip()
        )
        sections += [f"<cwd>\n{cwd}\n</cwd>", f"<date>\n{date.today().isoformat()}\n</date>"]
        return {"add": {"system": "\n\n".join(s for s in sections if s), "sources": []}}

    def input_hook(payload: JsonObject) -> JsonObject | None:
        content = cast(list[JsonObject], payload["content"])
        text = "".join(str(part.get("text", "")) for part in content if part.get("type") == "text")
        if not text.startswith("/skill:"):
            return None
        cwd = Path(str(payload.get("project", project)))
        if expanded := expand(discover(config, cwd)[0], text):
            return {"change": {"content": [{"type": "text", "text": expanded}]}}
        return None

    def skills_command(args: str, context: CommandContext) -> str:
        found, _ = discover(config, project)
        return "\n".join(f"{s.name:<28} {s.description}\n{'':28} {s.file}" for s in found)

    def setup(registrar: Registrar) -> None:
        registrar.on("input", input_hook, "first", in_process_only=True)
        registrar.on("turn.before", prompt, in_process_only=True)
        registrar.command("skills", "List skills", skills_command)

    return Plugin("standard.prompt", setup=setup)

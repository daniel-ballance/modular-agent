"""The standard file and command tools, over the SDK working environment."""

from __future__ import annotations

import base64
import fnmatch
import math
import shlex
import tempfile
import time
from pathlib import Path, PurePosixPath
from typing import cast

from modular_agent import (
    AgentError,
    ErrorCode,
    Json,
    JsonObject,
    Plugin,
    Tool,
    ToolContext,
    ToolOutput,
)

MAX_LINES = 2000
MAX_BYTES = 50 * 1024
MAX_IMAGE = 4_718_592


def _field(kind: str, description: str) -> JsonObject:
    return {"type": kind, "description": description}


def _schema(properties: JsonObject, *required: str) -> JsonObject:
    return {
        "type": "object",
        "properties": properties,
        "required": list(required),
        "additionalProperties": False,
    }


def _path(argument: Json) -> str:
    path = cast(str, argument).removeprefix("@")
    return str(Path.home()) + path[1:] if path == "~" or path.startswith("~/") else path


def _num(args: JsonObject, key: str, default: float) -> float:
    value = cast(float, args.get(key, default))
    if value < 0 or not math.isfinite(value):
        raise ValueError(f"{key} must be a number, zero or more")
    return value


def _lines(content: str) -> list[str]:
    return content.removesuffix("\n").split("\n") if content else []


def _size(n: int) -> str:
    if n < 1024:
        return f"{n}B"
    if n < 1024**2:
        return f"{n / 1024:.1f}KB"
    return f"{n / 1024**2:.1f}MB"


def _cut(content: str, limit: int, *, tail: bool = False) -> tuple[str, int, bool]:
    lines = _lines(content)
    if len(lines) <= limit and len(content.encode()) <= MAX_BYTES:
        return content, len(lines), False
    kept: list[str] = []
    size = 0
    by_bytes = False
    for line in (lines[::-1] if tail else lines)[:limit]:
        data = line.encode()
        size += len(data) + bool(kept)
        if size > MAX_BYTES:
            by_bytes = True
            if not kept and tail:
                kept.append(data[-MAX_BYTES:].decode(errors="ignore"))
            break
        kept.append(line)
    return "\n".join(reversed(kept) if tail else kept), len(kept), by_bytes


def _window(content: str, path: str, offset: int, limit: int | None) -> str:
    lines = _lines(content)
    total = len(lines)
    start = max(0, offset - 1)
    if start >= total and (total or start):
        raise ValueError(f"Offset {offset} is beyond end of file ({total} lines total)")
    end = total if limit is None else min(total, start + limit)
    window = "\n".join(lines[start:end])
    text, count, by_bytes = _cut(window, MAX_LINES)
    first = start + 1
    if by_bytes and not count:
        return (
            f"[Line {first} is {_size(len(lines[start].encode()))}, exceeds 50.0KB limit. "
            f"Use exec: sed -n '{first}p' {path} | head -c {MAX_BYTES}]"
        )
    if text != window:
        last = start + count
        note = " (50.0KB limit)" if by_bytes else ""
        return f"{text}\n\n[Showing lines {first}-{last} of {total}{note}. Use offset={last + 1} to continue.]"
    if end < total:
        return f"{text}\n\n[{total - end} more lines in file. Use offset={end + 1} to continue.]"
    return text


def _mime(data: bytes) -> str | None:
    for magic, mime in ((b"\x89PNG", "png"), (b"\xff\xd8\xff", "jpeg"), (b"GIF8", "gif")):
        if data.startswith(magic):
            return "image/" + mime
    if data.startswith(b"BM") and len(data) > 26:
        return "image/bmp"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    return None


async def _read(arguments: JsonObject, context: ToolContext) -> str | ToolOutput:
    path = _path(arguments["path"])
    offset = int(_num(arguments, "offset", 0))
    limit = int(_num(arguments, "limit", 0)) if "limit" in arguments else None
    data = await context.environment.read(path)
    if mime := _mime(data):
        if len(data) > MAX_IMAGE:
            return f"Read image file [{mime}], {_size(len(data))}. It is over the {_size(MAX_IMAGE)} limit for images, so it was not attached."
        return ToolOutput(
            [
                {"type": "text", "text": f"Read image file [{mime}]"},
                {"type": "image", "mimeType": mime, "data": base64.b64encode(data).decode()},
            ]
        )
    return _window(data.decode(errors="replace"), path, offset, limit)


async def _write(arguments: JsonObject, context: ToolContext) -> str:
    path = _path(arguments["path"])
    data = cast(str, arguments["content"]).encode()
    await context.environment.write(path, data)
    return f"Successfully wrote {len(data)} bytes to {path}"


def _lf(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _replace(original: str, edits: list[JsonObject], path: str) -> str:
    if not edits:
        raise ValueError("edits must contain at least one replacement")
    bom = "\ufeff" if original.startswith("\ufeff") else ""
    body = original.removeprefix(bom)
    base = _lf(body)
    spans: list[tuple[int, int, int, str]] = []
    for index, item in enumerate(edits):
        old, new = (_lf(cast(str, item[k])) for k in ("oldText", "newText"))
        label = "oldText" if len(edits) == 1 else f"edits[{index}].oldText"
        if not old:
            raise ValueError(f"{label} must not be empty in {path}.")
        count = base.count(old)
        if not count:
            raise ValueError(
                f"Could not find {label} in {path}. It must match exactly, including all whitespace and newlines."
            )
        if count != 1:
            raise ValueError(
                f"Found {count} occurrences of {label} in {path}. The text must be unique. Provide more context to make it unique."
            )
        start = base.index(old)
        spans.append((start, start + len(old), index, new))
    spans.sort()
    for a, b in zip(spans, spans[1:]):
        if a[1] > b[0]:
            raise ValueError(
                f"edits[{a[2]}] and edits[{b[2]}] overlap in {path}. Merge them into one edit or target disjoint regions."
            )
    pieces, pos = [], 0
    for start, end, _, new in spans:
        pieces += [base[pos:start], new]
        pos = end
    result = "".join([*pieces, base[pos:]])
    if result == base:
        raise ValueError(f"No changes made to {path}. The replacement produced identical content.")
    return bom + (
        result.replace("\n", "\r\n") if body.partition("\n")[0].endswith("\r") else result
    )


async def _edit(arguments: JsonObject, context: ToolContext) -> str:
    path = _path(arguments["path"])
    edits = cast(list[JsonObject], arguments["edits"])
    try:
        text = (await context.environment.read(path)).decode()
    except UnicodeDecodeError as exc:
        raise ValueError(f"{path} is not UTF-8 text") from exc
    await context.environment.write(path, _replace(text, edits, path).encode())
    return f"Successfully replaced {len(edits)} block(s) in {path}."


def _listing(entries: list[str], limit: int, label: str, extra: str = "") -> str:
    notes = []
    if len(entries) > limit:
        notes.append(f"{limit} {label} limit reached. Use limit={limit * 2} for more{extra}")
    joined = "\n".join(entries[:limit])
    text, _, _ = _cut(joined, limit)
    if text != joined:
        notes.append("50.0KB limit reached")
    return f"{text}\n\n[{'. '.join(notes)}]" if notes else text


async def _list(arguments: JsonObject, context: ToolContext) -> str:
    path = _path(arguments.get("path", "."))
    entries = [
        str(e["name"]) + ("/" if e["kind"] == "directory" else "")
        for e in await context.environment.list(path)
    ]
    entries.sort(key=str.lower)
    return (
        _listing(entries, max(1, int(_num(arguments, "limit", 500))), "entries")
        if entries
        else "(empty directory)"
    )


async def _find(arguments: JsonObject, context: ToolContext) -> str:
    path = _path(arguments.get("path", "."))
    raw_pattern = cast(str, arguments["pattern"])
    pattern = raw_pattern.removeprefix("./")
    if pattern.count("[") != pattern.count("]"):
        raise ValueError("invalid glob pattern: unclosed character class")
    command = (
        f"cd -- {shlex.quote(path)} && "
        "(git ls-files -z -co --exclude-standard 2>/dev/null || find . -type f -not -path './.git/*' -print0)"
    )
    try:
        result = await context.environment.exec(command)
        if result.get("exit_code"):
            raise ValueError(str(result.get("text", "File search failed")))
        paths = [p.removeprefix("./") for p in cast(str, result.get("text", "")).split("\0") if p]
    except AgentError as exc:
        if exc.code is not ErrorCode.NOT_SUPPORTED:
            raise
        paths = []
        pending = [""]
        while pending:
            prefix = pending.pop()
            for item in await context.environment.list(str(PurePosixPath(path, prefix))):
                name = str(item["name"])
                if name == ".git":
                    continue
                rel = prefix + name
                if item["kind"] == "directory":
                    pending.append(rel + "/")
                elif item["kind"] == "file":
                    paths.append(rel)
    matches = sorted(
        p
        for p in set(paths)
        if (
            PurePosixPath(p).full_match(pattern)
            if "/" in raw_pattern
            else fnmatch.fnmatchcase(PurePosixPath(p).name, pattern)
        )
    )
    return (
        _listing(
            matches, max(1, int(_num(arguments, "limit", 1000))), "results", ", or refine pattern"
        )
        if matches
        else "No files found matching pattern"
    )


def file_tools(spill: Path) -> Plugin:
    """Return the six standard tools; save cut command output under spill."""

    async def execute(arguments: JsonObject, context: ToolContext) -> ToolOutput:
        timeout = _num(arguments, "timeout", 0) or None
        start = time.monotonic()
        try:
            result = await context.environment.exec(cast(str, arguments["command"]), timeout)
        except AgentError as exc:
            if not isinstance(exc.__cause__, TimeoutError):
                raise
            return ToolOutput(
                [{"type": "text", "text": f"Command timed out after {timeout:g} seconds"}], "failed"
            )
        output = cast(str, result.get("text", ""))
        cut, count, by_bytes = _cut(output, MAX_LINES, tail=True)
        code = result.get("exit_code")
        value: JsonObject = {
            "output": cut,
            "exit_code": code,
            "truncated": cut != output,
            "wall_time_seconds": round(time.monotonic() - start, 3),
        }
        text = cut
        if cut != output:
            lines = len(_lines(output))
            note = f"\n\n[Showing lines {lines - count + 1}-{lines} of {lines}"
            if by_bytes:
                note += " (50.0KB limit)"
            try:
                spill.mkdir(parents=True, exist_ok=True, mode=0o700)
                with tempfile.NamedTemporaryFile(
                    mode="w",
                    encoding="utf-8",
                    prefix="exec-",
                    suffix=".log",
                    dir=spill,
                    delete=False,
                ) as file:
                    file.write(output)
                value["full_output_path"] = file.name
                note += f". Full output: {file.name}"
            except OSError:
                pass
            text += note + "]"
        if not text:
            text = "(no output)"
        if result.get("timed_out"):
            assert timeout is not None
            value["timed_out"] = True
            text += f"\n\nCommand timed out after {timeout:g} seconds"
        elif code:
            text += (
                f"\n\nCommand exited with code {code}"
                if cast(int, code) > 0
                else "\n\nCommand was ended by a signal"
            )
        return ToolOutput(
            [{"type": "text", "text": text}],
            "failed" if code or result.get("timed_out") else "completed",
            value,
        )

    def path(purpose: str) -> JsonObject:
        return _field("string", f"Path to the file to {purpose} (relative or absolute)")

    edits = _field(
        "array",
        "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
    )
    edits["items"] = _schema(
        {
            "oldText": _field(
                "string",
                "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
            ),
            "newText": _field("string", "Replacement text for this targeted edit."),
        },
        "oldText",
        "newText",
    )
    return Plugin(
        "tools.files",
        tools=[
            Tool.from_schema(
                "read",
                "Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
                _schema(
                    {
                        "path": path("read"),
                        "offset": _field("number", "Line number to start reading from (1-indexed)"),
                        "limit": _field("number", "Maximum number of lines to read"),
                    },
                    "path",
                ),
                _read,
                read_only=True,
                safe_to_repeat=True,
                parallel=True,
                in_process_only=True,
            ),
            Tool.from_schema(
                "exec",
                "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.",
                _schema(
                    {
                        "command": _field("string", "Shell command to execute"),
                        "timeout": _field(
                            "number", "Timeout in seconds (optional, no default timeout)"
                        ),
                    },
                    "command",
                ),
                execute,
                in_process_only=True,
            ),
            Tool.from_schema(
                "edit",
                "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
                _schema({"path": path("edit"), "edits": edits}, "path", "edits"),
                _edit,
                in_process_only=True,
            ),
            Tool.from_schema(
                "write",
                "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
                _schema(
                    {
                        "path": path("write"),
                        "content": _field("string", "Content to write to the file"),
                    },
                    "path",
                    "content",
                ),
                _write,
                in_process_only=True,
            ),
            Tool.from_schema(
                "find",
                "Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to 1000 results or 50KB (whichever is hit first).",
                _schema(
                    {
                        "pattern": _field(
                            "string",
                            "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
                        ),
                        "path": _field(
                            "string", "Directory to search in (default: current directory)"
                        ),
                        "limit": _field("number", "Maximum number of results (default: 1000)"),
                    },
                    "pattern",
                ),
                _find,
                read_only=True,
                safe_to_repeat=True,
                parallel=True,
                in_process_only=True,
            ),
            Tool.from_schema(
                "list",
                "List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to 500 entries or 50KB (whichever is hit first).",
                _schema(
                    {
                        "path": _field("string", "Directory to list (default: current directory)"),
                        "limit": _field(
                            "number", "Maximum number of entries to return (default: 500)"
                        ),
                    }
                ),
                _list,
                read_only=True,
                safe_to_repeat=True,
                parallel=True,
                in_process_only=True,
            ),
        ],
    )

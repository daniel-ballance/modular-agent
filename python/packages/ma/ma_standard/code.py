"""Monty sandbox, with all effects dispatched as nested SDK calls."""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
import json
import re
from typing import cast

from modular_agent import AgentError, Json, JsonObject, Tool, ToolContext, ToolOutput, ToolStatus
from pydantic_monty import (
    AsyncFunctionSnapshot,
    AsyncMonty,
    AsyncNameLookupSnapshot,
    CollectString,
    ExternalModule,
    MontyComplete,
    MontyCrashedError,
    MontyError,
)

TOOL = "codemode"
DESCRIPTION = 'Run Python in a sandbox. The functions listed under "Functions in codemode" in the system prompt are the only way to reach files, commands and other tools. Call them on `tools`, for example `text = tools.read(path="README.md")`. The value of the last expression and anything printed come back as the result. Each run starts fresh: no variables carry over. The sandbox runs a subset of Python: no classes with inheritance, no third-party packages, and no direct file, network or process access.'
INTRO = "# Functions in codemode\n\nYou have one tool, `codemode`, which runs Python. These functions exist inside it, on the `tools` object, and nowhere else. Call them as written; no import and no `await` is needed. Arguments go by keyword or in the order shown. A function returns a string unless its entry says otherwise, and raises `RuntimeError` when the call fails, is refused or is cancelled. Do several steps in one run when the later steps do not depend on your judgement of the earlier ones.\n"
HELPERS = "\n## describe_tool(name: str)\nReturns a dict with the full description of the `tools` function of that name and the JSON schema of its parameters.\n\n## search_tools(query: str)\nReturns the functions whose name or description contains every word of the query, as a list of dicts with `name`, `signature` and `description`.\n"
IMAGE = "\n`tools.read` on an image file (png, jpeg, gif, webp, bmp) returns a dict, not a string. To look at the image, make that dict the last expression of the run, alone or in a list.\n"
EXEC = "\n`tools.exec` returns a dict: `output` (stdout and stderr together), `exit_code`, `truncated`, `wall_time_seconds`, and `full_output_path` when the output was cut. A command that exits non-zero returns its dict; it does not raise.\n"


def _kind(schema: Json) -> str:
    if not isinstance(schema, dict):
        return "Any"
    kind = schema.get("type")
    if kind == "array":
        return f"list[{_kind(schema.get('items'))}]"
    return {
        "string": "str",
        "integer": "int",
        "number": "float",
        "boolean": "bool",
        "object": "dict",
        "null": "None",
    }.get(str(kind), "Any")


@dataclass(frozen=True)
class Function:
    name: str
    tool: str
    description: str
    schema: JsonObject
    required: list[str]
    properties: JsonObject
    read_only: bool

    @property
    def parameters(self) -> list[str]:
        return self.required + [name for name in self.properties if name not in self.required]

    @property
    def signature(self) -> str:
        params = [
            f"{name}: {_kind(self.properties.get(name))}"
            + ("" if name in self.required else " = None")
            for name in self.parameters
        ]
        return f"tools.{self.name}({', '.join(params)})"

    @property
    def brief(self) -> str:
        return self.description.partition("\n")[0][:160]

    def describe(self) -> JsonObject:
        return {
            "name": self.name,
            "signature": self.signature,
            "description": self.description,
            "parameters": self.schema,
            "read_only": self.read_only,
        }

    def bind(self, args: tuple[object, ...], kwargs: dict[str, object]) -> JsonObject:
        params = self.parameters
        if len(args) > len(params):
            raise TypeError(f"takes at most {len(params)} arguments, got {len(args)}")
        inputs = dict(zip(params, args))
        for key, value in kwargs.items():
            if key in inputs:
                raise TypeError(f"got two values for {key}")
            inputs[key] = value
        inputs = {k: v for k, v in inputs.items() if v is not None}
        if self.schema.get("additionalProperties") is False:
            for key in inputs.keys() - self.properties.keys():
                raise TypeError(f"unexpected argument {key}; the signature is {self.signature}")
        for key in self.required:
            if key not in inputs:
                raise TypeError(f"missing argument {key}; the signature is {self.signature}")
        return cast(JsonObject, json.loads(json.dumps(inputs, allow_nan=False)))


def functions(definitions: list[JsonObject]) -> dict[str, Function]:
    result = {}
    for definition in definitions:
        tool = cast(str, definition["name"])
        if tool == TOOL:
            continue
        name = re.sub(r"[^a-zA-Z0-9_]", "_", tool)
        if not name or name[0].isdigit():
            name = "_" + name
        if name in result:
            raise ValueError(f"two tools share the function name {name}")
        schema = cast(JsonObject, definition.get("parameters", {}))
        hints = cast(JsonObject, definition.get("hints", {}))
        result[name] = Function(
            name,
            tool,
            cast(str, definition["description"]),
            schema,
            cast(list[str], schema.get("required", [])),
            cast(JsonObject, schema.get("properties", {})),
            hints.get("readOnly") is True,
        )
    return result


def prompt(catalog: dict[str, Function]) -> str:
    text = INTRO
    if len(catalog) <= 12:
        text += "".join(f"\n## {f.signature}\n{f.description}\n" for f in catalog.values())
    else:
        text += "".join(f"\n- `{f.signature}`: {f.brief}" for f in catalog.values()) + "\n"
    return (
        text + HELPERS + (IMAGE if "read" in catalog else "") + (EXEC if "exec" in catalog else "")
    )


def _bounded(text: str) -> str:
    lines = text.splitlines()
    size = len(text.encode())
    if len(lines) <= 2000 and size <= 51200:
        return text
    kept: list[str] = []
    count = 0
    for line in lines[:2000]:
        length = len(line.encode()) + 1
        if count + length > 51200:
            break
        kept.append(line + "\n")
        count += length
    return "".join(kept) + (
        f"\n[Output cut: showing the first {len(kept)} of {len(lines)} lines "
        f"({count} of {size} bytes). Return or print less, or write the rest to a file.]"
    )


def _image(value: object) -> bool:
    return (
        isinstance(value, dict)
        and value.get("type") == "image"
        and isinstance(value.get("mimeType"), str)
        and isinstance(value.get("data"), str)
    )


def code_tool(
    *, compute: float = 30, calls: int = 500, recursion: int = 200, printed: int = 1048576
) -> Tool:
    async def execute(arguments: JsonObject, context: ToolContext) -> ToolOutput:
        catalog = functions(await context.tools.list())
        made = 0

        def describe_tool(name: str) -> JsonObject:
            if not isinstance(name, str):
                raise TypeError("describe_tool() takes one string")
            if name not in catalog:
                raise KeyError(f"no function named {name}")
            return catalog[name].describe()

        def search_tools(query: str) -> list[JsonObject]:
            if not isinstance(query, str):
                raise TypeError("search_tools() takes one string")
            return [
                {"name": f.name, "signature": f.signature, "description": f.brief}
                for f in sorted(catalog.values(), key=lambda f: f.name)
                if all(
                    word in f"{f.name} {f.description}".lower() for word in query.lower().split()
                )
            ]

        def callback(function: Function) -> Callable[..., Awaitable[Json]]:
            async def invoke(*args: object, **kwargs: object) -> Json:
                nonlocal made
                try:
                    inputs = function.bind(args, kwargs)
                except (TypeError, ValueError) as exc:
                    raise TypeError(f"{function.name}(): {exc}") from exc
                made += 1
                if made > calls:
                    raise RuntimeError(f"this run made more than {calls} function calls")
                try:
                    result = await context.tools.call(function.tool, inputs)
                except AgentError as exc:
                    raise RuntimeError(f"{function.name}() could not run: {exc}") from exc
                if result.status == ToolStatus.COMPLETED:
                    for part in result.content:
                        if _image(part):
                            return {**cast(JsonObject, part), "note": result.text()}
                    return result.text() if result.value is None else result.value
                if (
                    function.tool == "exec"
                    and isinstance(result.value, dict)
                    and result.status == ToolStatus.FAILED
                ):
                    return result.value
                raise RuntimeError(f"{function.name}() {result.status}: {result.text()}")

            return invoke

        collector = CollectString(max_bytes=printed)

        def no_os(*args: object, **kwargs: object) -> Json:
            raise RuntimeError(
                "the sandbox has no direct access to files, the network, the clock or the environment; use the provided functions"
            )

        try:
            # One pool and checkout per call. Never feed a session again after
            # a memory or time limit, when Monty no longer trusts its heap.
            async with AsyncMonty(max_processes=1, max_checkouts_per_worker=1) as pool:
                module = ExternalModule(dict.fromkeys(catalog, lambda: None))
                handlers = {f"tools.{name}": callback(f) for name, f in catalog.items()}
                async with pool.checkout(
                    external_modules={"tools": module},
                    os_policy={"datetime": "call_host", "sleep": "call_host"},
                    limits={
                        "max_memory": 256 * 1024 * 1024,
                        "max_turn_duration_secs": compute,
                        "max_recursion_depth": recursion,
                        # The pool counts lookups too. Leave the product call budget to invoke().
                        "max_suspensions": 2**31 - 1,
                    },
                ) as worker:
                    await worker.feed_run("import tools", print_callback=collector)
                    snapshot = await worker.feed_start(
                        cast(str, arguments["code"]),
                        external_lookup={
                            "describe_tool": describe_tool,
                            "search_tools": search_tools,
                        },
                        print_callback=collector,
                        os=no_os,
                    )
                    while not isinstance(snapshot, MontyComplete):
                        if isinstance(snapshot, AsyncNameLookupSnapshot) or (
                            isinstance(snapshot, AsyncFunctionSnapshot)
                            and str(snapshot.function_name) not in handlers
                        ):
                            snapshot = await snapshot.resume_auto()
                        elif isinstance(snapshot, AsyncFunctionSnapshot):
                            try:
                                answer = await handlers[str(snapshot.function_name)](
                                    *snapshot.args, **snapshot.kwargs
                                )
                            except (RuntimeError, TypeError) as exc:
                                snapshot = await snapshot.resume({"exception": exc})
                            else:
                                snapshot = await snapshot.resume({"return_value": answer})
                        else:
                            raise RuntimeError("awaited something that never resolves")
                    result: object = snapshot.output
        except (MontyError, MemoryError) as exc:
            if isinstance(exc, MontyCrashedError):
                kind = "TimeoutError: " if exc.timed_out else ""
                error = f"{kind}Sandbox worker process died: {exc}"
            elif isinstance(exc, MemoryError):
                error = f"MemoryError: {exc}"
            else:
                error = str(exc)
            combined = collector.output + error
            text = _bounded(combined)
            if text != combined:
                # Keep the error even if the run filled the output budget first.
                text = _bounded(error + "\n" + collector.output)
            return ToolOutput([{"type": "text", "text": text}], "failed")

        notes = collector.output
        if notes and not notes.endswith("\n"):
            notes += "\n"
        images: list[JsonObject] = []
        if _image(result):
            images, result = [cast(JsonObject, result)], None
        elif isinstance(result, (tuple, list)):
            rest = []
            for item in result:
                if _image(item):
                    images.append(cast(JsonObject, item))
                else:
                    rest.append(item)
            result = rest if rest or not images else None
        for image in images:
            if isinstance(note := image.pop("note", None), str):
                notes += note + "\n"
        if result is not None:
            try:
                notes += (
                    result
                    if isinstance(result, str)
                    else json.dumps(result, indent=2, ensure_ascii=False, sort_keys=True)
                )
            except (TypeError, ValueError):
                notes += str(result)
        return ToolOutput(
            [{"type": "text", "text": _bounded(notes or "(no output)")}, *images],
            value={"calls": made},
        )

    return Tool.from_schema(
        TOOL,
        DESCRIPTION,
        {
            "type": "object",
            "properties": {"code": {"type": "string", "description": "Python source to run"}},
            "required": ["code"],
            "additionalProperties": False,
        },
        execute,
        in_process_only=True,
    )

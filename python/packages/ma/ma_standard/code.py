"""Monty sandbox, with all effects dispatched as nested SDK calls."""

from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack
from dataclasses import dataclass
import json
import re
from typing import cast

from modular_agent import AgentError, Json, JsonObject, Tool, ToolContext, ToolOutput, ToolStatus
from opentelemetry.trace import use_span
from pydantic_monty import (
    AsyncFunctionSnapshot,
    AsyncMonty,
    AsyncNameLookupSnapshot,
    ExternalModule,
    MontyClassProxy,
    MontyComplete,
    MontyCrashedError,
    MontyError,
    MontyRuntimeError,
    MontySyntaxError,
)

from .code_clock import ComputeBudget, ComputeLimit, WorkerClockError

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


def _takes_object(schema: Json) -> bool:
    if not isinstance(schema, dict):
        return False
    kind = schema.get("type")
    if kind == "object" or (isinstance(kind, list) and "object" in kind):
        return True
    return any(
        isinstance(options := schema.get(key), list) and any(map(_takes_object, options))
        for key in ("anyOf", "oneOf")
    )


def _check_json_keys(value: object) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise TypeError("JSON object keys must be strings")
            _check_json_keys(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            _check_json_keys(item)


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
        return self.required + sorted(self.properties.keys() - self.required)

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
        if (
            len(args) == 1
            and isinstance(args[0], dict)
            and not kwargs
            and not (params and _takes_object(self.properties.get(params[0])))
        ):
            if any(not isinstance(key, str) for key in args[0]):
                raise TypeError("argument names must be strings")
            inputs = dict(args[0])
        else:
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
        # json.dumps silently stringifies some dict keys. Reject that loss
        # before letting it check scalars and turn tuples into JSON arrays.
        _check_json_keys(inputs)
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


def _utf8_prefix(data: bytes, limit: int) -> str:
    return data[:limit].decode("utf-8", errors="ignore")


class _PrintedOutput:
    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.data = bytearray()
        self.exceeded = False

    def __call__(self, _stream: str, text: str) -> None:
        chunk = text.encode("utf-8")
        remaining = self.limit - len(self.data)
        if len(chunk) > remaining:
            self.data.extend(chunk[:remaining])
            self.exceeded = True
            # A print callback error aborts the feed, outside the sandbox's try/except.
            raise RuntimeError(f"printed output exceeded {self.limit} bytes")
        self.data.extend(chunk)

    @property
    def output(self) -> str:
        return _utf8_prefix(bytes(self.data), self.limit)


def _bounded(text: str, *, ending: str = "") -> str:
    marker = "[Output cut: return or print less, or write the rest to a file.]\n"
    joined = text + ending
    if joined.count("\n") + (not joined.endswith("\n")) <= 2000 and len(joined.encode()) <= 51200:
        return joined
    if ending:
        # The traceback would be cut. Keep its last line visible before the prefix.
        frames, sep, reason = ending.rstrip("\n").rpartition("\n")
        joined = reason + "\n" + text + frames + sep
    size = 0
    lines = []
    for line in joined.split("\n", 2000)[:2000]:
        size += len(line.encode()) + 1
        if size > 51200:
            break
        lines.append(line + "\n")
    return "".join(lines) + marker


def _image(value: object) -> bool:
    return (
        isinstance(value, dict)
        and value.get("type") == "image"
        and isinstance(value.get("mimeType"), str)
        and isinstance(value.get("data"), str)
    )


def _value_repr(value: object) -> str:
    if isinstance(value, MontyClassProxy):
        attributes = ", ".join(f"{k}={_value_repr(v)}" for k, v in value.attributes.items())
        return f"{value.name}({attributes})"
    if type(value) is list:
        return "[" + ", ".join(map(_value_repr, value)) + "]"
    if type(value) is tuple:
        return "(" + ", ".join(map(_value_repr, value)) + ("," if len(value) == 1 else "") + ")"
    if type(value) is dict:
        return (
            "{" + ", ".join(f"{_value_repr(k)}: {_value_repr(v)}" for k, v in value.items()) + "}"
        )
    if type(value) is set and value:
        return "{" + ", ".join(map(_value_repr, value)) + "}"
    if type(value) is frozenset and value:
        return "frozenset({" + ", ".join(map(_value_repr, value)) + "})"
    return repr(value)


def code_tool(
    *, compute: float = 30, calls: int = 500, recursion: int = 200, printed: int = 1048576
) -> Tool:
    async def execute(arguments: JsonObject, context: ToolContext) -> ToolOutput:
        catalog = functions(await context.tools.list())
        made = 0
        budget = ComputeBudget(compute)

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
                except (TypeError, ValueError, RecursionError) as exc:
                    raise TypeError(f"{function.name}(): {exc}") from exc
                if made >= calls:
                    raise RuntimeError(f"this run made more than {calls} function calls")
                made += 1
                budget.reset()  # Only a dispatched nested call starts a new interval.
                try:
                    result = await context.tools.call(function.tool, inputs)
                except AgentError as exc:
                    raise RuntimeError(f"{function.name}() could not run: {exc}") from exc
                if result.status == ToolStatus.COMPLETED:
                    if result.value is not None:
                        return result.value
                    for part in result.content:
                        if _image(part):
                            return {**cast(JsonObject, part), "note": result.text()}
                    return result.text()
                if (
                    function.tool == "exec"
                    and result.status == ToolStatus.FAILED
                    and isinstance(result.value, dict)
                    and result.value.get("timed_out") is not True
                    and type(code := result.value.get("exit_code")) is int
                    and code != 0
                ):
                    return result.value
                raise RuntimeError(f"{function.name}() {result.status}: {result.text()}")

            return invoke

        collector = _PrintedOutput(printed)

        def no_os(*args: object, **kwargs: object) -> Json:
            raise RuntimeError(
                "the sandbox has no direct access to files, the network, the clock or the environment; use the provided functions"
            )

        try:
            # One pool and checkout per call. Never feed a session again after
            # a memory or time limit, when Monty no longer trusts its heap.
            async with AsyncExitStack() as stack:
                clock_span = stack.enter_context(budget.capture())
                pool = await stack.enter_async_context(
                    AsyncMonty(
                        execution_clock="wall",
                        max_processes=1,
                        max_checkouts_per_worker=1,
                        request_timeout=compute + 0.25,  # Only while waiting on the worker.
                    )
                )
                module = ExternalModule(dict.fromkeys(catalog, lambda: None))
                handlers = {f"tools.{name}": callback(f) for name, f in catalog.items()}
                with use_span(clock_span):
                    worker = await stack.enter_async_context(
                        pool.checkout(
                            external_modules={"tools": module},
                            os_policy={
                                "datetime": "call_host",
                                "sleep": "call_host",
                                "process_time": "zero",
                                "random_start": "call_host",
                            },
                            print_flush_interval=0,
                            limits={
                                "max_memory": 256 * 1024 * 1024,
                                # The turn clock restarts on every resume, not just tools.
                                "max_turn_duration_secs": compute,
                                "max_recursion_depth": recursion,
                                # Only dispatch in invoke() counts toward the nested-call limit.
                                "max_suspensions": 2**31 - 1,
                            },
                        )
                    )
                await worker.feed_run("import tools", print_callback=collector)
                budget.reset()  # Exclude the setup feed, before any user code runs.
                try:
                    snapshot = await worker.feed_start(
                        cast(str, arguments["code"]),
                        external_lookup={
                            "describe_tool": describe_tool,
                            "search_tools": search_tools,
                        },
                        print_callback=collector,
                        os=no_os,
                    )
                    while True:
                        budget.check()
                        if isinstance(snapshot, MontyComplete):
                            result: object = snapshot.output
                            break
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
                except MontyRuntimeError as exc:
                    # Keep native limit errors and their tracebacks.
                    if not isinstance(exc.exception(), (TimeoutError, MemoryError)):
                        # The binding can also raise before the worker replies.
                        budget.check(require_report=False)
                    raise
        except (MontyError, MemoryError, ComputeLimit, WorkerClockError) as exc:
            if collector.exceeded:
                text = _bounded(
                    f"RuntimeError: printed output exceeded {printed} bytes\n" + collector.output
                )
            else:
                if isinstance(exc, MontyCrashedError):
                    kind = "TimeoutError: " if exc.timed_out else ""
                    error = f"{kind}Sandbox worker process died: {exc}"
                elif isinstance(exc, MemoryError):
                    error = f"MemoryError: {exc}" if str(exc) else "MemoryError"
                elif isinstance(exc, ComputeLimit):
                    error = f"TimeoutError: {exc}"
                elif isinstance(exc, (MontyRuntimeError, MontySyntaxError)):
                    error = exc.display("traceback")
                else:
                    error = str(exc)
                output = collector.output
                if output and not output.endswith("\n"):
                    output += "\n"
                text = _bounded(output, ending=error)
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
            if images:
                result = (tuple(rest) if isinstance(result, tuple) else rest) if rest else None
        for image in images:
            if isinstance(note := image.get("note"), str):
                notes += note + "\n"
        if result is not None:
            try:
                notes += (
                    result
                    if isinstance(result, str)
                    else json.dumps(result, indent=2, ensure_ascii=False, allow_nan=False)
                )
            except (TypeError, ValueError):
                notes += _value_repr(result)
        return ToolOutput(
            [
                {"type": "text", "text": _bounded(notes or "(no output)")},
                *[{k: image[k] for k in ("type", "mimeType", "data")} for image in images],
            ],
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

"""The shared SDK fixtures, in process or over the plugin binding."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from . import AgentError, ErrorCode, JsonObject, Plugin, Registrar, ToolContext, serve, tool


@tool(read_only=True)
async def tide(harbour: str) -> str:
    """Today's high tide at a harbour.

    Args:
        harbour: The harbour to look up.
    """
    return f"High tide at {harbour} is 14:02."


@tool
async def confirm(question: str, cx: ToolContext) -> str:
    """Ask whether to go ahead."""
    answer = await cx.ask({"kind": "choice", "question": question, "options": ["yes", "no"]})
    if answer.kind == "value":
        return str(answer.value)
    return "allow" if answer.kind == "allow" else "declined"


@tool
async def moor(harbour: str, cx: ToolContext) -> str:
    """Moor at a harbour."""
    raise cx.refuse("the quay is closed")


@tool
async def pilot(harbour: str, cx: ToolContext) -> str:
    """Report the tide for a pilot."""
    result = await cx.tools.call("tide", {"harbour": harbour})
    return "Pilot: " + result.text()


def count(path: Path) -> int:
    try:
        return int(path.read_text())
    except (FileNotFoundError, ValueError):
        return 0


def _counter(r: Registrar) -> None:
    path_value = r.config().get("path")
    if not isinstance(path_value, str) or not Path(path_value).is_absolute():
        raise AgentError(ErrorCode.INVALID_PARAMS, "counter needs an absolute config path")
    path = Path(path_value)

    @tool
    async def bump(cx: ToolContext, hold: bool = False, note: str | None = None) -> str:
        """Add one to a count kept in a file.

        Args:
            hold: Wait after counting until cancelled, so a crash lands after the effect.
        """
        value = str(count(path) + 1)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(value)
        temporary.replace(path)
        if hold:
            await cx.cancelled.wait()
        return value

    r.tool(bump)


def _gate(payload: JsonObject) -> JsonObject | None:
    call = payload.get("call")
    if isinstance(call, dict) and "forbidden" in json.dumps(call.get("input"), ensure_ascii=False):
        return {"refuse": "the gate refused it"}
    return None


def fixture(name: str, *, config: JsonObject | None = None) -> Plugin:
    match name:
        case "tide":
            return Plugin(name, tools=[tide])
        case "confirm":
            return Plugin(name, tools=[confirm])
        case "counter":
            return Plugin(name, setup=_counter, config=config)
        case "quay":
            return Plugin(name, tools=[moor])
        case "pilot":
            return Plugin(name, tools=[pilot])
        case "gate":
            return Plugin(name, hooks={"tool.before": _gate})
        case _:
            raise AgentError(ErrorCode.NOT_FOUND, f"Unknown fixture: {name}")


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python -m modular_agent.fixtures FIXTURE")
    serve(fixture(sys.argv[1]))


if __name__ == "__main__":
    main()

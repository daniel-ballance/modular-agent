import asyncio
from collections.abc import Callable

from modular_agent import Plugin, Registrar, tool
from typing import Any
from modular_agent.testing import over_wire
from modular_agent.testing import test_agent as make_test_agent


def tide_preview(record_end: Callable[[str], None]) -> Plugin:
    def before(call: dict[str, Any]) -> dict[str, Any] | None:
        if call["call"]["name"] != "preview_tide":
            return None
        harbour = call["call"]["input"]["harbour"]
        if harbour == "closed":
            return {"refuse": "That station is closed."}
        if harbour == "old-town":
            return {"change": {"input": {"harbour": "Whitby"}}}
        return None

    def after(call: dict[str, Any]) -> dict[str, Any] | None:
        result = call["result"]
        if call["call"]["name"] == "preview_tide" and result["status"] == "completed":
            text = result["content"][0]["text"]
            return {"change": {"content": [{"type": "text", "text": f"Preview: {text}"}]}}
        return None

    def observe(turn: dict[str, Any]) -> None:
        record_end(turn["outcome"]["kind"])

    def setup(r: Registrar) -> None:
        r.on("turn.before", lambda _: {"add": {"system": "Give the local time."}})
        r.on("turn.before", lambda _: {"add": {"system": "Keep the report short."}}, "last")
        r.on("turn.before", lambda _: {"add": {"system": "Report high tides."}}, "first")
        r.on("tool.before", before)
        r.on("tool.after", after)
        r.on("step.after", lambda _: {"end": "Preview stops after one step."})
        r.on("turn.end", observe)

    return Plugin("tide-preview", setup=setup)


@tool(read_only=True)
async def preview_tide(harbour: str) -> str:
    """Find a high tide."""
    return f"{harbour}: 14:02"


async def test_previews_tides_in_process_and_served() -> None:
    for served in [False, True]:
        ended: asyncio.Queue[str] = asyncio.Queue()
        plugin = tide_preview(ended.put_nowait)
        script = [
            {
                "toolCalls": [
                    {"name": "preview_tide", "input": {"harbour": "old-town"}},
                    {"name": "preview_tide", "input": {"harbour": "closed"}},
                ]
            },
            {"text": "This step must not run."},
        ]
        async with make_test_agent(
            plugins=[over_wire(plugin) if served else plugin],
            tools=[preview_tide],
            script=script,
        ) as agent:
            session = await agent.session()
            turn = await session.prompt("Preview the high tides.")
            completed, refused = turn.tool_results()
            assert completed.status == "completed"
            assert completed.text() == "Preview: Whitby: 14:02"
            assert refused.status == "refused"
            assert "That station is closed." in refused.text()
            assert turn.outcome is not None and turn.outcome.kind == "failed"
            assert "Preview stops after one step." in (turn.outcome.error or "")
            assert not turn.text
            start = next(entry for entry in await session.history() if entry["kind"] == "turnStart")
            assert start["data"]["system"].split() == (
                "Report high tides. Give the local time. Keep the report short.".split()
            )
            assert await asyncio.wait_for(ended.get(), timeout=5) == "failed"

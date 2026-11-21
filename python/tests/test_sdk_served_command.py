"""A command runs in the reopened session's project, not its host's project."""

from pathlib import Path

import pytest

from modular_agent import CommandContext, Plugin, Registrar, create_agent, file_history
from modular_agent.testing import over_wire


@pytest.mark.asyncio
@pytest.mark.parametrize("served", [False, True])
async def test_command_reads_reopened_sessions_project(tmp_path: Path, served: bool) -> None:
    first, second, data = (tmp_path / name for name in ("first", "second", "data"))
    for path in (first, second, data):
        path.mkdir()
    (first / "message").write_text("first")
    (second / "message").write_text("second")
    history = file_history(data)
    async with create_agent(
        project=first, data_dir=data, history=history, durability="kept"
    ) as agent:
        sid = (await agent.session()).id

    async def who(_: str, context: CommandContext) -> str:
        assert context.project == first
        return (await context.environment.read("message")).decode()

    def setup(r: Registrar) -> None:
        r.command("who", "Read the session's message", who)

    plugin = Plugin("who", setup=setup)
    async with create_agent(
        project=second,
        data_dir=data,
        history=history,
        durability="kept",
        plugins=[over_wire(plugin) if served else plugin],
    ) as agent:
        assert await (await agent.open_session(sid)).run_command("/who") == "first"

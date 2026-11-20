import asyncio
import os
import sys
from pathlib import Path

import acp
from acp_fixture import Client, prompt

SERVER = """
import sys
from modular_agent import create_agent, run
from modular_agent.testing import scripted_provider

async def main():
    async with create_agent(
        project=sys.argv[1], plugin_host=True,
        providers=[scripted_provider([{"text": "Hello over ACP."}])],
    ) as agent:
        await agent.serve_acp()

run(main())
"""


async def test_drive_one_acp_prompt(tmp_path: Path) -> None:
    project = str(tmp_path.resolve())
    child = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        SERVER,
        project,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        env={**os.environ, "MODULAR_AGENT_PLUGINS": ""},
    )
    assert child.stdin is not None and child.stdout is not None
    client = Client()
    conn = acp.connect_to_agent(client, child.stdin, child.stdout)
    try:
        async with asyncio.timeout(10):
            await conn.initialize(protocol_version=1)
            session = await conn.new_session(cwd=project, mcp_servers=[])
            reply = await prompt(conn, session.session_id, "Say hello.")
            assert reply.stop_reason == "end_turn"
            text = "".join(
                update.content.text
                for _, update in client.updates
                if isinstance(update, acp.schema.AgentMessageChunk)
                and isinstance(update.content, acp.schema.TextContentBlock)
            )
            assert text == "Hello over ACP."
    finally:
        child.stdin.close()
        try:
            async with asyncio.timeout(5):
                await child.stdin.wait_closed()
                await conn.close()
                await child.wait()
        except TimeoutError:
            child.kill()
            await child.wait()
            raise
    assert child.returncode == 0

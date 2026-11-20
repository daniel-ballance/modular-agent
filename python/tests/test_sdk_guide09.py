import asyncio
import multiprocessing
import os
import secrets
import socket
from pathlib import Path

import pytest

from modular_agent import Agent, create_agent, file_history, http_history, serve_history
from modular_agent.testing import scripted_provider


def serve_store(address: tuple[str, int], store_dir: Path, token_file: Path) -> None:
    serve_history(file_history(store_dir), address=address, token_file=token_file)


async def connect_history(project: Path, data_dir: Path, url: str, token_file: Path) -> Agent:
    return await create_agent(
        project=project,
        data_dir=data_dir,
        durability="kept",
        history=http_history(url, token_file),
        providers=[scripted_provider([{"text": "Whitby."}, {"text": "14:02."}])],
        model="scripted/script",
    )


async def handoff(
    project: Path, writer_dir: Path, reader_dir: Path, url: str, token_file: Path
) -> None:
    async with await connect_history(project, writer_dir, url, token_file) as writer:
        first = await writer.session()
        assert (await first.prompt("Name a harbour.")).text == "Whitby."
        session_id = first.id
    # The writer lease has been released.

    async with await connect_history(project, reader_dir, url, token_file) as reader:
        reopened = await reader.open_session(session_id)
        saved = await reopened.last_turn()
        assert saved is not None and saved.text == "Whitby."
        assert (await reopened.prompt("When is high tide there?")).text == "14:02."
        history = await reopened.history()
        assert [e["actorId"] for e in history if e["kind"] == "input"] == ["user", "user"]


@pytest.mark.loopback
async def test_hands_off_a_session_over_http(tmp_path: Path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    token_file = tmp_path / "token"
    fd = os.open(token_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as token:
        token.write(secrets.token_hex(32) + "\n")

    with socket.socket() as reserved:
        reserved.bind(("127.0.0.1", 0))
        host, port = reserved.getsockname()
    server = multiprocessing.get_context("spawn").Process(
        target=serve_store, args=((host, port), tmp_path / "history", token_file)
    )
    server.start()
    try:
        async with asyncio.timeout(10):
            while True:
                assert server.is_alive(), f"history service exited with {server.exitcode}"
                try:
                    _, client = await asyncio.open_connection(host, port)
                except ConnectionRefusedError:
                    await asyncio.sleep(0.01)
                else:
                    client.close()
                    await client.wait_closed()
                    break
            await handoff(
                project,
                tmp_path / "writer",
                tmp_path / "reader",
                f"http://{host}:{port}",
                token_file,
            )
    finally:
        server.terminate()
        server.join(5)
        if server.is_alive():
            server.kill()
            server.join()
        server.close()

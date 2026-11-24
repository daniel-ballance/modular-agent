"""Kill ma inside a tool. Observe startup through the public SDK, without opening the turn."""

import asyncio
from contextlib import asynccontextmanager, suppress
import json
import os
from pathlib import Path
from secrets import token_hex
import sys

import acp
from httpx2 import AsyncClient, HTTPError
import pytest

from modular_agent import create_agent, file_history
from acp_fixture import Client
from test_sdk_agui import new, prompt

pytestmark = pytest.mark.loopback


@asynccontextmanager
async def ma(root, log, *args, acp=False):
    project, data = root / "project", root / "data"
    with (root / log).open("wb") as stderr:
        proc = await asyncio.create_subprocess_exec(
            str(Path(sys.executable).with_name("ma")),
            "--project",
            str(project),
            *args,
            *(
                ["--acp"]
                if acp
                else [
                    "--agui",
                    "--listen",
                    "127.0.0.1:0",
                    *([] if "--policy" in args else ["--token-file", str(root / "token")]),
                ]
            ),
            env={
                **os.environ,
                "MODULAR_AGENT_DATA_DIR": str(data),
                "MODULAR_AGENT_SCRIPT": str(root / "script"),
                "MODULAR_AGENT_CONFORMANCE": "",
            },
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=stderr,
        )
        try:
            if acp:
                yield proc, None
            else:
                origin = (await proc.stdout.readline()).decode().strip()
                assert origin.startswith("http://"), (root / log).read_text()
                async with AsyncClient(
                    base_url=origin + "/agui/v1/",
                    trust_env=False,
                    headers={"Authorization": "Bearer " + (root / "token").read_text()},
                ) as client:
                    yield proc, client
        finally:
            if proc.returncode is None:
                if acp:
                    proc.stdin.close()
                else:
                    proc.terminate()
            await proc.wait()


async def test_ma_agui_serves_host_reads_without_new_declarations(tmp_path):
    (tmp_path / "project").mkdir()
    (tmp_path / "data").mkdir()
    token = tmp_path / "token"
    token.touch(mode=0o600)
    token.write_text(token_hex(32))
    (tmp_path / "script").write_text(json.dumps([{"text": "Done."}]))
    async with ma(tmp_path, "listener.log") as (_, client):
        discovery = (await client.get(str(client.base_url).rstrip("/"))).json()
        sid = await new(client)
        path = f"threads/{sid}"
        view = (await client.get(path)).json()
        assert view["declaration"] == discovery["declaration"]
        assert not {"runReceipts", "waitCursor"}.intersection(view["declaration"])
        assert view["runReceipts"] == 1
        async with client.stream(
            "GET", path + "/wait-closures", params={"after": view["waitCursor"]}
        ) as stream:
            assert stream.status_code == 200
            result = await client.post("run", json=prompt(sid))
            assert result.status_code == 200 and '"type":"RUN_FINISHED"' in result.text
    async with ma(tmp_path, "restarted.log") as (_, client):
        receipt = await client.get(path + "/run-receipt", params={"runId": "one"})
        assert receipt.json() == {"work": "completed", "terminal": "success"}


@pytest.mark.parametrize(
    "mode,runtime",
    [
        ("flag", "durable"),
        ("global", "transient"),
        ("acp", "durable"),
        ("off", "durable"),
    ],
)
async def test_restart_during_tool_call(tmp_path, mode, runtime):
    root = tmp_path
    project, data = root / "project", root / "data"
    project.mkdir()
    data.mkdir()
    (root / "token").touch(mode=0o600)
    (root / "token").write_text(token_hex(24))
    # Hold the shell after its effect until the test has killed its writer.
    command = "echo started >> effects; while [ ! -e release ]; do sleep 0.05; done"
    (root / "script").write_text(
        json.dumps(
            [
                {
                    "toolCalls": [
                        {"name": "codemode", "input": {"code": f"tools.exec(command={command!r})"}}
                    ]
                },
                {"text": "recovered"},
            ]
        )
    )
    history = file_history(data / "state" / "sessions")
    async with (
        asyncio.timeout(20),
        create_agent(
            project=project, data_dir=data / "state", history=history, durability="kept"
        ) as observer,
    ):
        launch = []
        if mode == "acp":
            policy = root / "policy.json"
            policy.write_text(
                json.dumps(
                    {
                        "actors": [
                            {
                                "clientId": "operator",
                                "tokenFile": "token",
                                "actor": {
                                    "kind": "user",
                                    "id": "user",
                                    "rights": ["watch", "input", "tools", "settings"],
                                },
                            }
                        ]
                    }
                )
            )
            launch = ["--policy", str(policy)]
        async with ma(root, "original", "--runtime", runtime, *launch) as (proc, writer):
            sid = await new(writer)
            active = asyncio.create_task(writer.post("run", json=prompt(sid)))
            try:
                while not (project / "effects").exists():
                    if active.done():
                        pytest.fail((await active).text[-1500:])
                    await asyncio.sleep(0.02)
                if mode == "flag":
                    if sys.platform == "linux":
                        assert (await observer.session_summary(sid))["waiting"]["turn"] == "running"
                    async with ma(root, "held", "--resume-open"):
                        assert (root / "held").read_text().splitlines() == [
                            f"resume-open: skipped {sid}"
                        ]
            finally:
                proc.kill()
                await proc.wait()
                (project / "release").touch()
                with suppress(HTTPError):
                    await active
        summary = await observer.session_summary(sid)
        assert summary["waiting"]["turn"] == "interrupted"
        assert summary["id"] == sid and summary["project"] == str(project) and summary["updatedAt"]
        assert await observer.session_summary("missing") is None
        assert await observer.session_summary(sid, rights=["input"]) is None
        assert await observer.session_summary(sid, scope=lambda _p, _t: False) is None
        if mode == "global":
            (data / "settings.json").write_text('{"resume_open":true}')
            (project / ".modular-agent.json").write_text('{"resume_open":false}')
        elif mode == "off":
            (project / ".modular-agent.json").write_text('{"resume_open":true}')
        args = ["--resume-open"] if mode in {"flag", "acp"} else []
        async with ma(root, "restart", "--runtime", runtime, *args, acp=mode == "acp") as (
            restarted,
            client,
        ):
            if mode == "off":
                assert (root / "restart").read_text() == ""
                # Listing does not start recovery either.
                [thread] = (await client.get("threads")).json()["threads"]
                assert thread["waiting"] == {"turn": "interrupted", "questions": 0, "toolCalls": 0}
                assert (await observer.session_summary(sid))["waiting"]["turn"] == "interrupted"
                assert (await client.get("threads/" + sid)).status_code == 200
            # This reader neither takes a lease nor connects to ma.
            while (await observer.session_summary(sid))["waiting"]["turn"] != "none":
                await asyncio.sleep(0.02)
            if mode != "off":
                assert (root / "restart").read_text().splitlines() == [
                    f"resume-open: resumed {sid}"
                ]
            if mode == "acp":
                conn = acp.connect_to_agent(Client(), restarted.stdin, restarted.stdout)
                try:
                    await conn.initialize(protocol_version=1)
                    await conn.resume_session(cwd=str(project), session_id=sid, mcp_servers=[])
                    [row] = (await conn.list_sessions(cwd=str(project))).sessions
                    assert row.session_id == sid
                finally:
                    await conn.close()
        saved = await observer.open_session(sid)
        [end] = [r for r in await saved.history() if r["kind"] == "turnEnd"]
        assert end["data"]["outcome"]["kind"] == (
            "failed" if runtime == "transient" else "completed"
        )
        if runtime == "durable":
            assert (await saved.last_turn()).text == "recovered"
        assert (project / "effects").read_text() == "started\n"

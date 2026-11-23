"""Kill ma inside a tool. Observe startup through the public SDK, without opening the turn."""

import asyncio
from contextlib import asynccontextmanager, suppress
import json
import os
from pathlib import Path
from secrets import token_hex
import sys

from httpx2 import AsyncClient, HTTPError
import pytest

from modular_agent import create_agent, file_history
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
                else ["--agui", "--listen", "127.0.0.1:0", "--token-file", str(root / "token")]
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
        async with ma(root, "original", "--runtime", runtime) as (proc, writer):
            sid = await new(writer)
            active = asyncio.create_task(writer.post("run", json=prompt(sid)))
            try:
                while not (project / "effects").exists():
                    if active.done():
                        pytest.fail((await active).text[-1500:])
                    await asyncio.sleep(0.02)
                if mode == "flag":
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
        assert (await observer.session_summary(sid))["waiting"]["turn"] == "interrupted"
        if mode == "global":
            (data / "settings.json").write_text('{"resume_open":true}')
            (project / ".modular-agent.json").write_text('{"resume_open":false}')
        elif mode == "off":
            (project / ".modular-agent.json").write_text('{"resume_open":true}')
        args = ["--resume-open"] if mode in {"flag", "acp"} else []
        async with ma(root, "restart", "--runtime", runtime, *args, acp=mode == "acp") as (
            _,
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
        saved = await observer.open_session(sid)
        [end] = [r for r in await saved.history() if r["kind"] == "turnEnd"]
        assert end["data"]["outcome"]["kind"] == (
            "failed" if runtime == "transient" else "completed"
        )
        if runtime == "durable":
            assert (await saved.last_turn()).text == "recovered"
        assert (project / "effects").read_text() == "started\n"

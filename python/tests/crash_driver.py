"""Offline process fixture. Parent tests kill this process at a committed boundary."""

import asyncio
import json
import os
import socket
import sys
from pathlib import Path

from ma_core import content
from ma_durable import Durable
from ma_fake import Fake, call, reply
from ma_runtime import Runtime
from ma_cli import build


def refuse(*args, **kwargs):
    raise AssertionError("Crash fixture must stay offline")


socket.socket.connect = socket.socket.connect_ex = refuse


async def main():
    home, project, kind, phase = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3], sys.argv[4]
    runtime = Durable() if kind == "durable" else Runtime()
    (project / "facts").write_text("fact")
    calls = [
        call("write", path="written", text="once"),
        call("read", path="facts"),
        call(
            "bash",
            command="echo attempt >> bash-attempts; if test ! -f resume; then echo $$ > running.pid; setsid sleep 90 & echo $! > escaped.pid; wait; else printf recovered; fi",
        ),
        call("write", path="never", text="ran"),
    ]
    # A step end needs no tool effects. Keep the Runtime placement but don't
    # start unrelated process workers on the checkpoint's critical path.
    processes = None
    if phase == "step_end":
        placement = os.environ.get("MA_PLUGIN_PROCESSES", "").split(",")
        processes = ["runtime"] if {"all", "runtime", runtime.name}.intersection(placement) else []
    script = [reply("continued")]
    if phase not in {"step_end", "reopen"}:
        script.insert(0, reply(calls=calls))
    fake = Fake(script)
    h = await build(home, fake, runtime=runtime, process_plugins=processes)
    a = h.api()
    paused = False

    async def pause():
        nonlocal paused
        if paused:
            return
        paused = True
        (project / "checkpoint").write_text(phase)
        await asyncio.Event().wait()

    async def follow(event):
        if event["kind"] == "history_entry" and event["entry"]["kind"] == phase:
            await pause()

    a.follow("fixture", follow)
    environment = h.plugins["local"]
    original = environment.read

    async def read(d, emit):
        if d["path"] != "facts":
            return await original(d, emit)
        count = project / "read-count"
        count.write_text(str(int(count.read_text()) + 1) if count.exists() else "1")
        answer = await original(d, emit)
        if phase == "read_effect":
            await pause()
        return answer

    environment.read = read
    original_write = environment.write

    async def write(d, emit):
        log = project / "write-log"
        with log.open("a") as file:
            file.write(d["path"] + "\n")
        return await original_write(d, emit)

    environment.write = write
    try:
        if phase == "reopen":
            (project / "resume").touch()
            sid = (project / "session").read_text()
            await a.session("open", session=sid)
            results = await a.call("runtime", "wait", {"session": sid})
            (project / "recovered.json").write_text(
                json.dumps(
                    {
                        "results": results,
                        "entries": (await a.session("get", session=sid))["entries"],
                        "requests": fake.requests,
                    }
                )
            )
        else:
            s = await a.session("create", project=str(project), settings={"model": "fake"})
            (project / "session").write_text(s["id"])
            await a.call("runtime", "submit", {"session": s["id"], "content": content("go")})
            await a.call("runtime", "wait", {"session": s["id"]})
    finally:
        await h.stop()


asyncio.run(main())

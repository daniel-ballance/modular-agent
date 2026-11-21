"""Local commands with a process-group supervisor on macOS."""

import asyncio
import codecs
import os
import signal
import subprocess
import sys
import tempfile

from ma_core import AgentError, Plugin

from . import Local
from .points import Points


class DarwinLocal(Local):
    declarations = {
        **Local.declarations,
        "containment": "processGroup",
        "platforms": ["darwin"],
        "platform": "macOS process group with lifetime supervisor",
        # This flag is used as evidence of strong containment during recovery.
        "stops_commands_on_crash": False,
    }

    async def start(self, api):
        await Plugin.start(self, api)
        api.provide("environment", self)
        api.on("session.end", self._close)
        api.on("session.suspend", self._close)

    async def _close(self, d):
        session = d["session"]
        if isinstance(self.points, Points):
            self.points.close(session)
        # All groups begin their grace period together, not one per command.
        results = await asyncio.gather(
            *(self._stop_command(item) for item in self.commands.pop(session, [])),
            return_exceptions=True,
        )
        for result in results:
            if isinstance(result, BaseException):
                raise result

    async def _stop_command(self, item):
        process, lifetime = item
        if lifetime is not None:
            item[1] = None
            os.close(lifetime)
        try:
            result = await asyncio.wait_for(asyncio.to_thread(process.wait), 4)
        except TimeoutError as exc:
            raise AgentError("Command group cleanup not confirmed", "lost") from exc
        if result != -signal.SIGKILL:
            raise AgentError("Command supervisor died; cleanup not confirmed", "lost")

    async def bash(self, d, emit):
        session = d["session"]
        s = await self.api.session("get", session=session)
        with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as status_file:
            lifetime_read, lifetime = os.pipe()
            try:
                process = subprocess.Popen(
                    [
                        sys.executable,
                        "-m",
                        "ma_local.darwin_worker",
                        str(lifetime_read),
                        d.get("cwd") or s["project"],
                        d["command"],
                    ],
                    pass_fds=(lifetime_read,),
                    start_new_session=True,
                    stdin=subprocess.DEVNULL,
                    stdout=output,
                    stderr=status_file,
                )
            except BaseException:
                os.close(lifetime)
                raise
            finally:
                os.close(lifetime_read)
            item = [process, lifetime]
            self.commands.setdefault(session, []).append(item)
            offset = 0
            pieces = []
            decode = codecs.getincrementaldecoder("utf-8")(errors="replace")

            async def drain(final=False):
                nonlocal offset
                # At a result boundary do not wait for background writers to stop.
                end = os.fstat(output.fileno()).st_size
                while offset < end:
                    data = os.pread(output.fileno(), min(65536, end - offset), offset)
                    if not data:
                        break
                    offset += len(data)
                    if text := decode.decode(data):
                        pieces.append(text)
                        await emit({"text": text})
                if final and (text := decode.decode(b"", final=True)):
                    pieces.append(text)
                    await emit({"text": text})

            try:
                async with asyncio.timeout(d.get("timeout", 120)):
                    while True:
                        await drain()
                        line = os.pread(status_file.fileno(), 64, 0)
                        if line.endswith(b"\n"):
                            break
                        if process.poll() is not None:
                            raise AgentError("Command supervisor died; environment lost", "lost")
                        await asyncio.sleep(0.01)
                    code = int(line)
                    await drain(final=True)
            except BaseException:
                try:
                    await self._stop_command(item)
                finally:
                    remaining = self.commands.get(session, [])
                    if item in remaining:
                        remaining.remove(item)
                raise
            return {"text": "".join(pieces), "exit_code": code if code >= 0 else None}

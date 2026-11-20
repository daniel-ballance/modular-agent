"""Local working environment with kernel-contained command lifetimes."""

import asyncio
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from ma_core import AgentError, Plugin, identity

from .containment import cleanup, delegated_root, journal, owner_identity, recover
from .git_points import GitPoints
from .points import Points


class Local(Plugin):
    name = "local"
    role = "environment"
    declarations = {
        "point_preflight": True,
        "rewind": True,
        "stops_commands_on_crash": True,
        "normal_shutdown_cleanup": True,
        "containment": "strong",
        "confines_files": False,
        "platform": "Linux cgroup v2 with delegated subtree",
    }

    def __init__(self, root=None, *, point_store="copy"):
        self.root = Path(root or Path.home() / ".local/state/modular-agent-py") / "commands"
        self.commands = {}
        self.points = GitPoints(self.root.parent) if point_store == "git" else Points(self.root)

    def keeps_points(self, project):
        return not isinstance(self.points, GitPoints) or self.points.keeps_points(project)

    async def start(self, api):
        await super().start(api)
        await recover(self.root)
        api.provide("environment", self)
        api.on("session.end", self._close)
        api.on("session.suspend", self._close)

    async def save(self, d, emit):
        s = await self.api.session("get", session=d["session"])
        return self.points.save(d["session"], d.get("cwd") or s["project"])

    async def check_point(self, d, emit):
        s = await self.api.session("get", session=d["session"])
        return {
            "exists": self.points.exists(d["session"], d.get("cwd") or s["project"], d["point"])
        }

    async def restore(self, d, emit):
        s = await self.api.session("get", session=d["session"])
        return self.points.restore(d["session"], d.get("cwd") or s["project"], d["point"])

    async def _path(self, d):
        s = await self.api.session("get", session=d["session"])
        p = Path(d["path"]).expanduser()
        return p if p.is_absolute() else Path(d.get("cwd") or s["project"]) / p

    async def list_directory(self, d, emit):
        try:
            path = await self._path(d)
            return {
                "entries": [
                    {
                        "name": item.name,
                        "kind": "other"
                        if item.is_symlink()
                        else "directory"
                        if item.is_dir()
                        else "file"
                        if item.is_file()
                        else "other",
                    }
                    for item in sorted(path.iterdir())
                ]
            }
        except FileNotFoundError as exc:
            raise AgentError(str(exc), "not_found") from exc
        except (NotADirectoryError, PermissionError, ValueError) as exc:
            raise AgentError(str(exc), "invalid_request") from exc
        except OSError as exc:
            raise AgentError(str(exc), "internal") from exc

    async def read_bytes(self, d, emit):
        import base64

        try:
            return {"data": base64.b64encode((await self._path(d)).read_bytes()).decode()}
        except FileNotFoundError as exc:
            raise AgentError(str(exc), "not_found") from exc

    async def write_bytes(self, d, emit):
        import base64

        path = await self._path(d)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(base64.b64decode(d["data"], validate=True))
        return {}

    async def exists(self, d, emit):
        return {"exists": (await self._path(d)).exists()}

    async def read(self, d, emit):
        try:
            return (await self._path(d)).read_text()
        except FileNotFoundError as exc:
            raise AgentError(str(exc), "not_found") from exc
        except OSError as exc:
            raise AgentError(str(exc)) from exc

    async def write(self, d, emit):
        p = await self._path(d)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(d["text"])
        return {"bytes": len(d["text"].encode())}

    async def edit(self, d, emit):
        p = await self._path(d)
        old = p.read_text()
        matches = []
        for e in d["edits"]:
            if not e["old"] or old.count(e["old"]) != 1:
                raise AgentError("Each old text must occur exactly once")
            start = old.index(e["old"])
            matches.append((start, start + len(e["old"]), e["new"]))
        matches.sort()
        if any(a[1] > b[0] for a, b in zip(matches, matches[1:])):
            raise AgentError("Edits overlap")
        result = old
        for start, end, new in matches[::-1]:
            result = result[:start] + new + result[end:]
        p.write_text(result)
        return {"edits": len(matches)}

    async def _stop_command(self, item):
        process, lifetime, record = item
        if lifetime is not None:
            os.close(lifetime)
            item[1] = None
        # Do not block the event loop while the watcher kills and reaps children.
        try:
            await asyncio.wait_for(asyncio.to_thread(process.wait), 5)
        except TimeoutError:
            process.kill()
            await asyncio.to_thread(process.wait)
        await cleanup(record)

    async def bash(self, d, emit):
        s = await self.api.session("get", session=d["session"])
        owner = owner_identity()
        group = delegated_root() / f"ma-py-{owner['pid']}-{owner['start']}-{identity()}"
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        record = self.root / (group.name + ".json")
        # Persist the planned group before creating it. A crash between these
        # operations leaves either a harmless manifest or a recoverable group.
        journal(record, {"group": str(group), "owner": owner})
        try:
            group.mkdir()
            if not os.access(group / "cgroup.kill", os.W_OK):
                raise AgentError(
                    "Delegated cgroup lacks cgroup.kill permission", "environment_lost"
                )
        except BaseException:
            await cleanup(record)
            raise
        with tempfile.TemporaryFile() as output:
            read_fd, lifetime = os.pipe()
            try:
                process = subprocess.Popen(
                    [
                        sys.executable,
                        "-m",
                        "ma_local.worker",
                        str(record),
                        str(read_fd),
                        str(output.fileno()),
                        d.get("cwd") or s["project"],
                        d["command"],
                    ],
                    pass_fds=(read_fd, output.fileno()),
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            except BaseException:
                os.close(lifetime)
                await cleanup(record)
                raise
            finally:
                os.close(read_fd)
            item = [process, lifetime, record]
            self.commands.setdefault(d["session"], []).append(item)
            offset, pieces = 0, []

            async def read_output():
                nonlocal offset
                data = os.pread(output.fileno(), 65536, offset)
                while data:
                    offset += len(data)
                    pieces.append(data)
                    await emit({"text": data.decode(errors="replace")})
                    data = os.pread(output.fileno(), 65536, offset)

            try:
                async with asyncio.timeout(d.get("timeout", 120)):
                    result_path = record.with_suffix(".result")
                    while not result_path.exists():
                        await read_output()
                        if process.poll() is not None:
                            # The result may have been committed just before exit.
                            if not result_path.exists():
                                raise AgentError(
                                    "Command supervisor died; environment lost", "environment_lost"
                                )
                            break
                        await asyncio.sleep(0.01)
                    await read_output()
                    result = json.loads(result_path.read_text())
                    result_path.unlink(missing_ok=True)
            except BaseException:
                await self._stop_command(item)
                remaining = self.commands.get(d["session"], [])
                if item in remaining:
                    remaining.remove(item)
                raise
            return {"text": b"".join(pieces).decode(errors="replace"), **result}

    async def _close(self, d):
        if isinstance(self.points, Points):
            self.points.close(d["session"])
        for item in self.commands.pop(d["session"], []):
            await self._stop_command(item)

    async def stop(self):
        sessions = set(self.commands)
        if isinstance(self.points, Points):
            sessions.update(item[0] for item in self.points.saved.values())
        for sid in sessions:
            await self._close({"session": sid})


class ProcessGroupLocal(Local):
    """Local files with process-group containment when cgroup delegation is absent."""

    declarations = {
        **Local.declarations,
        "containment": "processGroup",
        "platform": "POSIX process group with lifetime supervisor",
        "stops_commands_on_crash": False,
    }

    async def start(self, api):
        await Plugin.start(self, api)
        api.provide("environment", self)
        api.on("session.end", self._close)
        api.on("session.suspend", self._close)

    async def bash(self, d, emit):
        s = await self.api.session("get", session=d["session"])
        read_fd, lifetime = os.pipe()
        with tempfile.TemporaryFile() as output:
            try:
                process = await asyncio.create_subprocess_exec(
                    sys.executable,
                    "-m",
                    "ma_local.group_worker",
                    str(read_fd),
                    d.get("cwd") or s["project"],
                    d["command"],
                    pass_fds=(read_fd,),
                    stdout=output,
                    stderr=asyncio.subprocess.PIPE,
                    stdin=asyncio.subprocess.DEVNULL,
                )
            except BaseException:
                os.close(lifetime)
                raise
            finally:
                os.close(read_fd)
            offset = 0
            timed_out = False
            try:
                async with asyncio.timeout(d.get("timeout")):
                    while process.returncode is None:
                        if data := os.pread(output.fileno(), 65536, offset):
                            offset += len(data)
                            await emit({"text": data.decode(errors="replace")})
                        else:
                            await asyncio.sleep(0.02)
            except TimeoutError:
                timed_out = True
            finally:
                os.close(lifetime)
                _, status = await process.communicate()
            output.seek(0)
            text = output.read().decode(errors="replace")
            if pending := text.encode()[offset:]:
                await emit({"text": pending.decode(errors="replace")})
            if process.returncode or not status.strip():
                raise AgentError("Command supervisor died; environment lost", "environment_lost")
            return {"text": text, "exit_code": int(status), "timed_out": timed_out}

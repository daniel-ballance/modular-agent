"""Measure one ACP tool turn, not plugin startup, history setup or shutdown.

cd python && uv run --offline python scripts/plugin_traffic.py > traffic.jsonl

process: the base ACP kit's --process-plugins all (private Python workers).
wire: a Runtime, Provider and tool source on modular-agent-plugin/1 stdio.
local: the same ACP prompt, Provider directive and read tool, in process.
All three use disposable SQLite history and an offline conformance Provider.
"""

import argparse
import asyncio
import json
import os
import sys
import time
from collections import defaultdict
from contextlib import ExitStack
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from acp.schema import TextContentBlock

from ma_acp import ACP
from ma_cli import build
from ma_core import content, identity, now, plain
from ma_fake import Fake
from ma_plugin.host import External, load_plugins
from ma_process import ProcessPlugin


class Sink:
    async def session_update(self, **kwargs):
        pass

    async def ext_notification(self, method, params):
        pass


class Prompt(ACP):
    # Enter the actual ACP handlers without including the ACP transport or a
    # terminal in the measurement. The private worker needs JSON arguments.
    async def open_project(self):
        self.client = Sink()
        await self.initialize(1)
        return (await self.new_session(self.project, [])).session_id

    async def read_file(self, sid):
        result = await self.prompt(sid, [TextContentBlock(text='tool:read {"path":"note"}')])
        return result.field_meta["modular-agent"]["outcome"]


async def seed(h, sid, count):
    # Build an ordinary linked branch in one store batch, outside the timed
    # region. Mix model-visible text with records that never belong in a model
    # request. Keep the text and fraction visible fixed as history grows.
    await h.api().session("append", session=sid, kind="setting", data={"approval": "off"})
    s = h.sessions[sid]
    batch, parent = [], s["position"]
    for i in range(len(s["entries"]), count):
        visible = i % 10 == 0
        batch.append(
            {
                "id": identity(),
                "parent": parent,
                "session": sid,
                "time": now(),
                "writer": "bench",
                "kind": "bench.note",
                "visible": visible,
                "content": content(f"Earlier note {i}") if visible else [],
                "copies": [],
                "data": {} if visible else {"note": "x" * 128},
            }
        )
        parent = batch[-1]["id"]
    if batch:
        await h._keep({**s, "entries": [*s["entries"], *batch], "position": parent}, batch)
    assert len(h.sessions[sid]["entries"]) == count


def capture(h, stack):
    # Save the bytes the host actually sends and receives. Decode after the
    # clock stops. feed_data chunks can split a frame or contain several.
    streams = {}
    for plugin in h.plugins.values():
        if not isinstance(plugin, (ProcessPlugin, External)):
            continue
        private = isinstance(plugin, ProcessPlugin)
        name = plugin.name if private else plugin.registration["name"]
        for direction, obj, attr in [
            ("out", plugin.peer.writer, "write"),
            ("in", plugin.peer.reader, "feed_data"),
        ]:
            chunks = streams[name, private, direction] = []
            original = getattr(obj, attr)

            def tap(raw, original=original, chunks=chunks):
                chunks.append(raw)
                return original(raw)

            stack.enter_context(patch.object(obj, attr, tap))
    return streams


def frames(raw, private):
    if not private:
        for line in raw.splitlines(keepends=True):
            yield json.loads(line), len(line)
        return
    pos = 0
    while pos < len(raw):
        end = pos + 4 + int.from_bytes(raw[pos : pos + 4], "big")
        assert end <= len(raw)
        yield json.loads(raw[pos + 4 : end]), end - pos
        pos = end


def summarize(streams, registered):
    # IDs are scoped to both the connection and the requesting direction.
    requests, answers = {}, []
    totals = defaultdict(lambda: {"out": 0, "in": 0, "frames": 0})
    for (plugin, private, direction), chunks in streams.items():
        for msg, size in frames(b"".join(chunks), private):
            other = "in" if direction == "out" else "out"
            ident = msg.get("id")
            if (private and msg["kind"] == "answer") or "result" in msg or "error" in msg:
                answers.append(((plugin, other, ident), direction, size))
                continue
            if private:
                op, d = msg["operation"], msg["data"]
                method = {
                    "invoke": d.get("method") or registered.get((plugin, d.get("key")), "emit"),
                    "call": f"{d.get('target')}/{d.get('operation')}",
                    "hook": d.get("name"),
                }.get(op, op)
            else:
                method = msg["method"]
                if method in ("host/hook", "host/runtime/hook", "hook/handle"):
                    method += ":" + msg["params"]["hook"]
            name = f"{plugin} {method}"
            if ident is not None:
                requests[plugin, direction, ident] = name
            totals[name][direction] += size
            totals[name]["frames"] += 1
    for key, direction, size in answers:
        row = totals[requests[key]]
        row[direction] += size
        row["frames"] += 1
    return dict(sorted(totals.items()))


async def measure(root, placement, count):
    project = root / "project"
    project.mkdir(parents=True)
    (project / "note").write_text("benchmark file")
    home = root / "state"
    h = await build(
        home, Fake(), project=project, process_plugins="all" if placement == "process" else ""
    )
    try:
        if placement == "wire":
            command = [str(Path(sys.executable).with_name("modular-agent-plugin"))]
            await load_plugins(
                h,
                [
                    {"command": command, "env": {"MODULAR_AGENT_PLUGIN_PARTS": part}}
                    for part in ("runtime", "provider", "tools")
                ],
                project,
                home,
            )
        await h.load(Prompt(project, {"model": "conformance/echo"}))
        interface = h.plugins["acp"]
        sid = await interface.open_project()
        await seed(h, sid, count)
        with ExitStack() as stack:
            streams = capture(h, stack)
            start = time.perf_counter()
            outcome = await interface.read_file(sid)
            elapsed = time.perf_counter() - start
        assert outcome["kind"] == "completed", outcome
        turn = h.sessions[sid]["entries"][count:]
        results = [e for e in turn if e["kind"] == "tool_result"]
        assert len(results) == 1 and plain(results[0]["content"]) == "benchmark file"
        assert sum(e["kind"] == "response" for e in turn) == 2
        return elapsed, streams
    finally:
        await h.stop()


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sizes", nargs="+", type=int, default=[10, 100, 1000])
    parser.add_argument(
        "--placements",
        nargs="+",
        choices=["local", "process", "wire"],
        default=["local", "process", "wire"],
    )
    args = parser.parse_args()
    # Do not pick up a login, a remote store, project settings or an injected
    # plugin. All children inherit this offline environment.
    for key in list(os.environ):
        if key not in {"PATH", "TMPDIR", "LANG", "SYSTEMROOT"}:
            del os.environ[key]
    with TemporaryDirectory(prefix="plugin-traffic-") as scratch:
        os.environ.update(HOME=scratch, MODULAR_AGENT_CONFORMANCE="1", MA_OFFLINE_TEST="1")
        for count in args.sizes:
            for placement in args.placements:
                registered = {}
                dispatch = ProcessPlugin.dispatch

                async def register(plugin, operation, data):
                    if operation == "register" and "key" in data:
                        registered[plugin.name, data["key"]] = data.get("name") or data["kind"]
                    return await dispatch(plugin, operation, data)

                with patch.object(ProcessPlugin, "dispatch", register):
                    elapsed, streams = await measure(
                        Path(scratch) / f"{placement}-{count}", placement, count
                    )
                rows = summarize(streams, registered)
                print(
                    json.dumps(
                        {
                            "entries": count,
                            "placement": placement,
                            "seconds": round(elapsed, 4),
                            "bytes": sum(r["out"] + r["in"] for r in rows.values()),
                            "frames": sum(r["frames"] for r in rows.values()),
                            "methods": rows,
                        }
                    ),
                    flush=True,
                )


if __name__ == "__main__":
    asyncio.run(main())

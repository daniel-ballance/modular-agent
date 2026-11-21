"""Milestone 5 black-box proofs. No inference, no process-local stand-in services."""

import asyncio
import json
import os
import signal
import sys
from pathlib import Path

import pytest

from ma_core import AgentError, Plugin, Stop, content, plain
from ma_fake import Fake, call, reply
from ma_harness import Harness
from ma_process import ProcessPlugin
from ma_cli import build
from test_swap import dead, pid_ready, until
from test_vanilla import entries, paired, run


class Streaming(Fake):
    async def generate(self, d, emit):
        for text in [f"provider-pid={os.getpid()} α ", "SEC", "RET"]:
            await emit({"text": text})
        return reply(f"provider-pid={os.getpid()} α SECRET")


@pytest.mark.skipif(sys.platform != "linux", reason="checks plugin parentage in Linux /proc")
async def test_only_harness_local_all_plugins_moved_stream_and_gate(tmp_path, runtime_type):
    h = await build(
        tmp_path / "store",
        Streaming(),
        secrets=["SECRET"],
        runtime=runtime_type(),
        process_plugins="all",
    )
    pids = [p.pid for p in h.plugins.values()]
    observed = []
    early = []
    try:
        assert all(isinstance(p, ProcessPlugin) for p in h.plugins.values())
        assert len(set(pids)) == len(pids) and os.getpid() not in pids
        for pid in pids:
            assert (
                int(Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[1])
                == os.getpid()
            )
        a = h.api()
        sid = (await a.session("create", project=str(tmp_path), settings={"model": "fake"}))["id"]

        async def follow(event):
            observed.append(event)
            if event["kind"] == "model_output" and event.get("text"):
                early.append(not bool(await entries(a, sid, "response")))

        a.follow("proof", follow)
        result = await run(a, sid)
        assert result[-1]["outcome"] == "completed"
        expected = f"provider-pid={h.plugins['fake'].pid} α SECRET"
        assert plain((await entries(a, sid, "response"))[0]["content"]) == expected
        assert early and all(early), "output arrived only after the complete response"
        assert "SECRET" not in json.dumps(observed)
        assert str(h.plugins["fake"].pid) in json.dumps(observed)
        assert not any(
            target == "credentials" and caller == h.capabilities["runtime"][0]
            for caller, target, _ in h.trace
        )
    finally:
        await h.stop()
    assert all(not Path(f"/proc/{pid}").exists() for pid in pids)


@pytest.mark.skipif(
    sys.platform != "linux", reason="checks containment of processes that use Linux setsid"
)
async def test_cancel_turn_joins_bash_two_processes_away(tmp_path, runtime_type):
    command = "echo $$ > shell.pid; setsid sleep 90 & echo $! > escaped.pid; printf live; wait"
    h = await build(
        tmp_path / "store",
        Fake([reply(calls=[call("bash", command=command)])]),
        runtime=runtime_type(),
        process_plugins="runtime,files,local,mcp",
    )
    try:
        a = h.api()
        sid = (await a.session("create", project=str(tmp_path), settings={"model": "fake"}))["id"]
        workers = [h.plugins[n].pid for n in (h.capabilities["runtime"][0], "files", "local")]
        assert len(set(workers)) == 3 and os.getpid() not in workers
        events = []
        a.follow("proof", lambda e: collect(events, e))
        await a.call("runtime", "submit", {"session": sid, "content": content("go")})
        await until(lambda: pid_ready(tmp_path / "escaped.pid"))
        shell, escaped = [int((tmp_path / p).read_text()) for p in ("shell.pid", "escaped.pid")]
        await until(
            lambda: any(e["kind"] == "tool_progress" and e.get("text") == "live" for e in events)
        )
        await a.call("runtime", "cancel", {"session": sid})
        assert dead(shell) and dead(escaped)
        assert (await entries(a, sid, "tool_result"))[0]["data"]["status"] == "cancelled"
        assert (await entries(a, sid, "turn_end"))[-1]["data"]["outcome"] == "cancelled"
        assert not list((tmp_path / "store/commands").glob("*.json"))
        paired(await entries(a, sid))
    finally:
        await h.stop()


async def collect(values, value):
    values.append(value)


class BlockingTools(Plugin):
    name = "blocker"
    role = "tool_source"

    async def start(self, api):
        await super().start(api)
        api.provide("blocker", self)
        api.on("tools.list", self.definitions)

    async def definitions(self, d):
        return [
            {
                "name": "block",
                "description": "Wait for interruption",
                "schema": {"type": "object"},
                "hints": {"safe_to_repeat": False},
                "parallel": False,
                "callers": ["model", "interface", "plugin"],
                "target": "blocker",
            }
        ]

    async def run(self, d, emit):
        await emit({"started_in": os.getpid(), "text": f"started:{os.getpid()}"})
        await asyncio.Event().wait()


async def test_plugin_death_fails_all_waiters_turn_continues_harness_reports(
    tmp_path, runtime_type
):
    h = await build(
        tmp_path / "store",
        Fake([reply(calls=[call("block")]), reply("continued")]),
        runtime=runtime_type(),
        process_plugins="runtime,files,local,mcp",
    )
    await h.load(BlockingTools(), process=True)
    events, started = [], []
    extra = None
    try:
        a = h.api()
        sid = (await a.session("create", project=str(tmp_path), settings={"model": "fake"}))["id"]
        a.follow("proof", lambda e: collect(events, e))
        await a.call("runtime", "submit", {"session": sid, "content": content("go")})
        await until(
            lambda: any(
                e["kind"] == "tool_progress" and e.get("text", "").startswith("started:")
                for e in events
            )
        )
        extra = asyncio.create_task(
            a.call("blocker", "run", {"session": sid}, lambda e: collect(started, e))
        )
        await until(lambda: bool(started))
        pid = h.plugins["blocker"].pid
        assert started[0]["started_in"] == pid
        os.kill(pid, signal.SIGKILL)
        with pytest.raises(AgentError, match="blocker.*disconnected") as exc:
            await asyncio.wait_for(extra, 5)
        assert exc.value.code == "process_lost"
        result = await asyncio.wait_for(a.call("runtime", "wait", {"session": sid}), 5)
        assert result[-1]["outcome"] == "completed"
        assert plain(result[-1]["content"]) == "continued"
        tools = await entries(a, sid, "tool_result")
        assert len(tools) == 1 and tools[0]["data"]["status"] == "outcome_unknown"
        assert "Check outside state" in plain(tools[0]["content"])
        await until(lambda: any(e["kind"] == "plugin_failed" for e in events))
        failures = [e for e in events if e["kind"] == "plugin_failed"]
        assert len(failures) == 1 and failures[0]["plugin"] == "blocker"
        assert failures[0]["session"] == sid and failures[0]["pid"] == pid
        assert (await a.session("declaration", session=sid))["blocker"]["available"] is False
        paired(await entries(a, sid))
    finally:
        if extra is not None:
            await asyncio.gather(extra, return_exceptions=True)
        await h.stop()


class Extensible(Plugin):
    name = "extensible"

    async def start(self, api):
        await super().start(api)
        api.provide("example", self)
        api.define_hook("example.changed", "transform")
        api.command("example", "Reentrant example", self.command)

    async def echo(self, d, emit):
        await emit({"pid": os.getpid(), "text": d["text"]})
        return await self.api.hook("example.changed", d)

    async def command(self, d):
        return await self.api.call("example", "echo", {"text": d["args"]})


class Interceptor(Plugin):
    name = "interceptor"

    async def start(self, api):
        await super().start(api)
        api.on("example.changed", self.change, "first")

    async def change(self, d):
        return Stop({**d, "changed_by": os.getpid()})


async def test_remote_custom_capability_hook_stop_command_reentrancy_and_large_frames():
    h = Harness(process_plugins="all")
    try:
        await h.load(Extensible())
        await h.load(Interceptor())
        pieces = []
        text = "unicode α\n" * 20000
        result = await h.api().call("example", "echo", {"text": text}, lambda p: collect(pieces, p))
        assert result == {"text": text, "changed_by": h.plugins["interceptor"].pid}
        assert pieces == [{"pid": h.plugins["extensible"].pid, "text": text}]
        with pytest.raises(AgentError, match="owner"):
            await h.api("intruder").hook("example.changed", {})
        sid = (await h.api().session("create", project="/tmp"))["id"]
        result = await h.api().session("command", session=sid, text="/example recursive")
        assert result["text"] == "recursive"
        assert result["changed_by"] == h.plugins["interceptor"].pid
    finally:
        await h.stop()


async def test_concurrent_remote_appends_and_key_admission_are_not_lost(tmp_path, runtime_type):
    h = await build(
        tmp_path / "store", Fake([reply("one")]), runtime=runtime_type(), process_plugins="all"
    )
    try:
        a = h.api()
        sid = (await a.session("create", project=str(tmp_path), settings={"model": "fake"}))["id"]
        await asyncio.gather(
            *(a.session("append", session=sid, kind="proof", data={"i": i}) for i in range(30))
        )
        es = await entries(a, sid)
        proof = [e for e in es if e["kind"] == "proof"]
        assert len(proof) == 30
        assert len({e["id"] for e in es}) == len(es)
        assert {e["data"]["i"] for e in proof} == set(range(30))
        assert [e["parent"] for e in es] == [None, *[e["id"] for e in es[:-1]]]
        admissions = await asyncio.gather(
            *(
                a.call(
                    "runtime", "submit", {"session": sid, "key": "once", "content": content("go")}
                )
                for _ in range(12)
            )
        )
        assert sum(not a["duplicate"] for a in admissions) == 1
        await a.call("runtime", "wait", {"session": sid})
        assert len(await entries(a, sid, "input")) == 1
        await a.session("close", session=sid)
        await a.session("open", session=sid)
        assert len(await entries(a, sid, "proof")) == 30
    finally:
        await h.stop()


class BadStart(Plugin):
    name = "bad"

    async def start(self, api):
        await super().start(api)
        api.provide("partial", self)
        raise AgentError("deliberate startup failure", "refused")


async def test_remote_start_failure_removes_registrations_and_reaps_child():
    h = Harness(process_plugins="all")
    plugin = ProcessPlugin(BadStart())
    # Explicit wrapper only for PID observation; do not wrap it a second time.
    with pytest.raises(AgentError, match="deliberate startup") as exc:
        await h.load(plugin, process=False)
    assert exc.value.code == "refused"
    assert not h.plugins and not h.capabilities
    assert not Path(f"/proc/{plugin.pid}").exists()
    await h.stop()


async def test_settings_placement_override_without_changing_plugin(tmp_path):
    root = tmp_path / "store"
    root.mkdir()
    (root / "settings.json").write_text(
        json.dumps(
            {
                "plugins": [
                    {
                        "factory": "ma_fake:Fake",
                        "options": {"script": [reply("placed")]},
                        "replaces": "fake",
                        "process": True,
                    }
                ]
            }
        )
    )
    h = await build(root, Fake(), process_plugins="")
    try:
        assert isinstance(h.plugins["fake"], ProcessPlugin)
        assert not isinstance(h.plugins["files"], ProcessPlugin)
        sid = (await h.api().session("create", project=str(tmp_path), settings={"model": "fake"}))[
            "id"
        ]
        assert plain((await run(h.api(), sid))[-1]["content"]) == "placed"
    finally:
        await h.stop()


async def test_cli_all_plugins_including_terminal_moved(tmp_path):
    script = tmp_path / "script.json"
    script.write_text(json.dumps([{**reply("CLI proof"), "pieces": ["CLI ", "proof"]}]))
    p = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "modular_agent",
        "--home",
        str(tmp_path / "store"),
        "--project",
        str(tmp_path),
        "--process-plugins",
        "all",
        "--fake-script",
        str(script),
        "--mode",
        "json",
        "-p",
        "go",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(p.communicate(), 20)
        assert p.returncode == 0, err.decode()
        events = [json.loads(line) for line in out.decode().splitlines()]
        assert any(e.get("kind") == "model_output" and e.get("text") == "CLI " for e in events)
        assert any(e.get("kind") == "turn_ended" and e["outcome"] == "completed" for e in events)
    finally:
        if p.returncode is None:
            p.kill()
            await p.wait()

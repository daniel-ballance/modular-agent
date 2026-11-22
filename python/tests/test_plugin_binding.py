"""Public stage 1 wire and Harness seams, as required by the binding assignment."""

import asyncio
import json
import os
from pathlib import Path

import pytest

from ma_core import AgentError, content
from ma_core.wire import entry_out

from ma_fake import Fake, call, reply
from ma_cli import build
from test_swap import dead, pid_ready, until

ROOT = Path(__file__).resolve().parents[1]
SERVE = [str(ROOT / ".venv/bin/modular-agent-plugin")]


async def run_kit(path, *args, env=None):
    process = await asyncio.create_subprocess_exec(
        "node",
        str(ROOT / path),
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        env={**os.environ, **(env or {})},
    )
    try:
        async with asyncio.timeout(120):
            output = (await process.communicate())[0].decode()
        assert process.returncode == 0, output
        return output
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


def split_plugins():
    return json.dumps(
        [
            {"command": SERVE, "env": {"MODULAR_AGENT_PLUGIN_PARTS": "provider,hooks"}},
            {"command": SERVE, "env": {"MODULAR_AGENT_PLUGIN_PARTS": "tools,environment"}},
        ]
    )


async def test_agent_hosts_split_plugin_through_acp_kit(runtime_kind):
    output = await run_kit(
        "conformance/acp/run.mjs",
        "--plugin-checks",
        "--",
        str(ROOT / ".venv/bin/modular-agent"),
        "--mode",
        "acp",
        "--runtime",
        runtime_kind,
        env={"MODULAR_AGENT_PLUGINS": split_plugins()},
    )
    assert "checks passed" in output


async def test_external_replacements_remove_local_registrations(
    tmp_path, monkeypatch, runtime_type
):
    monkeypatch.setenv("MODULAR_AGENT_CONFORMANCE", "1")
    monkeypatch.setenv("MODULAR_AGENT_PLUGINS", split_plugins())
    h = await build(tmp_path / "state", Fake(), runtime=runtime_type(), project=tmp_path)
    try:
        assert "local" not in h.plugins
        assert "conformance" not in h.plugins
        assert h.capabilities["environment"][0].startswith("external:")
        assert h.capabilities["conformance"][0].startswith("external:")
        # Ask the local source itself, not only the merged list: no shadowed copies.
        assert set(await h.api().call("tools", "omitted")) == {"bash", "read"}
        definitions = await h.api().call("tools", "definitions")
        for name in ("bash", "read"):
            matches = [t for t in definitions if t["name"] == name]
            assert len(matches) == 1
            assert matches[0]["target"].startswith("external:")
        s = await h.api().session(
            "create",
            project=str(tmp_path),
            settings={"model": "conformance/echo", "approval": "off"},
        )
        additions = await h.api().session("prepare", session=s["id"], turn="test")
        assert {"system": "The conformance plugin is loaded."} in additions
    finally:
        await h.stop()


async def test_shared_plugin_host_callbacks_and_list_refresh(tmp_path, monkeypatch, runtime_type):
    spec = {
        "command": [str(ROOT / ".venv/bin/python"), str(ROOT / "tests/shared_plugin_fixture.py")],
        "config": {"project": str(tmp_path), "hooks": ["output"], "redactProblem": True},
    }
    monkeypatch.setenv("MODULAR_AGENT_PLUGINS", json.dumps([spec]))
    h = await build(tmp_path / "state", Fake(), runtime=runtime_type(), project=tmp_path)
    try:
        sid = (await h.api().session("create", project=str(tmp_path), settings={"model": "fake"}))[
            "id"
        ]
        diagnostic = asyncio.get_running_loop().create_future()

        async def follow(event):
            if event["kind"] == "plugin_problem" and not diagnostic.done():
                diagnostic.set_result(event["message"])

        h.api().follow("operator", follow)
        async with asyncio.timeout(5):
            result = await h.api().session("command", session=sid, text="/probe callbacks")
            assert await diagnostic == "gated diagnostic"
        value = json.loads(result["output"])
        assert value["binary"] == {"data": "AP+A"}
        assert value["exists"] == {"exists": True}
        assert value["exec"]["output"] == "CALLBACK"
        assert value["timed"] == {"exitCode": None, "output": "BEFORE", "timedOut": True}
        assert value["credential"] == {"credential": None}
        assert value["question"]["declined"]
        assert value["foreign"] == "invalid_request"
        assert value["denied"] == ["invalid_request"] * 3
        assert not (tmp_path / "forbidden").exists()
        async with asyncio.timeout(5):
            await h.api().session("command", session=sid, text="/probe change")
        definitions = await h.api().call("tools", "definitions", {"session": sid})
        assert "added" in [t["name"] for t in definitions]
    finally:
        await h.stop()


async def test_shared_hooks_transform_native_operations(tmp_path, monkeypatch, runtime_type):
    spec = {
        "command": [str(ROOT / ".venv/bin/python"), str(ROOT / "tests/shared_plugin_fixture.py")],
        "config": {"hooks": ["step.before", "provider.request", "turn.before", "input"]},
    }
    monkeypatch.setenv("MODULAR_AGENT_PLUGINS", json.dumps([spec]))
    fake = Fake([reply("ok")])
    h = await build(tmp_path / "state", fake, runtime=runtime_type(), project=tmp_path)
    try:
        sid = (await h.api().session("create", project=str(tmp_path), settings={"model": "fake"}))[
            "id"
        ]
        await h.api().call(
            "runtime", "submit", {"session": sid, "content": [{"type": "text", "text": "hello"}]}
        )
        await h.api().call("runtime", "wait", {"session": sid})
        assert "WIRE-STEP" in fake.requests[0]["system"]
        assert "WIRE-PROVIDER" in fake.requests[0]["system"]
        assert any(
            m["content"] == [{"type": "text", "text": "WIRE-CONTEXT"}]
            for m in fake.requests[0]["messages"]
        )
        assert any(
            m["content"] == [{"type": "text", "text": "WIRE-INPUT"}]
            for m in fake.requests[0]["messages"]
        )
    finally:
        await h.stop()


async def test_shared_plugin_loss_settles_unknown_and_stops_nested_command(
    tmp_path, monkeypatch, runtime_type
):
    monkeypatch.setenv(
        "MODULAR_AGENT_PLUGINS",
        json.dumps(
            [
                {
                    "command": [
                        str(ROOT / ".venv/bin/python"),
                        str(ROOT / "tests/shared_plugin_fixture.py"),
                    ],
                    "config": {"project": str(tmp_path)},
                }
            ]
        ),
    )
    fake = Fake(
        [
            reply(calls=[{"id": "lost-call", "name": "probe", "input": {"operation": "die"}}]),
            reply("continued"),
        ]
    )
    h = await build(tmp_path / "state", fake, runtime=runtime_type(), project=tmp_path)
    events = []
    h.api().follow("user", lambda e: collect(events, e))
    try:
        sid = (
            await h.api().session(
                "create", project=str(tmp_path), settings={"model": "fake", "approval": "off"}
            )
        )["id"]
        await h.api().call("runtime", "submit", {"session": sid, "content": content("start")})
        async with asyncio.timeout(10):
            await h.api().call("runtime", "wait", {"session": sid})
        branch = await h.api().session("branch", session=sid)
        results = [e for e in branch if e["kind"] == "tool_result"]
        assert len(results) == 1 and results[0]["data"]["status"] == "outcome_unknown"
        assert [e for e in branch if e["kind"] == "turn_end"][-1]["data"]["outcome"] == "completed"
        assert any(e["kind"] == "plugin_failed" for e in events)
        assert "probe" not in [
            t["name"] for t in await h.api().call("tools", "definitions", {"session": sid})
        ]
        pid = int((tmp_path / "lost-pid").read_text())
        await until(lambda: dead(pid))
    finally:
        await h.stop()


async def collect(values, value):
    values.append(value)


@pytest.mark.parametrize(
    "registration",
    [
        {"providers": [{"id": "fake", "models": []}]},
        {
            "toolSources": [
                {"id": "bad", "tools": [{"name": "bash", "parameters": {"type": "object"}}]}
            ]
        },
        {"commands": [{"name": "model"}]},
        {"workingEnvironment": {"containment": "none", "platforms": ["linux"]}},
        {"hooks": [{"hook": "unknown-hook", "handlerId": 1}]},
    ],
)
async def test_shared_registration_refuses_collisions_and_output_gate(
    tmp_path, monkeypatch, registration
):
    monkeypatch.setenv(
        "MODULAR_AGENT_PLUGINS",
        json.dumps(
            [
                {
                    "command": [
                        str(ROOT / ".venv/bin/python"),
                        str(ROOT / "tests/shared_plugin_fixture.py"),
                    ],
                    "config": {"registration": registration},
                }
            ]
        ),
    )
    from ma_plugin.rpc import WireError

    with pytest.raises(WireError, match="External plugin 0 refused"):
        await build(tmp_path / "state", Fake(), project=tmp_path)


async def test_shared_step_gate_failure_is_not_success(tmp_path, monkeypatch, runtime_type):
    monkeypatch.setenv(
        "MODULAR_AGENT_PLUGINS",
        json.dumps(
            [
                {
                    "command": [
                        str(ROOT / ".venv/bin/python"),
                        str(ROOT / "tests/shared_plugin_fixture.py"),
                    ],
                    "config": {"hooks": ["step.after"]},
                }
            ]
        ),
    )
    h = await build(
        tmp_path / "state", Fake([reply("no")]), runtime=runtime_type(), project=tmp_path
    )
    try:
        sid = (await h.api().session("create", project=str(tmp_path), settings={"model": "fake"}))[
            "id"
        ]
        await h.api().call("runtime", "submit", {"session": sid, "content": content("start")})
        result = await h.api().call("runtime", "wait", {"session": sid})
        assert result[-1]["outcome"] == "failed"
        assert result[-1]["error"] == "WIRE-STEP-REFUSAL"
    finally:
        await h.stop()


async def test_shared_result_over_frame_cap_is_small_error(tmp_path, monkeypatch):
    monkeypatch.setenv(
        "MODULAR_AGENT_PLUGINS",
        json.dumps(
            [
                {
                    "command": [
                        str(ROOT / ".venv/bin/python"),
                        str(ROOT / "tests/shared_plugin_fixture.py"),
                    ],
                }
            ]
        ),
    )
    h = await build(tmp_path / "state", Fake(), project=tmp_path)
    try:
        sid = (await h.api().session("create", project=str(tmp_path), settings={"model": "fake"}))[
            "id"
        ]
        with pytest.raises(AgentError) as error:
            async with asyncio.timeout(10):
                await h.api().session("command", session=sid, text="/probe large")
        assert error.value.code == "result_too_large"
        # Oversized result does not destroy the connection.
        assert await h.api().session("command", session=sid, text="/probe change")
    finally:
        await h.stop()


async def test_served_environment_stops_active_work_on_stdin_eof(tmp_path):
    process = await asyncio.create_subprocess_exec(
        *SERVE,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        env={**os.environ, "MODULAR_AGENT_PLUGIN_PARTS": "environment"},
    )

    def send(key, method, params):
        process.stdin.write(
            (
                json.dumps({"jsonrpc": "2.0", "id": key, "method": method, "params": params}) + "\n"
            ).encode()
        )

    try:
        send(
            1,
            "plugin/initialize",
            {
                "binding": "modular-agent-plugin/1",
                "data": "modular-agent-data/1",
                "project": str(tmp_path),
                "home": str(tmp_path / "state"),
                "config": {},
            },
        )
        async with asyncio.timeout(5):
            registration = json.loads(await process.stdout.readline())["result"]
        containment = registration["workingEnvironment"]["containment"]
        # Use an escapee only when the serving environment promises to stop it.
        child = "setsid sleep 60" if containment == "strong" else "sleep 60"
        send(
            2,
            "env/exec",
            {
                "cwd": str(tmp_path),
                "sessionId": "eof-session",
                "command": f"{child} & echo $! > eof-pid; wait",
            },
        )
        async with asyncio.timeout(5):
            await until(lambda: pid_ready(tmp_path / "eof-pid"))
            pid = int((tmp_path / "eof-pid").read_text())
            assert not dead(pid)
            process.stdin.close()
            await process.wait()
        await until(lambda: dead(pid))
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


async def test_shared_unknown_fields_survive_history_and_next_model_request(
    tmp_path, monkeypatch, runtime_type
):
    monkeypatch.setenv(
        "MODULAR_AGENT_PLUGINS",
        json.dumps(
            [
                {
                    "command": [
                        str(ROOT / ".venv/bin/python"),
                        str(ROOT / "tests/shared_plugin_fixture.py"),
                    ],
                    "config": {"providerTest": True},
                }
            ]
        ),
    )
    h = await build(tmp_path / "state", Fake(), runtime=runtime_type(), project=tmp_path)
    try:
        sid = (
            await h.api().session(
                "create", project=str(tmp_path), settings={"model": "fixture/odd"}
            )
        )["id"]
        for text in ("first", "second"):
            await h.api().call("runtime", "submit", {"session": sid, "content": content(text)})
            outcomes = await h.api().call("runtime", "wait", {"session": sid})
            assert outcomes[-1]["outcome"] == "completed", outcomes
        responses = [
            e for e in await h.api().session("branch", session=sid) if e["kind"] == "response"
        ]
        assert responses[0]["data"]["futureResponse"] == {"kept": True}
        assert responses[0]["data"]["providerData"] == {"opaque": "not text"}
        assert {"type": "future-part", "payload": ["unchanged"]} in responses[0]["content"]
        assert responses[-1]["content"][0]["text"] == "preserved"
        # Compaction uses a logical summary request, not an unknown host session.
        assert await h.api().session("command", session=sid, text="/compact")
    finally:
        await h.stop()


async def test_shared_tool_lists_are_session_scoped(tmp_path, monkeypatch, runtime_type):
    monkeypatch.setenv(
        "MODULAR_AGENT_PLUGINS",
        json.dumps(
            [
                {
                    "command": [
                        str(ROOT / ".venv/bin/python"),
                        str(ROOT / "tests/shared_plugin_fixture.py"),
                    ],
                    "config": {"perSession": True},
                }
            ]
        ),
    )
    h = await build(tmp_path / "state", Fake(), runtime=runtime_type(), project=tmp_path)
    try:
        ids = [
            (await h.api().session("create", project=str(tmp_path), settings={"model": "fake"}))[
                "id"
            ]
            for _ in range(2)
        ]
        for sid in ids:
            names = [
                t["name"] for t in await h.api().call("tools", "definitions", {"session": sid})
            ]
            assert "in-" + sid in names
            assert "in-" + next(x for x in ids if x != sid) not in names
        await h.api().session("command", session=ids[0], text="/probe change")
        for sid in ids:
            names = [
                t["name"] for t in await h.api().call("tools", "definitions", {"session": sid})
            ]
            assert ("added" in names) == (sid == ids[0])
            assert "in-" + sid in names
    finally:
        await h.stop()


async def test_shared_result_gates_compose_changes_before_refusal(
    tmp_path, monkeypatch, runtime_type
):
    command = [str(ROOT / ".venv/bin/python"), str(ROOT / "tests/shared_plugin_fixture.py")]
    specs = [
        {
            "command": command,
            "config": {
                "registration": {
                    "name": "result-gate-" + mode,
                    "providers": [],
                    "toolSources": [],
                    "commands": [],
                },
                "hooks": ["turn.result"],
                "resultMode": mode,
            },
        }
        for mode in ("change", "refuse")
    ]
    monkeypatch.setenv("MODULAR_AGENT_PLUGINS", json.dumps(specs))
    fake = Fake([reply("first"), reply("second")])
    h = await build(tmp_path / "state", fake, runtime=runtime_type(), project=tmp_path)
    try:
        sid = (await h.api().session("create", project=str(tmp_path), settings={"model": "fake"}))[
            "id"
        ]
        await h.api().call("runtime", "submit", {"session": sid, "content": content("start")})
        result = (await h.api().call("runtime", "wait", {"session": sid}))[-1]
        assert result["outcome"] == "completed"
        assert result["content"] == content("CHANGED")
        assert len(fake.requests) == 2
        inputs = [e for e in await h.api().session("branch", session=sid) if e["kind"] == "input"]
        await h.api().session("erase", session=sid, entries=[inputs[0]["id"]])
        assert "CHANGED" not in json.dumps(h.sessions[sid])
    finally:
        await h.stop()


async def test_shared_tool_gate_cannot_change_authority_or_actor(
    tmp_path, monkeypatch, runtime_type
):
    monkeypatch.setenv(
        "MODULAR_AGENT_PLUGINS",
        json.dumps(
            [
                {
                    "command": [
                        str(ROOT / ".venv/bin/python"),
                        str(ROOT / "tests/shared_plugin_fixture.py"),
                    ],
                    "config": {"hooks": ["tool.before"], "hijack": True},
                }
            ]
        ),
    )
    (tmp_path / "note").write_text("safe")
    fake = Fake(
        [reply(calls=[{"id": "gate", "name": "read", "input": {"path": "note"}}]), reply("done")]
    )
    h = await build(tmp_path / "state", fake, runtime=runtime_type(), project=tmp_path)
    try:
        sid = (
            await h.api().session(
                "create", project=str(tmp_path), settings={"model": "fake", "approval": "off"}
            )
        )["id"]
        await h.api().call("runtime", "submit", {"session": sid, "content": content("start")})
        await h.api().call("runtime", "wait", {"session": sid})
        started = next(
            e for e in await h.api().session("branch", session=sid) if e["kind"] == "tool_started"
        )
        assert started["data"]["call"]["actor"] == "user"
        assert started["data"]["call"]["initiator"] == "model"
    finally:
        await h.stop()


def read_error_plugin(code="not_found", message="Fichier introuvable"):
    return {
        "command": [str(ROOT / ".venv/bin/python"), str(ROOT / "tests/shared_plugin_fixture.py")],
        "config": {
            "registration": {
                "workingEnvironment": {"containment": "none", "platforms": ["linux"]},
                "replaces": ["working-environment"],
            },
            "readError": {"code": code, "message": message},
        },
    }


@pytest.mark.parametrize("operation", ["read", "read_bytes"])
async def test_local_missing_file_is_not_found(agent, operation):
    _, api, sid, _ = await agent()
    with pytest.raises(AgentError) as error:
        await api.call("environment", operation, {"session": sid, "path": "AGENTS.md"})
    assert error.value.code == "not_found"


@pytest.mark.parametrize(
    ("code", "message", "outcome"),
    [
        ("not_found", "Fichier introuvable", "completed"),
        ("internal", "No such file is only message text, not an error code", "failed"),
    ],
)
async def test_prompt_uses_external_environment_error_code(
    tmp_path, monkeypatch, runtime_type, code, message, outcome
):
    monkeypatch.setenv("MODULAR_AGENT_PLUGINS", json.dumps([read_error_plugin(code, message)]))
    fake = Fake([reply("done")])
    h = await build(tmp_path / "state", fake, runtime=runtime_type(), project=tmp_path)
    try:
        assert h.capabilities["environment"][0].startswith("external:")
        sid = (await h.api().session("create", project=str(tmp_path), settings={"model": "fake"}))[
            "id"
        ]
        with pytest.raises(AgentError) as error:
            await h.api().call("environment", "read", {"session": sid, "path": "AGENTS.md"})
        assert error.value.code == code
        assert str(error.value) == message
        await h.api().call("runtime", "submit", {"session": sid, "content": content("start")})
        result = (await h.api().call("runtime", "wait", {"session": sid}))[-1]
        assert result["outcome"] == outcome, result
        if outcome == "completed":
            assert result["content"] == content("done")
            assert "Project AGENTS.md:" not in fake.requests[0]["system"]
        else:
            assert not fake.requests
    finally:
        await h.stop()


@pytest.mark.parametrize("environment", ["local", "external"])
async def test_host_env_read_preserves_not_found(tmp_path, monkeypatch, runtime_type, environment):
    spec = read_error_plugin()
    if environment == "local":
        spec["config"] = {}
    monkeypatch.setenv("MODULAR_AGENT_PLUGINS", json.dumps([spec]))
    h = await build(tmp_path / "state", Fake(), runtime=runtime_type(), project=tmp_path)
    try:
        sid = (await h.api().session("create", project=str(tmp_path), settings={"model": "fake"}))[
            "id"
        ]
        result = await h.api().session("command", session=sid, text="/probe read-error")
        assert json.loads(result["output"])["code"] == "not_found"
    finally:
        await h.stop()


async def test_served_conformance_plugin_passes_kit():
    # run_kit asserts the exit code; the number of checks can grow.
    await run_kit("conformance/plugin/run.mjs", "--", *SERVE)


@pytest.mark.parametrize("external", [False, True], ids=["native", "public-durable"])
async def test_turn_end_hook_matches_history(tmp_path, monkeypatch, runtime_type, external):
    from ma_core.wire import entry_out

    log = tmp_path / "turn-end.log"
    plugins = json.loads(runtime_plugins("durable-runtime")) if external else []
    plugins.append(
        {
            "command": [
                str(ROOT / ".venv/bin/python"),
                str(ROOT / "tests/shared_plugin_fixture.py"),
            ],
            "config": {"hooks": ["turn.end"], "turnEnd": str(log)},
        }
    )
    monkeypatch.setenv("MODULAR_AGENT_PLUGINS", json.dumps(plugins))
    h = await build(tmp_path / "state", Fake([reply("a result")]), runtime=runtime_type())
    try:
        a = h.api()
        sid = (await a.session("create", project=str(tmp_path), settings={"model": "fake"}))["id"]
        await a.call("runtime", "submit", {"session": sid, "content": content("start")})
        (result,) = await a.call("runtime", "wait", {"session": sid})
        assert result["outcome"] == "completed", result
        await a.session("settings", session=sid, changes={"max_steps": 0})
        await a.call("runtime", "submit", {"session": sid, "content": content("limit")})
        (result,) = await a.call("runtime", "wait", {"session": sid})
        assert result["outcome"] == "limit", result
        ends = [
            entry_out(e) for e in await a.session("branch", session=sid) if e["kind"] == "turn_end"
        ]
        assert len(ends) == 2
        assert [json.loads(line) for line in log.read_text().splitlines()] == [
            {
                "sessionId": sid,
                "turnId": e["turnId"],
                "outcome": e["data"]["outcome"],
                "result": e["data"]["result"],
            }
            for e in ends
        ]
    finally:
        await h.stop()


@pytest.mark.parametrize("external", [False, True], ids=["native", "public-durable"])
@pytest.mark.parametrize("tools_right", [False, True], ids=["revoked", "allowed"])
async def test_recovery_checks_tools_right(tmp_path, monkeypatch, external, tools_right):
    from ma_durable import Durable
    from test_recovery_edges import seed

    if external:
        monkeypatch.setenv("MODULAR_AGENT_PLUGINS", runtime_plugins("durable-runtime"))
    (tmp_path / "facts").write_text("RECOVERED FILE")
    h = await build(tmp_path / "state", Fake([reply("continued")]), runtime=Durable())
    try:
        a = h.api()
        sid = (
            await a.session(
                "create", project=str(tmp_path), settings={"model": "fake", "approval": "off"}
            )
        )["id"]
        tool = next(
            t for t in await a.call("tools", "definitions", {"session": sid}) if t["name"] == "read"
        )
        first, second = call("read", path="facts"), call("read", path="facts")
        await seed(a, sid, [first, second], [tool, tool], started=[first["id"]])
        rights = ["watch", "input"] + (["tools"] if tools_right else [])
        await a.session("grant", session=sid, subject="user", authority=rights)
        await a.session("close", session=sid)
        await a.session("open", session=sid)
        (result,) = await a.call("runtime", "wait", {"session": sid})
        assert result["outcome"] == "completed", result.get("error")
        entries = await a.session("branch", session=sid)
        statuses = [(e["call"], e["data"]["status"]) for e in entries if e["kind"] == "tool_result"]
        # The local environment does not confirm crash cleanup on macOS. Even
        # with tools rights, only the call known not to have started can run.
        repeated = tools_right and h.plugins["local"].declarations["stops_commands_on_crash"]
        assert dict(statuses) == {
            first["id"]: "completed" if repeated else "outcome_unknown",
            second["id"]: "completed" if tools_right else "refused",
        }
        assert len(statuses) == 2
        assert sum(e["kind"] == "tool_started" for e in entries) == 1 + tools_right + repeated
    finally:
        await h.stop()


def runtime_plugins(part):
    return json.dumps([{"command": SERVE, "env": {"MODULAR_AGENT_PLUGIN_PARTS": part}}])


@pytest.mark.parametrize("external", [False, True], ids=["native", "public-durable"])
async def test_acp_crash_kit(runtime_kind, external):
    output = await run_kit(
        "conformance/acp/run.mjs",
        "--crash-checks",
        "--",
        str(ROOT / ".venv/bin/modular-agent"),
        "--mode",
        "acp",
        "--runtime",
        runtime_kind,
        "--process-plugins",
        "",
        env={"MODULAR_AGENT_PLUGINS": runtime_plugins("durable-runtime")} if external else None,
    )
    assert "checks passed" in output


@pytest.mark.parametrize("watch", [True, False], ids=["can-watch", "input-only"])
async def test_hosted_runtime_reads_history_on_resume(tmp_path, monkeypatch, runtime_type, watch):
    root = tmp_path / "state"
    h = await build(root, Fake(), project=tmp_path, runtime=runtime_type())
    try:
        a = h.api()
        sid = (await a.session("create", project=str(tmp_path), settings={"model": "fake"}))["id"]
        await a.session("append", session=sid, kind="off-branch")
        await a.session("move", session=sid, point=None)
        start = await a.session(
            "append",
            session=sid,
            kind="turn_start",
            turn="interrupted",
            data={"startedBy": {"kind": "actor", "id": "user"}},
        )
        await a.session(
            "append",
            session=sid,
            kind="input",
            turn=start["turn"],
            content=content("RAW-HISTORY-CANARY"),
            visible=True,
            data={"authority": ["input", "watch"] if watch else ["input"]},
        )
    finally:
        await h.stop()

    spec = {
        "command": [str(ROOT / ".venv/bin/python"), str(ROOT / "tests/shared_plugin_fixture.py")],
        "config": {"runtimeHistory": True},
    }
    monkeypatch.setenv("MODULAR_AGENT_PLUGINS", json.dumps([spec]))
    h = await build(
        root, Fake(), secrets=["RAW-HISTORY-CANARY"], project=tmp_path, runtime=runtime_type()
    )
    try:
        a = h.api()
        async with asyncio.timeout(5):
            await a.session("open", session=sid)
            (result,) = await a.call("runtime", "wait", {"session": sid})
        if watch:
            assert result["outcome"] == "completed", result
            assert result["content"] == content("rebuilt from history")
        else:
            assert result["outcome"] == "failed", result
            assert result["error"] == "History read requires watch authority"
    finally:
        await h.stop()


@pytest.mark.parametrize(
    "mode",
    ["completed", "steps", "questions-hook", "questions-reply", "questions-record", "missing-call"],
)
async def test_hosted_runtime_checks_outcome_with_a_pending_tool_reply(
    tmp_path, monkeypatch, runtime_type, mode
):
    log = tmp_path / "turn-end.jsonl"
    spec = {
        "command": [str(ROOT / ".venv/bin/python"), str(ROOT / "tests/shared_plugin_fixture.py")],
        "config": {
            "runtimePending": True,
            "pendingOutcome": mode,
            "hooks": ["turn.end"],
            "turnEnd": str(log),
        },
    }
    monkeypatch.setenv("MODULAR_AGENT_PLUGINS", json.dumps([spec]))
    c = call("probe", operation="late-question")
    h = await build(
        tmp_path / "state", Fake([reply(calls=[c])]), project=tmp_path, runtime=runtime_type()
    )
    try:
        a = h.api()
        settings = {"model": "fake", "approval": "off"}
        if mode == "steps":
            settings["max_steps"] = 1
        sid = (await a.session("create", project=str(tmp_path), settings=settings))["id"]
        await a.call("runtime", "submit", {"session": sid, "content": content("start")})
        (result,) = await a.call("runtime", "wait", {"session": sid})
        expected_calls = [c["id"]]
        if mode.startswith("questions-"):
            expected = {"kind": "failed", "error": "Leaving a question open is not a turn limit"}
            expected_calls = []
        elif mode == "missing-call":
            expected = {
                "kind": "failed",
                "error": "Reported open tool calls disagree with committed pending calls",
            }
            expected_calls = []
        elif mode == "steps":
            expected = {"kind": "limit", "limit": "steps"}
        else:
            expected = {"kind": "completed"}
        assert result["shared_outcome"] == expected
        assert result["open_calls"] == expected_calls
        entries = [entry_out(e) for e in await a.session("branch", session=sid)]
        (pending,) = [e for e in entries if e["kind"] == "toolPending"]
        assert pending["toolCallId"] == c["id"]
        (end,) = [e for e in entries if e["kind"] == "turnEnd"]
        assert end["data"]["outcome"] == expected
        assert end["data"]["result"]["openToolCalls"] == expected_calls
        observed = json.loads(log.read_text())
        assert observed["outcome"] == expected
        assert observed["result"]["openToolCalls"] == expected_calls
        settlements = [e["toolCallId"] for e in entries if e["kind"] == "toolResult"]
        assert settlements == ([] if expected_calls else [c["id"]])
    finally:
        await h.stop()


async def test_hosted_runtime_continues_open_calls(tmp_path, monkeypatch, runtime_type):
    monkeypatch.setenv("MODULAR_AGENT_PLUGINS", runtime_plugins("durable-runtime"))
    c = call("ask_user", question="Which?", kind="choice", options=["red", "blue"], timeout=0)
    h = await build(
        tmp_path / "state",
        Fake([reply(calls=[c]), reply("continued")]),
        project=tmp_path,
        runtime=runtime_type(),
    )
    try:
        assert runtime_type.name not in h.plugins
        owner, runtime = h.capabilities["runtime"]
        assert owner.startswith("external:") and runtime.declarations["durable"]
        a = h.api()
        sid = (await a.session("create", project=str(tmp_path), settings={"model": "fake"}))["id"]
        args = {"session": sid}
        await a.call("questions", "connect", {**args, "actor": "user"})
        await a.call("runtime", "submit", {**args, "content": content("start")})
        (first,) = await a.call("runtime", "wait", args)
        assert first["outcome"] == "completed" and first["open_calls"] == [c["id"]]
        (q,) = await a.call("questions", "list", args)
        await a.call(
            "questions", "answer", {**args, "actor": "user", "request": q["id"], "value": "blue"}
        )
        (later,) = await a.call("runtime", "wait", args)
        assert later["outcome"] == "completed" and later["content"] == content("continued")
        entries = await a.session("branch", **args)
        (resumed,) = [e for e in entries if e["kind"] == "tool_result"]
        assert resumed["call"] == c["id"] and resumed["turn"] == later["turn"]
        assert json.loads(resumed["content"][0]["text"]) == "blue"
        assert [e["data"]["startedBy"]["kind"] for e in entries if e["kind"] == "turn_start"] == [
            "actor",
            "answer",
        ]
    finally:
        await h.stop()

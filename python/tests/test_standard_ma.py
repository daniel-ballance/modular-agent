"""Offline verification of ma's product-specific behavior and public SDK boundary."""

import ast
import asyncio
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import re
import signal
import stat
import sys

from pydantic_monty import AsyncFunctionSnapshot, AsyncMontySession, AsyncNameLookupSnapshot
import pytest

from modular_agent import (
    AgentError,
    Answer,
    ApiKey,
    OAuth,
    subscription_logins,
    Tool,
    ToolContext,
    ToolOutput,
    ToolResult,
    create_agent,
    file_credentials,
    file_history,
    local_environment,
)
from modular_agent.files import file_tools
from modular_agent.testing import memory_environment, scripted_provider, test_agent as offline_agent
from ma_standard import cli, oauth, prompt
from modular_agent.chatgpt import ChatGPT
from modular_agent.grok import Grok
from ma_standard.code import code_tool, functions, prompt as function_prompt
from ma_standard.config import Paths
from test_swap import pid_exists

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / "python/packages/ma/ma_standard"


def test_public_sdk_only() -> None:
    public = {
        "modular_agent",
        "modular_agent.chatgpt",
        "modular_agent.claude",
        "modular_agent.compaction",
        "modular_agent.files",
        "modular_agent.grok",
        "modular_agent.mcp",
        "modular_agent.testing",
    }
    for file in PACKAGE.glob("*.py"):
        for node in ast.walk(ast.parse(file.read_text())):
            names = (
                [node.module or ""]
                if isinstance(node, ast.ImportFrom) and node.level == 0
                else [alias.name for alias in node.names]
                if isinstance(node, ast.Import)
                else []
            )
            for name in names:
                assert not name.startswith("ma_")
                assert not name.startswith("modular_agent") or name in public
            if isinstance(node, ast.ImportFrom) and node.module in public:
                assert all(not alias.name.startswith("_") for alias in node.names)


def test_resume_open_is_global_and_not_a_session_setting(tmp_path: Path) -> None:
    paths = Paths(tmp_path, tmp_path / "state")
    (tmp_path / ".modular-agent.json").write_text('{"resume_open":true}')
    assert not paths.resume_open()
    (tmp_path / "settings.json").write_text('{"resume_open":true}')
    assert paths.resume_open()
    assert "resume_open" not in paths.settings(tmp_path)
    (tmp_path / "settings.json").write_text('{"resume_open":"false"}')
    with pytest.raises(ValueError, match="resume_open must be a boolean"):
        paths.resume_open()


async def test_rust_auth_fixture(tmp_path: Path) -> None:
    # serde_json::to_vec_pretty over AuthFile Contents: struct fields keep
    # declaration order, BTreeMap keys sort, and there is no final newline.
    fixture = b"""{
  "logins": {
    "chatgpt": {
      "type": "oauth",
      "access": "test-access",
      "refresh": "test-refresh",
      "expires": 1,
      "account": "test-account"
    },
    "grok": {
      "type": "api_key",
      "key": "test-key"
    }
  },
  "answers": {
    "example": "test-answer"
  }
}"""
    path = tmp_path / "auth.json"
    path.write_bytes(fixture)
    path.chmod(0o600)
    auth = subscription_logins(path)
    assert auth.login("chatgpt") == OAuth("test-access", "test-refresh", 1, "test-account")
    assert auth.login("grok") == ApiKey("test-key")
    await auth.set_login("grok", ApiKey("test-key"))
    assert path.read_bytes() == fixture
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.with_suffix(".lock").stat().st_mode) == 0o600


type Request = tuple[str, dict[str, str], bytes]
type Reply = tuple[int, str, str]


@asynccontextmanager
async def _http(handler: Callable[[Request], Reply]) -> AsyncIterator[str]:
    async def serve(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            head = (await reader.readuntil(b"\r\n\r\n")).decode().splitlines()
            headers = {
                k.lower(): v.strip() for k, v in (line.split(":", 1) for line in head[1:] if line)
            }
            body = await reader.readexactly(int(headers.get("content-length", "0")))
            code, media, text = handler((head[0].split()[1], headers, body))
            data = text.encode()
            writer.write(
                f"HTTP/1.1 {code} Test\r\nContent-Type: {media}\r\nContent-Length: {len(data)}\r\nConnection: close\r\n\r\n".encode()
                + data
            )
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    async with await asyncio.start_server(serve, "127.0.0.1", 0) as server:
        yield f"http://127.0.0.1:{server.sockets[0].getsockname()[1]}"


async def test_secret_answer_is_written_to_shared_auth_not_history(tmp_path: Path) -> None:
    auth = subscription_logins(tmp_path / "auth.json")
    await auth.set_login("grok", ApiKey("test-key"))

    async def ask(arguments, context):
        reply = await context.ask(
            {"kind": "secret", "question": "Signing key?", "credential": "signing-key"}
        )
        return str(reply.value)

    tool = Tool.from_schema("ask_secret", "Ask a secret", {"type": "object"}, ask)
    provider = scripted_provider([{"toolCalls": [{"name": "ask_secret"}]}, {"text": "done"}])
    async with create_agent(
        project=tmp_path,
        tools=[tool],
        providers=[provider],
        on_question=lambda question, _: Answer("value", "test-secret"),
        credentials=file_credentials(auth),
    ) as agent:
        session = await agent.session()
        result = await asyncio.wait_for(session.prompt("ask"), 5)
        assert result.text == "done"
        assert result.tool_results()[0].text() == "signing-key"
        assert "test-secret" not in json.dumps(await session.history())
    document = json.loads(auth.path.read_text())
    assert document["logins"] == {"grok": {"type": "api_key", "key": "test-key"}}
    assert document["answers"] == {"signing-key": "test-secret"}
    assert stat.S_IMODE(auth.path.stat().st_mode) == 0o600


@pytest.mark.parametrize("identity", ["", "a" * 65, "with space", "a/1", "é", "agent\n"])
def test_ma_rejects_invalid_client_identity_before_startup(
    identity: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv("MA_CLIENT_IDENTITY", identity)
    monkeypatch.setenv("MODULAR_AGENT_SCRIPT", str(tmp_path / "missing-script.json"))
    monkeypatch.setattr(sys, "argv", ["ma", "-p", "hello"])
    with pytest.raises(SystemExit) as caught:
        cli.main()
    assert caught.value.code == 1
    assert "MA_CLIENT_IDENTITY" in capsys.readouterr().err


@pytest.fixture
def ma_args(tmp_path, monkeypatch):
    config = tmp_path / "config"
    config.mkdir()
    monkeypatch.setenv("MODULAR_AGENT_DATA_DIR", str(config))
    monkeypatch.setenv("MA_NO_BROWSER", "1")
    monkeypatch.delenv("MODULAR_AGENT_SCRIPT", raising=False)

    def args(*arguments):
        result = cli._parser().parse_args(["--project", str(tmp_path), *arguments])
        result.client_identity = "test-client"
        return result

    return config, args


@pytest.mark.parametrize(("key", "provider"), [("openai-codex", "chatgpt"), ("xai", "grok")])
async def test_ma_requires_exact_subscription_id(ma_args, monkeypatch, key, provider):
    config, args = ma_args
    logins = subscription_logins(config / "auth.json")
    await logins.set_login(key, ApiKey("unused"))
    assert logins.login(provider) is None
    for command in ("login", "logout"):
        with pytest.raises(ValueError, match="unknown provider"):
            await cli._run(args(command, key))

    async def sign_in(name, store, *, device, on_step, paste, client_identity):
        assert name == provider and device and paste is None and client_identity == "test-client"
        await store.set_login(name, ApiKey("device-key"))

    monkeypatch.setattr(oauth, "sign_in", sign_in)
    assert await cli._run(args("--device", "login", provider)) == 0
    assert logins.login(provider) == ApiKey("device-key")
    assert await cli._run(args("logout", provider)) == 0
    assert logins.login(provider) is None and logins.login(key) == ApiKey("unused")


async def test_ma_does_not_rewrite_a_saved_unavailable_provider(ma_args, tmp_path):
    config, args = ma_args
    history = file_history(config / "state" / "sessions")
    fixture = scripted_provider([{"text": "done"}])
    fixture.id = "xai"
    selection = "xai/" + fixture.models()[0]["id"]
    async with create_agent(
        project=tmp_path,
        history=history,
        data_dir=config / "state",
        durability="kept",
        providers=[fixture],
        model=selection,
    ) as agent:
        session = await agent.session()
        assert (await session.prompt("first")).text == "done"
        before = await session.history()
    with pytest.raises(AgentError, match="Unknown model: xai/"):
        await cli._run(args("--runtime", "transient", "--session", session.id, "--history"))
    async with create_agent(
        project=tmp_path, data_dir=config / "state", history=history, durability="kept"
    ) as agent:
        saved = await agent.session_info(session.id)
        assert saved["settings"]["model"]["provider"] == "xai"
        reopened = await agent.open_session(session.id)
        before_ids = {r["id"] for r in before}
        assert not any(
            e["kind"] == "setting" and e["id"] not in before_ids for e in await reopened.history()
        )


@pytest.mark.loopback
@pytest.mark.parametrize(("provider", "model"), [("chatgpt", "gpt-6.1-sol"), ("grok", "grok-4.7")])
@pytest.mark.parametrize("source", ["flag", "settings", "reopen"])
async def test_ma_uses_selected_provider(
    ma_args, tmp_path, monkeypatch, capsys, provider, model, source
):
    config, args = ma_args
    auth = subscription_logins(config / "auth.json")
    await auth.set_login(
        provider, OAuth("fixture-access", "fixture-refresh", 2**62, "fixture-account")
    )
    sent = []

    def route(request):
        sent.append((request[1], json.loads(request[2])))
        completed = {
            "type": "response.completed",
            "response": {
                "output": [
                    {
                        "type": "message",
                        "content": [{"type": "output_text", "text": "Test response"}],
                    },
                ]
            },
        }
        return 200, "text/event-stream", f"data: {json.dumps(completed)}\n\n"

    selection = f"{provider}/{model}"
    options = []
    if source == "flag":
        options = ["--model", selection]
    elif source == "settings":
        (config / "settings.json").write_text(json.dumps({"model": selection}))
    else:
        fixture = scripted_provider([{"text": "First reply"}])
        fixture.id = provider
        original_models = fixture.models
        fixture.models = lambda: [{**info, "id": model} for info in original_models()]
        history = config / "state" / "sessions"
        async with create_agent(
            project=tmp_path,
            data_dir=config / "state",
            history=file_history(history),
            durability="kept",
            providers=[fixture],
            model=selection,
            local_process_groups=True,
        ) as agent:
            session = await agent.session()
            assert (await session.prompt("Hello")).text == "First reply"
        options = ["--session", session.id]

    async with _http(route) as url:
        monkeypatch.setattr(ChatGPT, "_endpoint", url + "/responses")
        monkeypatch.setattr(Grok, "_endpoint", url + "/responses")
        assert await cli._run(args("--runtime", "transient", *options, "-p", "Hello")) == 0
    assert capsys.readouterr().out == "Test response\n"
    [(headers, body)] = sent
    assert body["model"] == model
    if provider == "chatgpt":
        assert headers["originator"] == "test-client"
    else:
        assert "originator" not in headers and "referrer" not in headers
    if source == "reopen":
        async with create_agent(
            project=tmp_path,
            data_dir=config / "state",
            history=file_history(history),
            durability="kept",
            local_process_groups=True,
        ) as agent:
            saved = await agent.session_info(session.id)
        assert saved["settings"]["model"] == {"provider": provider, "id": model}


async def test_ma_catalog_reads_only_the_selected_provider(ma_args, monkeypatch, capsys):
    config, args = ma_args
    auth = subscription_logins(config / "auth.json")
    for key in ("chatgpt", "grok"):
        await auth.set_login(key, ApiKey("fixture"))
    rows = {
        key: [{"id": "extra-" + key, "name": "Extra", "contextWindow": 12000, "maxTokens": 1234}]
        for key in ("openai-codex", "chatgpt", "xai", "grok")
    }
    rows["chatgpt"].append({"id": "gpt-6.1-sol", "contextWindow": 12001, "maxTokens": 1234})
    rows["grok"].append(
        {"id": "grok-4.7", "contextWindow": 12002, "maxTokens": 1234, "effort": {"high": "high"}}
    )
    (config / "models.json").write_text(json.dumps(rows))

    class NoClaude:
        id = "claude"
        supports = scripted_provider([]).supports

        async def available(self):
            return False

    monkeypatch.setattr(cli, "claude", NoClaude)
    assert await cli._run(args("--runtime", "transient", "models")) == 0
    shown = capsys.readouterr().out
    assert re.search(r"chatgpt/gpt-6.1-sol\s+context\s+12001\s+thinking minimal,low", shown)
    assert re.search(r"grok/grok-4.7\s+context\s+12002\s+thinking high", shown)
    assert "chatgpt/extra-chatgpt" in shown and "grok/extra-grok" in shown
    assert "extra-openai-codex" not in shown and "extra-xai" not in shown


@pytest.mark.parametrize(
    ("code", "limits", "status", "contains"),
    [
        (
            "print(tools.read('in')); print(search_tools('read contents')[0]['name']); describe_tool('read')['name']",
            {},
            "completed",
            "example\nread\nread",
        ),
        (
            "try:\n    tools.read('missing')\nexcept RuntimeError as e:\n    print(str(e))",
            {},
            "completed",
            "read() failed",
        ),
        ("tools.read()", {}, "failed", "missing argument path"),
        (
            "tools.read('in'); tools.read('in')",
            {"calls": 1},
            "failed",
            "more than 1 function calls",
        ),
        (
            "print('x' * 1000)",
            {"printed": 30},
            "failed",
            "RuntimeError: printed output exceeded 30 bytes",
        ),
        ("while True:\n    pass", {"compute": 0.1}, "failed", "TimeoutError"),
        (
            "import time\ntime.time()",
            {},
            "failed",
            "no direct access",
        ),
        ("def f():\n    return 1 + f()\nf()", {"recursion": 15}, "failed", "recursion"),
        (
            "from pathlib import Path\nPath('/etc/passwd').read_text()",
            {},
            "failed",
            "no direct access",
        ),
        ("print('x' * 60000)", {}, "completed", "Output cut:"),
    ],
)
async def test_monty(tmp_path: Path, code: str, limits: dict, status: str, contains: str) -> None:
    async with offline_agent(
        project=tmp_path,
        environment=memory_environment({"in": "example"}),
        tools=[code_tool(**limits)],
        plugins=[file_tools(tmp_path)],
        script=[{"toolCalls": [{"name": "codemode", "input": {"code": code}}]}, {"text": "ok"}],
    ) as agent:
        result = await (await agent.session()).prompt("use code")
    [tool] = result.tool_results()
    assert tool.status == status, tool.text()
    assert contains.lower() in tool.text().lower()


async def _run_code(tmp_path: Path, source: str, **limits) -> ToolResult:
    (tmp_path / "in").write_text("example")
    script = [{"toolCalls": [{"name": "codemode", "input": {"code": source}}]}, {"text": "ok"}]
    async with offline_agent(
        project=tmp_path,
        environment=local_environment(tmp_path),
        plugins=[file_tools(tmp_path)],
        tools=[code_tool(**limits)],
        script=script,
    ) as agent:
        [result] = (await (await agent.session()).prompt("run code")).tool_results()
    return result


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("tools.read({'path': 'in', 'offset': None})", "example"),
        (
            "{'z': 1.0, 'a': ('é', 2**70)}",
            '{\n  "z": 1.0,\n  "a": [\n    "é",\n    1180591620717411303424\n  ]\n}',
        ),
        ("(b'hi', float('nan'))", "(b'hi', nan)"),
        ("float('nan')", "nan"),
        ("'é'", "é"),
        ("None", "(no output)"),
        (
            "class P:\n    def __init__(self):\n        self.x = 1\n        self.y = 'a'\n"
            "    def __repr__(self):\n        return 'custom'\n[P(), (P(),)]",
            "[P(x=1, y='a'), (P(x=1, y='a'),)]",
        ),
    ],
)
async def test_codemode_value(tmp_path: Path, source: str, expected: str) -> None:
    result = await _run_code(tmp_path, source)
    assert result.status == "completed"
    assert result.text() == expected


def test_codemode_single_object_parameter() -> None:
    [function] = functions(
        [
            {
                "name": "echo",
                "description": "echo",
                "parameters": {
                    "required": ["value"],
                    "properties": {"value": {"type": "object"}},
                },
            },
        ]
    ).values()
    assert function.bind(({"x": 1},), {}) == {"value": {"x": 1}}


async def test_codemode_rejects_lossy_json_arguments_without_dispatch(tmp_path: Path) -> None:
    result = await _run_code(
        tmp_path,
        """\
for value in ({1: 'would become a string key'}, float('nan'), b'not JSON', 2**20000):
    try:
        tools.write('after', value)
    except TypeError:
        print('rejected')
""",
    )
    assert result.status == "completed", result.text()
    assert result.text() == "rejected\n" * 4
    assert result.value == {"calls": 0}
    assert not (tmp_path / "after").exists()


@pytest.mark.parametrize("source", ["image", "[image, image]", "(image, image)"])
async def test_codemode_attaches_images(tmp_path: Path, source: str) -> None:
    result = await _run_code(
        tmp_path,
        "image = {'type': 'image', 'mimeType': 'image/png', 'data': 'aW1hZ2U=', 'note': 'look'}\n"
        + source,
    )
    assert result.status == "completed", result.text()
    count = 1 if source == "image" else 2
    assert result.text() == "look\n" * count
    assert (
        list(result.content[1:])
        == [{"type": "image", "mimeType": "image/png", "data": "aW1hZ2U="}] * count
    )


async def test_codemode_raises_for_exec_timeout_with_structured_result(tmp_path: Path) -> None:
    environment = memory_environment()
    environment.on_exec("slow", lambda _: {"timed_out": True, "exit_code": -15})
    code = "try:\n    tools.exec('slow', timeout=1)\nexcept RuntimeError:\n    print('timed out')"
    async with offline_agent(
        project=tmp_path,
        environment=environment,
        tools=[code_tool()],
        plugins=[file_tools(tmp_path)],
        script=[{"toolCalls": [{"name": "codemode", "input": {"code": code}}]}, {"text": "ok"}],
    ) as agent:
        [result] = (await (await agent.session()).prompt("run code")).tool_results()
    assert result.status == "completed", result.text()
    assert result.text() == "timed out\n"


async def test_codemode_uncaught_exception_includes_monty_traceback(tmp_path: Path) -> None:
    result = await _run_code(
        tmp_path, "def fail():\n    raise ValueError('stop')\nprint('before')\nfail()"
    )
    assert result.status == "failed"
    assert result.text().startswith("before\nTraceback (most recent call last):\n")
    assert "line 2, in fail" in result.text()
    assert result.text().endswith("ValueError: stop")


async def test_codemode_cut_keeps_whole_lines_and_leads_with_error(tmp_path: Path) -> None:
    result = await _run_code(tmp_path, "print('before')\nprint('é' * 30000)\nraise ValueError()")
    assert result.status == "failed"
    assert result.text().splitlines() == [
        "ValueError",
        "before",
        "[Output cut: return or print less, or write the rest to a file.]",
    ]


async def test_codemode_print_limit_cuts_utf8_and_stops_before_next_tool(tmp_path: Path) -> None:
    result = await _run_code(
        tmp_path,
        "print('ab')\ntry:\n    print('é😀zzz', end='')\nexcept RuntimeError:\n    print('caught')\ntools.write('after', 'should not run')",
        printed=8,
    )
    assert result.status == "failed"
    assert result.text() == "RuntimeError: printed output exceeded 8 bytes\nab\né"
    assert not (tmp_path / "after").exists()


@pytest.mark.parametrize(("depth", "status"), [(200, "completed"), (201, "failed")])
async def test_codemode_recursion_boundary(tmp_path: Path, depth: int, status: str) -> None:
    result = await _run_code(
        tmp_path, f"def f(n):\n    return 1 if n == 1 else 1 + f(n - 1)\nf({depth})"
    )
    assert result.status == status
    if status == "completed":
        assert result.text() == "200"
    else:
        assert result.text().endswith("RecursionError: maximum recursion depth exceeded")


async def test_codemode_denies_ambient_access_but_allows_seeded_random(tmp_path: Path) -> None:
    result = await _run_code(
        tmp_path,
        """\
import os
import time
import random
from pathlib import Path

def attempt(name, action):
    try:
        action()
        print(name, 'allowed')
    except Exception:
        print(name, 'denied')

def network():
    import socket
    socket.socket()

def process():
    import subprocess
    subprocess.run(['true'])

attempt('file', lambda: open('in'))
attempt('path', lambda: Path('in').read_text())
attempt('network', network)
attempt('process', process)
attempt('clock', lambda: time.time())
attempt('sleep', lambda: time.sleep(0))
attempt('system entropy', lambda: os.urandom(1))
attempt('module random', lambda: random.random())
attempt('unseeded generator', lambda: random.Random().random())
print(time.process_time(), time.process_time_ns(), time.thread_time(), time.thread_time_ns())
print(random.Random(7).random())
""",
    )
    assert result.status == "completed", result.text()
    assert result.text().splitlines() == [
        f"{name} denied"
        for name in (
            "file",
            "path",
            "network",
            "process",
            "clock",
            "sleep",
            "system entropy",
            "module random",
            "unseeded generator",
        )
    ] + ["0.0 0 0.0 0", "0.32383276483316237"]


async def test_codemode_compute_budget_spans_describe_calls(tmp_path: Path) -> None:
    result = await _run_code(
        tmp_path,
        """\
for i in range(500):
    for j in range(50000):
        x = j * j
    describe_tool('read')
tools.write('after', 'should not run')
""",
        compute=0.1,
    )
    assert result.status == "failed"
    assert result.text() == "TimeoutError: sandbox exceeded its active time limit"
    assert not (tmp_path / "after").exists()


async def test_codemode_dispatched_calls_reset_compute_budget(tmp_path: Path) -> None:
    result = await _run_code(
        tmp_path,
        """\
for i in range(40):
    for j in range(500000):
        x = j * j
    tools.read('in')
'finished'
""",
        compute=0.125,
    )
    assert result.status == "completed", result.text()
    assert result.value == {"calls": 40}
    assert result.text() == "finished"


async def test_codemode_host_waits_do_not_spend_execution_time(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    compute = 0.2
    snapshots = []
    resume_call = AsyncFunctionSnapshot.resume_auto
    resume_name = AsyncNameLookupSnapshot.resume_auto

    async def delayed_call(snapshot):
        snapshots.append(str(snapshot.function_name))
        await asyncio.sleep(compute + 0.01)
        return await resume_call(snapshot)

    async def delayed_name(snapshot):
        snapshots.append(snapshot.variable_name)
        await asyncio.sleep(compute + 0.01)
        return await resume_name(snapshot)

    async def wait(arguments, context):
        snapshots.append("wait")
        await asyncio.sleep(compute + 0.01)
        return ToolOutput([{"type": "text", "text": "waited"}])

    monkeypatch.setattr(AsyncFunctionSnapshot, "resume_auto", delayed_call)
    monkeypatch.setattr(AsyncNameLookupSnapshot, "resume_auto", delayed_name)
    source = "import tools\ndescribe = describe_tool\ndescribe('wait')\nsearch_tools('wait')\ntools.wait()"
    script = [{"toolCalls": [{"name": "codemode", "input": {"code": source}}]}, {"text": "ok"}]
    async with offline_agent(
        project=tmp_path,
        tools=[
            code_tool(compute=compute),
            Tool.from_schema("wait", "wait", {"type": "object"}, wait),
        ],
        script=script,
    ) as agent:
        [result] = (await (await agent.session()).prompt("run code")).tool_results()
    assert result.status == "completed", result.text()
    assert result.text() == "waited"
    assert snapshots == ["import", "describe_tool", "describe_tool", "search_tools", "wait"]


async def test_codemode_memory_limit_discards_session(tmp_path: Path) -> None:
    # Grow past 256 MiB in small allocations, not just one pre-checked allocation.
    grow = "print('x' * 60000)\nitems = []\nfor i in range(30000):\n    items.append('y' * 10000)\nprint('finished')"
    script = [
        {"toolCalls": [{"name": "codemode", "input": {"code": grow}}]},
        {"toolCalls": [{"name": "codemode", "input": {"code": "print('still here'); 1 + 2"}}]},
        {"text": "done"},
    ]
    async with offline_agent(project=tmp_path, tools=[code_tool()], script=script) as agent:
        failed, completed = (await (await agent.session()).prompt("use code")).tool_results()
    assert failed.status == "failed"
    assert "MemoryError" in failed.text()
    assert "finished" not in failed.text()
    assert completed.status == "completed"
    assert completed.text() == "still here\n3"


@pytest.mark.parametrize("stop", ["kill", "cancel", "watchdog"])
async def test_codemode_worker_stops_and_next_run_works(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stop: str
) -> None:
    code = "print('started')\nwhile True:\n    pass"
    entered: asyncio.Future[int] = asyncio.get_running_loop().create_future()
    loop = asyncio.get_running_loop()
    original = AsyncMontySession.feed_start

    def observe(worker: AsyncMontySession, source: str, **kwargs):
        if source == code:
            pid = worker.worker_pid
            assert pid is not None and pid != os.getpid()

            def printed(_stream: str, text: str) -> None:
                if text == "started\n":
                    loop.call_soon_threadsafe(entered.set_result, pid)

            kwargs["print_callback"] = printed
        return original(worker, source, **kwargs)

    # Synchronize on output from the real worker, before stopping its running turn.
    monkeypatch.setattr(AsyncMontySession, "feed_start", observe)
    script = [
        {"toolCalls": [{"name": "codemode", "input": {"code": code}}]},
        {"toolCalls": [{"name": "codemode", "input": {"code": "print('fresh'); 42"}}]},
        {"text": "done"},
    ]
    tool = code_tool(compute=1) if stop == "watchdog" else code_tool()
    async with offline_agent(project=tmp_path, tools=[tool], script=script) as agent:
        session = await agent.session()
        async with asyncio.timeout(5), asyncio.TaskGroup() as tasks:
            running = tasks.create_task(session.prompt("run code"))
            pid = await entered
            if stop == "kill":
                os.kill(pid, signal.SIGKILL)
            elif stop == "watchdog":
                os.kill(pid, signal.SIGSTOP)
            else:
                await session.cancel()
            result = await running
            # Monty's native runtime reaps the child, independently of asyncio.
            while pid_exists(pid):
                await asyncio.sleep(0.01)
        if stop != "cancel":
            failed, completed = result.tool_results()
            assert failed.status == "failed"
            assert "worker process died" in failed.text()
            if stop == "watchdog":
                assert "TimeoutError" in failed.text()
        else:
            assert result.outcome.kind == "cancelled"
            [cancelled] = result.tool_results()
            assert cancelled.status == "cancelled"
            [completed] = (await session.prompt("try again")).tool_results()
        assert completed.status == "completed"
        assert completed.text() == "fresh\n42"


async def test_codemode_prints_started_call_on_stderr(tmp_path: Path, capsys) -> None:
    from argparse import Namespace

    from ma_standard.cli import _event

    code = "n = 1\nprint(n)"
    async with offline_agent(
        project=tmp_path,
        tools=[code_tool()],
        script=[{"toolCalls": [{"name": "codemode", "input": {"code": code}}]}, {"text": "ok"}],
    ) as agent:
        async for event in (await agent.session()).prompt_stream("use code"):
            _event(event, Namespace(json=False, verbose=False), line=False)
    assert capsys.readouterr().err == "codemode\n  | n = 1\n  | print(n)\n"


async def test_codemode_only_nested_calls_count_toward_500() -> None:
    calls = []

    async def unexpected(*args):
        pytest.fail(f"unexpected callback: {args}")

    read = Tool.from_schema(
        "read",
        "Read a file",
        {"type": "object", "required": ["path"], "properties": {"path": {"type": "string"}}},
        unexpected,
    )

    async def nested(operation, params):
        if operation == "list":
            return [read.definition]
        assert operation == "call"
        calls.append(params)
        return {
            "status": "completed",
            "content": [{"type": "text", "text": "example"}],
            "callId": str(len(calls)),
        }

    # Exercise the real worker at the SDK tool boundary without writing 1000 history entries.
    context = ToolContext("session", "user", "call", unexpected, unexpected, nested)
    result = await code_tool()._run(
        {
            "code": """\
import tools
for i in range(501):
    describe_tool('read')
    search_tools('read')
try:
    tools.read()
except TypeError:
    pass
for i in range(500):
    tools.read('in')
print('made 500 calls')
tools.read('after')
"""
        },
        context,
    )
    assert calls == [{"name": "read", "input": {"path": "in"}}] * 500
    assert result["status"] == "failed"
    text = result["content"][0]["text"]
    assert text.startswith("made 500 calls\nTraceback")
    assert text.endswith("RuntimeError: this run made more than 500 function calls")


def test_codemode_positional_order_for_mcp_schema() -> None:
    name = "mcp_example__lookup"
    catalog = functions(
        [
            {
                "name": name,
                "description": "Look up a record",
                "parameters": {
                    "type": "object",
                    "required": ["source", "key"],
                    "properties": {
                        "key": {"type": "string"},
                        "offset": {"type": "integer"},
                        "source": {"type": "string"},
                        "limit": {"type": "integer"},
                        "detailed": {"type": "boolean"},
                    },
                },
            }
        ]
    )
    assert catalog[name].bind(("archive", "record-42", True, 3, 10), {}) == {
        "source": "archive",
        "key": "record-42",
        "detailed": True,
        "limit": 3,
        "offset": 10,
    }
    assert (
        f"tools.{name}(source: str, key: str, detailed: bool = None, "
        "limit: int = None, offset: int = None)"
    ) in function_prompt(catalog)


def test_codemode_large_catalog_keeps_every_signature_and_shortens_descriptions() -> None:
    definitions = [
        {
            "name": f"tool_{i}",
            "description": "x" * 200 + "\nDetailed notes",
            "parameters": {
                "type": "object",
                "required": ["first"],
                "properties": {
                    "zed": {"type": "integer"},
                    "alpha": {"type": "boolean"},
                    "first": {"type": "string"},
                },
            },
        }
        for i in range(13)
    ]
    catalog = functions(definitions)
    listing = function_prompt(catalog)
    assert listing.count("- `tools.") == 13
    assert "tools.tool_12(first: str, alpha: bool = None, zed: int = None)" in listing
    assert "x" * 160 in listing and "x" * 161 not in listing
    assert (
        "Detailed notes" not in listing
        and "Detailed notes" in catalog["tool_12"].describe()["description"]
    )


async def test_prompt_and_skills_against_rust(tmp_path: Path) -> None:
    config, outer = tmp_path / "config", tmp_path / "outer"
    cwd = outer / "inner"
    for path, text in {
        config / "AGENTS.md": "global",
        outer / "CLAUDE.md": "outer",
        cwd / "AGENTS.md": "inner",
        cwd / "CLAUDE.md": "not included",
        cwd
        / ".agents/skills/working/SKILL.md": "---\nname: working\ndescription: >\n  Do one\n  thing & finish\n---\nyes!\n",
        cwd
        / ".modular-agent/skills/working/SKILL.md": "---\nname: working\ndescription: shadow\n---\nx",
        config
        / "skills/hidden/SKILL.md": "---\nname: hidden\ndescription: manual only\ndisable-model-invocation: true\n---\nz",
    }.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    skills, problems = prompt.discover(config, cwd)
    assert len(skills) == 2 and len(problems) == 1 and "already defined" in problems[0]
    assert "\n\nyes!\n</skill>\n\nwith args" in (
        prompt.expand(skills, "/skill:working with args") or ""
    )
    async with offline_agent(
        project=cwd,
        tools=[code_tool()],
        plugins=[file_tools(tmp_path), prompt.prompt_plugin(config, cwd)],
        script=[{"text": "ok"}],
    ) as agent:
        session = await agent.session()
        await session.prompt("hello")
        entries = await session.history()
    request = next(e["data"]["request"] for e in entries if e["kind"] == "modelRequest")
    system = request["systemPrompt"]
    rust = (ROOT / "rust/crates/standard/src/prompt.rs").read_text()
    preamble, rules = [
        re.search(rf'const {name}: &str = "(.*?)";', rust, re.S)[1]
        for name in ("PREAMBLE", "RULES")
    ]
    assert system.startswith(preamble + "\n\n" + rules)
    fragments = [
        "<project_context>",
        "global",
        "outer",
        "inner",
        "<skills>",
        "Do one thing &amp; finish",
        "# Functions in codemode",
        "<cwd>",
        "<date>",
    ]
    assert sorted(fragments, key=system.index) == fragments
    assert "not included" not in system and "manual only" not in system


def test_config_trust_and_mcp_expansion(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    config = Paths(tmp_path / "config", tmp_path / "state")
    config.config.mkdir()
    project = tmp_path / "project"
    project.mkdir()
    monkeypatch.setenv("FIXTURE_NAME", "echo")
    (project / ".mcp.json").write_text(
        '{"mcpServers":{"local":{"command":"${FIXTURE_NAME}","args":["test"]}}}'
    )
    assert config.mcp(project) == []
    config.trust(project)
    [server] = config.mcp(project)
    assert server["command"] == "echo" and server["cwd"] == str(project)
    assert json.loads(config.ledger.read_text()) == {str(project): True}

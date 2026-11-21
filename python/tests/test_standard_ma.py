"""Offline verification of ma's product-specific behavior and public SDK boundary."""

import ast
import asyncio
import base64
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
from urllib.parse import parse_qs, urlsplit

from httpx2 import AsyncClient
from pydantic_monty import AsyncFunctionSnapshot, AsyncMontySession, AsyncNameLookupSnapshot
import pytest

from modular_agent import (
    Answer,
    ModelRef,
    ProviderContext,
    Tool,
    ToolContext,
    ToolOutput,
    ToolResult,
    create_agent,
    file_credentials,
    local_environment,
)
from modular_agent.files import file_tools
from modular_agent.testing import memory_environment, scripted_provider, test_agent as offline_agent
from ma_standard import oauth, prompt, responses
from ma_standard.auth import ApiKey, AuthFile, OAuth
from ma_standard.code import code_tool, functions, prompt as function_prompt
from ma_standard.config import Paths

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / "python/packages/ma/ma_standard"


def test_public_sdk_only() -> None:
    public = {
        "modular_agent",
        "modular_agent.compaction",
        "modular_agent.files",
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


async def test_rust_auth_fixture(tmp_path: Path) -> None:
    # serde_json::to_vec_pretty over AuthFile Contents: struct fields keep
    # declaration order, BTreeMap keys sort, and there is no final newline.
    fixture = b"""{
  "logins": {
    "openai-codex": {
      "type": "oauth",
      "access": "test-access",
      "refresh": "test-refresh",
      "expires": 1,
      "account": "test-account"
    },
    "xai": {
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
    auth = AuthFile(path)
    assert auth.login("openai-codex") == OAuth("test-access", "test-refresh", 1, "test-account")
    assert auth.login("xai") == ApiKey("test-key")
    await auth.set_login("xai", ApiKey("test-key"))
    assert path.read_bytes() == fixture
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.with_suffix(".lock").stat().st_mode) == 0o600


def _jwt() -> str:
    claims = {"https://api.openai.com/auth": {"chatgpt_account_id": "loopback-account"}}
    return (
        "fake."
        + base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
        + ".fake"
    )


type Request = tuple[str, dict[str, str], bytes]
type Reply = tuple[int, str, str]


def _reply(value: object, status: int = 200) -> Reply:
    return status, "application/json", json.dumps(value)


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


@pytest.mark.loopback
@pytest.mark.parametrize("vendor", ["openai-codex", "xai"])
async def test_device_sign_in(vendor: oauth.Vendor, monkeypatch: pytest.MonkeyPatch) -> None:
    recorded: list[Request] = []
    access = _jwt() if vendor == "openai-codex" else "fake-access"
    token = {"access_token": access, "refresh_token": "fake-refresh", "expires_in": 3600}

    def route(request: Request) -> Reply:
        recorded.append(request)
        match request[0]:
            case "/api/accounts/deviceauth/usercode":
                return _reply({"device_auth_id": "device", "user_code": "CODE", "interval": "1"})
            case "/api/accounts/deviceauth/token":
                return _reply({"authorization_code": "code", "code_verifier": "verifier"})
            case "/oauth2/device/code":
                return _reply(
                    {
                        "device_code": "device",
                        "user_code": "CODE",
                        "verification_uri": "https://example.test/verify",
                        "interval": 1,
                    }
                )
            case "/oauth/token" | "/oauth2/token":
                return _reply(token)
        return _reply({}, 404)

    shown: list[oauth.Step] = []
    async with _http(route) as url:
        monkeypatch.setattr(oauth, "CODEX" if vendor == "openai-codex" else "XAI", url)
        login = await oauth.sign_in(vendor, True, shown.append)
    assert shown[0].code == "CODE"
    assert login.secret == access and not login.expired
    assert login.account == ("loopback-account" if vendor == "openai-codex" else None)
    exchange = parse_qs(recorded[-1][2].decode())
    assert exchange["client_id"] == [oauth.CLIENTS[vendor]]
    if vendor == "openai-codex":
        assert json.loads(recorded[0][2]) == {"client_id": oauth.CLIENTS[vendor]}
        assert exchange["code_verifier"] == ["verifier"]
    else:
        assert parse_qs(recorded[0][2].decode())["referrer"] == ["pi"]
        assert exchange["device_code"] == ["device"]


@pytest.mark.loopback
@pytest.mark.parametrize("wrong_state", [False, True])
async def test_browser_sign_in(wrong_state: bool, monkeypatch: pytest.MonkeyPatch) -> None:
    posted: list[Request] = []
    shown: dict[str, list[str]] = {}
    callbacks: list[asyncio.Task[int]] = []

    def route(request: Request) -> Reply:
        posted.append(request)
        return _reply({"access_token": _jwt(), "refresh_token": "fake-rotate"})

    async with _http(route) as url, AsyncClient(trust_env=False) as client:
        monkeypatch.setattr(oauth, "CODEX", url)

        async def browser_callback() -> int:
            redirect = urlsplit(shown["redirect_uri"][0])
            reply = await client.get(
                f"http://127.0.0.1:{redirect.port}{redirect.path}",
                params={
                    "code": "local-code",
                    "state": "wrong" if wrong_state else shown["state"][0],
                },
            )
            return reply.status_code

        def show(step: oauth.Step) -> None:
            assert step.code is None and step.note is None and not step.open_and_paste
            shown.update(parse_qs(urlsplit(step.address).query))
            callbacks.append(asyncio.create_task(browser_callback()))

        if wrong_state:
            with pytest.raises(ValueError, match="wrong state"):
                await oauth._browser(client, show, port=0)
            assert not posted and await callbacks[0] == 400
            return
        login = await oauth._browser(client, show, port=0)
        assert await callbacks[0] == 200
    assert login.account == "loopback-account"
    fields = parse_qs(posted[0][2].decode())
    digest = hashlib.sha256(fields["code_verifier"][0].encode()).digest()
    assert shown["code_challenge"] == [base64.urlsafe_b64encode(digest).decode().rstrip("=")]
    assert fields["code"] == ["local-code"]


@pytest.mark.loopback
async def test_browser_sign_in_from_paste_when_port_is_busy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    posted: list[Request] = []
    notes: list[str] = []
    shown: dict[str, list[str]] = {}

    def route(request: Request) -> Reply:
        posted.append(request)
        return _reply({"access_token": _jwt(), "refresh_token": "fake-rotate"})

    def show(step: oauth.Step) -> None:
        if step.note:
            notes.append(step.note)
        else:
            assert step.open_and_paste
            shown.update(parse_qs(urlsplit(step.address).query))

    async def pasted() -> AsyncIterator[str]:
        yield ""
        yield "http://localhost:1455/auth/callback?code=stale&state=other"
        yield f"http://localhost:1455/auth/callback?code=pasted-code&scope=x&state={shown['state'][0]}"

    async with _http(route) as url, AsyncClient(trust_env=False) as client:
        monkeypatch.setattr(oauth, "CODEX", url)
        # The token fake is already bound on that port.
        async with asyncio.timeout(4):
            login = await oauth._browser(
                client, show, port=urlsplit(url).port or 0, pasted=pasted()
            )

    assert login.account == "loopback-account" and login.refresh == "fake-rotate"
    assert shown["originator"] == ["pi"]
    assert len(posted) == 1 and posted[0][0] == "/oauth/token"
    fields = parse_qs(posted[0][2].decode())
    assert fields["code"] == ["pasted-code"]
    assert fields["redirect_uri"] == ["http://localhost:1455/auth/callback"]
    assert len(notes) == 2
    assert "Port 1455 is in use" in notes[0]
    assert "different sign-in" in notes[1] and "Paste it again." in notes[1]


def test_pasted_code_forms() -> None:
    read = oauth.pasted_code
    assert read("http://localhost:1455/auth/callback?code=c1&state=st", "st") == "c1"
    assert read("  code=a%2Fb+c&state=st  ", "st") == "a/b c"
    assert read("c3#st", "st") == "c3"
    assert read("c4", "st") == "c4"
    assert read("   ", "st") is None
    with pytest.raises(ValueError, match="different sign-in"):
        read("http://localhost:1455/auth/callback?code=c&state=other", "st")
    with pytest.raises(ValueError, match="different sign-in"):
        read("code=c&state=", "st")
    with pytest.raises(ValueError, match="not completed"):
        read("http://localhost:1455/auth/callback?error=access_denied&state=st", "st")
    with pytest.raises(ValueError, match="no code"):
        read("http://localhost:1455/auth/callback?state=st", "st")


async def test_secret_answer_is_written_to_shared_auth_not_history(tmp_path: Path) -> None:
    auth = AuthFile(tmp_path / "auth.json")
    await auth.set_login("xai", ApiKey("test-key"))

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
        credentials=file_credentials(auth.path),
    ) as agent:
        session = await agent.session()
        result = await asyncio.wait_for(session.prompt("ask"), 5)
        assert result.text == "done"
        assert result.tool_results()[0].text() == "signing-key"
        assert "test-secret" not in json.dumps(await session.history())
    document = json.loads(auth.path.read_text())
    assert document["logins"] == {"xai": {"type": "api_key", "key": "test-key"}}
    assert document["answers"] == {"signing-key": "test-secret"}
    assert stat.S_IMODE(auth.path.stat().st_mode) == 0o600


@pytest.mark.loopback
@pytest.mark.parametrize("vendor", ["openai-codex", "xai"])
async def test_responses_refresh_retry_and_stream(
    vendor: oauth.Vendor, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    requests: list[Request] = []
    actual = _jwt() if vendor == "openai-codex" else "fresh"
    vendors_model = "gpt-6.1-sol" if vendor == "openai-codex" else "grok-4.7"
    auth = AuthFile(tmp_path / "auth.json")
    await auth.set_login(
        vendor, OAuth("rejected", "old-refresh", 9_999_999_999_999, "stale-account")
    )
    emitted = []

    async def sink(event: dict[str, object]) -> None:
        emitted.append(event)

    def route(request: Request) -> Reply:
        requests.append(request)
        path, headers, _ = request
        if path.endswith("/token"):
            return _reply({"access_token": actual, "refresh_token": "rotated"})
        if headers["authorization"] == "Bearer rejected":
            return _reply({"error": {"code": "token_expired"}}, 401)
        events = [
            {"type": "response.output_text.delta", "delta": "hello"},
            {
                "type": "response.output_item.done",
                "item": {"type": "reasoning", "id": "rs_1", "encrypted_content": "opaque-fixture"},
            },
            {
                "type": "response.output_item.done",
                "item": {"type": "message", "content": [{"type": "output_text", "text": "hello"}]},
            },
            {
                "type": "response.completed",
                "response": {"output": [], "usage": {"input_tokens": 9, "output_tokens": 2}},
            },
        ]
        return (
            200,
            "text/event-stream",
            "".join(f"data: {json.dumps(event)}\n\n" for event in events),
        )

    async with _http(route) as url:
        monkeypatch.setattr(oauth, "CODEX" if vendor == "openai-codex" else "XAI", url)
        monkeypatch.setitem(responses.ENDPOINTS, vendor, url + "/responses")
        provider = responses.Responses(vendor, auth, tmp_path / "models.json")
        first, _ = await asyncio.gather(
            *[
                provider.request(
                    ModelRef(vendor, vendors_model),
                    {
                        "systemPrompt": "instructions",
                        "settings": {"reasoning": "high", "maxOutput": 25},
                        "messages": [
                            {"role": "user", "content": [{"type": "text", "text": "greet"}]}
                        ],
                        "tools": [],
                    },
                    ProviderContext("session-abc", "user", sink, lambda: None),
                )
                for _ in range(2)
            ]
        )
        assert first["providerData"] == [
            {"type": "reasoning", "id": "rs_1", "encrypted_content": "opaque-fixture"}
        ]
        await provider.request(
            ModelRef(vendor, vendors_model),
            {
                "systemPrompt": "instructions",
                "settings": {"reasoning": "high", "maxOutput": 25},
                "messages": [
                    first,
                    {"role": "user", "content": [{"type": "text", "text": "next"}]},
                ],
                "tools": [],
            },
            ProviderContext("session-abc", "user", sink, lambda: None),
        )
    token_requests = [body for path, _, body in requests if path.endswith("/token")]
    assert len(token_requests) == 1 and parse_qs(token_requests[0].decode())["refresh_token"] == [
        "old-refresh"
    ]
    assert isinstance(login := auth.login(vendor), OAuth) and login.refresh == "rotated"
    assert len(emitted) == 3 and emitted[0]["event"] == {"type": "text", "delta": "hello"}
    _, headers, body = requests[-1]
    request = json.loads(body)
    assert request["include"] == ["reasoning.encrypted_content"]
    assert headers["authorization"] == "Bearer " + actual
    assert {"type": "reasoning", "id": "rs_1", "encrypted_content": "opaque-fixture"} in request[
        "input"
    ]
    if vendor == "openai-codex":
        assert request["instructions"] == "instructions" and "max_output_tokens" not in request
        assert headers["chatgpt-account-id"] == "loopback-account" and headers["originator"] == "pi"
        assert headers["session-id"] == headers["x-client-request-id"] == "session-abc"
    else:
        assert request["input"][0] == {"role": "system", "content": "instructions"}
        assert request["max_output_tokens"] == 25


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
    ] + ["0.32383276483316237"]


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


@pytest.mark.parametrize("stop", ["kill", "cancel"])
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
    async with offline_agent(project=tmp_path, tools=[code_tool()], script=script) as agent:
        session = await agent.session()
        async with asyncio.timeout(5), asyncio.TaskGroup() as tasks:
            running = tasks.create_task(session.prompt("run code"))
            pid = await entered
            if stop == "kill":
                os.kill(pid, signal.SIGKILL)
            else:
                await session.cancel()
            result = await running
            # Monty's native runtime reaps the child, independently of asyncio.
            while Path(f"/proc/{pid}").exists():
                await asyncio.sleep(0.01)
        if stop == "kill":
            failed, completed = result.tool_results()
            assert failed.status == "failed"
            assert "worker process died" in failed.text()
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
    assert "tools.tool_12(first: str, zed: int = None, alpha: bool = None)" in listing
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

"""Offline checks of the subscription API."""

import asyncio
import base64
from contextlib import asynccontextmanager
import hashlib
from importlib.metadata import version as _package_version
from importlib.resources import files
import json
from pathlib import Path
import time
from urllib.parse import parse_qs, urlsplit

import httpx2
from modular_agent import (
    AgentError,
    ErrorCode,
    ModelFailure,
    ModelRef,
    OAuth,
    Plugin,
    ProviderContext,
    create_agent,
    durable_runtime,
    serve,
    sign_in,
    sign_out,
    subscription_logins,
)
from modular_agent.chatgpt import chatgpt
from modular_agent.grok import grok
import pytest


def test_subscription_table_bytes():
    source = Path(__file__).resolve().parents[2] / "docs/sdk/subscription-models.json"
    assert files("modular_agent").joinpath(source.name).read_bytes() == source.read_bytes()


def test_chatgpt_catalog(tmp_path):
    logins = subscription_logins(tmp_path / "auth.json")
    provider = chatgpt(logins=logins, models=["unlisted-test"])
    models = {m["id"]: m for m in provider.models()}
    assert models["gpt-6.1-sol"]["thinking"] == ["minimal", "low", "medium", "high", "xhigh"]
    assert "thinking" not in models["unlisted-test"]
    assert not provider.available()
    with pytest.raises(AgentError) as exc:
        chatgpt(logins=logins, client_identity="spaces not allowed")
    assert exc.value.code == ErrorCode.INVALID_COMPOSITION


@pytest.fixture
def subscription_http(monkeypatch):
    def install(handler):
        transport = httpx2.MockTransport(handler)
        monkeypatch.setattr(
            "modular_agent._subscription_auth.AsyncClient",
            lambda **kw: httpx2.AsyncClient(transport=transport, **kw),
        )
        monkeypatch.setattr(
            "modular_agent._responses.AsyncClient",
            lambda **kw: httpx2.AsyncClient(transport=transport, **kw),
        )

    return install


def fake_tokens():
    claims = {"https://api.openai.com/auth": {"chatgpt_account_id": "fixture-account"}}
    jwt = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return {
        "access_token": f"fake.{jwt}.fake",
        "refresh_token": "fresh-fixture-refresh",
        "expires_in": 3600,
    }


async def test_invalid_grant_does_not_change_login(tmp_path, subscription_http):
    def refused(request):
        assert request.url == "https://auth.openai.com/oauth/token"
        assert parse_qs(request.content.decode())["refresh_token"] == ["fixture-refresh"]
        return httpx2.Response(
            400, json={"error": "invalid_grant", "error_description": "fixture-refresh"}
        )

    subscription_http(refused)
    path = tmp_path / "auth.json"
    logins = subscription_logins(path)
    await logins.set_login(
        "chatgpt", OAuth("fixture-access", "fixture-refresh", 1, "fixture-account")
    )
    before = path.read_bytes()

    async def emit(piece):
        pytest.fail("No model piece expected")

    cx = ProviderContext("session", None, emit, lambda: None)
    with pytest.raises(ModelFailure, match="Sign in again") as exc:
        await chatgpt(logins=logins).request(ModelRef("chatgpt", "gpt-6.1-sol"), {}, cx)
    assert exc.value.error["kind"] == "credentials"
    assert "fixture-refresh" not in str(exc.value)
    assert path.read_bytes() == before


@pytest.mark.loopback
@pytest.mark.parametrize("form", ["url", "query", "hash", "bare"])
async def test_browser_sign_in_paste_forms(tmp_path, monkeypatch, subscription_http, form):
    monkeypatch.setattr("modular_agent._chatgpt_auth._PORT", 0)
    seen, steps = [], []

    def exchange(request):
        assert request.url == "https://auth.openai.com/oauth/token"
        seen.append(parse_qs(request.content.decode()))
        return httpx2.Response(200, json=fake_tokens())

    subscription_http(exchange)
    lines = iter(["error=fixture-error", "code=wrong&state=wrong"])

    async def paste():
        if line := next(lines, None):
            return line
        authorize = urlsplit(steps[0].url)
        params = parse_qs(authorize.query)
        code, state = "fixture-code", params["state"][0]
        return {
            "url": f"{params['redirect_uri'][0]}?code={code}&state={state}",
            "query": f"code={code}&state={state}",
            "hash": f"{code}#{state}",
            "bare": code,
        }[form]

    logins = subscription_logins(tmp_path / "auth.json")
    options = {"client_identity": "other.App-1"} if form != "url" else {}
    await sign_in("chatgpt", logins, on_step=steps.append, paste=paste, **options)
    assert [step.kind for step in steps] == ["openAndPaste"] * 3
    assert "did not complete" in steps[1].message
    assert "different sign-in" in steps[2].message
    authorize = urlsplit(steps[0].url)
    assert authorize._replace(query="").geturl() == "https://auth.openai.com/oauth/authorize"
    query = parse_qs(authorize.query)
    assert query == {
        "response_type": ["code"],
        "client_id": ["app_EMoamEEZ73f0CkXaXp7hrann"],
        "redirect_uri": seen[0]["redirect_uri"],
        "scope": ["openid profile email offline_access"],
        "code_challenge_method": ["S256"],
        "state": query["state"],
        "code_challenge": [
            base64.urlsafe_b64encode(hashlib.sha256(seen[0]["code_verifier"][0].encode()).digest())
            .decode()
            .rstrip("=")
        ],
        "id_token_add_organizations": ["true"],
        "codex_cli_simplified_flow": ["true"],
        "originator": [options.get("client_identity", "modular-agent")],
    }
    assert seen[0]["code"] == ["fixture-code"]
    assert logins.login("chatgpt").account == "fixture-account"
    await sign_out("chatgpt", logins)
    assert not chatgpt(logins=logins).available()


@pytest.mark.loopback
@pytest.mark.parametrize("busy", [False, True])
async def test_browser_sign_in_callback_or_busy_paste(
    tmp_path, monkeypatch, subscription_http, busy
):
    listener = await asyncio.start_server(lambda *_: None, "127.0.0.1", 0) if busy else None
    port = listener.sockets[0].getsockname()[1] if listener else 0
    monkeypatch.setattr("modular_agent._chatgpt_auth._PORT", port)
    steps = []
    posted = []

    async def callback():
        params = parse_qs(urlsplit(steps[0].url).query)
        redirect = urlsplit(params["redirect_uri"][0])
        if busy:
            assert "port is in use" in steps[0].message
            return f"fixture-code#{params['state'][0]}"
        for state, status in [("wrong", b"400"), (params["state"][0], b"200")]:
            reader, writer = await asyncio.open_connection("127.0.0.1", redirect.port)
            writer.write(
                f"GET /auth/callback?code=fixture-code&state={state} HTTP/1.1\r\n\r\n".encode()
            )
            await writer.drain()
            assert (await reader.read()).startswith(b"HTTP/1.1 " + status)
            writer.close()
            await writer.wait_closed()
        return None

    def exchange(req):
        posted.append(parse_qs(req.content.decode())["code"])
        return httpx2.Response(200, json=fake_tokens())

    subscription_http(exchange)
    try:
        await sign_in(
            "chatgpt",
            subscription_logins(tmp_path / "auth.json"),
            on_step=steps.append,
            paste=callback,
        )
    finally:
        if listener:
            listener.close()
            await listener.wait_closed()
    assert posted == [["fixture-code"]]


@pytest.mark.loopback
@pytest.mark.parametrize("device", [False, True])
async def test_device_sign_in_explicit_or_busy_fallback(
    tmp_path, monkeypatch, subscription_http, device
):
    routes, steps = [], []
    listener = await asyncio.start_server(lambda *_: None, "127.0.0.1", 0)
    monkeypatch.setattr("modular_agent._chatgpt_auth._PORT", listener.sockets[0].getsockname()[1])

    def endpoint(request):
        path = request.url.path
        routes.append(path)
        if path.endswith("/usercode"):
            assert json.loads(request.content) == {"client_id": "app_EMoamEEZ73f0CkXaXp7hrann"}
            return httpx2.Response(
                200,
                json={"user_code": "TEST-0000", "device_auth_id": "fixture-device", "interval": 1},
            )
        if path == "/api/accounts/deviceauth/token":
            assert json.loads(request.content) == {
                "device_auth_id": "fixture-device",
                "user_code": "TEST-0000",
            }
            if routes.count(path) == 1:
                return httpx2.Response(404)
            return httpx2.Response(
                200,
                json={"authorization_code": "fixture-code", "code_verifier": "fixture-verifier"},
            )
        assert path == "/oauth/token"
        body = parse_qs(request.content.decode())
        assert body["redirect_uri"] == ["https://auth.openai.com/deviceauth/callback"]
        assert body["code_verifier"] == ["fixture-verifier"]
        return httpx2.Response(200, json=fake_tokens())

    subscription_http(endpoint)
    logins = subscription_logins(tmp_path / "auth.json")
    async with listener:
        await sign_in("chatgpt", logins, on_step=steps.append, device=device)
    assert [step.kind for step in steps] == ["deviceCode", "waiting"]
    assert steps[0].url == "https://auth.openai.com/codex/device"
    assert steps[0].code == "TEST-0000"
    assert routes == [
        "/api/accounts/deviceauth/usercode",
        "/api/accounts/deviceauth/token",
        "/api/accounts/deviceauth/token",
        "/oauth/token",
    ]
    assert logins.login("chatgpt").account == "fixture-account"


@asynccontextmanager
async def mounted(tmp_path, provider, served, model, runtime_kind, **options):
    if runtime_kind == "durable":
        options = {
            "runtime": durable_runtime(),
            "durability": "durable",
            "data_dir": tmp_path / "state",
            **options,
        }
    if not served:
        async with create_agent(providers=[provider], model=model, **options) as agent:
            yield agent
        return
    token = tmp_path / "service.token"
    token.touch(mode=0o600)
    token.write_text("offline-fixture-token")
    server = await serve(
        Plugin("subscription-test", setup=lambda r: r.provider(provider)),
        listen="127.0.0.1:0",
        token_file=token,
    )
    try:
        async with create_agent(
            service_plugins=[{"url": server.url, "token_file": token}],
            model=model,
            **options,
        ) as agent:
            yield agent
    finally:
        await server.close()


@pytest.mark.loopback
@pytest.mark.parametrize("served", [False, True], ids=["embedded", "served"])
@pytest.mark.parametrize(
    ("model", "identity", "asked", "expected"),
    [
        ("gpt-6.1-sol", None, "off", None),
        ("gpt-6.1-sol", "test-client", "minimal", {"effort": "low", "summary": "auto"}),
        ("gpt-5.6-sol", None, None, None),
        ("fixture-unlisted", None, "xhigh", None),
    ],
)
async def test_chatgpt_request_and_replay(
    tmp_path, git_project, subscription_http, runtime_kind, served, model, identity, asked, expected
):
    seen = []
    failures = []
    opaque = {"type": "reasoning", "id": "r1", "encrypted_content": "opaque-fixture", "summary": []}
    output = [
        opaque,
        {
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": "Hello"}],
        },
    ]

    def endpoint(request):
        if request.url == "https://auth.openai.com/oauth/token":
            return httpx2.Response(400, json={"error": "invalid_grant"})
        assert request.url == "https://chatgpt.com/backend-api/codex/responses"
        seen.append((request.headers, json.loads(request.content)))
        events = [
            {"type": "response.output_text.delta", "delta": "Hello"},
            {"type": "response.completed", "response": {"output": output}},
        ]
        return httpx2.Response(
            200,
            headers={"Content-Type": "text/event-stream"},
            text="".join(f"data: {json.dumps(event)}\n\n" for event in events),
        )

    subscription_http(endpoint)
    logins = subscription_logins(tmp_path / "auth.json")
    await logins.set_login(
        "chatgpt", OAuth("fixture-access", "fixture-refresh", 2**62, "fixture-account")
    )
    options = {"client_identity": identity} if identity else {}
    provider = chatgpt(logins=logins, models=["fixture-unlisted"], **options)
    observe = Plugin(
        "observe-failure", hooks={"model.failed": lambda d: failures.append(d["error"])}
    )
    async with mounted(
        tmp_path,
        provider,
        served,
        f"chatgpt/{model}",
        runtime_kind,
        project=git_project,
        plugins=[observe],
    ) as agent:
        session = await agent.session(settings={"reasoning": asked} if asked else {})
        assert (await session.prompt("First")).text == "Hello"
        assert (await session.prompt("Second")).text == "Hello"
        await logins.set_login("chatgpt", OAuth("old", "old-refresh", 1, "fixture-account"))
        before = logins.path.read_bytes()
        failed = await session.prompt("After expiry")
        assert failed.outcome is not None and failed.outcome.kind == "failed"
        assert failures == [
            {"kind": "credentials", "message": "ChatGPT refused the token refresh. Sign in again."}
        ]
        assert logins.path.read_bytes() == before
    assert len(seen) == 2
    for headers, body in seen:
        assert headers["authorization"] == "Bearer fixture-access"
        assert headers["chatgpt-account-id"] == "fixture-account"
        assert headers["openai-beta"] == "responses=experimental"
        assert headers["user-agent"] == f"modular-agent/{_package_version('modular-agent')}"
        assert headers["content-type"] == "application/json"
        assert headers["originator"] == (identity or "modular-agent")
        assert (
            headers["session-id"]
            == headers["x-client-request-id"]
            == body["prompt_cache_key"]
            == session.id
        )
        assert body["model"] == model and body["stream"] and body["store"] is False
        assert body["include"] == ["reasoning.encrypted_content"]
        assert "max_output_tokens" not in body
        assert body.get("reasoning") == expected
    assert opaque in seen[1][1]["input"]


async def test_sign_in_validates_identity_before_opening_a_connection(tmp_path):
    with pytest.raises(AgentError) as exc:
        await sign_in(
            "chatgpt",
            subscription_logins(tmp_path / "auth.json"),
            on_step=lambda _: None,
            client_identity="é",
        )
    assert exc.value.code == ErrorCode.INVALID_PARAMS


_GROK_ORIGIN = "https://auth.x.ai"
_GROK_CLIENT = "b1a00492-073a-47ea-816f-4c329264a828"
_GROK_ENDPOINT = "https://api.x.ai/v1/responses"
_GROK_DEVICE = {
    "device_code": "fixture-device",
    "user_code": "TEST-CODE",
    "verification_uri": "https://accounts.x.ai/oauth2/device",
}


def test_grok_catalog_and_identity(tmp_path):
    logins = subscription_logins(tmp_path / "auth.json")
    provider = grok(logins=logins, models=["unlisted-test"])
    models = {row["id"]: row for row in provider.models()}
    assert list(models) == ["grok-4.3", "grok-4.5", "grok-4.6", "grok-4.7", "unlisted-test"]
    assert models["grok-4.3"]["maxOutput"] == 30000
    assert models["grok-4.3"]["thinking"] == ["off", "low", "medium", "high", "xhigh"]
    assert models["grok-4.7"]["input"] == ["text", "image"]
    assert models["unlisted-test"]["provider"] == "grok"
    assert not provider.available()
    with pytest.raises(AgentError) as exc:
        grok(logins=logins, client_identity="with spaces")
    assert exc.value.code == ErrorCode.INVALID_COMPOSITION


@pytest.fixture
def poll_delays(monkeypatch):
    delays = []

    async def advance(delay):
        delays.append(delay)
        await asyncio.sleep(0)

    monkeypatch.setattr("modular_agent._subscription_oauth._sleep", advance)
    return delays


@pytest.mark.parametrize("identity", [None, "Custom-Agent_2.0"])
async def test_grok_device_sign_in(tmp_path, subscription_http, poll_delays, identity):
    logins = subscription_logins(tmp_path / "auth.json")
    provider = grok(logins=logins)
    steps = []
    complete = _GROK_DEVICE["verification_uri"] + "?code=TEST-CODE"
    device = (
        {**_GROK_DEVICE, "verification_uri_complete": complete, "interval": 2}
        if identity
        else _GROK_DEVICE
    )
    replies = iter(["authorization_pending", "slow_down", "slow_down", None])

    async def paste():
        pytest.fail("Grok must not ask for a pasted code")

    def endpoint(request):
        assert request.method == "POST"
        assert request.headers["content-type"] == "application/x-www-form-urlencoded"
        form = parse_qs(request.content.decode())
        if request.url == _GROK_ORIGIN + "/oauth2/device/code":
            assert not steps
            assert form == {
                "client_id": [_GROK_CLIENT],
                "scope": ["openid profile email offline_access grok-cli:access api:access"],
                "referrer": [identity or "modular-agent"],
            }
            return httpx2.Response(200, json=device)
        assert request.url == _GROK_ORIGIN + "/oauth2/token"
        assert form == {
            "grant_type": ["urn:ietf:params:oauth:grant-type:device_code"],
            "client_id": [_GROK_CLIENT],
            "device_code": ["fixture-device"],
        }
        assert [step.kind for step in steps] == ["deviceCode", "waiting"]
        if error := next(replies):
            return httpx2.Response(400, json={"error": error})
        return httpx2.Response(
            200, json={"access_token": "fixture-access", "refresh_token": "fixture-refresh"}
        )

    subscription_http(endpoint)
    options = {"client_identity": identity} if identity else {}
    await sign_in(
        "grok", logins, device=bool(identity), paste=paste, on_step=steps.append, **options
    )
    assert steps[0].url == (complete if identity else device["verification_uri"])
    assert steps[0].code == "TEST-CODE"
    assert poll_delays == ([2, 2, 7, 12] if identity else [5, 5, 10, 15])
    assert provider.available()
    login = logins.login("grok")
    assert login.account is None and login.access == "fixture-access"
    await sign_out("grok", logins)
    assert not provider.available()


@pytest.mark.parametrize(
    ("error", "message"),
    [
        ("access_denied", "was denied"),
        ("authorization_denied", "was denied"),
        ("expired_token", "code expired"),
    ],
)
async def test_grok_terminal_oauth_answers(
    tmp_path, subscription_http, poll_delays, error, message
):
    def endpoint(request):
        if request.url.path == "/oauth2/device/code":
            return httpx2.Response(200, json=_GROK_DEVICE)
        assert request.url.path == "/oauth2/token"
        return httpx2.Response(400, json={"error": error})

    subscription_http(endpoint)
    logins = subscription_logins(tmp_path / "auth.json")
    steps = []
    with pytest.raises(AgentError, match=message) as exc:
        await sign_in("grok", logins, on_step=steps.append)
    assert exc.value.code == ErrorCode.UNAVAILABLE
    assert [step.kind for step in steps] == ["deviceCode", "waiting"]
    assert poll_delays == [5]
    assert not grok(logins=logins).available()


@pytest.mark.parametrize("field", ["verification_uri", "verification_uri_complete"])
async def test_grok_refuses_non_https_and_invalid_identity(tmp_path, subscription_http, field):
    def endpoint(request):
        assert request.url.path == "/oauth2/device/code"
        return httpx2.Response(200, json={**_GROK_DEVICE, field: "http://example.test"})

    logins = subscription_logins(tmp_path / "auth.json")
    steps = []
    # Install a transport that fails if identity validation attempts any request.
    subscription_http(lambda _: pytest.fail("Invalid client identity must not reach the service"))
    with pytest.raises(AgentError) as exc:
        await sign_in("grok", logins, on_step=steps.append, client_identity="invalid identity")
    assert exc.value.code == ErrorCode.INVALID_PARAMS

    subscription_http(endpoint)
    with pytest.raises(AgentError, match="not https") as exc:
        await sign_in("grok", logins, on_step=steps.append)
    assert exc.value.code == ErrorCode.UNAVAILABLE
    assert steps == [] and not grok(logins=logins).available()


_OPAQUE = {"type": "reasoning", "id": "r1", "encrypted_content": "opaque-fixture", "summary": []}
_MESSAGE = {
    "type": "message",
    "role": "assistant",
    "content": [{"type": "output_text", "text": "Hello"}],
}


def _grok_stream():
    events = [
        {"type": "response.output_text.delta", "delta": "Hello"},
        {"type": "response.output_item.done", "item": _OPAQUE},
        {"type": "response.output_item.done", "item": _MESSAGE},
        {"type": "response.completed", "response": {"output": []}},
    ]
    return httpx2.Response(
        200,
        headers={"Content-Type": "text/event-stream"},
        text="".join(f"data: {json.dumps(event)}\n\n" for event in events),
    )


@pytest.mark.loopback
@pytest.mark.parametrize("served", [False, True], ids=["embedded", "served"])
@pytest.mark.parametrize("model", ["grok-4.3", "fixture-unlisted"])
async def test_grok_request_replay_and_refused_refresh(
    tmp_path, git_project, subscription_http, runtime_kind, served, model
):
    seen = []
    failures = []

    def endpoint(request):
        if request.url == _GROK_ORIGIN + "/oauth2/token":
            return httpx2.Response(
                400, json={"error": "invalid_grant", "error_description": "fixture-expired-refresh"}
            )
        assert request.url == _GROK_ENDPOINT and request.method == "POST"
        assert dict(request.headers) == {
            "authorization": "Bearer fixture-access",
            "accept": "text/event-stream",
            "content-type": "application/json",
            "content-length": str(len(request.content)),
            "host": "api.x.ai",
            "user-agent": f"modular-agent/{_package_version('modular-agent')}",
        }
        seen.append(json.loads(request.content))
        return _grok_stream()

    subscription_http(endpoint)
    logins = subscription_logins(tmp_path / "auth.json")
    await logins.set_login("grok", OAuth("fixture-access", "fixture-refresh", 2**62))
    provider = grok(logins=logins, models=["fixture-unlisted"], client_identity="Custom-Agent")
    observe = Plugin(
        "observe-failure",
        hooks={
            "model.failed": lambda d: failures.append(d["error"]),
            "turn.before": lambda _: {"add": {"system": "Fixture system prompt"}},
        },
    )
    async with mounted(
        tmp_path,
        provider,
        served,
        f"grok/{model}",
        runtime_kind,
        project=git_project,
        plugins=[observe],
    ) as agent:
        session = await agent.session(settings={"reasoning": "minimal", "maxOutput": 60000})
        assert (await session.prompt("First")).text == "Hello"
        assert (await session.prompt("Second")).text == "Hello"
        await logins.set_login("grok", OAuth("expired", "fixture-expired-refresh", 1))
        before = logins.path.read_bytes()
        failed = await session.prompt("After expiry")
        assert failed.outcome is not None and failed.outcome.kind == "failed"
        assert failures == [
            {"kind": "credentials", "message": "Grok refused the token refresh. Sign in again."}
        ]
        assert logins.path.read_bytes() == before

    first = [
        {"role": "system", "content": "Fixture system prompt"},
        {"role": "user", "content": "First"},
    ]
    body = {
        "model": model,
        "stream": True,
        "store": False,
        "include": ["reasoning.encrypted_content"],
        "tool_choice": "auto",
        "parallel_tool_calls": True,
        "max_output_tokens": 30000 if model == "grok-4.3" else 4096,
    }
    if model == "grok-4.3":
        body["reasoning"] = {"effort": "none", "summary": "auto"}
    assert seen == [
        {**body, "input": first},
        {**body, "input": [*first, _OPAQUE, _MESSAGE, {"role": "user", "content": "Second"}]},
    ]


@pytest.mark.loopback
@pytest.mark.parametrize("served", [False, True], ids=["embedded", "served"])
async def test_grok_concurrent_refresh_keeps_old_refresh_token(
    tmp_path, git_project, monkeypatch, subscription_http, runtime_kind, served
):
    # Stop the first refresh at the HTTP boundary until the other Provider has
    # tried to acquire the same kernel lock. Neither request can race past it.
    import fcntl

    first_post = asyncio.Event()
    contended = asyncio.Event()
    flock = fcntl.flock

    def record_contention(fd, operation):
        try:
            flock(fd, operation)
        except BlockingIOError:
            contended.set()
            raise

    monkeypatch.setattr(fcntl, "flock", record_contention)
    calls = []
    accepted = []

    async def endpoint(request):
        if request.url == _GROK_ORIGIN + "/oauth2/token":
            assert request.headers["content-type"] == "application/x-www-form-urlencoded"
            calls.append(parse_qs(request.content.decode()))
            first_post.set()
            await contended.wait()
            return httpx2.Response(200, json={"access_token": "fixture-fresh"})
        assert request.url == _GROK_ENDPOINT
        if request.headers["authorization"] == "Bearer rejected":
            return httpx2.Response(401, json={"error": {"code": "token_expired"}})
        accepted.append(request.headers["authorization"])
        return _grok_stream()

    subscription_http(endpoint)
    path = tmp_path / "auth.json"
    logins = subscription_logins(path)
    await logins.set_login("grok", OAuth("rejected", "fixture-old-refresh", 2**62))

    start = time.time_ns() // 1_000_000
    async with mounted(
        tmp_path, grok(logins=logins), served, "grok/grok-4.7", runtime_kind, project=git_project
    ) as agent:
        first_session, second_session = await agent.session(), await agent.session()
        async with asyncio.timeout(5), asyncio.TaskGroup() as tasks:
            first = tasks.create_task(first_session.prompt("First"))
            await first_post.wait()
            second = tasks.create_task(second_session.prompt("Second"))
        assert first.result().text == second.result().text == "Hello"
    end = time.time_ns() // 1_000_000
    assert calls == [
        {
            "grant_type": ["refresh_token"],
            "refresh_token": ["fixture-old-refresh"],
            "client_id": [_GROK_CLIENT],
        },
    ]
    assert accepted == ["Bearer fixture-fresh", "Bearer fixture-fresh"]
    login = logins.login("grok")
    assert login.access == "fixture-fresh" and login.refresh == "fixture-old-refresh"
    assert start + 3_300_000 <= login.expires <= end + 3_300_000

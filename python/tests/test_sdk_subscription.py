"""Offline checks of the subscription API."""

import asyncio
import base64
from contextlib import asynccontextmanager
import hashlib
from importlib.resources import files
import json
from pathlib import Path
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
def chatgpt_http(monkeypatch):
    def install(handler):
        transport = httpx2.MockTransport(handler)
        monkeypatch.setattr(
            "modular_agent._chatgpt_auth.AsyncClient",
            lambda **kw: httpx2.AsyncClient(transport=transport, **kw),
        )
        monkeypatch.setattr(
            "modular_agent.chatgpt.AsyncClient",
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


async def test_invalid_grant_does_not_change_login(tmp_path, chatgpt_http):
    def refused(request):
        assert request.url == "https://auth.openai.com/oauth/token"
        assert parse_qs(request.content.decode())["refresh_token"] == ["fixture-refresh"]
        return httpx2.Response(
            400, json={"error": "invalid_grant", "error_description": "fixture-refresh"}
        )

    chatgpt_http(refused)
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
async def test_browser_sign_in_paste_forms(tmp_path, monkeypatch, chatgpt_http, form):
    monkeypatch.setattr("modular_agent._chatgpt_auth._PORT", 0)
    seen, steps = [], []

    def exchange(request):
        assert request.url == "https://auth.openai.com/oauth/token"
        seen.append(parse_qs(request.content.decode()))
        return httpx2.Response(200, json=fake_tokens())

    chatgpt_http(exchange)
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
async def test_browser_sign_in_callback_or_busy_paste(tmp_path, monkeypatch, chatgpt_http, busy):
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

    chatgpt_http(exchange)
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
    tmp_path, monkeypatch, chatgpt_http, device
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

    chatgpt_http(endpoint)
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
    tmp_path, chatgpt_http, runtime_kind, served, model, identity, asked, expected
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

    chatgpt_http(endpoint)
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
        tmp_path, provider, served, f"chatgpt/{model}", runtime_kind, plugins=[observe]
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

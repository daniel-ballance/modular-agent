"""Offline checks of the subscription API."""

import base64
from importlib.resources import files
import json
from pathlib import Path
from urllib.parse import parse_qs

import httpx2
from modular_agent import (
    AgentError,
    ErrorCode,
    ModelFailure,
    ModelRef,
    OAuth,
    ProviderContext,
    sign_in,
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


async def test_sign_in_validates_identity_before_opening_a_connection(tmp_path):
    with pytest.raises(AgentError) as exc:
        await sign_in(
            "chatgpt",
            subscription_logins(tmp_path / "auth.json"),
            on_step=lambda _: None,
            client_identity="é",
        )
    assert exc.value.code == ErrorCode.INVALID_PARAMS

"""ChatGPT subscription Provider over the streamed Responses API."""

from collections.abc import Sequence

from httpx2 import AsyncClient

from ._chatgpt_auth import account, refresh
from ._provider import ModelInfo
from ._responses import ResponsesProvider
from ._subscription_logins import Login, OAuth, SubscriptionLogins
from ._subscription_oauth import DEFAULT_CLIENT_IDENTITY


class ChatGPT(ResponsesProvider):
    id = "chatgpt"
    _label = "ChatGPT"
    _endpoint = "https://chatgpt.com/backend-api/codex/responses"

    async def _refresh(self, client: AsyncClient, old: OAuth) -> OAuth:
        return await refresh(client, old)

    def _extra_headers(self, login: Login, session: str) -> dict[str, str]:
        return {
            "User-Agent": "modular-agent/0.1.0",
            "chatgpt-account-id": (login.account if isinstance(login, OAuth) else None)
            or account(login.secret),
            "OpenAI-Beta": "responses=experimental",
            "originator": self._client_identity,
            "session-id": session,
            "x-client-request-id": session,
        }


def chatgpt(
    *,
    logins: SubscriptionLogins,
    models: Sequence[str | ModelInfo] | None = None,
    client_identity: str = DEFAULT_CLIENT_IDENTITY,
) -> ChatGPT:
    """Use the ChatGPT subscription saved in a login file."""
    return ChatGPT(logins, models=models, client_identity=client_identity)

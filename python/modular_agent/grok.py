"""Grok subscription Provider over the streamed Responses API."""

from collections.abc import Sequence
from typing import NotRequired, cast

from httpx2 import AsyncClient

from ._grok_auth import refresh
from ._provider import ModelInfo
from ._responses import ResponsesProvider
from ._subscription_logins import OAuth, SubscriptionLogins
from ._subscription_oauth import DEFAULT_CLIENT_IDENTITY


class GrokModelInfo(ModelInfo):
    """A catalog entry with an optional explicit mapping to Grok reasoning effort."""

    effort: NotRequired[dict[str, str]]


class Grok(ResponsesProvider):
    id = "grok"
    _label = "Grok"
    _endpoint = "https://api.x.ai/v1/responses"
    _system_message = True

    def __init__(
        self,
        logins: SubscriptionLogins,
        *,
        models: Sequence[str | ModelInfo] | None,
        client_identity: str,
    ) -> None:
        super().__init__(logins, models=models, client_identity=client_identity)
        for entry in models or ():
            if not isinstance(entry, str) and "effort" in entry:
                self._catalog.set_effort(entry["id"], cast(GrokModelInfo, entry)["effort"])

    async def _refresh(self, client: AsyncClient, old: OAuth) -> OAuth:
        return await refresh(client, old)


def grok(
    *,
    logins: SubscriptionLogins,
    models: Sequence[str | ModelInfo | GrokModelInfo] | None = None,
    client_identity: str = DEFAULT_CLIENT_IDENTITY,
) -> Grok:
    """Use the Grok subscription saved in a login file."""
    return Grok(logins, models=models, client_identity=client_identity)

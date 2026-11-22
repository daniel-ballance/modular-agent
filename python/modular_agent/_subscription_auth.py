"""Public sign-in and sign-out for subscription Providers with an SDK login."""

from httpx2 import AsyncClient, HTTPError

from ._chatgpt_auth import browser_sign_in, device_sign_in as chatgpt_device
from ._grok_auth import device_sign_in as grok_device
from ._subscription_logins import SubscriptionLogins
from ._subscription_oauth import DEFAULT_CLIENT_IDENTITY, Paste, Show, validate_client_identity
from ._types import AgentError, ErrorCode

_LABELS = {"chatgpt": "ChatGPT", "grok": "Grok"}


async def sign_in(
    provider: str,
    logins: SubscriptionLogins,
    *,
    on_step: Show,
    device: bool = False,
    paste: Paste | None = None,
    client_identity: str = DEFAULT_CLIENT_IDENTITY,
) -> None:
    """Sign in to ChatGPT or Grok and save the login. Never opens a browser."""
    if provider not in _LABELS:
        raise AgentError(ErrorCode.INVALID_PARAMS, "SDK sign-in supports chatgpt and grok")
    identity = validate_client_identity(client_identity, ErrorCode.INVALID_PARAMS)
    try:
        async with AsyncClient(timeout=30, follow_redirects=False, trust_env=False) as client:
            if provider == "grok":
                login = await grok_device(client, on_step, identity)
            elif device:
                login = await chatgpt_device(client, on_step)
            else:
                login = await browser_sign_in(client, on_step, paste, identity)
    except TimeoutError:
        raise AgentError(ErrorCode.UNAVAILABLE, "The sign-in was not completed in time.") from None
    except HTTPError:
        raise AgentError(
            ErrorCode.UNAVAILABLE, f"Could not reach the {_LABELS[provider]} sign-in endpoint."
        ) from None
    except (OSError, ValueError) as exc:
        raise AgentError(ErrorCode.UNAVAILABLE, str(exc)) from None
    await logins.set_login(provider, login)


async def sign_out(provider: str, logins: SubscriptionLogins) -> None:
    """Remove the local login. Does not revoke it with the vendor."""
    if provider not in _LABELS:
        raise AgentError(ErrorCode.INVALID_PARAMS, "SDK sign-out supports chatgpt and grok")
    await logins.set_login(provider, None)

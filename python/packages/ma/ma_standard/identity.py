"""The client label sent to subscription services."""

import re
from typing import Final

DEFAULT_CLIENT_IDENTITY: Final = "modular-agent"


def validate_client_identity(value: str, *, name: str = "client_identity") -> str:
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", value):
        raise ValueError(f"{name} must be 1 to 64 characters from A-Z, a-z, 0-9, ., _ and -")
    return value

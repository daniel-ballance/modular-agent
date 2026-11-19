"""Shared request/response HTTP transport for API-key Providers."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any, Literal, cast

import httpx2

from ._provider import ModelFailure, ModelInfo, ProviderSupports
from ._types import Json, JsonObject


def _failure(kind: str, message: str) -> ModelFailure:
    return ModelFailure(
        {
            "kind": cast(
                Literal["temporary", "contextTooLarge", "credentials", "refused", "other"], kind
            ),
            "message": message,
        }
    )


class _HttpProvider:
    supports = ProviderSupports(safe_to_repeat=True)

    def __init__(self, provider: str, models: tuple[str, ...], base_url: str) -> None:
        self.id = provider
        self._models = models
        self._base_url = base_url.rstrip("/")

    def models(self) -> list[ModelInfo]:
        return [
            {
                "provider": self.id,
                "id": name,
                "contextWindow": 128_000,
                "maxOutput": 4096,
                "input": ["text"],
                "reasoning": False,
                "thinking": ["off"],
            }
            for name in self._models
        ]

    async def _events(
        self, path: str, headers: dict[str, str], body: JsonObject
    ) -> AsyncIterator[dict[str, Any]]:
        try:
            async with httpx2.AsyncClient(
                timeout=httpx2.Timeout(60, connect=10), trust_env=False
            ) as client:
                async with client.stream(
                    "POST", self._base_url + path, headers=headers, json=body
                ) as response:
                    if response.is_error or response.is_redirect:
                        status = response.status_code
                        kind = (
                            "credentials"
                            if status in {401, 403}
                            else "temporary"
                            if status in {408, 429} or status >= 500
                            else "other"
                        )
                        # Inspect only a bounded body; never expose it, since it may echo input or a key.
                        if status in {400, 413}:
                            iterator = response.aiter_bytes(chunk_size=16384)
                            raw = await anext(iterator, b"")
                            if (
                                status == 413
                                or b"context_length_exceeded" in raw
                                or b"prompt is too long" in raw
                            ):
                                kind = "contextTooLarge"
                        raise _failure(kind, f"{self.id} returned HTTP {status}")
                    data: list[str] = []
                    async for line in response.aiter_lines():
                        if line.startswith("data:"):
                            data.append(line[5:].strip())
                        elif not line and data:
                            frame = "\n".join(data)
                            data.clear()
                            if frame != "[DONE]":
                                yield _frame(frame)
                    if data and data != ["[DONE]"]:
                        yield _frame("\n".join(data))
        except (httpx2.NetworkError, httpx2.TimeoutException, httpx2.RemoteProtocolError) as exc:
            raise _failure("temporary", f"{self.id} connection failed") from exc
        except (httpx2.HTTPError, ValueError) as exc:
            raise _failure("other", f"Invalid {self.id} response") from exc


def _frame(raw: str) -> dict[str, Any]:
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("Invalid SSE payload")
    return value


def _rows(value: Json) -> list[JsonObject]:
    return [v for v in value if isinstance(v, dict)] if isinstance(value, list) else []


def _argument(value: str) -> Json:
    try:
        return cast(Json, json.loads(value))
    except ValueError:
        return value  # The tool dispatcher reports invalid arguments as a failed tool result.


def _tools(request: JsonObject) -> list[JsonObject]:
    return _rows(request.get("tools"))


def _max_tokens(request: JsonObject) -> int:
    settings = request.get("settings")
    value = settings.get("maxOutput") if isinstance(settings, dict) else None
    return value if type(value) is int and value > 0 else 4096

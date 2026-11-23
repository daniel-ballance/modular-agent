"""The developer-facing Provider API and its native adapter."""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, NotRequired, Protocol, TypedDict, cast
from uuid import NAMESPACE_URL, uuid5

from ma_core import Plugin as _BasePlugin
from ma_core import lower_reasoning
from ma_core.wire import model_in, request_for_provider, request_out, response_in

from ._credentials import CredentialStore
from ._types import AgentError, ErrorCode, Json, JsonObject, ModelRef


class ModelInfo(TypedDict):
    provider: str
    id: str
    contextWindow: int
    maxOutput: int
    input: list[str]
    reasoning: bool
    thinking: NotRequired[list[str]]


class ModelError(TypedDict):
    kind: Literal["temporary", "contextTooLarge", "credentials", "refused", "other"]
    message: str


class ModelFailure(Exception):
    def __init__(self, error: ModelError) -> None:
        super().__init__(error["message"])
        self.error = error


@dataclass(frozen=True)
class ProviderSupports:
    keeps_state: bool = False
    safe_to_repeat: bool = False


@dataclass
class ProviderContext:
    session_id: str | None
    actor_id: str | None
    _emit: Callable[[JsonObject], Awaitable[None]]
    _credential: Callable[[], str | None]
    cancelled: asyncio.Event = field(default_factory=asyncio.Event)
    _active: bool = True
    _named_credential: Callable[[str], str | None] | None = None

    def _check(self) -> None:
        if not self._active:
            raise AgentError(ErrorCode.INVALID_REQUEST, "Model request has settled")

    def credential(self, name: str | None = None) -> str | None:
        self._check()
        if name is None:
            return self._credential()
        if self._named_credential is None:
            raise AgentError(
                ErrorCode.NOT_SUPPORTED, "Named credentials require an in-process Provider"
            )
        return self._named_credential(name)

    async def piece(self, type: str, delta: Json, tool_call_id: str | None = None) -> None:
        self._check()
        event = {"type": type, "delta": delta}
        if tool_call_id is not None:
            event["toolCallId"] = tool_call_id
        await self._emit({"event": event})


class ProviderCatalog:
    """Optional mixin for Providers that signal catalog changes to embedded hosts."""

    _catalog_revision = 0

    def changed(self) -> None:
        self._catalog_revision += 1


class Provider(Protocol):
    id: str
    supports: ProviderSupports

    def models(self) -> Sequence[ModelInfo]: ...

    async def request(
        self, model: ModelRef, request: JsonObject, context: ProviderContext
    ) -> JsonObject: ...


async def _available(provider: Provider) -> bool:
    available = getattr(provider, "available", None)
    if available is None:
        return True
    value = available()
    return bool(await value if inspect.isawaitable(value) else value)


def _models(provider: Provider) -> list[ModelInfo]:
    models = list(provider.models())
    if any(m["provider"] != provider.id or not m["id"] for m in models) or len(
        {m["id"] for m in models}
    ) != len(models):
        raise AgentError(ErrorCode.INVALID_COMPOSITION, f"Invalid catalog for {provider.id}")
    return models


async def _request(
    provider: Provider,
    model: ModelRef,
    info: ModelInfo,
    request: JsonObject,
    cx: ProviderContext,
) -> JsonObject:
    error: JsonObject
    try:
        settings = request.get("settings", {})
        if isinstance(settings, dict):
            requested = settings.get("reasoning")
            if requested is not None:
                offered = info.get("thinking", [])
                level = lower_reasoning(requested, offered)
                if level not in offered:
                    request = {
                        **request,
                        "settings": {
                            k: v for k, v in settings.items() if k not in {"reasoning", "thinking"}
                        },
                    }
                elif level != requested:
                    request = {**request, "settings": {**settings, "reasoning": level}}
        return await provider.request(model, request, cx)
    except ModelFailure as exc:
        error = {"kind": exc.error["kind"], "message": exc.error["message"]}
    except asyncio.CancelledError:
        cx.cancelled.set()
        raise
    except Exception as exc:
        error = {"kind": "other", "message": str(exc) or type(exc).__name__}
    finally:
        cx._active = False
    return {"role": "assistant", "stop": "failed", "content": [], "error": error}


class _ProviderAdapter(_BasePlugin):  # type: ignore[misc]  # Untyped base adapter.
    role = "provider"

    def __init__(self, provider: Provider, credentials: CredentialStore | None = None) -> None:
        self.provider = provider
        self.credentials = credentials
        self.name = provider.id
        self._cached: tuple[int, list[ModelInfo]] | None = None
        self.declarations = {
            "stateful": provider.supports.keeps_state,
            "requests_safe_to_repeat": provider.supports.safe_to_repeat,
        }

    async def start(self, api: Any) -> None:
        await super().start(api)
        api.provide(self.name, self)

    async def catalog(self, d: JsonObject, emit: Any) -> list[JsonObject]:
        if not await _available(self.provider):
            return []
        revision = (
            self.provider._catalog_revision if isinstance(self.provider, ProviderCatalog) else None
        )
        if revision is None:
            models = _models(self.provider)
        elif self._cached is None or self._cached[0] != revision:
            models = _models(self.provider)
            self._cached = (revision, models)
        else:
            models = self._cached[1]
        supports = self.provider.supports
        result = []
        for model in models:
            native = model_in(model, {"keepsState": supports.keeps_state})
            # Selection adds the provider prefix; native tools expect a bare model id.
            native["id"] = model["id"]
            native["provider"].update(
                id=self.name,
                requests_safe_to_repeat=supports.safe_to_repeat,
                explicit_repeat_promise=True,
            )
            native["model_ref"] = {"provider": self.name, "id": model["id"]}
            result.append(native)
        return result

    async def generate(self, d: dict[str, Any], emit: Any) -> JsonObject:
        import os

        model = ModelRef(self.name, d["access"]["id"])
        info = next((item for item in self.provider.models() if item["id"] == model.id), None)
        if info is None:
            raise AgentError(ErrorCode.INVALID_REQUEST, f"Unknown model: {model}")
        cx = ProviderContext(
            d.get("session"),
            d.get("actor"),
            emit,
            lambda: (
                self.credentials.read(self.name)
                if self.credentials is not None
                else os.getenv(self.name.upper().replace("-", "_") + "_API_KEY")
            ),
            _named_credential=self.credentials.read if self.credentials is not None else None,
        )
        request = request_for_provider(d.get("_shared_request") or request_out(d), self.name)
        reply = await _request(self.provider, model, info, request, cx)
        response = response_in({**reply, "model": {"provider": self.name, "id": model.id}})
        # Vendor ids can repeat across sessions/turns. Bind them to the recorded attempt.
        for call in response.get("calls", []):
            call["_provider_call_id"] = call["id"]
            call["id"] = uuid5(NAMESPACE_URL, f"{d['attempt_id']}:{call['id']}").hex
        return cast(JsonObject, response)

    async def discard(self, d: dict[str, Any], emit: Any) -> JsonObject:
        discard = getattr(self.provider, "discard_state", None)
        if discard is not None:
            await discard(d["session"])
        return {}

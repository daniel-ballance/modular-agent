"""Request, stream and replay handling for subscription Responses Providers."""

from abc import ABC, abstractmethod
from collections.abc import Sequence
from copy import deepcopy
import json
from typing import Literal

from httpx2 import AsyncClient, HTTPError, Timeout

from ._subscription_oauth import validate_client_identity
from ._provider import ModelFailure, ModelInfo, ProviderContext, ProviderSupports
from importlib.metadata import version as _package_version

from ._subscription_logins import Login, OAuth, SubscriptionLogins
from ._subscription_models import SubscriptionModels
from ._types import AgentError, ErrorCode, Json, JsonObject, ModelRef

# Sent on every model request, as the other SDKs do.
USER_AGENT = f"modular-agent/{_package_version('modular-agent')}"


def _obj(value: Json) -> JsonObject:
    return value if isinstance(value, dict) else {}


def _rows(value: Json) -> list[JsonObject]:
    return [row for row in value if isinstance(row, dict)] if isinstance(value, list) else []


def _text(parts: list[JsonObject]) -> str:
    return "".join(str(p.get("text", "")) for p in parts if p.get("type") == "text")


def _input_rows(provider: str, request: JsonObject) -> list[JsonObject]:
    rows: list[JsonObject] = []
    for message in _rows(request.get("messages")):
        role = message.get("role")
        parts = _rows(message.get("content"))
        text = _text(parts)
        images: list[JsonObject] = [
            {"type": "input_image", "image_url": f"data:{p['mimeType']};base64,{p['data']}"}
            for p in parts
            if p.get("type") == "image"
        ]
        if role == "assistant":
            calls = [p for p in parts if p.get("type") == "toolCall"]
            opaque = _obj(message.get("providerData"))
            if opaque.get("provider") == provider and isinstance(opaque.get("output"), list):
                ids = iter(calls)
                for item in _rows(opaque["output"]):
                    if item.get("type") == "function_call" and (call := next(ids, None)):
                        item = {**item, "call_id": call["id"]}
                    rows.append(item)
                continue
            if text:
                rows.append({"role": "assistant", "content": text})
            for call in calls:
                rows.append(
                    {
                        "type": "function_call",
                        "call_id": call["id"],
                        "name": call["name"],
                        "arguments": json.dumps(
                            call.get("arguments", {}), ensure_ascii=False, separators=(",", ":")
                        ),
                    }
                )
        elif role == "toolResult":
            rows.append(
                {"type": "function_call_output", "call_id": message["toolCallId"], "output": text}
            )
            if images:
                rows.append({"role": "user", "content": list(images)})
        else:
            rows.append(
                {
                    "role": role,
                    "content": [{"type": "input_text", "text": text}, *images] if images else text,
                }
            )
    return rows


def _request_body(
    provider: str,
    model: str,
    request: JsonObject,
    session: str,
    reasoning: JsonObject,
    max_output: int,
    *,
    system_message: bool,
) -> JsonObject:
    messages = _input_rows(provider, request)
    tools: list[Json] = [
        {
            "type": "function",
            "name": t["name"],
            "description": t["description"],
            "parameters": t["parameters"],
            "strict": False,
        }
        for t in _rows(request.get("tools"))
    ]
    body: JsonObject = {
        "model": model,
        "stream": True,
        "store": False,
        "include": ["reasoning.encrypted_content"],
        "tool_choice": "auto",
        "parallel_tool_calls": True,
    }
    if tools:
        body["tools"] = tools
    if reasoning:
        body["reasoning"] = {**_obj(reasoning.get("reasoning")), "summary": "auto"}
    system = request.get("systemPrompt")
    if system_message:
        if isinstance(system, str) and system:
            messages.insert(0, {"role": "system", "content": system})
        limit = _obj(request.get("settings")).get("maxOutput")
        if type(limit) is int and limit > 0:
            body["max_output_tokens"] = min(limit, max_output)
    else:
        # The Codex backend sets its own output limit and refuses one here.
        body.update(
            instructions=system or "You are a helpful assistant.",
            text={"verbosity": "low"},
            prompt_cache_key=session,
        )
    body["input"] = list(messages)
    return body


def _response_body(provider: str, raw: JsonObject, *, strict_arguments: bool) -> JsonObject:
    if not isinstance(raw.get("output"), list):
        raise ValueError("the model response has no output")
    parts: list[JsonObject] = []
    output = _rows(raw["output"])
    for item in output:
        kind = item.get("type")
        if kind == "message":
            for p in _rows(item.get("content")):
                if p.get("type") == "output_text":
                    parts.append({"type": "text", "text": p.get("text", "")})
                elif p.get("type") == "refusal":
                    parts.append({"type": "text", "text": p.get("refusal", "model refused")})
                else:
                    parts.append(p)
        elif kind == "function_call":
            if not isinstance(id := item.get("call_id"), str):
                raise ValueError("missing tool call id")
            if not isinstance(name := item.get("name"), str):
                raise ValueError("missing tool name")
            try:
                args = json.loads(str(item.get("arguments", "{}")).strip() or "{}")
            except ValueError:
                if strict_arguments:
                    raise
                args = item.get("arguments", "")
            parts.append({"type": "toolCall", "id": id, "name": name, "arguments": args})
        elif kind == "reasoning":
            parts.append(
                {
                    "type": "reasoning",
                    "text": _text([{**p, "type": "text"} for p in _rows(item.get("summary"))]),
                }
            )
        else:
            parts.append(item)
    usage = _obj(raw.get("usage"))
    stop = (
        "length"
        if raw.get("status") == "incomplete"
        else "toolUse"
        if any(p["type"] == "toolCall" for p in parts)
        else "finished"
    )
    return {
        "role": "assistant",
        "stop": stop,
        "content": list(parts),
        "providerData": {"provider": provider, "output": list(output)},
        "usage": {
            "input": usage.get("input_tokens", 0),
            "output": usage.get("output_tokens", 0),
            "cacheRead": _obj(usage.get("input_tokens_details")).get("cached_tokens", 0),
        },
    }


def _failure(label: str, error: Json, status: int = 0) -> ModelFailure:
    data = _obj(error)
    code = str(data.get("code") or data.get("type") or "")
    kind: Literal["temporary", "contextTooLarge", "credentials", "refused", "other"]
    if code in {"context_length_exceeded", "context_window_exceeded"}:
        kind = "contextTooLarge"
    elif code in {"usage_limit_reached", "usage_not_included", "insufficient_quota"}:
        kind = "other"
    elif code in {"invalid_api_key", "authentication_error", "token_expired"} or status in {
        401,
        403,
    }:
        kind = "credentials"
    elif (
        code in {"rate_limit_exceeded", "server_error", "overloaded"}
        or status == 429
        or 500 <= status <= 599
    ):
        kind = "temporary"
    elif code == "content_policy_violation":
        kind = "refused"
    else:
        kind = "other"
    message = (
        f"{label} rejected the model request."
        if status == 0
        else f"{label} returned HTTP {status}."
    )
    if kind == "credentials":
        message += " Sign in again."
    return ModelFailure({"kind": kind, "message": message})


class ResponsesProvider(ABC):
    id: str
    _label: str
    _endpoint: str
    _system_message = False
    supports = ProviderSupports()

    def __init__(
        self,
        logins: SubscriptionLogins,
        *,
        models: Sequence[str | ModelInfo] | None,
        client_identity: str,
    ) -> None:
        self._logins = logins
        self._client_identity = validate_client_identity(client_identity)
        self._catalog = SubscriptionModels(self.id, models, override_limits=True)

    @abstractmethod
    async def _refresh(self, client: AsyncClient, old: OAuth) -> OAuth: ...

    def _extra_headers(self, login: Login, session: str) -> dict[str, str]:
        return {}

    def available(self) -> bool:
        return self._logins.login(self.id) is not None

    def models(self) -> list[ModelInfo]:
        return deepcopy(list(self._catalog.infos.values()))

    async def request(
        self, model: ModelRef, request: JsonObject, context: ProviderContext
    ) -> JsonObject:
        if model.provider != self.id or model.id not in self._catalog.infos:
            raise AgentError(ErrorCode.INVALID_REQUEST, f"Unknown {self._label} model")
        session = context.session_id or ""
        body = _request_body(
            self.id,
            model.id,
            request,
            session,
            self._catalog.reasoning(model.id, request),
            self._catalog.infos[model.id]["maxOutput"],
            system_message=self._system_message,
        )
        async with AsyncClient(
            timeout=Timeout(300, connect=15), follow_redirects=False, trust_env=False
        ) as client:
            if self._system_message:
                # Keep only the explicit headers and the HTTP/JSON framing.
                client.headers.clear()

            async def renew(old: OAuth) -> OAuth:
                return await self._refresh(client, old)

            rejected: str | None = None
            while True:
                try:
                    login = await self._logins.current(self.id, renew, rejected=rejected)
                    headers = {
                        "Accept": "text/event-stream",
                        "Authorization": "Bearer " + login.secret,
                        "User-Agent": USER_AGENT,
                        **self._extra_headers(login, session),
                    }
                except (OSError, ValueError):
                    raise ModelFailure(
                        {
                            "kind": "credentials",
                            "message": f"Could not read the {self._label} login. Check the login file or sign in again.",
                        }
                    ) from None
                try:
                    async with client.stream(
                        "POST", self._endpoint, json=body, headers=headers
                    ) as result:
                        if (
                            result.status_code == 401
                            and rejected is None
                            and isinstance(login, OAuth)
                        ):
                            rejected = login.access
                            continue
                        if not result.is_success:
                            raw = (await result.aread()).decode(errors="replace")
                            try:
                                error: Json = json.loads(raw)
                            except ValueError:
                                error = raw[:500]
                            raise _failure(
                                self._label, _obj(error).get("error", error), result.status_code
                            )
                        completed: JsonObject | None = None
                        items: list[Json] = []
                        data: list[str] = []
                        size = 0
                        async for line in result.aiter_lines():
                            if line.startswith("data:"):
                                size += len(line.encode())
                                if size >= 16 * 1024**2:
                                    raise ValueError("model event too large")
                                data.append(line[5:].lstrip())
                            if line or not data:
                                continue
                            payload = "\n".join(data)
                            size, data = 0, []
                            if payload == "[DONE]":
                                continue
                            event = _obj(json.loads(payload))
                            kind = event.get("type")
                            if kind == "response.output_text.delta":
                                await context.piece("text", event.get("delta", ""))
                            elif kind in (
                                "response.reasoning_summary_text.delta",
                                "response.reasoning_text.delta",
                            ):
                                await context.piece("reasoning", event.get("delta", ""))
                            elif kind == "response.output_item.done":
                                items.append(event["item"])
                            elif kind in (
                                "response.completed",
                                "response.incomplete",
                                "response.done",
                            ):
                                completed = _obj(event.get("response"))
                            elif kind == "response.failed":
                                raise _failure(
                                    self._label, _obj(event.get("response")).get("error")
                                )
                            elif kind == "error":
                                raise _failure(self._label, event.get("error", event))
                        if completed is None:
                            raise ModelFailure(
                                {
                                    "kind": "temporary",
                                    "message": "the model stream ended before a complete response",
                                }
                            )
                        if not completed.get("output") and items:
                            completed["output"] = items
                        return _response_body(
                            self.id, completed, strict_arguments=self._system_message
                        )
                except HTTPError:
                    raise ModelFailure(
                        {"kind": "temporary", "message": f"Could not reach {self._label}."}
                    ) from None
                except (KeyError, ValueError):
                    raise ModelFailure(
                        {"kind": "other", "message": f"Invalid {self._label} response."}
                    ) from None

"""Grok subscription requests over the Responses API."""

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Literal, cast

from httpx2 import AsyncClient, HTTPError, Timeout
from modular_agent import (
    Json,
    JsonObject,
    ModelFailure,
    ModelInfo,
    ModelRef,
    ProviderContext,
    ProviderSupports,
    OAuth,
    SubscriptionLogins,
)

from .config import model_overrides
from .identity import DEFAULT_CLIENT_IDENTITY, validate_client_identity
from .oauth import refresh

ENDPOINT = "https://api.x.ai/v1/responses"
LEVELS = ("off", "minimal", "low", "medium", "high", "xhigh")


def _obj(value: Json) -> JsonObject:
    return value if isinstance(value, dict) else {}


def _rows(value: Json) -> list[JsonObject]:
    return [row for row in value if isinstance(row, dict)] if isinstance(value, list) else []


def _text(parts: list[JsonObject]) -> str:
    return "".join(str(p.get("text", "")) for p in parts if p.get("type") == "text")


@dataclass(frozen=True)
class Model:
    id: str
    context: int
    maximum: int
    effort: dict[str, str]

    @classmethod
    def parse(cls, row: JsonObject) -> "Model":
        model, context, maximum, effort = (
            row.get(k) for k in ("id", "contextWindow", "maxTokens", "effort")
        )
        if (
            not isinstance(model, str)
            or not model
            or type(context) is not int
            or context <= 0
            or type(maximum) is not int
            or maximum <= 0
        ):
            raise ValueError("models need id, contextWindow and maxTokens")
        if effort is not None and (
            not isinstance(effort, dict) or any(not isinstance(v, str) for v in effort.values())
        ):
            raise ValueError("model effort must be an object of strings")
        return cls(model, context, maximum, cast(dict[str, str], effort or {}))


def _input_rows(request: JsonObject) -> list[JsonObject]:
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
            rows.extend(
                row for row in _rows(message.get("providerData")) if row.get("type") == "reasoning"
            )
            calls = [p for p in parts if p.get("type") == "toolCall"]
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


def request_body(model: Model, request: JsonObject) -> JsonObject:
    messages = _input_rows(request)
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
        "model": model.id,
        "stream": True,
        "store": False,
        "include": ["reasoning.encrypted_content"],
        "tool_choice": "auto",
        "parallel_tool_calls": True,
    }
    if tools:
        body["tools"] = tools
    settings = _obj(request.get("settings"))
    level = str(settings.get("reasoning", "off"))
    if level in LEVELS:
        for offered in reversed(LEVELS[: LEVELS.index(level) + 1]):
            if offered in model.effort:
                body["reasoning"] = {"effort": model.effort[offered], "summary": "auto"}
                break
    system = str(request.get("systemPrompt", ""))
    if system:
        messages.insert(0, {"role": "system", "content": system})
    limit = settings.get("maxOutput", settings.get("max_output", model.maximum))
    if type(limit) is int and limit > 0:
        body["max_output_tokens"] = min(limit, model.maximum)
    body["input"] = list(messages)
    return body


def response_body(raw: JsonObject) -> JsonObject:
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
            except ValueError as exc:
                raise ValueError(f"the model sent tool arguments that are not JSON: {exc}") from exc
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
        **(
            {"providerData": list[Json](reasoning)}
            if (reasoning := [p for p in output if p.get("type") == "reasoning"])
            else {}
        ),
        "usage": {
            "input": usage.get("input_tokens", 0),
            "output": usage.get("output_tokens", 0),
            "cacheRead": _obj(usage.get("input_tokens_details")).get("cached_tokens", 0),
        },
    }


def _failure(error: Json, status: int = 0) -> ModelFailure:
    data = _obj(error)
    code = str(data.get("code") or data.get("type") or "")
    message = str(
        data.get("message")
        or data.get("detail")
        or (error if isinstance(error, str) and error else "the model service refused the request")
    )
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
    suffix = f" ({code})" if code else f" (HTTP {status})" if status else ""
    return ModelFailure({"kind": kind, "message": message + suffix})


class Grok:
    id = "grok"
    supports = ProviderSupports()

    def __init__(
        self,
        auth: SubscriptionLogins,
        overrides: Path,
        *,
        client_identity: str = DEFAULT_CLIENT_IDENTITY,
    ) -> None:
        self.auth = auth
        validate_client_identity(client_identity)
        built = model_overrides(Path(__file__).with_name("models.json"), self.id)
        extra = model_overrides(overrides, self.id)
        self.catalog: dict[str, Model] = {}
        for model in map(Model.parse, built + extra):
            self.catalog.pop(model.id, None)
            self.catalog[model.id] = model

    def models(self) -> list[ModelInfo]:
        return [
            {
                "provider": self.id,
                "id": m.id,
                "contextWindow": m.context,
                "maxOutput": m.maximum,
                "input": ["text", "image"],
                "reasoning": any(level != "off" for level in m.effort),
                "thinking": [level for level in LEVELS if level in m.effort],
            }
            for m in self.catalog.values()
        ]

    async def request(
        self, model: ModelRef, request: JsonObject, context: ProviderContext
    ) -> JsonObject:
        body = request_body(self.catalog[model.id], request)
        headers = {"Accept": "text/event-stream", "User-Agent": "modular-agent/0.1.0"}
        async with AsyncClient(
            timeout=Timeout(300, connect=15), follow_redirects=False, trust_env=False
        ) as client:

            async def renew(old: OAuth) -> OAuth:
                return await refresh(client, old)

            rejected: str | None = None
            while True:
                try:
                    login = await self.auth.current(self.id, renew, rejected=rejected)
                    headers["Authorization"] = "Bearer " + login.secret
                except (HTTPError, ValueError, OSError) as exc:
                    raise ModelFailure({"kind": "credentials", "message": str(exc)}) from exc
                try:
                    async with client.stream(
                        "POST", ENDPOINT, json=body, headers=headers
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
                            failure = _failure(_obj(error).get("error", error), result.status_code)
                            if failure.error["kind"] == "credentials":
                                raise ModelFailure(
                                    {
                                        "kind": "credentials",
                                        "message": f"{failure} Run `ma login grok` to sign in again.",
                                    }
                                )
                            raise failure
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
                                raise _failure(_obj(event.get("response")).get("error"))
                            elif kind == "error":
                                raise _failure(event.get("error", event))
                        if completed is None:
                            raise ModelFailure(
                                {
                                    "kind": "temporary",
                                    "message": "the model stream ended before a complete response",
                                }
                            )
                        if not completed.get("output") and items:
                            completed["output"] = items
                        return response_body(completed)
                except HTTPError as exc:
                    raise ModelFailure(
                        {
                            "kind": "temporary",
                            "message": f"could not reach Grok subscription: {exc}",
                        }
                    ) from exc

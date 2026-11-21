"""Anthropic Messages API over streamed HTTP."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from ._model_http import _HttpProvider, _argument, _failure, _max_tokens, _rows, _tools
from ._provider import ModelInfo, ProviderContext
from ._types import Json, JsonObject, ModelRef, _text


def _messages(request: JsonObject) -> list[Json]:
    messages: list[JsonObject] = []
    for message in _rows(request.get("messages")):
        role = "assistant" if message["role"] == "assistant" else "user"
        parts: list[Json] = []
        content = _rows(message.get("content"))
        if message["role"] == "toolResult":
            parts.append(
                {
                    "type": "tool_result",
                    "tool_use_id": message["toolCallId"],
                    "content": _text(list(content)),
                    "is_error": message.get("isError", False),
                }
            )
        else:
            for item in content:
                if item.get("type") == "text" and item.get("text"):
                    parts.append({"type": "text", "text": item["text"]})
                elif item.get("type") == "toolCall" and role == "assistant":
                    parts.append(
                        {
                            "type": "tool_use",
                            "id": item["id"],
                            "name": item["name"],
                            "input": item["arguments"],
                        }
                    )
        if parts:
            previous = (
                messages[-1].get("content")
                if messages and messages[-1].get("role") == role
                else None
            )
            if isinstance(previous, list):
                previous.extend(parts)
            else:
                messages.append({"role": role, "content": parts})
    return list(messages)


class Anthropic(_HttpProvider):
    async def request(
        self, model: ModelRef, request: JsonObject, context: ProviderContext
    ) -> JsonObject:
        key = context.credential()
        if not key:
            raise _failure("credentials", "ANTHROPIC_API_KEY is not set")
        tools: list[Json] = [
            {"name": t["name"], "description": t["description"], "input_schema": t["parameters"]}
            for t in _tools(request)
        ]
        body: JsonObject = {
            "model": model.id,
            "messages": _messages(request),
            "tools": tools,
            "system": request.get("systemPrompt", ""),
            "stream": True,
            "max_tokens": _max_tokens(request),
        }
        body.update(self._reasoning(model.id, request, max_tokens=_max_tokens(request)))
        blocks: dict[int, dict[str, Any]] = {}
        usage: dict[str, Any] = {}
        stop: str | None = None
        ended = False
        async for event in self._events(
            "/messages", {"x-api-key": key, "anthropic-version": "2023-06-01"}, body
        ):
            kind = event.get("type")
            if kind == "error":
                error = event.get("error") or {}
                e = error.get("type")
                raise _failure(
                    {
                        "authentication_error": "credentials",
                        "permission_error": "credentials",
                        "overloaded_error": "temporary",
                        "rate_limit_error": "temporary",
                        "api_error": "temporary",
                    }.get(str(e), "other"),
                    "Anthropic did not complete the response",
                )
            if kind == "message_start":
                usage.update((event.get("message") or {}).get("usage") or {})
            elif kind == "content_block_start":
                blocks[event["index"]] = dict(event["content_block"])
            elif kind == "content_block_delta":
                delta = event["delta"]
                block = blocks[event["index"]]
                if delta["type"] == "text_delta":
                    block["text"] += delta["text"]
                    await context.piece("text", delta["text"])
                elif delta["type"] == "input_json_delta":
                    block["json"] = block.get("json", "") + delta["partial_json"]
                elif delta["type"] == "thinking_delta":
                    block["thinking"] += delta["thinking"]
                    await context.piece("reasoning", delta["thinking"])
            elif kind == "message_delta":
                stop = event["delta"].get("stop_reason")
                usage.update(event.get("usage") or {})
            elif kind == "message_stop":
                ended = True
        if not ended or stop is None:
            raise _failure("temporary", "Anthropic stream ended without a response")
        if stop == "refusal":
            raise _failure("refused", "Anthropic refused the request")
        if stop == "model_context_window_exceeded":
            raise _failure("contextTooLarge", "Anthropic context window exceeded")
        parts: list[Json] = []
        for _, block in sorted(blocks.items()):
            if block["type"] == "text":
                parts.append({"type": "text", "text": block["text"]})
            elif block["type"] == "thinking":
                parts.append({"type": "reasoning", "text": block["thinking"]})
            elif block["type"] == "tool_use":
                parts.append(
                    {
                        "type": "toolCall",
                        "id": block["id"],
                        "name": block["name"],
                        "arguments": _argument(block["json"])
                        if "json" in block
                        else block.get("input", {}),
                    }
                )
        return {
            "role": "assistant",
            "content": parts,
            "stop": {"tool_use": "toolUse", "max_tokens": "length"}.get(stop, "finished"),
            "usage": {
                "input": usage.get("input_tokens", 0),
                "output": usage.get("output_tokens", 0),
                "cacheRead": usage.get("cache_read_input_tokens", 0),
                "cacheWrite": usage.get("cache_creation_input_tokens", 0),
            },
        }


def anthropic(
    *,
    models: Sequence[str | ModelInfo] | None = None,
    base_url: str = "https://api.anthropic.com/v1",
) -> Anthropic:
    return Anthropic("anthropic", models, base_url)

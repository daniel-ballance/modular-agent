"""OpenAI Responses API over streamed HTTP."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from ._model_http import _HttpProvider, _argument, _failure, _max_tokens, _rows, _tools
from ._provider import ProviderContext
from ._types import Json, JsonObject, ModelRef, _text


def _input(request: JsonObject) -> list[Json]:
    result: list[Json] = []
    for message in _rows(request.get("messages")):
        role = message["role"]
        parts = _rows(message.get("content"))
        if role == "toolResult":
            result.append(
                {
                    "type": "function_call_output",
                    "call_id": message["toolCallId"],
                    "output": _text(list(parts)),
                }
            )
        elif role in {"assistant", "user", "system", "developer"}:
            text = _text(list(parts))
            if text or role != "assistant":
                result.append({"role": role, "content": text})
            if role == "assistant":
                import json

                for call in parts:
                    if call.get("type") == "toolCall":
                        result.append(
                            {
                                "type": "function_call",
                                "call_id": call["id"],
                                "name": call["name"],
                                "arguments": json.dumps(call["arguments"]),
                            }
                        )
    return result


class OpenAI(_HttpProvider):
    async def request(
        self, model: ModelRef, request: JsonObject, context: ProviderContext
    ) -> JsonObject:
        key = context.credential()
        if not key:
            raise _failure("credentials", "OPENAI_API_KEY is not set")
        tools: list[Json] = [
            {
                "type": "function",
                "name": t["name"],
                "description": t["description"],
                "parameters": t["parameters"],
                "strict": False,
            }
            for t in _tools(request)
        ]
        body: JsonObject = {
            "model": model.id,
            "input": _input(request),
            "tools": tools,
            "instructions": request.get("systemPrompt", ""),
            "stream": True,
            "store": False,
            "max_output_tokens": _max_tokens(request),
        }
        final: dict[str, Any] | None = None
        async for event in self._events("/responses", {"Authorization": f"Bearer {key}"}, body):
            kind = event.get("type")
            if kind == "response.output_text.delta":
                await context.piece("text", event.get("delta", ""))
            elif kind == "response.reasoning_summary_text.delta":
                await context.piece("reasoning", event.get("delta", ""))
            elif kind in {"response.completed", "response.incomplete"}:
                final = event.get("response")
            elif kind in {"error", "response.failed"}:
                error = event.get("error") or (event.get("response") or {}).get("error") or event
                code = error.get("code")
                raise _failure(
                    {
                        "context_length_exceeded": "contextTooLarge",
                        "rate_limit_exceeded": "temporary",
                        "server_error": "temporary",
                        "invalid_api_key": "credentials",
                    }.get(str(code), "other"),
                    "OpenAI did not complete the response",
                )
        if final is None:
            raise _failure("temporary", "OpenAI stream ended without a response")
        parts: list[Json] = []
        for item in final.get("output", []):
            if item.get("type") == "message":
                for part in item.get("content", []):
                    if part.get("type") == "refusal":
                        raise _failure("refused", "OpenAI refused the request")
                    if part.get("type") == "output_text":
                        parts.append({"type": "text", "text": part["text"]})
            elif item.get("type") == "function_call":
                parts.append(
                    {
                        "type": "toolCall",
                        "id": item["call_id"],
                        "name": item["name"],
                        "arguments": _argument(item["arguments"]),
                    }
                )
            elif item.get("type") == "reasoning":
                for summary in item.get("summary", []):
                    if summary.get("type") == "summary_text":
                        parts.append({"type": "reasoning", "text": summary["text"]})
        stop = (
            "toolUse"
            if any(isinstance(p, dict) and p["type"] == "toolCall" for p in parts)
            else "finished"
        )
        if final.get("status") == "incomplete":
            if (final.get("incomplete_details") or {}).get("reason") == "max_output_tokens":
                stop = "length"
            else:
                raise _failure("refused", "OpenAI returned an incomplete response")
        usage = final.get("usage") or {}
        cached = (usage.get("input_tokens_details") or {}).get("cached_tokens", 0)
        return {
            "role": "assistant",
            "content": parts,
            "stop": stop,
            "usage": {
                "input": max(0, usage.get("input_tokens", 0) - cached),
                "output": usage.get("output_tokens", 0),
                "cacheRead": cached,
            },
        }


def openai(
    *, models: Sequence[str] = ("gpt-4.1-mini",), base_url: str = "https://api.openai.com/v1"
) -> OpenAI:
    return OpenAI("openai", tuple(models), base_url)

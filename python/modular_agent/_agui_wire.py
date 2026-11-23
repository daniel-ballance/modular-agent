"""Closed AG-UI 1.0 input shapes and the HTTP/SSE encoding boundary."""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import re
from datetime import UTC, datetime
from typing import Any

from ma_history.service import check_json
from ma_plugin.rpc import json_object

Obj = dict[str, Any]
MAX = 64 << 20
LOG = logging.getLogger("modular_agent.agui")
STATUS = {
    "invalid_request": 400,
    "not_supported": 400,
    "unauthenticated": 401,
    "not_found": 404,
    "refused": 403,
    "output_withheld": 403,
    "conflict": 409,
    "cursor_expired": 409,
    "result_too_large": 413,
    "busy": 503,
    "unavailable": 503,
}


class Failure(Exception):
    def __init__(self, code: str = "invalid_request") -> None:
        self.code = code
        super().__init__(code)


def warn(field: str) -> None:
    LOG.warning("AG-UI: %s", field)


def require(value: object, code: str = "invalid_request") -> None:
    if not value:
        raise Failure(code)


def decode(raw: bytes | bytearray) -> Obj:
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=json_object)
        check_json(value)
        if isinstance(value, dict):
            return value
    except Exception:
        pass
    raise Failure()


def encode(value: Any) -> bytes:
    try:
        check_json(value)
        b = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
    except Exception:
        raise Failure("output_withheld") from None
    require(len(b) <= MAX, "result_too_large")
    return b


def fingerprint(value: Any) -> bytes:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).digest()


def iso(milliseconds: int) -> str:
    return datetime.fromtimestamp(milliseconds / 1000, UTC).isoformat(timespec="milliseconds")


def shape(value: Any, *, strings: str = "", optional: str = "", extra: str = "") -> Obj:
    require(isinstance(value, dict))
    for key in strings.split():
        require(isinstance(value.get(key), str))
    for key in optional.split():
        require(key not in value or isinstance(value[key], str))
    allowed = set((strings + " " + optional + " " + extra).split())
    if "metadata" in allowed and "metadata" in value and "role" in value:
        require(isinstance(value["metadata"], dict))
    if value.keys() - allowed:
        warn("unknown field")  # Do not log a client-supplied string.
    return {k: v for k, v in value.items() if k in allowed}


def array(d: Obj, key: str, *, required: bool = False) -> list[Any]:
    items = d.get(key, None if required else [])
    if not isinstance(items, list):
        raise Failure()
    return items


def parts(value: Any) -> list[Obj]:
    require(isinstance(value, list))
    result = []
    for p in value:
        require(isinstance(p, dict))
        if p.get("type") == "text":
            result.append(shape(p, strings="type text", optional="id", extra="metadata"))
        else:
            require(p.get("type") in ("image", "audio", "video", "document"))
            p = shape(p, strings="type", optional="id", extra="source metadata")
            s = shape(p.get("source"), strings="type value", optional="mimeType provider")
            require(s["type"] in ("data", "file", "url"))
            require(s["type"] != "data" or "mimeType" in s)
            p["source"] = s
            result.append(p)
    return result


def message(value: Any) -> Obj:
    require(isinstance(value, dict))
    role = value.get("role")
    require(isinstance(role, str))
    allowed = {"assistant": "toolCalls", "tool": "toolCallId error", "activity": "activityType"}
    m = shape(
        value,
        strings="id role",
        optional="encryptedValue subagentRunId"
        + (" name" if role in ("user", "assistant", "system", "developer") else ""),
        extra="content metadata " + allowed.get(role, ""),
    )
    require(
        m["id"]
        and role in ("user", "assistant", "tool", "activity", "reasoning", "system", "developer")
    )
    if role == "activity":
        require(isinstance(m.get("activityType"), str) and isinstance(m.get("content"), dict))
    elif role == "assistant":
        require("content" not in m or isinstance(m["content"], str))
        if "toolCalls" in m:
            calls = []
            for call in array(m, "toolCalls"):
                call = shape(call, strings="id type", extra="function")
                require(call["type"] == "function")
                call["function"] = shape(call.get("function"), strings="name arguments")
                calls.append(call)
            m["toolCalls"] = calls
    elif not isinstance(m.get("content"), str):
        require(role in ("tool", "user"))
        m["content"] = parts(m.get("content"))
    if role == "tool":
        require(isinstance(m.get("toolCallId"), str) and isinstance(m.get("error", ""), str))
    return m


def parse_run(raw: Obj) -> Obj:
    d = shape(
        raw,
        strings="threadId runId protocolVersion",
        optional="parentRunId",
        extra="messages tools context resume state forwardedProps",
    )
    require(d["threadId"] and d["runId"])
    version = re.fullmatch(r"(\d+)\.(\d+)", d["protocolVersion"])
    require(not version or version[1] == "1", "not_supported")
    if d["protocolVersion"] != "1.0":
        warn("protocolVersion")
    d["messages"] = [
        m
        for v in array(d, "messages", required=True)
        if (m := message(v))["role"] not in ("reasoning", "activity")
    ]
    offers = []
    for t in array(d, "tools"):
        t = shape(t, strings="name description", extra="parameters metadata")
        require(isinstance(t.setdefault("parameters", {}), dict))
        if "metadata" in t:
            require(isinstance(t.pop("metadata"), dict))
        offers.append(t)
    d["tools"] = offers
    for c in array(d, "context"):
        shape(c, strings="description value")
        warn("context")
    answers = []
    for a in array(d, "resume"):
        a = shape(a, strings="interruptId status", extra="payload metadata")
        require(a["status"] in ("resolved", "cancelled"))
        require(isinstance(a.get("metadata", {}), dict))
        answers.append(a)
    d["resume"] = answers
    return d


def to_shared(value: str | list[Obj]) -> list[Obj]:
    if isinstance(value, str):
        return [{"type": "text", "text": value}]
    shared = []
    for p in value:
        if p["type"] == "text":
            shared.append({"type": "text", "text": p["text"]})
        elif p["type"] == "image" and (s := p["source"])["type"] == "data":
            require(re.fullmatch(r"image/[a-zA-Z0-9.+-]+", s["mimeType"]))
            try:
                base64.b64decode(s["value"], validate=True)
            except ValueError:
                raise Failure() from None
            shared.append({"type": "image", "data": s["value"], "mimeType": s["mimeType"]})
        else:
            warn("content")
    return shared


def content(parts: list[Obj]) -> str | list[Obj]:
    items = []
    for p in parts:
        if p["type"] == "text":
            items.append({"type": "text", "text": p["text"]})
        elif p["type"] == "image":
            items.append(
                {
                    "type": "image",
                    "source": {"type": "data", "value": p["data"], "mimeType": p["mimeType"]},
                }
            )
    if all(p["type"] == "text" for p in items):
        return "".join(str(p["text"]) for p in items)
    return items


def event(kind: str, **fields: Any) -> Obj:
    return {"type": kind, **fields}


def valid_patch(value: Any) -> bool:
    def pointer(p: Any) -> bool:
        return (
            isinstance(p, str) and (not p or p.startswith("/")) and not re.search(r"~(?![01])", p)
        )

    return isinstance(value, list) and all(
        isinstance(op, dict)
        and op.get("op") in ("add", "remove", "replace", "move", "copy", "test")
        and pointer(op.get("path"))
        and (op["op"] not in ("add", "replace", "test") or "value" in op)
        and (op["op"] not in ("move", "copy") or pointer(op.get("from")))
        for op in value
    )


def triad(cid: str, name: str, args: Obj, parent: str | None = None) -> list[Obj]:
    return [
        event(
            "TOOL_CALL_START",
            toolCallId=cid,
            toolCallName=name,
            **({"parentMessageId": parent} if parent else {}),
        ),
        event("TOOL_CALL_ARGS", toolCallId=cid, delta=encode(args).decode()),
        event("TOOL_CALL_END", toolCallId=cid),
    ]

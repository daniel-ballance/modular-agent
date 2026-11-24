"""Conformance redaction, including matches split across stream pieces."""

from ma_core import clone
from ma_core.redaction import redact_stream


SECRET = "conformance-secret"
REPLACEMENT = "[redacted]"


def redact(events):
    changed = clone(events)

    def replace(value):
        if isinstance(value, str):
            return value.replace(SECRET, REPLACEMENT)
        if isinstance(value, dict):
            return {k: replace(v) for k, v in value.items()}
        if isinstance(value, list):
            return [replace(v) for v in value]
        return value

    # The host sends a whole stream. Reasoning can be interleaved with text.
    streams = {}
    for event in changed:
        data = event["data"]
        kind = event["type"]
        if kind == "toolOutput":
            pieces = streams.setdefault((kind, data["toolCallId"]), [])
            pieces.extend((p, "text") for p in data["content"] if p["type"] == "text")
        elif kind in {"text", "reasoning"}:
            streams.setdefault((kind, data.get("stepId")), []).append((data, "delta"))
    for pieces in streams.values():
        redact_stream(pieces, SECRET, REPLACEMENT)
    for event in changed:
        event["data"] = replace(event["data"])
    return {"events": changed} if changed != events else None

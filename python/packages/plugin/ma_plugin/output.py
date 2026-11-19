"""Conformance redaction, including matches split across stream pieces."""

import re

from ma_core import clone


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
    def flush(pieces):
        if not pieces:
            return
        texts = [d[k] for d, k in pieces]
        for match in reversed(list(re.finditer(SECRET, "".join(texts)))):
            offset = 0
            for i, (d, k) in enumerate(pieces):
                start, end = match.span()
                width = len(texts[i])
                if offset < end and offset + width > start:
                    left, right = max(0, start - offset), min(width, end - offset)
                    insert = REPLACEMENT if offset <= start < offset + width else ""
                    d[k] = d[k][:left] + insert + d[k][right:]
                offset += width
        pieces.clear()

    streams = {}
    for event in changed:
        data = event["data"]
        kind = event["type"]
        key = {"text": "delta", "reasoning": "delta", "toolOutput": "chunk"}.get(kind)
        if key and isinstance(data, dict) and isinstance(data.get(key), str):
            scope = data.get("toolCallId") if kind == "toolOutput" else data.get("stepId")
            streams.setdefault((kind, scope), []).append((data, key))
    for pieces in streams.values():
        flush(pieces)
    for event in changed:
        event["data"] = replace(event["data"])
    return {"events": changed} if changed != events else None

"""Redact a string even when it spans several output parts."""

import re


def redact_stream(fields, secret, replacement):
    texts = [obj[key] for obj, key in fields]
    for match in reversed(list(re.finditer(re.escape(secret), "".join(texts)))):
        start, end = match.span()
        offset = 0
        for text, (obj, key) in zip(texts, fields, strict=True):
            width = len(text)
            if offset < end and offset + width > start and width:
                left, right = max(0, start - offset), min(width, end - offset)
                insert = replacement if offset <= start < offset + width else ""
                obj[key] = obj[key][:left] + insert + obj[key][right:]
            offset += width

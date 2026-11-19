"""Shared tool schema used by the Python conformance fixtures."""

NEST = {
    "name": "nest",
    "description": "Run a nested tool",
    "schema": {
        "type": "object",
        "properties": {"name": {"type": "string"}, "input": {"type": "object"}},
        "required": ["name", "input"],
        "additionalProperties": False,
    },
    "parallel": False,
    "callers": ["model", "plugin", "interface"],
    "hints": {},
}

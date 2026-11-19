"""Optional output gate. Holds streams until final to catch secrets across pieces."""

from ma_core import Plugin


class Guardrail(Plugin):
    name = "guardrail"
    declarations = {"holds_output": True}

    def __init__(self, secrets=()):
        self.secrets = tuple(x for x in secrets if x)
        self.buffers = {}

    async def start(self, api):
        await super().start(api)
        api.on("output", self.gate, "last")
        api.on("session.invalidate", self.clear)
        api.on("session.end", self.clear)

    async def clear(self, d):
        self.buffers = {k: v for k, v in self.buffers.items() if k[1] != d["session"]}

    def redact(self, value):
        if isinstance(value, str):
            for secret in self.secrets:
                value = value.replace(secret, "[REDACTED]")
            return value
        if isinstance(value, list):
            return [self.redact(v) for v in value]
        if isinstance(value, dict):
            return {k: self.redact(v) for k, v in value.items()}
        return value

    async def gate(self, d):
        if not self.secrets:
            return d
        value = d["value"]
        if isinstance(value, dict) and value.get("kind") in {"model_output", "tool_progress"}:
            key = (
                d["recipient"],
                value["session"],
                value.get("turn"),
                value.get("step"),
                value.get("call"),
                value["kind"],
            )
            self.buffers[key] = self.buffers.get(key, "") + value["text"]
            if not value.get("final"):
                return {**d, "value": None}
            value = {**value, "text": self.buffers.pop(key)}
        return {**d, "value": self.redact(value)}

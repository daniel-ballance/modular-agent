"""Version 1 plugin API. Request/response data must be JSON-serializable."""

import json
import uuid
from datetime import UTC, datetime


def identity():
    return uuid.uuid4().hex


def now():
    return datetime.now(UTC).isoformat()


def lower_reasoning(level, accepted):
    levels = ("off", "minimal", "low", "medium", "high", "xhigh")
    if level not in levels:
        return "off"
    return next(
        (
            candidate
            for candidate in reversed(levels[: levels.index(level) + 1])
            if candidate in accepted
        ),
        "off",
    )


def clone(value):
    # JSON values can share immutable strings. Avoid repeatedly encoding a
    # whole history just to isolate changes to its arrays and objects.
    kind = type(value)
    if kind is dict and all(type(k) is str for k in value):
        return {k: clone(v) for k, v in value.items()}
    if kind in {list, tuple}:
        return [clone(v) for v in value]
    if value is None or kind in {str, int, float, bool}:
        return value
    return json.loads(json.dumps(value))


def content(text):
    return [{"type": "text", "text": str(text)}]


def plain(parts):
    return "".join(p.get("text", "") for p in parts if p.get("type") == "text")


async def silent(_):
    pass


class AgentError(Exception):
    def __init__(self, message, code="failed"):
        super().__init__(message)
        self.code = code


class Stop:
    """Explicit short circuit for transform hooks."""

    def __init__(self, value):
        self.value = value


class Plugin:
    name = ""
    role = "feature"
    declarations = {}

    async def start(self, api):
        self.api = api

    async def stop(self):
        pass


class API:
    """Only connection a plugin receives to the rest of the agent."""

    version = 1

    def __init__(self, harness, owner, role="feature"):
        self._harness, self.owner, self.role = harness, owner, role

    def provide(self, name, service):
        self._harness.provide(self.owner, name, service)

    def define_hook(self, name, rule):
        self._harness.define_hook(self.owner, name, rule)

    def on(self, name, handler, order="normal"):
        self._harness.on(self.owner, name, handler, order)

    def command(self, name, description, handler):
        self._harness.command(self.owner, name, description, handler)

    async def call(self, target, operation, data=None, emit=None):
        if target == "credentials" and not (
            self.role in {"provider", "tool_source", "environment"}
            or (self.role == "interface" and operation == "answer")
        ):
            raise AgentError("This plugin cannot access credentials", "forbidden")
        if self.role == "interface":
            await self._harness.authorize(target, operation, data or {})
        return await self._harness.call(self.owner, target, operation, data or {}, emit or silent)

    async def hook(self, name, data):
        return await self._harness.fire(self.owner, name, data)

    async def session(self, operation, **data):
        return await self.call("@harness", operation, data)

    async def event(self, kind, **data):
        return await self.session("event", kind=kind, **data)

    def follow(self, recipient, handler):
        self._harness.follow(self.owner, recipient, handler)

"""Core hook payloads and answers, with the shared field spellings."""

from __future__ import annotations

from typing import Literal, NotRequired, TypedDict

from ._types import Content, Json, JsonObject, QuestionSpec


class PluginLoad(TypedDict):
    name: str
    origin: str
    project: NotRequired[str]


class SessionHook(TypedDict):
    sessionId: str
    resumed: NotRequired[bool]
    project: NotRequired[str]


class ActorHook(TypedDict):
    sessionId: str
    actor: NotRequired[JsonObject]
    actorId: NotRequired[str]


class InputHook(TypedDict):
    sessionId: str
    actorId: str
    when: str
    content: Content
    project: NotRequired[str]


class TurnBefore(TypedDict):
    sessionId: str
    input: Content
    project: NotRequired[str]
    nestedTools: NotRequired[list[JsonObject]]


class TurnStart(TypedDict):
    sessionId: str
    turnId: str


class TurnEnd(TypedDict):
    sessionId: str
    turnId: str
    outcome: JsonObject
    result: JsonObject


class StepBefore(TypedDict):
    sessionId: str
    stepId: str
    request: JsonObject
    model: JsonObject
    history: NotRequired[list[JsonObject]]
    usage: NotRequired[JsonObject]


class StepAfter(TypedDict):
    sessionId: str
    stepId: str
    response: JsonObject


class ToolBefore(TypedDict):
    sessionId: str
    turnId: NotRequired[str | None]
    stepId: NotRequired[str | None]
    call: JsonObject
    definition: JsonObject | None


class ToolAfter(TypedDict):
    sessionId: str
    turnId: NotRequired[str | None]
    call: JsonObject
    result: JsonObject


class ModelFailed(TypedDict):
    sessionId: str
    request: JsonObject
    error: JsonObject


class TurnResult(TypedDict):
    sessionId: str
    result: JsonObject
    shape: NotRequired[JsonObject | None]


class ProviderRequest(TypedDict):
    sessionId: str | None
    provider: str
    model: JsonObject
    request: JsonObject


class ProviderResponse(TypedDict):
    sessionId: str | None
    provider: str
    model: JsonObject
    message: JsonObject


class ProviderPiece(TypedDict):
    sessionId: str | None
    stepId: NotRequired[str]
    provider: str
    model: JsonObject
    event: JsonObject


class OutputHook(TypedDict):
    sessionId: str | None
    recipient: str
    events: list[JsonObject]


class Allow(TypedDict):
    allow: Literal[True]


class Refuse(TypedDict):
    refuse: str


class ChangeInput(TypedDict):
    input: JsonObject


class ChangeContent(TypedDict):
    content: Content


class ChangeToolResult(TypedDict):
    content: NotRequired[Content]
    value: NotRequired[Json]


class Pending(TypedDict):
    pending: QuestionSpec


class HandleCommand(TypedDict):
    command: str


class Handle(TypedDict):
    handle: Literal[True] | HandleCommand


class Contribution(TypedDict):
    system: NotRequired[str]
    context: NotRequired[Content]


class Add(TypedDict):
    add: Contribution


class End(TypedDict):
    end: str


class Retry(TypedDict):
    retry: Literal[True] | JsonObject


class StopRetrying(TypedDict):
    stop: Literal[True]


class Accept(TypedDict):
    accept: Literal[True]


class Redact(TypedDict):
    redact: list[JsonObject]


class Block(TypedDict):
    block: Literal[True]


class Change[T](TypedDict):
    change: T


Continue = TypedDict("Continue", {"continue": Literal[True]})

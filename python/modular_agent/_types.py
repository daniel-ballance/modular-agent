"""Application errors and shared JSON values."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Literal, NotRequired, TypedDict


type Json = None | bool | int | float | str | list[Json] | dict[str, Json]
type JsonObject = dict[str, Json]
type Content = list[Json]
type Input = str | Content
type Durability = Literal["ephemeral", "kept", "durable"]
type Approval = Literal["off", "ask", "all", "never"]
type Timing = Literal["now", "steer", "after", "propose"]


class ErrorCode(StrEnum):
    INVALID_PARAMS = "invalid_params"
    INVALID_REQUEST = "invalid_request"
    INVALID_COMPOSITION = "invalid_composition"
    FORBIDDEN = "forbidden"
    NOT_FOUND = "not_found"
    NOT_OPEN = "not_open"
    BUSY = "busy"
    UNAVAILABLE = "unavailable"
    HELD = "held"
    CONFLICT = "conflict"
    CANCELLED = "cancelled"
    NOT_SUPPORTED = "not_supported"
    TURN_LIMIT = "turn_limit"
    UNKNOWN_HANDLER = "unknown_handler"
    WITHHELD = "withheld"
    RESULT_TOO_LARGE = "result_too_large"
    MESSAGE_TOO_LARGE = "message_too_large"
    LOST = "lost"
    INTERNAL = "internal"


class AgentError(Exception):
    def __init__(self, code: ErrorCode, message: str, data: Json = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


class ToolStatus(StrEnum):
    COMPLETED = "completed"
    FAILED = "failed"
    REFUSED = "refused"
    CANCELLED = "cancelled"
    OUTCOME_UNKNOWN = "outcomeUnknown"
    NOT_STARTED = "notStarted"


class Disposition(StrEnum):
    TURN = "turn"
    HANDLED = "handled"
    HANDED_BACK = "handedBack"


class OutcomeKind(StrEnum):
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    LIMIT = "limit"


@dataclass(frozen=True)
class Outcome:
    kind: OutcomeKind
    error: Json = None
    limit: str | None = None


def _content(value: Input) -> Content:
    return [{"type": "text", "text": value}] if isinstance(value, str) else value


def _text(parts: Content) -> str:
    return "".join(
        str(p.get("text", "")) for p in parts if isinstance(p, dict) and p.get("type") == "text"
    )


@dataclass(frozen=True)
class ToolResult:
    name: str
    status: ToolStatus
    call_id: str
    content: Content
    value: Json = None

    def text(self) -> str:
        return _text(self.content)


@dataclass(frozen=True)
class PromptResult:
    input_id: str
    disposition: Disposition
    outcome: Outcome | None = None
    text: str = ""
    value: Json = None
    turn_id: str | None = None
    open_tool_calls: tuple[str, ...] = ()
    usage: JsonObject = field(default_factory=dict)
    _results: tuple[ToolResult, ...] = ()

    def tool_results(self) -> tuple[ToolResult, ...]:
        return self._results


@dataclass(frozen=True)
class InputReceipt:
    input_id: str
    timing: Timing
    duplicate: bool = False
    disposition: Disposition | None = None


class ErasureReport(TypedDict):
    erased: list[JsonObject]
    pending: list[JsonObject]
    outOfReach: list[JsonObject]


class Proposal(TypedDict):
    inputId: str
    actorId: str
    content: Content
    time: int


class QuestionSpec(TypedDict):
    kind: Literal["approval", "choice", "text", "link", "secret"]
    question: str
    credential: NotRequired[str]
    options: NotRequired[list[str]]
    details: NotRequired[Json]
    answerers: NotRequired[list[str]]


@dataclass(frozen=True)
class Question:
    id: str
    session_id: str
    kind: str
    question: str
    options: tuple[Json, ...] = ()
    details: Json = None
    call: Json = None
    deadline: Json = None
    answerable: bool = True


@dataclass(frozen=True)
class QuestionContext:
    session_id: str
    actor_id: str = "user"


@dataclass(frozen=True)
class Answer:
    kind: Literal["allow", "value", "decline"]
    value: Json = None
    reason: str | None = None


class ValueAnswer(TypedDict):
    value: Json


type AnswerInput = Answer | ValueAnswer | Literal["allow", "decline"] | None
type QuestionHandler = Callable[[Question, QuestionContext], AnswerInput | Awaitable[AnswerInput]]


def _answer(value: AnswerInput) -> Answer:
    if isinstance(value, Answer):
        return value
    if isinstance(value, dict):
        return Answer("value", value["value"])
    return Answer("allow" if value == "allow" else "decline")


class Actor(TypedDict):
    id: str
    kind: Literal["user", "host", "agent", "program"]
    rights: list[str]


class Tenant(TypedDict):
    rights: list[str]
    tokens: NotRequired[int | float]


@dataclass(frozen=True)
class ModelRef:
    provider: str
    id: str

    def __str__(self) -> str:
        return f"{self.provider}/{self.id}"

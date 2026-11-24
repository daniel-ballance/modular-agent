"""Tagged session events and their payloads. Wire dictionaries retain shared keys."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, NotRequired, TypedDict, cast

from ._types import Content, Json, JsonObject


@dataclass(frozen=True)
class EventData[P]:
    fields: P

    @property
    def delta(self) -> str:
        return str(cast(JsonObject, self.fields).get("delta", ""))

    @property
    def outcome(self) -> Json:
        return cast(JsonObject, self.fields).get("outcome")


@dataclass(frozen=True)
class _Event[T: str, P]:
    type: T
    time: str
    session_id: str
    data: EventData[P]
    turn_id: str | None = None
    step_id: str | None = None
    call_id: str | None = None


class Delta(TypedDict):
    delta: str


class NoEventFields(TypedDict):
    pass


class SessionStartedEvent(_Event[Literal["sessionStarted"], NoEventFields]):
    pass


class SessionEndedEvent(_Event[Literal["sessionEnded"], NoEventFields]):
    pass


class SessionInterruptedEventFields(TypedDict):
    reason: Literal["commitFailed", "writerLost"]


class SessionInterruptedEvent(_Event[Literal["sessionInterrupted"], SessionInterruptedEventFields]):
    pass


class ActorJoinedEventFields(TypedDict):
    actor: JsonObject


class ActorJoinedEvent(_Event[Literal["actorJoined"], ActorJoinedEventFields]):
    pass


class ActorLeftEventFields(TypedDict):
    actorId: str


class ActorLeftEvent(_Event[Literal["actorLeft"], ActorLeftEventFields]):
    pass


class InputAcceptedEventFields(TypedDict):
    input: str
    when: str


class InputAcceptedEvent(_Event[Literal["inputAccepted"], InputAcceptedEventFields]):
    pass


class InputWithdrawnEventFields(TypedDict):
    inputId: NotRequired[str]
    inputIds: NotRequired[list[str]]


class InputWithdrawnEvent(_Event[Literal["inputWithdrawn"], InputWithdrawnEventFields]):
    pass


class InputHandedBackEventFields(TypedDict):
    input: str
    content: Content


class InputHandedBackEvent(_Event[Literal["inputHandedBack"], InputHandedBackEventFields]):
    pass


class TurnStartedEventFields(TypedDict):
    input: NotRequired[str]


class TurnStartedEvent(_Event[Literal["turnStarted"], TurnStartedEventFields]):
    pass


class TurnEndedEventFields(TypedDict):
    outcome: JsonObject
    result: JsonObject


class TurnEndedEvent(_Event[Literal["turnEnded"], TurnEndedEventFields]):
    pass


class StepStartedEventFields(TypedDict):
    index: NotRequired[int]


class StepStartedEvent(_Event[Literal["stepStarted"], StepStartedEventFields]):
    pass


class StepEndedEventFields(TypedDict):
    usage: NotRequired[JsonObject]


class StepEndedEvent(_Event[Literal["stepEnded"], StepEndedEventFields]):
    pass


class TextEvent(_Event[Literal["text"], Delta]):
    pass


class ReasoningEvent(_Event[Literal["reasoning"], Delta]):
    pass


class ToolInputEventFields(TypedDict):
    delta: Json
    toolCallId: NotRequired[str]


class ToolInputEvent(_Event[Literal["toolInput"], ToolInputEventFields]):
    pass


class AudioEventFields(TypedDict):
    delta: Json


class AudioEvent(_Event[Literal["audio"], AudioEventFields]):
    pass


class ToolCallEventFields(TypedDict):
    name: str
    input: JsonObject


class ToolCallEvent(_Event[Literal["toolCall"], ToolCallEventFields]):
    pass


class ToolStartedEventFields(TypedDict):
    call: JsonObject
    definition: NotRequired[JsonObject]
    approvalCoveredBy: NotRequired[JsonObject]


class ToolStartedEvent(_Event[Literal["toolStarted"], ToolStartedEventFields]):
    pass


class ToolOutputEventFields(TypedDict):
    toolCallId: str
    content: Content


class ToolOutputEvent(_Event[Literal["toolOutput"], ToolOutputEventFields]):
    pass


class ToolResultEventFields(TypedDict):
    status: str
    value: NotRequired[Json]


class ToolResultEvent(_Event[Literal["toolResult"], ToolResultEventFields]):
    pass


class QuestionOpenedEventFields(TypedDict):
    request: JsonObject


class QuestionOpenedEvent(_Event[Literal["questionOpened"], QuestionOpenedEventFields]):
    pass


class QuestionAnsweredEventFields(TypedDict):
    answer: JsonObject


class QuestionAnsweredEvent(_Event[Literal["questionAnswered"], QuestionAnsweredEventFields]):
    pass


class QuestionClosedEventFields(TypedDict):
    request: NotRequired[str]
    reason: NotRequired[str]


class QuestionClosedEvent(_Event[Literal["questionClosed"], QuestionClosedEventFields]):
    pass


class QuestionNoLongerAnswerableEventFields(TypedDict):
    request: str


class QuestionNoLongerAnswerableEvent(
    _Event[Literal["questionNoLongerAnswerable"], QuestionNoLongerAnswerableEventFields]
):
    pass


class JobStartedEventFields(TypedDict):
    job: str


class JobStartedEvent(_Event[Literal["jobStarted"], JobStartedEventFields]):
    pass


class JobProgressEventFields(TypedDict):
    job: str
    content: NotRequired[Content]


class JobProgressEvent(_Event[Literal["jobProgress"], JobProgressEventFields]):
    pass


class JobEndedEventFields(TypedDict):
    job: str


class JobEndedEvent(_Event[Literal["jobEnded"], JobEndedEventFields]):
    pass


class EntryEventFields(TypedDict):
    entry: JsonObject


class EntryEvent(_Event[Literal["entry"], EntryEventFields]):
    pass


class PositionMovedEventFields(TypedDict):
    position: NotRequired[str]


class PositionMovedEvent(_Event[Literal["positionMoved"], PositionMovedEventFields]):
    pass


class EntriesErasedEventFields(TypedDict):
    entries: NotRequired[list[str]]


class EntriesErasedEvent(_Event[Literal["entriesErased"], EntriesErasedEventFields]):
    pass


class SettingChangedEvent(_Event[Literal["settingChanged"], JsonObject]):
    pass


class PluginLoadedEventFields(TypedDict):
    plugin: str


class PluginLoadedEvent(_Event[Literal["pluginLoaded"], PluginLoadedEventFields]):
    pass


class PluginReplacedEventFields(TypedDict):
    plugin: str


class PluginReplacedEvent(_Event[Literal["pluginReplaced"], PluginReplacedEventFields]):
    pass


class PluginUnloadedEventFields(TypedDict):
    plugin: str


class PluginUnloadedEvent(_Event[Literal["pluginUnloaded"], PluginUnloadedEventFields]):
    pass


class CustomEvent(_Event[str, JsonObject]):
    pass


type StandardEvent = (
    SessionStartedEvent
    | SessionEndedEvent
    | SessionInterruptedEvent
    | ActorJoinedEvent
    | ActorLeftEvent
    | InputAcceptedEvent
    | InputWithdrawnEvent
    | InputHandedBackEvent
    | TurnStartedEvent
    | TurnEndedEvent
    | StepStartedEvent
    | StepEndedEvent
    | TextEvent
    | ReasoningEvent
    | ToolInputEvent
    | AudioEvent
    | ToolCallEvent
    | ToolStartedEvent
    | ToolOutputEvent
    | ToolResultEvent
    | QuestionOpenedEvent
    | QuestionAnsweredEvent
    | QuestionClosedEvent
    | QuestionNoLongerAnswerableEvent
    | JobStartedEvent
    | JobProgressEvent
    | JobEndedEvent
    | EntryEvent
    | PositionMovedEvent
    | EntriesErasedEvent
    | SettingChangedEvent
    | PluginLoadedEvent
    | PluginReplacedEvent
    | PluginUnloadedEvent
)
type Event = StandardEvent | CustomEvent


_VARIANTS = {
    "sessionStarted": SessionStartedEvent,
    "sessionEnded": SessionEndedEvent,
    "sessionInterrupted": SessionInterruptedEvent,
    "actorJoined": ActorJoinedEvent,
    "actorLeft": ActorLeftEvent,
    "inputAccepted": InputAcceptedEvent,
    "inputWithdrawn": InputWithdrawnEvent,
    "inputHandedBack": InputHandedBackEvent,
    "turnStarted": TurnStartedEvent,
    "turnEnded": TurnEndedEvent,
    "stepStarted": StepStartedEvent,
    "stepEnded": StepEndedEvent,
    "text": TextEvent,
    "reasoning": ReasoningEvent,
    "toolInput": ToolInputEvent,
    "audio": AudioEvent,
    "toolCall": ToolCallEvent,
    "toolStarted": ToolStartedEvent,
    "toolOutput": ToolOutputEvent,
    "toolResult": ToolResultEvent,
    "questionOpened": QuestionOpenedEvent,
    "questionAnswered": QuestionAnsweredEvent,
    "questionClosed": QuestionClosedEvent,
    "questionNoLongerAnswerable": QuestionNoLongerAnswerableEvent,
    "jobStarted": JobStartedEvent,
    "jobProgress": JobProgressEvent,
    "jobEnded": JobEndedEvent,
    "entry": EntryEvent,
    "positionMoved": PositionMovedEvent,
    "entriesErased": EntriesErasedEvent,
    "settingChanged": SettingChangedEvent,
    "pluginLoaded": PluginLoadedEvent,
    "pluginReplaced": PluginReplacedEvent,
    "pluginUnloaded": PluginUnloadedEvent,
}


def _event(
    tag: str,
    data: JsonObject,
    time: str,
    session_id: str,
    turn_id: str | None = None,
    step_id: str | None = None,
    call_id: str | None = None,
) -> Event:
    variant = cast(type[_Event[str, JsonObject]], _variant(tag))
    return cast(Event, variant(tag, time, session_id, EventData(data), turn_id, step_id, call_id))


def _variant(tag: str) -> object:
    return _VARIANTS.get(tag, CustomEvent)

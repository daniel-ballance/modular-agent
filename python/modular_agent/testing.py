"""Offline agents and model scripts for SDK tests."""

from __future__ import annotations

from collections import deque
from collections.abc import Sequence
from os import PathLike
from tempfile import TemporaryDirectory
from typing import Unpack, TypedDict

from ._agent import Agent, AgentStart, create_agent
from ._environment import MemoryEnvironment, memory_environment as memory_environment
from ._history import HistoryStore
from ._history_port import HistoryPort
from ._plugin import Plugin, ProcessPlugin, ServicePlugin
from ._serve import _OverWire
from ._provider import ModelInfo, ProviderContext, ProviderSupports
from ._tool import Tool
from ._types import (
    AgentError,
    AnswerInput,
    Approval,
    Durability,
    ErrorCode,
    JsonObject,
    ModelRef,
    Question,
    QuestionContext,
    QuestionHandler,
)


class ScriptedProvider:
    id = "scripted"
    supports = ProviderSupports(safe_to_repeat=True)

    def __init__(self, script: Sequence[JsonObject]) -> None:
        self._script = tuple(script)

    def models(self) -> list[ModelInfo]:
        return [
            {
                "provider": self.id,
                "id": "script",
                "contextWindow": 1_000_000,
                "maxOutput": 4096,
                "input": ["text"],
                "reasoning": False,
                "thinking": ["off"],
            }
        ]

    async def request(
        self, model: ModelRef, request: JsonObject, context: ProviderContext
    ) -> JsonObject:
        messages = request.get("messages")
        index = (
            sum(isinstance(m, dict) and m.get("role") == "assistant" for m in messages)
            if isinstance(messages, list)
            else 0
        )
        response: JsonObject = (
            self._script[index]
            if index < len(self._script)
            else {"error": {"kind": "other", "message": "script exhausted"}}
        )
        parts: list[JsonObject] = []
        for key in ("reasoning", "text"):
            if isinstance(text := response.get(key), str):
                await context.piece(key, text)
                parts.append({"type": key, "text": text})
        calls = response.get("toolCalls")
        if isinstance(calls, list):
            for n, call in enumerate(calls):
                if not isinstance(call, dict) or not isinstance(call.get("name"), str):
                    raise AgentError(ErrorCode.INVALID_REQUEST, "Invalid scripted tool call")
                parts.append(
                    {
                        "type": "toolCall",
                        "id": f"script-{index}-{n}",
                        "name": call["name"],
                        "arguments": call.get("input", {}),
                    }
                )
        return {
            "role": "assistant",
            "content": list(parts),
            "stop": "failed" if "error" in response else "toolUse" if calls else "finished",
            "usage": response.get("usage", {}),
            **({"error": response["error"]} if "error" in response else {}),
        }


def scripted_provider(script: Sequence[JsonObject]) -> ScriptedProvider:
    return ScriptedProvider(script)


class AnswerQueue:
    def __init__(self, values: Sequence[AnswerInput]) -> None:
        self._pending = deque(values)
        self.unexpected: list[Question] = []

    def __call__(self, question: Question, context: QuestionContext) -> AnswerInput:
        if not self._pending:
            self.unexpected.append(question)
            return "decline"
        return self._pending.popleft()

    def assert_done(self) -> None:
        if self._pending or self.unexpected:
            raise AssertionError(
                f"{len(self._pending)} unused answers; unexpected questions: "
                + ", ".join(q.question for q in self.unexpected)
            )


def answers(values: Sequence[AnswerInput]) -> AnswerQueue:
    return AnswerQueue(values)


def over_wire(plugin: Plugin) -> Plugin:
    return _OverWire(plugin)


async def restart(agent: Agent) -> Agent:
    return await agent._interrupt_and_restart()


class _Options(TypedDict, total=False):
    several_actors: bool
    session_limits: bool
    data_dir: str | PathLike[str] | None
    durability: Durability
    environment: MemoryEnvironment
    history: HistoryStore | HistoryPort | None
    tools: Sequence[Tool]
    plugins: Sequence[Plugin]
    process_plugins: Sequence[ProcessPlugin | JsonObject] | None
    service_plugins: Sequence[ServicePlugin] | None
    plugin_host: bool | None
    settings: JsonObject
    approval: Approval | None
    on_question: QuestionHandler | None


def test_agent(
    *,
    script: Sequence[JsonObject],
    project: str | PathLike[str] | None = None,
    **options: Unpack[_Options],
) -> AgentStart:
    async def build() -> Agent:
        scratch = TemporaryDirectory(prefix="modular-agent-test-") if project is None else None
        options.setdefault("environment", memory_environment())
        try:
            agent = await create_agent(
                project=scratch.name if scratch else project,
                providers=[scripted_provider(script)],
                **options,
            )
        except BaseException:
            if scratch:
                scratch.cleanup()
            raise
        agent._test_project = scratch
        return agent

    return AgentStart(build())

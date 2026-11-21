"""Jobs have their own lifetime, independent of the call which started them."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Literal, Protocol

from ._context import CallContext
from ._types import AgentError, Content, ErrorCode, Input, Json, JsonObject, _content

JobOutcome = Literal["completed", "cancelled", "failed", "outcomeUnknown"]


class Job:
    def __init__(
        self,
        id: str,
        session_id: str,
        actor_id: str,
        kind: str,
        detail: Json,
        progress: Callable[[Content], Awaitable[None]],
        end: Callable[[JobOutcome, Content | None, bool], Awaitable[None]],
    ) -> None:
        self.id, self.session_id, self.actor_id = id, session_id, actor_id
        self.kind, self.detail = kind, detail
        self._progress, self._end = progress, end
        self._settled = False

    async def progress(self, content: Input) -> None:
        if self._settled:
            raise AgentError(ErrorCode.INVALID_REQUEST, "Job has ended")
        await self._progress(_content(content))

    async def end(
        self, outcome: JobOutcome, result: Input | None = None, *, report: bool = False
    ) -> None:
        await self._end(outcome, None if result is None else _content(result), report)
        self._settled = True


class JobContext(CallContext):
    def __init__(
        self,
        job: Job,
        *,
        history: Callable[[str | None], Awaitable[JsonObject]] | None = None,
        emit: Callable[[str, Json], Awaitable[None]] | None = None,
    ) -> None:
        super().__init__(job.session_id, job.actor_id, history=history, emit=emit)
        self.job_id = job.id


class JobOwner(Protocol):
    async def cancel(self, job: Job, context: JobContext) -> None: ...

    # resume(job, context), when supplied, is called in session.start on reopen.


class JobManager:
    def __init__(
        self,
        check: Callable[[], None],
        start: Callable[[str, Json, str | None], Awaitable[Job]] | None = None,
    ) -> None:
        self._check, self._start = check, start

    async def start(self, kind: str, detail: Json, key: str | None = None) -> Job:
        self._check()
        if self._start is None:
            raise AgentError(ErrorCode.NOT_SUPPORTED, "Plugin has not registered a job owner")
        return await self._start(kind, detail, key)

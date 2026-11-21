"""Read Monty's worker clock through the Python binding's telemetry hooks."""

from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from threading import Lock
from uuid import uuid4

from opentelemetry.context import Context
from opentelemetry.trace import (
    NonRecordingSpan,
    SpanContext,
    TraceFlags,
    get_current_span,
)
from pydantic_monty import instrument_telemetry


class ComputeLimit(TimeoutError):
    def __init__(self) -> None:
        super().__init__("sandbox exceeded its active time limit")


class WorkerClockError(RuntimeError):
    def __init__(self) -> None:
        super().__init__("RuntimeError: sandbox worker did not report its active time")


class ComputeBudget:
    def __init__(self, seconds: float) -> None:
        self.limit = int(seconds * 1_000_000)
        self.latest = 0
        self.checkpoint = 0
        self.reported = False

    def report(self, attributes: Mapping[str, object]) -> None:
        micros = attributes.get("total_execution_micros")
        # Monty exports unsigned span attributes as decimal strings.
        if isinstance(micros, str) and micros.isdecimal():
            micros = int(micros)
        if type(micros) is int:
            self.latest = max(self.latest, micros)
            self.reported = True

    def check(self, *, require_report: bool = True) -> None:
        if require_report and not self.reported:
            raise WorkerClockError()
        self.reported = False
        if self.latest - self.checkpoint >= self.limit:
            raise ComputeLimit()

    def reset(self) -> None:
        self.reported = False
        self.checkpoint = self.latest

    @contextmanager
    def capture(self) -> Iterator[NonRecordingSpan]:
        # Monty captures the current trace at checkout. A private trace lets
        # native callbacks report to this run, even with other runs in flight.
        _install()
        trace_id = uuid4().int
        span = NonRecordingSpan(SpanContext(trace_id, 1, False, TraceFlags(TraceFlags.SAMPLED)))
        _budgets[trace_id] = self
        try:
            yield span
        finally:
            del _budgets[trace_id]


_budgets: dict[int, ComputeBudget] = {}
_install_lock = Lock()
_installed = False


class _WorkerSpan(NonRecordingSpan):
    def set_attributes(self, attributes: Mapping[str, object]) -> None:
        # Successful completion sets the final clock on the feed span.
        if budget := _budgets.get(self.get_span_context().trace_id):
            budget.report(attributes)


class _WorkerClock:
    def start_span(
        self, _name: str, *, context: Context, attributes: Mapping[str, object], start_time: int
    ) -> NonRecordingSpan:
        # Suspensions report the cumulative session clock when their spans open.
        parent = get_current_span(context).get_span_context()
        if budget := _budgets.get(parent.trace_id):
            budget.report(attributes)
        return _WorkerSpan(
            SpanContext(parent.trace_id, uuid4().int & (2**64 - 1), False, parent.trace_flags)
        )

    def emit(self, *, context: Context, attributes: Mapping[str, object], **_: object) -> None:
        # A worker exception reports the clock on an error log, not on the feed span.
        if budget := _budgets.get(get_current_span(context).get_span_context().trace_id):
            budget.report(attributes)


def _install() -> None:
    global _installed
    with _install_lock:
        if not _installed:
            # AsyncMonty's snapshots do not expose the protocol clock. In 1.6.0
            # the span and log attributes carry the same clock across feeds:
            # https://github.com/pydantic/monty/blob/v1.6.0/crates/monty-pool/src/telemetry/tracing.rs
            clock = _WorkerClock()
            instrument_telemetry(tracer=clock, logger=clock)
            _installed = True

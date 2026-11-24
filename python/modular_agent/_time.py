"""Convert Python durations to shared record units at the SDK boundary."""

from datetime import UTC, datetime

from ._types import AgentError, ErrorCode


def duration_ms(seconds: float, option: str, code: ErrorCode) -> int:
    error = f"{option} must be a positive duration in whole milliseconds"
    if type(seconds) not in (int, float) or not 0.001 <= seconds <= (2**53 - 1) / 1000:
        raise AgentError(code, error)
    milliseconds = round(seconds * 1000)
    # 1.001 * 1000 is not exactly 1001 in binary floating point.
    if seconds != milliseconds / 1000:
        raise AgentError(code, error)
    return milliseconds


def iso_time(milliseconds: int) -> str:
    seconds, remainder = divmod(milliseconds, 1000)
    return (
        datetime.fromtimestamp(seconds, UTC)
        .replace(microsecond=1000 * remainder)
        .isoformat(timespec="milliseconds")
    )

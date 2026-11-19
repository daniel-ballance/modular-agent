"""The official context compaction policy and /compact command."""

from typing import Any

from ma_context import Context

from ._plugin import Plugin


class _CompactionPlugin(Plugin):
    def __init__(self) -> None:
        super().__init__("context")

    def _native(self) -> Any:
        return Context()


def compaction() -> Plugin:
    """Summarize older context without erasing recorded history."""
    return _CompactionPlugin()

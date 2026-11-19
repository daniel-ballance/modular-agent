"""SDK history selections. The base owns persistence and the lease protocol."""

from __future__ import annotations

from dataclasses import dataclass
from os import PathLike
from pathlib import Path
from typing import Literal


@dataclass(frozen=True)
class HistoryStore:
    _kind: Literal["memory", "file", "http"]
    _path: Path | None = None
    _url: str | None = None


def memory_history() -> HistoryStore:
    return HistoryStore("memory")


def file_history(dir: str | PathLike[str]) -> HistoryStore:
    return HistoryStore("file", Path(dir))


def http_history(url: str, token_file: str | PathLike[str]) -> HistoryStore:
    return HistoryStore("http", Path(token_file), url)

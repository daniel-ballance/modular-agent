"""The shared telemetry kit's app and independent scenario observations."""

from __future__ import annotations

import asyncio
import json
import sys
import os
import sqlite3
from collections.abc import Iterator, Sequence
from contextlib import ExitStack, closing, contextmanager
from ipaddress import ip_address
from pathlib import Path
from typing import Any
from unittest.mock import patch
from urllib.parse import urlsplit

from ma_plugin.host import External

from . import Agent, ModelRef, ProcessPlugin, PromptResult, ProviderContext, Session
from ._acp_interface import _Interface
from ._native import _MemoryHistory
from .testing import ScriptedProvider


@contextmanager
def exporter(endpoint: str | None) -> Iterator[None]:
    if endpoint is None:
        yield
        return
    url = urlsplit(endpoint)
    if (
        url.scheme != "http"
        or url.hostname is None
        or not ip_address(url.hostname).is_loopback
        or url.port is None
        or url.path != "/v1/traces"
        or url.username is not None
        or url.password is not None
        or url.query
        or url.fragment
    ):
        raise ValueError("The scenario OTLP endpoint must be numeric loopback /v1/traces")

    from opentelemetry import trace
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanExportResult
    from opentelemetry.sdk.trace.sampling import ALWAYS_ON
    from requests import Session as HttpSession

    failed = False

    class CheckedExporter(OTLPSpanExporter):
        def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
            nonlocal failed
            try:
                result = super().export(spans)
            except Exception:
                failed = True
                raise
            failed |= result != SpanExportResult.SUCCESS
            return result

    session = HttpSession()
    session.trust_env = False  # No netrc, proxies, or implicit credentials.
    provider = TracerProvider(sampler=ALWAYS_ON, shutdown_on_exit=False)
    provider.add_span_processor(
        BatchSpanProcessor(CheckedExporter(endpoint=endpoint, session=session))
    )
    trace.set_tracer_provider(provider)
    try:
        yield
    finally:
        try:
            flushed = provider.force_flush()
        finally:
            provider.shutdown()
        if not flushed or failed:
            raise RuntimeError("Scenario OTLP export was not acknowledged")


def _records(directory: Path, session: str) -> list[dict[str, Any]]:
    # Read the committed store without taking a writer lease or opening recovery.
    uri = (directory / "data/history.sqlite3").as_uri() + "?mode=ro"
    with closing(sqlite3.connect(uri, uri=True)) as db:
        return [
            json.loads(value)
            for (value,) in db.execute(
                "SELECT record FROM entries WHERE session=? ORDER BY rowid", (session,)
            )
        ]


class TelemetryRun:
    def __init__(self, path: Path, request: dict[str, Any]) -> None:
        self.path = path
        self.request = request
        self.directory = Path(request["workDir"])
        self.attempts: list[dict[str, Any]] = []
        self.commits: list[dict[str, Any]] = []
        self.fixtures: list[Any] = []
        self.before: list[dict[str, Any]] = []
        self.after: list[dict[str, Any]] = []
        self.count_before: int | None = None

    @property
    def endpoint(self) -> str | None:
        return os.environ["MODULAR_AGENT_TELEMETRY_OTLP"] if self.request["sdk"] else None

    @property
    def process(self) -> bool:
        return bool(self.request["fixtures"])

    def fixture(self, name: str, config: dict[str, Any]) -> ProcessPlugin:
        spec = next(spec for spec in self.request["fixtures"] if spec["name"] == name)
        return ProcessPlugin(spec["command"], env=spec["env"], config=config)

    @contextmanager
    def observe(self, *, crash_child: bool = False) -> Iterator[None]:
        request = ScriptedProvider.request
        keep = _MemoryHistory.keep
        run = self

        async def inference(
            provider: ScriptedProvider, model: ModelRef, payload: Any, cx: ProviderContext
        ) -> Any:
            if self.count_before is not None and not self.after:
                assert cx.session_id is not None
                # Sample the actual committed store at the first resumed effect, not afterwards.
                self.after.extend(
                    row
                    for row in _records(self.directory, cx.session_id)
                    if row["kind"] == "modular-agent.turnTrace"
                )
                self.after.append({"kind": "effect"})
            response = await request(provider, model, payload, cx)
            parts = response["content"]
            assert isinstance(parts, list)
            self.attempts.append(
                {
                    "model": model.id,
                    "calls": [
                        {"name": part["name"], "id": part["id"]}
                        for part in parts
                        if isinstance(part, dict) and part["type"] == "toolCall"
                    ],
                }
            )
            if crash_child:
                # The counter only runs after the Provider returns this response.
                (self.directory / "killed-attempts.json").write_text(json.dumps(self.attempts))
            return response

        async def commit(store: _MemoryHistory, data: dict[str, Any], emit: Any) -> Any:
            result = await keep(store, data, emit)
            entries = data["entries"]
            kind = entries[0]["kind"]
            ids: dict[str, str]
            if any(e["kind"] == "plugins" for e in entries):
                parent = "modular_agent.session.open"
                ids = {}
            elif kind == "input_queued":
                parent = "modular_agent.input.admit"
                ids = {}
            else:
                # A stepStart is written by the step it opens. A turn's remaining
                # records that have no step come from the invocation itself.
                ids = {
                    key + "Id": entries[0][key] for key in ("turn", "step") if entries[0].get(key)
                }
                parent = "modular_agent.step" if "stepId" in ids else "invoke_agent"
            self.commits.append(
                {
                    "count": len(entries),
                    "status": "committed",
                    **ids,
                    "parent": {"name": parent, **ids},
                }
            )
            return result

        class FixtureHost(External):  # type: ignore[misc]  # Untyped base adapter.
            trace_context = run.request.get("handshake") != "no-offer"

            async def stop(self) -> None:
                await super().stop()
                if self.process is not None:
                    run.fixtures.append(self.process)

        with ExitStack() as stack:
            if self.request["sdk"]:
                stack.enter_context(patch.object(ScriptedProvider, "request", inference))
                if self.request["scenario"] == "first-turn":
                    stack.enter_context(patch.object(_MemoryHistory, "keep", commit))
            if self.process:
                stack.enter_context(patch("modular_agent._agent.External", FixtureHost))
            yield

    def at_barrier(self, session: str, count_before: int) -> None:
        self.count_before = count_before
        self.before = _records(self.directory, session)
        self.attempts = json.loads((self.directory / "killed-attempts.json").read_text())

    async def evidence(
        self, agent: Agent, session: Session, result: PromptResult, count_after: int
    ) -> dict[str, Any]:
        assert result.turn_id is not None and result.outcome is not None
        # Use store entries, not the public view that may omit internal records.
        state = await agent._session("branch", session=session.id)
        from ma_core.wire import entry_out

        rows = [entry_out(entry) for entry in state]
        report = {
            "scenario": self.request["scenario"],
            "placement": self.request["placement"],
            "passed": True,
            "sessionId": session.id,
            "turnId": result.turn_id,
            "outcome": result.outcome.kind.value,
            "historyKinds": [e["kind"] for e in rows],
        }
        if self.request["scenario"] == "first-turn":
            interface = _Interface(
                agent,
                None,
                None,
                None,
                None,
                scope={"tenants": frozenset({None}), "represents": {}},
            )
            interface.api = agent._h.api()
            # Probe a compatible session without exporting another session in this trace.
            proc = await asyncio.create_subprocess_exec(
                sys.executable,
                "-m",
                "modular_agent._scenarios",
                "--waiting-probe",
                self.directory / "probe",
                stdout=asyncio.subprocess.PIPE,
            )
            output, _ = await proc.communicate()
            if proc.returncode:
                raise RuntimeError("Waiting approval probe failed")
            report["declarations"] = {
                "waitingSession": json.loads(output),
                "agent": agent.declaration(),
                "session": await interface.declaration(session.id),
            }
            if self.request["sdk"]:
                report["commits"] = self.commits
        if self.request["sdk"]:
            killed = {e["stepId"] for e in self.before if e["kind"] == "modelRequest"}
            report["steps"] = []
            provider_calls = {}
            for row, attempt in zip(
                (e for e in rows if e["kind"] == "modelRequest"), self.attempts, strict=True
            ):
                step = row["stepId"]
                report["steps"].append(
                    {
                        "id": step,
                        "model": attempt["model"],
                        **({"beforeCrash": True} if step in killed else {}),
                    }
                )
                provider_calls[step] = {call["name"]: call["id"] for call in attempt["calls"]}
            calls = {e["toolCallId"]: e["data"] for e in rows if e["kind"] == "python.tool_call"}
            report["calls"] = []
            for e in rows:
                if e["kind"] != "toolResult":
                    continue
                call = calls[e["toolCallId"]]
                item = {
                    "id": e["toolCallId"],
                    "name": call["name"],
                    "stepId": e["stepId"],
                    "status": e["data"]["status"],
                }
                if parent := call.get("parentCallId"):
                    item["parentCallId"] = parent
                elif provider_id := provider_calls[e["stepId"]].get(call["name"]):
                    item["providerCallId"] = provider_id
                report["calls"].append(item)
        if self.request["scenario"] == "question-answered":
            question = next(e["data"]["request"] for e in rows if e["kind"] == "inputRequest")
            report["question"] = {"id": question["id"], "kind": question["kind"]}
        if self.count_before is not None:
            # Also include checkpoints committed after the effect. A kept turn
            # never dispatches the Provider on reopen, but can still be checked
            # for an unexpected checkpoint.
            observed_ids = {row.get("id") for row in [*self.before, *self.after]}
            timeline = [
                *self.after,
                *(
                    row
                    for row in _records(self.directory, session.id)
                    if row["kind"] == "modular-agent.turnTrace" and row["id"] not in observed_ids
                ),
            ]
            report["crash"] = {
                "signal": "SIGKILL",
                "countBefore": self.count_before,
                "countAfter": count_after,
                "turnStart": next(e for e in self.before if e["kind"] == "turnStart"),
                "afterRestart": timeline,
            }
        return report

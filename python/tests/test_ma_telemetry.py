"""Check ma's OTLP configuration without a real model or collector."""

import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
from threading import Thread

from opentelemetry.proto.collector.metrics.v1.metrics_service_pb2 import ExportMetricsServiceRequest
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
import pytest

from ma_standard import telemetry


@pytest.mark.parametrize("disabled", [False, True])
def test_no_exporter_without_endpoint_or_when_disabled(monkeypatch, disabled):
    for name in list(os.environ):
        if name.startswith("OTEL_"):
            monkeypatch.delenv(name)
    if disabled:
        monkeypatch.setenv("OTEL_SDK_DISABLED", "TRUE")
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1")
    calls = []

    def exporter(options):
        calls.append(options)

    monkeypatch.setattr(telemetry, "trace_exporter", exporter)
    monkeypatch.setattr(telemetry, "metric_exporter", exporter)
    with telemetry.configured():
        pass
    assert not calls  # No exporter or connection to a default endpoint.


def test_signal_overrides(monkeypatch):
    for name in list(os.environ):
        if name.startswith("OTEL_"):
            monkeypatch.delenv(name)
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://127.0.0.1:1234/custom")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_TRACES_TIMEOUT", "1300")
    assert telemetry.signal_options("traces") == telemetry.Signal(
        "http://127.0.0.1:1234/custom", "http/protobuf", 1.3
    )
    assert telemetry.signal_options("metrics") is None
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:2345/")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", "grpc")
    assert telemetry.signal_options("metrics") == telemetry.Signal(
        "http://127.0.0.1:2345/", "grpc", 10
    )


@pytest.mark.loopback
@pytest.mark.parametrize(
    "sampling", ["parentbased_always_on", "always_off", "disabled", "no-endpoint"]
)
async def test_scripted_ma_sends_metadata_only(tmp_path, sampling):
    packets = []

    class Receiver(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            packets.append((self.path, self.headers.get("x-test"), body))
            self.send_response(200)
            self.send_header("Content-Type", "application/x-protobuf")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *args):
            pass

    script = tmp_path / "script.json"
    script.write_text(
        json.dumps([{"text": "COMPLETION_SENTINEL", "usage": {"input": 2, "output": 1}}])
    )
    home = tmp_path / "home"
    home.mkdir()
    with ThreadingHTTPServer(("127.0.0.1", 0), Receiver) as server:
        thread = Thread(target=server.serve_forever)
        thread.start()
        try:
            url = f"http://127.0.0.1:{server.server_port}"
            env = {
                "PATH": os.environ["PATH"],
                "HOME": str(home),
                "TMPDIR": os.environ["TMPDIR"],
                "MODULAR_AGENT_SCRIPT": str(script),
                "OTEL_SERVICE_NAME": "ma-python-test",
                "OTEL_EXPORTER_OTLP_HEADERS": "x-test=BASE_SENTINEL",
                "OTEL_EXPORTER_OTLP_TRACES_HEADERS": "x-test=OVERRIDE_SENTINEL",
            }
            if sampling != "no-endpoint":
                env["OTEL_EXPORTER_OTLP_ENDPOINT"] = url
            if sampling == "disabled":
                env["OTEL_SDK_DISABLED"] = "true"
            elif sampling != "no-endpoint":
                env["OTEL_TRACES_SAMPLER"] = sampling
            proc = await asyncio.create_subprocess_exec(
                str(Path(sys.executable).with_name("ma")),
                "-p",
                "PROMPT_SENTINEL",
                cwd=tmp_path,
                env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await proc.communicate()
        finally:
            server.shutdown()
            thread.join()
    assert proc.returncode == 0, stderr.decode()
    assert b"COMPLETION_SENTINEL" in stdout
    if sampling in {"disabled", "no-endpoint"}:
        assert not packets
        return
    assert {path for path, _, _ in packets} == (
        {"/v1/metrics"} if sampling == "always_off" else {"/v1/metrics", "/v1/traces"}
    )
    for path, header, body in packets:
        assert b"SENTINEL" not in body
        if path == "/v1/traces":
            assert header == "OVERRIDE_SENTINEL"
            request = ExportTraceServiceRequest.FromString(body)
            [resource] = request.resource_spans
            assert {a.key: a.value.string_value for a in resource.resource.attributes} == {
                "service.name": "ma-python-test"
            }
            spans = {span.name for scope in resource.scope_spans for span in scope.spans}
            assert "invoke_agent ma" in spans and "chat script" in spans
        else:
            assert header == "BASE_SENTINEL"
            request = ExportMetricsServiceRequest.FromString(body)
            [resource] = request.resource_metrics
            names = {metric.name for scope in resource.scope_metrics for metric in scope.metrics}
            assert "gen_ai.client.inference.duration" in names
            assert "gen_ai.client.inference.usage.input_tokens" in names

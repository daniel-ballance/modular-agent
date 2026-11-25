import socket
import subprocess
from pathlib import Path

import pytest

from ma_fake import Fake
from ma_durable import Durable
from ma_runtime import Runtime
from ma_cli import build


def pytest_addoption(parser):
    parser.addoption("--runtime", choices=["transient", "durable"], default="transient")
    parser.addoption("--binding", choices=["local", "process"], default="local")


def pytest_configure(config):
    config.addinivalue_line("markers", "loopback: allow TCP to numeric IPv4 loopback only")
    config.addinivalue_line(
        "markers", "live: a live check against real model services; lifts the offline guard"
    )


@pytest.fixture
def runtime_kind(request):
    return request.config.getoption("--runtime")


@pytest.fixture
def runtime_type(runtime_kind):
    return Durable if runtime_kind == "durable" else Runtime


@pytest.fixture(autouse=True)
def subprocess_runtime(monkeypatch, runtime_kind, request):
    monkeypatch.setenv("MA_TEST_RUNTIME", runtime_kind)
    if request.node.get_closest_marker("live") is None:
        monkeypatch.setenv("MA_OFFLINE_TEST", "1")
    monkeypatch.setenv(
        "MA_PLUGIN_PROCESSES",
        "runtime,files,local,mcp" if request.config.getoption("--binding") == "process" else "",
    )


@pytest.fixture(autouse=True)
def no_network(monkeypatch, request):
    if request.node.get_closest_marker("live") is not None:
        return  # Skipped unless MODULAR_AGENT_LIVE=1; then it must reach the model service.
    loopback = request.node.get_closest_marker("loopback") is not None

    def guarded(operation):
        def connect(sock, address):
            if loopback and sock.family == socket.AF_INET and address[0] == "127.0.0.1":
                return operation(sock, address)
            raise AssertionError("Offline tests must not connect outside loopback")

        return connect

    monkeypatch.setattr(socket.socket, "connect", guarded(socket.socket.connect))
    monkeypatch.setattr(socket.socket, "connect_ex", guarded(socket.socket.connect_ex))


@pytest.fixture
def git_project(tmp_path: Path) -> Path:
    project = tmp_path / "project"
    project.mkdir()
    subprocess.run(["git", "init", "-q", str(project)], check=True)
    return project


@pytest.fixture
async def agent(tmp_path, runtime_type):
    agents = []

    async def factory(script=(), settings=None, secrets=()):
        provider = Fake(script)
        h = await build(
            tmp_path / str(len(agents)) / "store", provider, secrets, runtime=runtime_type()
        )
        agents.append(h)
        s = await h.api().session(
            "create", project=str(tmp_path), settings={"model": "fake", **(settings or {})}
        )
        return h, h.api(), s["id"], provider

    try:
        yield factory
    finally:
        for h in agents:
            await h.stop()

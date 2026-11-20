import asyncio
import json
import secrets
import ssl
import subprocess
from pathlib import Path

import pytest
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve as listen
from websockets.exceptions import ConnectionClosed, InvalidStatus

from modular_agent import AgentError, Plugin, create_agent, serve, tool
from modular_agent.testing import scripted_provider

pytestmark = pytest.mark.loopback

PROTOCOL = "modular-agent-plugin-1"
INIT = {"binding": "modular-agent-plugin/1", "data": "modular-agent-data/1"}


@pytest.fixture
def token_file(tmp_path):
    file = tmp_path / "token"
    file.touch(mode=0o600)
    file.write_text(secrets.token_hex(32))
    return file


def headers(file):
    return {"Authorization": "Bearer " + file.read_text().strip()}


async def rpc(ws, key, method, params):
    await ws.send(json.dumps({"jsonrpc": "2.0", "id": key, "method": method, "params": params}))
    return json.loads(await ws.recv())


async def test_plugin_service_auth_frames_and_instance_lifetime(token_file):
    instances = []
    stopped = []

    class Example(Plugin):
        async def setup(self, r):
            instances.append(self)

        async def stop(self):
            stopped.append(self)

    server = await serve(Example("sample"), listen="127.0.0.1:0", token_file=token_file)
    opts = {"subprotocols": [PROTOCOL], "additional_headers": headers(token_file)}
    try:
        for auth in ({}, {"Authorization": "Bearer wrong"}):
            with pytest.raises(InvalidStatus) as exc:
                await connect(server.url, additional_headers=auth, subprotocols=[PROTOCOL])
            assert exc.value.response.status_code == 401
        with pytest.raises(InvalidStatus):
            await connect(server.url, additional_headers=headers(token_file))
        async with connect(server.url, **opts) as a, connect(server.url, **opts) as b:
            for conn in (a, b):
                assert conn.subprotocol == PROTOCOL
                assert (await rpc(conn, 1, "plugin/initialize", INIT))["result"]["name"] == "sample"
            assert len(instances) == 2 and instances[0] is not instances[1]
            assert (await rpc(a, 2, "plugin/shutdown", {}))["result"] == {}
            await a.wait_closed()
            assert a.close_code == 1000 and stopped == [instances[0]]
            await b.send(b"not text")
            with pytest.raises(ConnectionClosed):
                await b.recv()
            assert b.close_code == 1003
        async with connect(server.url, compression=None, **opts) as conn:
            # Fragmentation cannot circumvent the message limit.
            await conn.send(["a" * (4 << 20)] * 16 + ["a"])
            with pytest.raises(ConnectionClosed):
                await conn.recv()
            assert conn.close_code == 1009
        async with connect(server.url, **opts) as conn:
            await rpc(conn, 1, "plugin/initialize", INIT)
            await server.close()
            assert conn.close_code == 1000
            assert stopped == instances
    finally:
        await server.close()


async def test_plugin_service_tls(token_file, tmp_path: Path, monkeypatch):
    with pytest.raises(ValueError, match="loopback"):
        await serve(Plugin("sample"), listen="0.0.0.0:0", token_file=token_file)
    cert, key = tmp_path / "cert.pem", tmp_path / "key.pem"
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=IP:127.0.0.1",
            "-out",
            str(cert),
            "-keyout",
            str(key),
        ],
        check=True,
        capture_output=True,
    )
    server = await serve(
        Plugin("sample"),
        listen="127.0.0.1:0",
        token_file=token_file,
        tls={"cert_file": cert, "key_file": key},
    )
    try:
        assert server.url.startswith("wss://")
        opts = {"additional_headers": headers(token_file), "subprotocols": [PROTOCOL]}
        with pytest.raises(ssl.SSLCertVerificationError):
            await connect(server.url, **opts)
        client = ssl.create_default_context(cafile=cert)
        async with connect(server.url, ssl=client, **opts) as conn:
            assert (await rpc(conn, 1, "$/ping", {}))["result"] == {}
        service = {"url": server.url, "token_file": token_file}
        with pytest.raises(AgentError, match="CERTIFICATE_VERIFY_FAILED") as exc:
            await create_agent(service_plugins=[service])
        assert exc.value.code == "invalid_composition"
        monkeypatch.setenv("SSL_CERT_FILE", str(cert))
        async with create_agent(service_plugins=[service]):
            pass
    finally:
        await server.close()


async def test_host_service_config_and_environment(token_file, monkeypatch):
    received = []
    server = await serve(
        Plugin("sample", setup=lambda r: received.append(r.config())),
        listen="127.0.0.1:0",
        token_file=token_file,
    )
    env = {"url": server.url, "tokenFile": str(token_file), "config": {"count": 2}}
    try:
        monkeypatch.setenv("MODULAR_AGENT_PLUGINS", json.dumps([env]))
        async with create_agent():
            assert received == []
        async with create_agent(plugin_host=True):
            assert received == [{"count": 2}]
        monkeypatch.setenv("MODULAR_AGENT_PLUGINS", "[]")
        async with create_agent(
            service_plugins=[{"url": server.url, "token_file": token_file, "config": {"count": 3}}]
        ):
            assert received == [{"count": 2}, {"count": 3}]
        for specs in ([env | {"command": ["bad"]}], [env, env]):
            monkeypatch.setenv("MODULAR_AGENT_PLUGINS", json.dumps(specs))
            with pytest.raises(AgentError) as exc:
                await create_agent(plugin_host=True)
            assert exc.value.code == "invalid_composition"
    finally:
        await server.close()
    with pytest.raises(AgentError) as exc:
        await create_agent(service_plugins=[{"url": server.url, "token_file": token_file}])
    assert exc.value.code == "invalid_composition"


@pytest.mark.parametrize("stall", [False, True])
async def test_service_loss_settles_dispatched_tool(token_file, stall):
    dispatched = asyncio.Event()
    pinged = asyncio.Event()

    @tool
    async def hold() -> str:
        """Keep the call pending until the connection closes."""
        dispatched.set()
        await asyncio.Future()
        return "unreachable"

    async def silent(ws):
        registration = {
            "binding": INIT["binding"],
            "name": "sample",
            "toolSources": [{"id": "sample", "tools": [hold.definition], "perSession": False}],
        }
        async for raw in ws:
            request = json.loads(raw)
            if request["method"] == "plugin/initialize":
                await ws.send(
                    json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": registration})
                )
            elif request["method"] == "tools/call":
                dispatched.set()
            elif request["method"] == "$/ping":
                pinged.set()

    server = (
        await listen(silent, "127.0.0.1", 0, subprotocols=[PROTOCOL])
        if stall
        else await serve(
            Plugin("sample", tools=[hold]), listen="127.0.0.1:0", token_file=token_file
        )
    )

    async def close():
        if stall:
            server.close()
            await server.wait_closed()
        else:
            await server.close()

    url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}" if stall else server.url
    try:
        async with create_agent(
            providers=[
                scripted_provider(
                    [{"toolCalls": [{"name": "hold", "input": {}}]}, {"text": "done"}]
                )
            ],
            service_plugins=[{"url": url, "token_file": token_file}],
            service_ping_interval=0.05 if stall else 30,
            service_control_timeout=0.1 if stall else 5,
        ) as agent:
            session = await agent.session()
            async with asyncio.timeout(5):
                turn = asyncio.create_task(session.prompt("call hold"))
                await dispatched.wait()
                if stall:
                    await pinged.wait()
                else:
                    await close()
                [result] = (await turn).tool_results()
                assert result.status == "outcomeUnknown"
    finally:
        await close()


async def test_acp_connections_authenticate_and_scope_independently(
    token_file, tmp_path, monkeypatch
):
    monkeypatch.setenv("MODULAR_AGENT_ACTOR", "not-the-network-actor")
    other = tmp_path / "other"
    other.touch(mode=0o600)
    other.write_text(secrets.token_hex(32))
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    first = {"id": "first", "kind": "program", "rights": ["watch", "input"]}
    second = {"id": "second", "kind": "agent", "rights": ["watch"]}
    tenants = {"team": {"rights": ["watch", "input"]}}
    async with create_agent(
        project=allowed,
        plugin_host=True,
        tenants=tenants,
        providers=[scripted_provider([{"text": "done"}])],
    ) as agent:

        async def compose(project):
            return agent

        server = await agent.serve_acp(
            listen="127.0.0.1:0",
            compose=compose,
            actors=[
                {
                    "token_file": token_file,
                    "actor": first,
                    "projects": [allowed],
                    "tenants": ["team"],
                },
                {"token_file": other, "actor": second},
            ],
        )
        opts = {"subprotocols": ["modular-agent-acp-1"]}
        meta = "modular-agent"
        with pytest.raises(InvalidStatus) as exc:
            await connect(server.url, **opts)
        assert exc.value.response.status_code == 401
        async with connect(server.url, additional_headers=headers(token_file), **opts) as a:
            assert (await rpc(a, 1, "initialize", {"protocolVersion": 1}))["result"]["_meta"][meta][
                "actor"
            ] == first
            params = {"cwd": str(allowed), "mcpServers": []}
            error = await rpc(a, 2, "session/new", params)
            assert error["error"]["data"]["code"] == "forbidden"
            scoped = params | {"_meta": {meta: {"tenant": "team"}}}
            error = await rpc(a, 3, "session/new", scoped | {"cwd": str(tmp_path)})
            assert error["error"]["data"]["code"] == "forbidden"
            reply = await rpc(a, 4, "session/new", scoped)
            while reply.get("id") != 4:
                reply = json.loads(await a.recv())
            sid = reply["result"]["sessionId"]
            async with connect(server.url, additional_headers=headers(other), **opts) as b:
                assert (await rpc(b, 1, "initialize", {"protocolVersion": 1}))["result"]["_meta"][
                    meta
                ]["actor"] == second
                listing = await rpc(b, 2, "session/list", {})
                assert listing["result"]["sessions"] == []
                error = await rpc(b, 3, "session/prompt", {"sessionId": sid, "prompt": []})
                assert "error" in error
                reply = await rpc(b, 4, "session/new", params)
                while reply.get("id") != 4:
                    reply = json.loads(await b.recv())
                assert reply["result"]["sessionId"] != sid
            assert (await rpc(a, 5, "$/ping", {}))["result"] == {}

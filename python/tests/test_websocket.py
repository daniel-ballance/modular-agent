import json
import secrets
import ssl
import subprocess
from pathlib import Path

import pytest
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from modular_agent import Plugin, serve

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


async def test_plugin_service_tls(token_file, tmp_path: Path):
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
    finally:
        await server.close()

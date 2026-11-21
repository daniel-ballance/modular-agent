"""Developer Providers use the same credential and streaming contracts in both placements."""

import sys
from pathlib import Path

import pytest

from modular_agent import (
    ModelFailure,
    Plugin,
    ProcessPlugin,
    ProviderCatalog,
    ProviderSupports,
    create_agent,
    serve,
)
from modular_agent.testing import over_wire


class Beacon(ProviderCatalog):
    id = "beacon"
    supports = ProviderSupports(safe_to_repeat=True)
    name = "demo"
    ready = True

    def available(self):
        return self.ready

    def models(self):
        return [
            {
                "provider": self.id,
                "id": self.name,
                "input": ["text"],
                "contextWindow": 4096,
                "maxOutput": 256,
                "reasoning": False,
            }
        ]

    async def request(self, model, request, cx):
        if cx.credential() != "offline-key":
            raise ModelFailure({"kind": "credentials", "message": "Key rejected"})
        await cx.piece("text", "Beacon ")
        await cx.piece("text", "ready.")
        return {
            "role": "assistant",
            "stop": "finished",
            "content": [{"type": "text", "text": "Beacon ready."}],
        }


def plugin(provider):
    return Plugin("beacon-plugin", setup=lambda registrar: registrar.provider(provider))


@pytest.mark.parametrize("served", [False, True])
@pytest.mark.parametrize("key", ["offline-key", "rejected"])
async def test_provider_records_its_response_and_streams(served, key, monkeypatch):
    monkeypatch.setenv("BEACON_API_KEY", key)
    process = ProcessPlugin([sys.executable, str(Path(__file__).resolve())])
    kwargs = {"process_plugins": [process]} if served else {"plugins": [plugin(Beacon())]}
    async with create_agent(**kwargs) as agent:
        assert (await agent.models())[0]["id"] == "demo"
        session = await agent.session()
        chunks = [
            e.data.delta
            async for e in session.prompt_stream("Check the beacon.")
            if e.type == "text"
        ]
        result = await session.last_turn()
        assert result is not None and result.outcome is not None
        records = await session.history()
        kinds = [entry["kind"] for entry in records]
        assert kinds.index("modelRequest") < kinds.index("response")
        if key == "offline-key":
            assert result.outcome.kind == "completed"
            assert chunks == ["Beacon ", "ready."]
            assert result.text == "Beacon ready."
        else:
            assert result.outcome.kind == "failed"
            assert not chunks
            assert (
                next(e["message"] for e in records if e["kind"] == "response")["error"]["kind"]
                == "credentials"
            )


@pytest.mark.parametrize("served", [False, True])
async def test_sdk_provider_declaration_only_advertises_kept_state(served):
    beacon = Beacon()
    beacon.supports = ProviderSupports(keeps_state=True, safe_to_repeat=True)
    registered = plugin(beacon)
    async with create_agent(plugins=[over_wire(registered) if served else registered]) as agent:
        value = agent.declaration()
        assert value["keepsStateAtProvider"] is True
        assert value["runsToolsAtProvider"] is False
        assert value["liveSessions"] is False


async def test_provider_refreshes_catalog_and_consults_readiness():
    beacon = Beacon()
    async with create_agent(providers=[beacon]) as agent:
        assert [m["id"] for m in await agent.models()] == ["demo"]
        beacon.name = "new"
        beacon.changed()
        assert [m["id"] for m in await agent.models()] == ["new"]
        beacon.ready = False
        assert await agent.models() == []
        session = await agent.session()
        turn = await session.prompt("Do not invoke an unavailable Provider.")
        assert turn.outcome is not None and turn.outcome.kind == "failed"
        assert not any(e["kind"] == "modelRequest" for e in await session.history())


if __name__ == "__main__":
    serve(plugin(Beacon()))

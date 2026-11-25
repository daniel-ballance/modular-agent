from pathlib import Path

import pytest
from modular_agent import (
    ModelFailure,
    ModelInfo,
    ModelRef,
    ProviderContext,
    ProviderSupports,
    create_agent,
)
from modular_agent import JsonObject


class Beacon:
    id = "beacon"
    supports = ProviderSupports(safe_to_repeat=True)

    def models(self) -> list[ModelInfo]:
        return [
            {
                "provider": self.id,
                "id": "demo",
                "contextWindow": 4096,
                "maxOutput": 256,
                "input": ["text"],
                "reasoning": False,
            }
        ]

    async def request(
        self, _model: ModelRef, _request: JsonObject, cx: ProviderContext
    ) -> JsonObject:
        key = cx.credential()
        if key != "offline-key":
            raise ModelFailure({"kind": "credentials", "message": "Key unavailable or rejected"})
        await cx.piece("text", "Beacon ")
        await cx.piece("text", "ready.")
        return {
            "role": "assistant",
            "stop": "finished",
            "content": [{"type": "text", "text": "Beacon ready."}],
        }


@pytest.mark.parametrize("key", ["offline-key", "rejected"])
async def test_beacon_streams_and_records_failures(
    key: str, monkeypatch: pytest.MonkeyPatch, git_project: Path
) -> None:
    monkeypatch.setenv("BEACON_API_KEY", key)
    async with create_agent(project=git_project, providers=[Beacon()]) as agent:
        assert (await agent.models())[0]["id"] == "demo"
        session = await agent.session()
        pieces = [
            event.data.delta
            async for event in session.prompt_stream("Check the beacon.")
            if event.type == "text"
        ]
        turn = await session.last_turn()
        assert turn is not None
        if key == "offline-key":
            assert pieces == ["Beacon ", "ready."]
            assert turn.text == "Beacon ready."
        else:
            assert pieces == []
            assert turn.outcome.kind == "failed"
            response = next(
                entry for entry in await session.history() if entry["kind"] == "response"
            )
            assert response["message"]["stop"] == "failed"
            assert response["message"]["error"]["kind"] == "credentials"

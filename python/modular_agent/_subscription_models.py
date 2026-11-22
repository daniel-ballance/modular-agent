"""The shared catalog and reasoning mappings for subscription Providers."""

from collections.abc import Sequence
from copy import deepcopy
from importlib.resources import files
import json
from typing import cast

from ._model_http import _LEVELS
from ._provider import ModelInfo
from ._types import AgentError, ErrorCode, JsonObject

_ROWS: list[JsonObject] = json.loads(
    files("modular_agent").joinpath("subscription-models.json").read_bytes()
)["models"]


class SubscriptionModels:
    def __init__(
        self,
        provider: str,
        models: Sequence[str | ModelInfo] | None,
        *,
        override_limits: bool = False,
    ) -> None:
        self.infos: dict[str, ModelInfo] = {}
        self.levels: dict[str, JsonObject] = {}
        for row in _ROWS:
            if row["provider"] != provider:
                continue
            model = cast(str, row["id"])
            levels = cast(JsonObject, row["levels"])
            self.levels[model] = levels
            built_in = {k: deepcopy(v) for k, v in row.items() if k != "levels"}
            if levels:
                built_in["thinking"] = list(levels)
            self.infos[model] = cast(ModelInfo, built_in)
        for entry in models or ():
            model = entry if isinstance(entry, str) else entry["id"]
            if not model:
                raise AgentError(ErrorCode.INVALID_COMPOSITION, "A model id cannot be empty")
            if model in self.infos:
                if override_limits and not isinstance(entry, str):
                    # Local catalog limits may be narrower or wider. The shared
                    # model's verified reasoning settings do not change.
                    known = self.infos[model]
                    known["contextWindow"] = entry["contextWindow"]
                    known["maxOutput"] = entry["maxOutput"]
                    known["input"] = list(entry["input"])
                continue
            info = (
                ModelInfo(
                    provider=provider,
                    id=model,
                    contextWindow=128_000,
                    maxOutput=4096,
                    input=["text"],
                    reasoning=False,
                )
                if isinstance(entry, str)
                else deepcopy(entry)
            )
            info["provider"] = provider
            info.pop("thinking", None)
            self.infos[model] = info

    def reasoning(self, model: str, request: JsonObject) -> JsonObject:
        settings = request.get("settings")
        asked = settings.get("reasoning") if isinstance(settings, dict) else None
        if not isinstance(asked, str) or asked not in _LEVELS:
            return {}
        offered = self.levels.get(model, {})
        for level in reversed(_LEVELS[: _LEVELS.index(asked) + 1]):
            mapping = offered.get(level)
            if isinstance(mapping, dict):
                return deepcopy(mapping)
        return {}

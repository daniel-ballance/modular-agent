import json
import sys
import types

import pytest

from ma_config import Config
from ma_core import AgentError, Plugin
from ma_fake import Fake
from ma_harness import Harness
from modular_agent import build


class Example(Plugin):
    name = "example"

    def __init__(self, value):
        self.value = value

    async def start(self, api):
        await super().start(api)
        api.command("example", "Configured example", self.command)

    async def command(self, d):
        return self.value


@pytest.fixture
def plugin_module(monkeypatch):
    module = types.ModuleType("ma_test_configured")
    module.Example = Example
    monkeypatch.setitem(sys.modules, module.__name__, module)
    return "ma_test_configured:Example"


def settings(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


async def test_global_plugin_options_and_project_defaults(tmp_path, runtime_type, plugin_module):
    root, project = tmp_path / "store", tmp_path / "project"
    settings(
        root / "settings.json",
        {"plugins": [{"factory": plugin_module, "options": {"value": "global"}}]},
    )
    settings(
        project / ".modular-agent/settings.json",
        {
            "model": "fake",
            "thinking": "high",
            "plugins": [{"factory": "DO_NOT_IMPORT:No"}],
            "plugin_settings": {plugin_module: {"value": "project"}},
            "trusted": True,
        },
    )
    h = await build(root, Fake(), runtime=runtime_type(), project=project)
    try:
        s = await h.api().session("create", project=str(project))
        assert s["settings"]["model"] == "fake"
        assert s["settings"]["thinking"] == "high"
        assert "plugins" not in s["settings"] and "plugin_settings" not in s["settings"]
        assert await h.api().session("command", session=s["id"], text="/example") == "global"
    finally:
        await h.stop()


async def test_project_trust_canonical_revocable_and_plugin_options(
    tmp_path, runtime_type, plugin_module
):
    root, project = tmp_path / "store", tmp_path / "project"
    settings(
        project / ".modular-agent/settings.json",
        {
            "plugins": [{"factory": plugin_module, "options": {"value": "original"}}],
            "plugin_settings": {plugin_module: {"value": "trusted"}},
        },
    )
    config = Config(root)
    config.set_trust(project / ".." / "project")
    assert config.trusted(project)
    h = await build(root, Fake(), runtime=runtime_type(), project=project)
    try:
        s = await h.api().session("create", project=str(project), settings={"model": "fake"})
        assert await h.api().session("command", session=s["id"], text="/example") == "trusted"
        with pytest.raises(AgentError, match="bound to project"):
            await h.api().session("create", project=str(tmp_path / "other"))
        assert len(h.sessions) == 1
    finally:
        await h.stop()
    config.set_trust(project, False)
    h = await build(root, Fake(), runtime=runtime_type(), project=project)
    try:
        assert "example" not in h.plugins
    finally:
        await h.stop()


async def test_gate_checks_before_import_and_constructor(tmp_path):
    h = Harness()

    async def deny(d):
        return {**d, "refused": True, "reason": "Not trusted"}

    h.api().on("plugin.load", deny)
    with pytest.raises(AgentError, match="Not trusted"):
        await h.load_named({"factory": "does_not_exist:Example", "project": str(tmp_path)})
    assert not h.plugins
    await h.stop()


async def test_configured_failure_cleans_composition(tmp_path, plugin_module, runtime_type):
    settings(
        tmp_path / "settings.json",
        {"plugins": [{"factory": plugin_module, "options": {"wrong": 1}}]},
    )
    with pytest.raises(TypeError):
        await build(tmp_path, Fake(), runtime=runtime_type())
    # No acquired session lock or child processes remain, and startup works again.
    settings(tmp_path / "settings.json", {})
    h = await build(tmp_path, Fake(), runtime=runtime_type())
    await h.stop()

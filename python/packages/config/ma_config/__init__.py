"""Settings and explicit project trust. Project data cannot grant itself trust."""

import json
from pathlib import Path

from ma_core import AgentError, Plugin


DEFAULTS = {"model": "claude-haiku-5-5", "thinking": "off", "max_steps": 16, "max_retries": 1}
PLUGIN_KEYS = {"plugins", "plugin_settings"}


class Config(Plugin):
    name = "config"
    role = "configuration"
    declarations = {"project_trust": True, "plugins_fixed_at_startup": True}

    def __init__(self, root, project=None, *, defaults=None):
        self.defaults = {**DEFAULTS, **(defaults or {})}
        self.root = Path(root)
        self.project = str(Path(project).resolve()) if project is not None else None

    async def start(self, api):
        await super().start(api)
        api.provide("config", self)
        api.on("session.start", self.check_project, order="first")
        api.on("plugin.load", self.check_trust, order="first")

    def _read(self, path):
        if not path.exists():
            return {}
        value = json.loads(path.read_text())
        if not isinstance(value, dict):
            raise AgentError("Settings must be a JSON object: " + str(path))
        return value

    def trusted(self, project):
        return str(Path(project).resolve()) in self._read(self.root / "trust.json").get(
            "projects", []
        )

    def set_trust(self, project, trusted=True):
        """Called only by explicit local startup controls, never from project settings."""
        path = self.root / "trust.json"
        projects = set(self._read(path).get("projects", []))
        canonical = str(Path(project).resolve())
        projects.add(canonical) if trusted else projects.discard(canonical)
        self.root.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps({"projects": sorted(projects)}) + "\n")
        temporary.replace(path)

    def layers(self, project):
        return (
            self._read(self.root / "settings.json"),
            self._read(Path(project) / ".modular-agent" / "settings.json"),
        )

    async def load(self, d, emit):
        settings = dict(self.defaults)
        for layer in self.layers(d["project"]):
            settings.update({k: v for k, v in layer.items() if k not in PLUGIN_KEYS})
        return settings

    async def plan(self, d, emit):
        global_settings, project_settings = self.layers(d["project"])
        layers = [(global_settings, None)]
        if not d.get("global_only") and self.trusted(d["project"]):
            layers.append((project_settings, str(Path(d["project"]).resolve())))
        plugins, options = [], {}
        for layer, project in layers:
            for spec in layer.get("plugins", []):
                if not isinstance(spec, dict) or not isinstance(spec.get("factory"), str):
                    raise AgentError("A plugin needs a module:factory name and optional options")
                plugins.append({**spec, "project": project})
            for name, value in layer.get("plugin_settings", {}).items():
                options[name] = {**options.get(name, {}), **value}
        return {"plugins": plugins, "options": options}

    async def check_trust(self, d):
        project = d.get("project")
        if project is not None and (not self.trusted(project) or project != self.project):
            return {
                **d,
                "refused": True,
                "reason": "Project plugins require explicit project trust",
            }
        return d

    async def check_project(self, d):
        if self.project is not None:
            s = await self.api.session("get", session=d["session"])
            if s["project"] != self.project:
                raise AgentError("This composition is bound to project " + self.project, "refused")

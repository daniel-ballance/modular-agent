"""Shared configuration and Python's private state directory."""

from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import sys
from typing import cast

from modular_agent import Json, JsonObject, ProcessPlugin


def read_object(path: Path) -> JsonObject:
    try:
        value: object = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    if not isinstance(value, dict):
        raise ValueError(f"{path}: settings must be an object")
    return cast(JsonObject, value)


def _xdg(var: str, fallback: str) -> Path:
    path = Path(os.environ.get(var, ""))
    return (path if path.is_absolute() else Path.home() / fallback) / "modular-agent"


def _expand(text: str) -> str:
    def replace(match: re.Match[str]) -> str:
        name = match[1]
        try:
            return os.environ[name]
        except KeyError:
            raise ValueError(f"environment variable {name} is not set") from None

    if re.search(r"\$\{[^}]*$", text):
        raise ValueError("unclosed ${...} in MCP server settings")
    return re.sub(r"\$\{([^}]+)\}", replace, text)


def _strings(value: Json, what: str) -> JsonObject:
    if value is None:
        return {}
    if not isinstance(value, dict) or any(not isinstance(v, str) for v in value.values()):
        raise ValueError(f"{what} must contain only strings")
    return {k: _expand(cast(str, v)) for k, v in value.items()}


def _server(name: str, spec: Json, project: Path) -> JsonObject | None:
    if not isinstance(spec, dict):
        raise ValueError("server settings must be an object")
    if spec.get("enabled") is False or spec.get("disabled") is True:
        return None
    if not re.fullmatch(r"[A-Za-z0-9_-]+", name):
        raise ValueError("invalid MCP server name")
    kind = spec.get("type", "http" if "url" in spec else "stdio")
    if kind in ("http", "streamable-http", "streamableHttp") and isinstance(
        url := spec.get("url"), str
    ):
        url = _expand(url)
        if not url.startswith(("http://", "https://")):
            raise ValueError("MCP HTTP server needs an http(s) URL")
        return {
            "name": name,
            "type": "http",
            "url": url,
            "headers": _strings(spec.get("headers"), "headers"),
        }
    if kind == "stdio" and isinstance(command := spec.get("command"), str) and command:
        arguments = spec.get("args", [])
        if not isinstance(arguments, list) or any(not isinstance(a, str) for a in arguments):
            raise ValueError("args must be an array of strings")
        return {
            "name": name,
            "type": "stdio",
            "command": _expand(command),
            "args": [_expand(cast(str, a)) for a in arguments],
            "env": _strings(spec.get("env"), "env"),
            "cwd": str(project),
        }
    raise ValueError("expected a command or url")


@dataclass(frozen=True)
class Paths:
    config: Path
    state: Path

    @classmethod
    def from_env(cls) -> "Paths":
        if (data := os.environ.get("MODULAR_AGENT_DATA_DIR")) is not None:
            return cls(Path(data).resolve(), Path(data).resolve() / "state")
        return cls(
            _xdg("XDG_CONFIG_HOME", ".config"), _xdg("XDG_STATE_HOME", ".local/state") / "python"
        )

    @property
    def ledger(self) -> Path:
        return self.config / "trusted-projects.json"

    def trusted(self, project: Path) -> bool:
        return read_object(self.ledger).get(str(project)) is True

    def trust(self, project: Path) -> None:
        entries = read_object(self.ledger)
        entries[str(project)] = True
        self.config.mkdir(parents=True, exist_ok=True)
        import tempfile

        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=self.config, delete=False
        ) as file:
            json.dump(entries, file, ensure_ascii=False, indent=2)
        Path(file.name).replace(self.ledger)

    def settings(self, project: Path) -> JsonObject:
        settings: JsonObject = {
            "thinking": "medium",
            "maxSteps": 500,
            "maxOutput": 32000,
            "modelTools": ["codemode"],
        }
        names = {"model_tools": "modelTools", "step_limit": "maxSteps", "output_limit": "maxOutput"}
        for layer in (
            read_object(self.config / "settings.json"),
            read_object(project / ".modular-agent.json"),
        ):
            for key, value in layer.items():
                if not key.startswith("_") and key not in {
                    "plugins",
                    "plugin_settings",
                    "mcp_servers",
                    "trusted",
                }:
                    settings[names.get(key, key)] = value
        return settings

    def mcp(self, project: Path) -> list[JsonObject]:
        files = [self.config / "mcp.json"]
        if self.trusted(project):
            files.append(project / ".mcp.json")
        servers: dict[str, JsonObject] = {}
        for path in files:
            try:
                raw = read_object(path).get("mcpServers", {})
                if not isinstance(raw, dict):
                    raise ValueError("mcpServers must be an object")
                for name, spec in sorted(raw.items()):
                    try:
                        if server := _server(name, spec, project):
                            servers[name] = server
                    except ValueError as exc:
                        print(f"{path}: {name}: {exc}", file=sys.stderr)
            except (OSError, ValueError) as exc:
                print(f"{path}: {exc}", file=sys.stderr)
        return list(servers.values())


def claude_launch() -> ProcessPlugin | None:
    override = os.environ.get("MODULAR_AGENT_CLAUDE_SIDECAR")
    paths = [Path(override)] if override else []
    paths.extend(
        parent / "typescript/sidecars/claude/dist/main.js"
        for parent in Path(__file__).resolve().parents
    )
    paths.append(Path.home() / ".local/share/modular-agent/sidecars/claude/dist/main.js")
    for script in paths:
        if script.is_file():
            env = {
                name: os.environ[name]
                for name in ("HOME", "PATH", "CLAUDE_CONFIG_DIR")
                if name in os.environ
            }
            return ProcessPlugin(["node", str(script.resolve())], env=env)
    return None

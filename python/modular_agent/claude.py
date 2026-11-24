"""Claude plan Provider using one Python Agent SDK conversation per request."""

import asyncio
from collections.abc import AsyncIterator, Callable, Sequence
from copy import deepcopy
from hashlib import sha256
from importlib.metadata import version as _package_version
import json
import os
import tempfile
from typing import Any, cast
from uuid import uuid4

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    ResultMessage,
    StreamEvent,
    TextBlock,
    ThinkingBlock,
    ToolUseBlock,
)
from claude_agent_sdk.types import EffortLevel, McpSdkServerConfig, ThinkingConfig
from mcp.server import Server
from mcp.types import CallToolResult, ListToolsResult, Tool

from ._provider import ModelFailure, ModelInfo, ProviderCatalog, ProviderContext, ProviderSupports
from ._subscription_models import SubscriptionModels
from ._types import AgentError, ErrorCode, Json, JsonObject, ModelRef

_CLIENT_APP = f"modular-agent-py/{_package_version('modular-agent')}"
_PREFIX = "mcp__agent__"
_SIGN_IN = "Run `claude auth login` and sign in to a Claude plan."


def _obj(value: Json) -> JsonObject:
    return value if isinstance(value, dict) else {}


def _rows(value: Json) -> list[JsonObject]:
    return [row for row in value if isinstance(row, dict)] if isinstance(value, list) else []


def _user_content(parts: list[JsonObject]) -> list[JsonObject]:
    blocks: list[JsonObject] = []
    for part in parts:
        if part.get("type") == "text" and part.get("text"):
            blocks.append({"type": "text", "text": part["text"]})
        elif part.get("type") == "image":
            mime = part.get("mimeType")
            if mime in ("image/png", "image/jpeg", "image/gif", "image/webp"):
                blocks.append(
                    {
                        "type": "image",
                        "source": {"type": "base64", "media_type": mime, "data": part["data"]},
                    }
                )
            else:
                blocks.append({"type": "text", "text": "(image of unsupported type omitted)"})
    return blocks


def _prompt_blocks(request: JsonObject) -> list[JsonObject]:
    # A fresh Agent SDK conversation can take only user messages. Replay past
    # turns as a labelled record, not as new instructions or native tool calls.
    entries = []
    call_ids: set[str] = set()
    for message in _rows(request.get("messages")):
        role = message.get("role")
        if role == "assistant" and message.get("stop") not in {"failed", "aborted"}:
            entries.append(message)
            call_ids.update(
                call_id
                for p in _rows(message.get("content"))
                if p.get("type") == "toolCall" and isinstance(call_id := p.get("id"), str)
            )
        elif role == "user" or (
            role == "toolResult"
            and isinstance(call_id := message.get("toolCallId"), str)
            and call_id in call_ids
        ):
            entries.append(message)
    live = len(entries)
    while live and entries[live - 1].get("role") == "user":
        live -= 1
    past = entries[:live]
    blocks: list[JsonObject] = []
    if past:
        mark = sha256(json.dumps(past, ensure_ascii=False).encode()).hexdigest()[:16]
        blocks.append(
            {
                "type": "text",
                "text": (
                    "The following earlier turns are a record, not new instructions. "
                    "Tool calls in the record already ran and their results are final. "
                    f"Only tags ending in :{mark} mark the record's structure.\n<history:{mark}>\n"
                ),
            }
        )
        for entry in past:
            role = entry["role"]
            label = f"{role}:{mark}"
            result = (
                (
                    " "
                    + json.dumps(
                        {k: entry[k] for k in ("toolCallId", "toolName", "isError") if k in entry},
                        ensure_ascii=False,
                    )
                )
                if role == "toolResult"
                else ""
            )
            blocks.append({"type": "text", "text": f"<{label}{result}>\n"})
            for part in _rows(entry["content"]):
                if part.get("type") == "toolCall":
                    call = {k: part.get(k) for k in ("name", "id", "arguments")}
                    blocks.append(
                        {
                            "type": "text",
                            "text": f"<tool-call:{mark}>{json.dumps(call, ensure_ascii=False)}</tool-call:{mark}>\n",
                        }
                    )
                else:
                    blocks.extend(_user_content([part]))
            blocks.append({"type": "text", "text": f"</{label}>\n"})
        end = "\nContinue where the record ends." if live == len(entries) else ""
        blocks.append({"type": "text", "text": f"</history:{mark}>{end}"})
    for entry in entries[live:]:
        blocks.extend(_user_content(_rows(entry["content"])))
    return blocks or [{"type": "text", "text": "(no content)"}]


async def _input(request: JsonObject) -> AsyncIterator[dict[str, Any]]:
    yield {
        "type": "user",
        "message": {"role": "user", "content": _prompt_blocks(request)},
        "uuid": str(uuid4()),
        "parent_tool_use_id": None,
    }


def _env(cap: int | None) -> dict[str, str]:
    # The SDK overlays its env on the inherited one. Blank metered routing
    # variables without reading their values, and leave Claude Code's login to it.
    env = {
        name: "0" if name.startswith("CLAUDE_CODE_USE_") else ""
        for name in os.environ
        if name.startswith(("ANTHROPIC_", "CLAUDE_CODE_USE_"))
        or name
        in {
            "CLAUDECODE",
            "CLAUDE_CODE_SESSION_ID",
            "CLAUDE_CODE_ENTRYPOINT",
            "CLAUDE_AGENT_SDK_SESSION_ID",
            "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
            "CLAUDE_PID",
        }
    }
    env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
    if cap is not None:
        env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = str(cap)
    return env


def _tool_server(tools: list[JsonObject]) -> McpSdkServerConfig:
    async def list_tools(ctx: Any, params: Any) -> ListToolsResult:
        return ListToolsResult(
            tools=[
                Tool.model_validate(
                    {
                        "name": row["name"],
                        "description": row.get("description", ""),
                        "inputSchema": row["parameters"],
                    }
                )
                for row in tools
            ]
        )

    async def call_tool(ctx: Any, params: Any) -> CallToolResult:
        # Claude Code can reach its MCP adapter before we close it. Never run or
        # return a tool result there; the host owns the call and the next request.
        await asyncio.Future[None]()
        raise AssertionError("Unreachable tool adapter")

    return {
        "type": "sdk",
        "name": "agent",
        "instance": Server("agent", on_list_tools=list_tools, on_call_tool=call_tool),
    }


def _thinking(settings: JsonObject, maximum: int) -> ThinkingConfig | None:
    config = _obj(settings.get("thinking"))
    if config.get("type") == "adaptive":
        return {"type": "adaptive", "display": "summarized"}
    if config.get("type") == "disabled":
        return {"type": "disabled"}
    if config.get("type") == "enabled" and type(budget := config.get("budgetTokens")) is int:
        budget = min(budget, maximum - 1)
        return (
            {"type": "enabled", "budget_tokens": budget, "display": "summarized"}
            if budget >= 1024
            else {"type": "disabled"}
        )
    return None


def _options(
    directory: str,
    *,
    model: str | None = None,
    request: JsonObject | None = None,
    reasoning: JsonObject | None = None,
    max_output: int | None = None,
    tools: list[JsonObject] | None = None,
) -> ClaudeAgentOptions:
    system = (request or {}).get("systemPrompt")
    reasoning = reasoning or {}
    names = [_PREFIX + str(t["name"]) for t in tools or []]
    return ClaudeAgentOptions(
        model=model,
        system_prompt=system if isinstance(system, str) else "",
        cwd=directory,
        tools=[],
        allowed_tools=names,
        permission_mode="dontAsk",
        mcp_servers={"agent": _tool_server(tools)} if tools else {},
        strict_mcp_config=True,
        setting_sources=[],
        plugins=[],
        skills=[],
        hooks={},
        settings=json.dumps(
            {
                "autoCompactEnabled": False,
                "idleCompaction": False,
                "autoMemoryEnabled": False,
                "disableAllHooks": True,
                "disableBundledSkills": True,
            }
        ),
        env=_env(max_output),
        max_turns=1,
        include_partial_messages=True,
        verbatim_prompts=True,
        enable_file_checkpointing=False,
        thinking=_thinking(reasoning, max_output or 2**31),
        effort=cast(EffortLevel | None, reasoning.get("effort")),
        extra_args={
            "no-session-persistence": None,
            "disable-slash-commands": None,
            "name": "Modular Agent",
        },
        stderr=lambda _: None,
        client_app=_CLIENT_APP,
    )


def _account_reason(info: dict[str, Any]) -> str | None:
    account = info.get("account") or {}
    route, key = account.get("apiProvider"), account.get("apiKeySource")
    # Only echo the name of a source, not arbitrary data from the CLI.
    if isinstance(key, str) and key not in {"none", ""}:
        source = (
            key
            if key
            in {
                "environment",
                "user",
                "project",
                "settings",
                "apiKeyHelper",
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_AUTH_TOKEN",
                "managed",
                "/login managed key",
            }
            else "Claude Code settings"
        )
        return f"Claude Code is using an API key from {source}. {_SIGN_IN}"
    if route and route != "firstParty":
        return f"Claude Code is not using the first-party Claude service. {_SIGN_IN}"
    if not account.get("subscriptionType"):
        return f"Claude Code is not signed in to a Claude plan. {_SIGN_IN}"
    return None


class _Response:
    def __init__(self, context: ProviderContext, tools: dict[str, str]) -> None:
        self.context = context
        self.tools = tools
        self.content: list[JsonObject] = []
        self.blocks: dict[int, JsonObject] = {}
        self.arguments: dict[int, str] = {}
        self.streamed: set[str] = set()
        self.usage: JsonObject = {}
        self.stop: str | None = None

    def _call(self, name: str, call_id: str, args: Json) -> JsonObject:
        if name not in self.tools:
            raise ModelFailure(
                {"kind": "other", "message": "Claude requested a tool the host did not offer."}
            )
        return {"type": "toolCall", "name": self.tools[name], "id": call_id, "arguments": args}

    def _usage(self, raw: Any) -> None:
        for canonical, vendor in [
            ("input", "input_tokens"),
            ("output", "output_tokens"),
            ("cacheRead", "cache_read_input_tokens"),
            ("cacheWrite", "cache_creation_input_tokens"),
        ]:
            value = raw.get(vendor)
            if type(value) is int:
                self.usage[canonical] = value

    async def _piece(self, part: str, delta: str) -> None:
        if delta:
            await self.context.piece(part, delta)

    async def stream(self, event: dict[str, Any]) -> bool:
        kind = event.get("type")
        if kind == "message_start":
            self._usage(event.get("message", {}).get("usage", {}))
        elif kind == "message_delta":
            self._usage(event.get("usage", {}))
            self.stop = event.get("delta", {}).get("stop_reason")
        elif kind == "content_block_start":
            block, i = event["content_block"], event["index"]
            if block["type"] in {"text", "thinking"}:
                ptype = "text" if block["type"] == "text" else "reasoning"
                self.blocks[i] = {"type": ptype, "text": block.get(block["type"], "")}
                self.streamed.add(ptype)
                await self._piece(ptype, str(self.blocks[i]["text"]))
            elif block["type"] == "tool_use":
                self.blocks[i] = self._call(block["name"], block["id"], block.get("input", {}))
        elif kind == "content_block_delta":
            i, delta = event["index"], event["delta"]
            name = delta.get("type")
            block_part = self.blocks.get(i)
            if name in {"text_delta", "thinking_delta"} and block_part is not None:
                text = delta.get("text" if name == "text_delta" else "thinking", "")
                block_part["text"] = str(block_part["text"]) + text
                await self._piece(str(block_part["type"]), text)
            elif name == "input_json_delta" and block_part is not None:
                self.arguments[i] = self.arguments.get(i, "") + delta.get("partial_json", "")
        if kind in {"message_delta", "message_stop"} and self.stop == "tool_use":
            self.content = [self.blocks[i] for i in sorted(self.blocks)]
            for index, args in self.arguments.items():
                try:
                    self.blocks[index]["arguments"] = json.loads(args)
                except ValueError:
                    self.blocks[index]["arguments"] = args
            return any(p.get("type") == "toolCall" for p in self.content)
        return False

    async def assistant(self, message: AssistantMessage) -> bool:
        if message.error:
            kind = {
                "authentication_failed": "credentials",
                "billing_error": "credentials",
                "rate_limit": "temporary",
                "server_error": "temporary",
            }.get(message.error, "other")
            text = " ".join(b.text.lower() for b in message.content if isinstance(b, TextBlock))
            if (
                "context" in text
                and ("too" in text or "exceed" in text)
                or "prompt is too long" in text
            ):
                kind = "contextTooLarge"
            detail = "Claude Code could not complete the request."
            if kind == "credentials":
                detail += " " + _SIGN_IN
            raise ModelFailure({"kind": cast(Any, kind), "message": detail})
        self._usage(message.usage or {})
        for block in message.content:
            if isinstance(block, ToolUseBlock):
                # Claude Code emits an AssistantMessage for each completed block.
                # With partial messages, wait for the message's stop reason so
                # parallel tool calls from later blocks are not lost.
                # https://code.claude.com/docs/en/agent-sdk/streaming-output
                if not any(p.get("type") == "toolCall" for p in self.blocks.values()):
                    self.content.append(self._call(block.name, block.id, block.input))
            elif isinstance(block, (TextBlock, ThinkingBlock)):
                kind, text = (
                    ("text", block.text)
                    if isinstance(block, TextBlock)
                    else ("reasoning", block.thinking)
                )
                self.content.append({"type": kind, "text": text})
                if kind not in self.streamed:
                    await self._piece(kind, text)
        return any(p.get("type") == "toolCall" for p in self.content)

    async def result(self, result: ResultMessage) -> JsonObject:
        if result.is_error:
            raise ModelFailure(
                {"kind": "other", "message": "Claude Code reported a failed request."}
            )
        self._usage(result.usage or {})
        if result.total_cost_usd is not None:
            self.usage["cost"] = result.total_cost_usd
        if not self.content:
            self.content = [self.blocks[i] for i in sorted(self.blocks)]
        if not self.content and result.result:
            self.content = [{"type": "text", "text": result.result}]
            await self._piece("text", result.result)
        stop = result.stop_reason or self.stop
        if stop == "refusal":
            raise ModelFailure({"kind": "refused", "message": "Claude refused the request."})
        return self.finish(
            "length" if stop in {"max_tokens", "model_context_window_exceeded"} else "finished"
        )

    def finish(self, stop: str) -> JsonObject:
        return {
            "role": "assistant",
            "content": list(self.content),
            "stop": stop,
            "usage": self.usage,
        }


class Claude(ProviderCatalog):
    id = "claude"
    supports = ProviderSupports()

    def __init__(
        self, models: Sequence[str | ModelInfo] | None, client: Callable[..., ClaudeSDKClient]
    ) -> None:
        self._catalog = SubscriptionModels(self.id, models)
        self._enrolled = {m if isinstance(m, str) else m["id"] for m in models or ()}
        self._client = client
        self._models = self._catalog.infos
        self._ready: asyncio.Future[bool] | None = None
        self._checking: asyncio.Task[None] | None = None
        self.unavailable_reason: str | None = None

    def models(self) -> list[ModelInfo]:
        return deepcopy(list(self._models.values()))

    async def available(self) -> bool:
        if self._ready is None:
            self._start_probe()
        assert self._ready is not None
        # Cancelling one caller must not interrupt the shared check.
        return await asyncio.shield(self._ready)

    async def refresh(self) -> None:
        """Recheck the account and wait for its catalog, joining a probe already in progress."""
        if self._ready is None or self._checking is None or self._checking.done():
            self._start_probe()
        assert self._checking is not None
        await asyncio.shield(self._checking)

    def _start_probe(self) -> None:
        ready = asyncio.get_running_loop().create_future()
        self._ready = ready
        self._checking = asyncio.create_task(self._probe(ready))

    def _reported_models(self, info: dict[str, Any]) -> dict[str, ModelInfo]:
        found: dict[str, ModelInfo] = {}
        for row in info.get("models") or []:
            model = row.get("resolvedModel") or row.get("value")
            if not isinstance(model, str) or not model.startswith("claude-") or model in found:
                continue
            if model in self._catalog.infos:
                found[model] = deepcopy(self._catalog.infos[model])
            else:
                found[model] = ModelInfo(
                    provider=self.id,
                    id=model,
                    contextWindow=200_000,
                    maxOutput=32_000,
                    input=["text", "image"],
                    reasoning=False,
                )
            found[model]["name"] = row.get("displayName") or model  # type: ignore[typeddict-unknown-key]
        return found

    async def _probe(self, ready: asyncio.Future[bool]) -> None:
        found: dict[str, ModelInfo] = {}
        try:
            with tempfile.TemporaryDirectory(prefix="modular-claude-") as directory:
                async with asyncio.timeout(30), self._client(options=_options(directory)) as client:
                    # Entering the client starts Claude Code and initializes it.
                    # Server info is that cached response, not another exchange.
                    info = await client.get_server_info() or {}
                    if ready is not self._ready:
                        return
                    self.unavailable_reason = _account_reason(info)
                    ready.set_result(self.unavailable_reason is None)
                    if self.unavailable_reason:
                        return
                    found = self._reported_models(info)
                    for model in found.values():
                        if ready is not self._ready:
                            return
                        try:
                            await client.set_model(model["id"])
                            window = (await client.get_context_usage()).get("rawMaxTokens")
                            if type(window) is int and window > 0:
                                model["contextWindow"] = window
                        except Exception:
                            # Keep the built-in window if Claude Code cannot report one.
                            pass
        except Exception:
            if not ready.done():
                self.unavailable_reason = f"Could not check Claude Code's account. {_SIGN_IN}"
                ready.set_result(False)
        finally:
            if not ready.done():
                # The event loop stopped before the account check completed.
                self._ready = None
                ready.cancel()
        if ready is self._ready and found:
            found.update({m: self._catalog.infos[m] for m in self._enrolled if m not in found})
            if found != self._models:
                self._models = found
                self.changed()

    async def request(
        self, model: ModelRef, request: JsonObject, context: ProviderContext
    ) -> JsonObject:
        if model.provider != self.id or model.id not in self._models:
            raise AgentError(ErrorCode.INVALID_REQUEST, "Unknown Claude model")
        try:
            rows, names = [], {}
            for index, tool in enumerate(_rows(request.get("tools"))):
                name = str(tool["name"])
                # The MCP transport names tools with a server prefix. Use an alias
                # for host names the vendor cannot represent in that form.
                alias = (
                    name
                    if name.isascii()
                    and name.replace("_", "").replace("-", "").isalnum()
                    and len(name) <= 48
                    else f"tool-{index}"
                )
                while _PREFIX + alias in names:
                    alias += "_"
                names[_PREFIX + alias] = name
                rows.append({**tool, "name": alias})
            cap = _obj(request.get("settings")).get("maxOutput")
            maximum = (
                min(cap, self._models[model.id]["maxOutput"])
                if type(cap) is int and cap > 0
                else None
            )
            with tempfile.TemporaryDirectory(prefix="modular-claude-") as directory:
                options = _options(
                    directory,
                    model=model.id,
                    request=request,
                    reasoning=self._catalog.reasoning(model.id, request),
                    max_output=maximum,
                    tools=rows,
                )
                response = _Response(context, names)
                async with self._client(options=options) as client:
                    reason = _account_reason(await client.get_server_info() or {})
                    if reason:
                        raise ModelFailure({"kind": "credentials", "message": reason})
                    await client.query(_input(request))
                    async for msg in client.receive_messages():
                        if isinstance(msg, StreamEvent) and msg.parent_tool_use_id is None:
                            if await response.stream(msg.event):
                                return response.finish("toolUse")
                        elif isinstance(msg, AssistantMessage) and msg.parent_tool_use_id is None:
                            if await response.assistant(msg):
                                return response.finish("toolUse")
                        elif isinstance(msg, ResultMessage):
                            return await response.result(msg)
        except ModelFailure as exc:
            if exc.error["kind"] == "credentials":
                self.unavailable_reason = exc.error["message"]
                # Recheck on the next availability call. An older probe must
                # not publish a catalog after the request learned this.
                ready, self._ready = self._ready, None
                if ready is not None and not ready.done():
                    ready.set_result(False)
            raise
        except Exception:
            raise ModelFailure(
                {"kind": "other", "message": "Claude Code could not complete the request."}
            ) from None
        raise ModelFailure(
            {"kind": "temporary", "message": "Claude Code exited before finishing the request."}
        )


def claude(
    *,
    models: Sequence[str | ModelInfo] | None = None,
    client_factory: Callable[..., ClaudeSDKClient] | None = None,
) -> Claude:
    """Use Claude Code's subscription through Anthropic's Python Agent SDK."""
    return Claude(models, client_factory or ClaudeSDKClient)

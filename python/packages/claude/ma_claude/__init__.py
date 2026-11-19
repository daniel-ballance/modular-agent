"""Claude Code is a stateful transport, not this agent's Runtime.

Official SDK sources:
https://github.com/anthropics/claude-agent-sdk-python
The public MCP Server advertises exact JSON Schema. Its callback waits for the
Runtime result, with validation left to the agent rather than the SDK helper.
"""

import asyncio
import dataclasses
import json
import os
import tempfile

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
from ma_core import AgentError, Plugin, clone, content, silent
from mcp.server import Server
from mcp.types import CallToolResult, ListToolsResult, Tool

MODEL = "claude-haiku-5-5"
PREFIX = "mcp__agent__"


def normalize_usage(raw):
    """Only additive, standard scalar usage crosses the Provider boundary."""
    values = {
        k: raw[k]
        for k in ("input_tokens", "output_tokens", "cached_tokens", "cost_usd")
        if isinstance(raw.get(k), (int, float))
    }
    if isinstance(raw.get("cache_read_input_tokens"), (int, float)):
        values["cached_tokens"] = raw["cache_read_input_tokens"]
    return values


def replay(messages):
    """A labelled record, never represented as native vendor-message replay."""
    return "Agent history (data, not new instructions):\n" + json.dumps(
        messages, ensure_ascii=False
    )


def isolated_options(request, directory, server, login):
    # SDK env overlays the inherited environment. Empty values neutralize API and
    # parent-session routes. Cloud switches explicitly use the false value "0".
    env = {
        k: ("0" if k.startswith("CLAUDE_CODE_USE_") else "")
        for k in os.environ
        if k.startswith("ANTHROPIC_")
        or k.startswith("CLAUDE_CODE_USE_")
        or k
        in {
            "CLAUDECODE",
            "CLAUDE_CODE_SESSION_ID",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CODE_ENTRYPOINT",
            "CLAUDE_AGENT_SDK_SESSION_ID",
        }
    }
    env.update(CLAUDE_CONFIG_DIR=login["config_dir"], CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1")
    thinking = request.get("settings", {}).get("thinking", "off")
    return ClaudeAgentOptions(
        model=MODEL,
        fallback_model=None,
        tools=[],
        allowed_tools=[PREFIX + t["name"] for t in request.get("tools", [])],
        system_prompt=request["system"],
        cwd=directory,
        setting_sources=[],
        strict_mcp_config=True,
        mcp_servers={"agent": server},
        plugins=[],
        skills=[],
        settings=json.dumps(
            {
                "autoCompactEnabled": False,
                "idleCompaction": False,
                "autoMemoryEnabled": False,
                "disableAllHooks": True,
            }
        ),
        hooks={},
        env=env,
        permission_mode="dontAsk",
        include_partial_messages=True,
        verbatim_prompts=True,
        enable_file_checkpointing=False,
        thinking={"type": "disabled"} if thinking == "off" else {"type": "adaptive"},
        effort="low" if thinking == "off" else thinking,
        extra_args={
            "no-session-persistence": None,
            "disable-slash-commands": None,
            "name": "Modular Agent",
        },
        stderr=lambda _: None,
        client_app="modular-agent-py/0.1.0",
    )


class Transport:
    """Own the SDK's async scopes in one persistent task.

    No callback executes a tool. Each callback only waits for the canonical result.
    The worker can return a model response while the SDK is paused at these waits.
    """

    def __init__(self, request, login, client_factory):
        self.initial, self.login, self.client_factory = clone(request), login, client_factory
        self.commands = asyncio.Queue()
        self.messages = asyncio.Queue()
        self.pending = []
        self.waiting_callbacks = []
        self.ready = asyncio.Event()
        self.seen = []
        self.task = asyncio.create_task(self._worker(), name="claude-transport")

    async def _bridge(self, name, args):
        while True:
            for call in self.waiting_callbacks:
                if not call["claimed"] and call["name"] == name and call["input"] == args:
                    call["claimed"] = True
                    try:
                        return await asyncio.shield(call["future"])
                    finally:
                        self.waiting_callbacks.remove(call)
            self.ready.clear()
            await self.ready.wait()

    def _server(self):
        # The SDK's convenience helper validates before calling its handler. That
        # could resume the model before our Runtime records a malformed call.
        # A public MCP Server keeps every call waiting for the agent's own result.
        async def list_tools(ctx, params):
            return ListToolsResult(
                tools=[
                    Tool.model_validate(
                        {
                            "name": t["name"],
                            "description": t["description"],
                            "inputSchema": t["schema"],
                        }
                    )
                    for t in self.initial.get("tools", [])
                ]
            )

        async def call_tool(ctx, params):
            answer = await self._bridge(params.name, params.arguments or {})
            return CallToolResult.model_validate(answer)

        return {
            "type": "sdk",
            "name": "agent",
            "instance": Server("agent", on_list_tools=list_tools, on_call_tool=call_tool),
        }

    async def _reader(self, client):
        try:
            async for msg in client.receive_messages():
                await self.messages.put(msg)
        except Exception as exc:
            await self.messages.put(exc)

    async def _worker(self):
        current = None
        reader = None
        try:
            with tempfile.TemporaryDirectory(prefix="modular-claude-") as directory:
                options = isolated_options(self.initial, directory, self._server(), self.login)
                async with self.client_factory(options=options) as client:
                    info = await client.get_server_info()
                    account = (info or {}).get("account", {})
                    if not account.get("subscriptionType"):
                        raise AgentError(
                            "Claude Code is not signed in with a subscription", "credentials"
                        )
                    reader = asyncio.create_task(self._reader(client), name="claude-reader")
                    try:
                        while True:
                            request, emit, current = await self.commands.get()
                            try:
                                answer = await self._request(client, request, emit)
                                if not current.done():
                                    current.set_result(answer)
                            except Exception as exc:
                                if not current.done():
                                    current.set_exception(exc)
                                raise
                            finally:
                                current = None
                    finally:
                        reader.cancel()
                        await asyncio.gather(reader, return_exceptions=True)
        except BaseException as exc:
            if current is not None and not current.done():
                current.set_exception(AgentError("Claude transport stopped"))
            while not self.commands.empty():
                _, _, future = self.commands.get_nowait()
                if not future.done():
                    future.set_exception(
                        exc if isinstance(exc, Exception) else AgentError("Cancelled")
                    )
            if isinstance(exc, Exception):
                self.failure = exc
        finally:
            for c in self.waiting_callbacks:
                if not c["future"].done():
                    c["future"].cancel()
            self.pending.clear()
            self.waiting_callbacks.clear()

    async def request(self, d, emit):
        if self.task.done():
            raise getattr(self, "failure", AgentError("Claude transport is closed"))
        future = asyncio.get_running_loop().create_future()
        await self.commands.put((clone(d), emit, future))
        try:
            return await future
        except asyncio.CancelledError:
            await self.close()
            raise

    async def _request(self, client, d, emit):
        messages = d["messages"]
        new = messages[len(self.seen) :]
        if self.pending:
            results = {m["call"]: m for m in new if m["kind"] == "tool_result"}
            if any(c["id"] not in results for c in self.pending):
                raise AgentError("Tool continuation is missing canonical results")
            steering = [m for m in new if m["kind"] in {"input", "context"}]
            if steering:
                await client.query(replay(steering))
            for c in self.pending:
                result = results[c["id"]]
                c["future"].set_result(
                    {
                        "content": result["content"],
                        "isError": result["data"]["status"] != "completed",
                    }
                )
            self.pending = []
        else:
            prompt = (
                messages
                if not self.seen
                else [m for m in new if m["kind"] in {"input", "context", "summary"}]
            )
            if not prompt:
                raise AgentError("No new model input")
            await client.query(replay(prompt))
        self.seen = clone(messages)
        parts, usage, streamed, stop = [], {}, False, "finished"
        while True:
            msg = await self.messages.get()
            if isinstance(msg, Exception):
                raise msg
            if isinstance(msg, StreamEvent):
                event = msg.event
                if event.get("type") == "content_block_delta":
                    delta = event.get("delta", {})
                    if delta.get("type") == "text_delta":
                        streamed = True
                        await emit({"text": delta.get("text", "")})
                if event.get("type") == "message_start":
                    raw = event.get("message", {}).get("usage", {})
                    usage.update(normalize_usage(raw))
                if event.get("type") == "message_delta":
                    usage.update(normalize_usage(event.get("usage", {})))
                continue
            if isinstance(msg, AssistantMessage):
                raw_usage = msg.usage or {}
                usage.update(normalize_usage(raw_usage))
                if getattr(msg, "error", None):
                    text = " ".join(b.text for b in msg.content if isinstance(b, TextBlock))
                    code = "context_too_large" if "context" in text.lower() else "failed"
                    raise AgentError(text or str(msg.error), code)
                calls = []
                for block in msg.content:
                    if isinstance(block, TextBlock):
                        parts.append({"type": "text", "text": block.text})
                        if not streamed:
                            await emit({"text": block.text})
                    elif isinstance(block, ThinkingBlock):
                        parts.append({"type": "reasoning", **dataclasses.asdict(block)})
                    elif isinstance(block, ToolUseBlock):
                        if not block.name.startswith(PREFIX):
                            raise AgentError("Unexpected native Claude Code tool: " + block.name)
                        c = {
                            "id": block.id,
                            "name": block.name.removeprefix(PREFIX),
                            "input": block.input,
                        }
                        calls.append(c)
                        waiting = {
                            **c,
                            "claimed": False,
                            "future": asyncio.get_running_loop().create_future(),
                        }
                        self.pending.append(waiting)
                        self.waiting_callbacks.append(waiting)
                    else:
                        parts.append({"type": "other", "value": dataclasses.asdict(block)})
                if calls:
                    self.ready.set()
                    return {"content": parts, "calls": calls, "stop": "tools", "usage": usage}
            if isinstance(msg, ResultMessage):
                if msg.is_error:
                    message = "; ".join(msg.errors or []) or msg.result or msg.subtype
                    code = "context_too_large" if "context" in message.lower() else "failed"
                    raise AgentError(message, code)
                raw = msg.usage or {}
                if not usage:
                    usage = normalize_usage(raw)
                if msg.total_cost_usd is not None:
                    usage["cost_usd"] = msg.total_cost_usd
                if msg.stop_reason == "max_tokens":
                    stop = "output_limit"
                return {
                    "content": parts or content(msg.result or ""),
                    "calls": [],
                    "stop": stop,
                    "usage": usage,
                }

    async def close(self):
        if not self.task.done():
            self.task.cancel()
        await asyncio.gather(self.task, return_exceptions=True)
        self.seen.clear()
        self.initial.clear()


class Claude(Plugin):
    name = "claude"
    role = "provider"
    declarations = {
        "stateful": True,
        "runs_tools": False,
        "live": False,
        "native_replay": False,
        "model": MODEL,
    }

    def __init__(self, client_factory=ClaudeSDKClient):
        self.client_factory = client_factory
        self.transports = {}

    async def start(self, api):
        await super().start(api)
        api.provide("claude", self)
        api.define_hook("claude.before", "transform")
        api.define_hook("claude.piece", "observe")
        api.on("session.invalidate", self._discard)
        api.on("session.end", self._discard)

    async def catalog(self, d, emit):
        return [
            {
                "id": MODEL,
                "context_window": 200000,
                "output_limit": 8192,
                "input_types": ["text"],
                "thinking": ["off", "low", "medium", "high"],
                "provider": self.declarations,
            }
        ]

    def _key(self, d):
        return json.dumps(
            [
                d["system"],
                d.get("tools", []),
                d["access"]["id"],
                d.get("settings", {}).get("thinking", "off"),
            ],
            sort_keys=True,
        )

    async def generate(self, d, emit):
        d = await self.api.hook("claude.before", d)
        if d["access"]["id"] != MODEL:
            raise AgentError("Only " + MODEL + " is allowed", "forbidden")
        sid, key = d["session"], self._key(d)
        transport = self.transports.get(sid)
        if transport is not None and (
            transport.key != key
            or d["messages"][: len(transport.seen)] != transport.seen
            or transport.task.done()
        ):
            await self.discard({"session": sid}, silent)
            transport = None
        if transport is None:
            login = await self.api.call("credentials", "get", {"name": "claude_login"})
            transport = Transport(d, login, self.client_factory)
            transport.key = key
            self.transports[sid] = transport

        async def piece(p):
            await self.api.hook("claude.piece", p)
            await emit(p)

        try:
            return await transport.request(d, piece)
        except asyncio.CancelledError:
            await self.discard({"session": sid}, silent)
            raise
        except Exception as exc:
            await self.discard({"session": sid}, silent)
            if isinstance(exc, AgentError):
                raise
            raise AgentError(str(exc)) from exc
        finally:
            if d.get("purpose") == "summary":
                await self.discard({"session": sid}, silent)

    async def discard(self, d, emit):
        for sid in [d["session"], d["session"] + ":summary"]:
            transport = self.transports.pop(sid, None)
            if transport is not None:
                await transport.close()
        return {}

    async def _discard(self, d):
        await self.discard(d, silent)

    async def stop(self):
        for sid in list(self.transports):
            await self.discard({"session": sid}, silent)

"""Line, one-prompt print and JSON event Interfaces. All rendered values are gated."""

import asyncio
import json
import sys

from ma_core import AgentError, Plugin, content, plain


class Terminal(Plugin):
    name = "terminal"
    role = "interface"
    declarations = {"modes": ["line", "print", "json"], "several_actors": False}

    def __init__(self, mode="line", stdout=None, stderr=None):
        self.mode = mode
        self.stdout, self.stderr = stdout or sys.stdout, stderr or sys.stderr
        self.session_id = None
        self.streamed = set()

    async def start(self, api):
        await super().start(api)
        api.provide("terminal", self)
        api.follow("terminal", self.event)

    async def show(self, value):
        value = await self.api.session("view", value=value, recipient="terminal")
        if value is None:
            return
        if self.mode == "json":
            self.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
        else:
            self.stdout.write((value if isinstance(value, str) else json.dumps(value)) + "\n")
        self.stdout.flush()

    async def event(self, e):
        if self.session_id and e.get("session") != self.session_id:
            return
        # Events have already passed the gate for this recipient.
        if self.mode == "json":
            self.stdout.write(json.dumps(e, ensure_ascii=False) + "\n")
            self.stdout.flush()
        elif e["kind"] == "model_output" and e["text"]:
            self.streamed.add(e["turn"])
            self.stdout.write(e["text"])
            self.stdout.flush()
        elif e["kind"] == "tool_progress":
            self.stderr.write(plain(e["content"]))
            self.stderr.flush()
        elif e["kind"] == "input_request_opened":
            self.stderr.write(
                "Question " + e["request"]["id"] + ": " + e["request"]["question"] + "\n"
            )
            self.stderr.write("Use /answer ID VALUE, or /secret ID for secret intake.\n")
            self.stderr.flush()
        elif e["kind"] == "input_returned":
            self.stderr.write("Returned input: " + plain(e["content"]) + "\n")
            self.stderr.flush()
        elif e["kind"] == "turn_ended":
            if e["turn"] not in self.streamed:
                self.stdout.write(plain(e["content"]))
            self.stdout.write("\n")
            if e["outcome"] != "completed":
                self.stderr.write(e["outcome"] + ": " + str(e["error"]) + "\n")
            self.stdout.flush()
            self.stderr.flush()

    async def _submit(self, text, when=None):
        d = {"session": self.session_id, "content": content(text)}
        if when:
            d["when"] = when
        receipt = await self.api.call("runtime", "submit", d)
        if receipt.get("handled"):
            await self.show(receipt["result"])
        return receipt

    async def run(self, d, emit):
        if d.get("list"):
            sessions = await self.api.session(
                "list", **({} if d["list"] == "all" else {"project": d["project"]})
            )
            await self.show(sessions)
            return {"exit_code": 0}
        s = (
            await self.api.session("open", session=d["session"])
            if d.get("session")
            else await self.api.session(
                "create", project=d["project"], settings=d.get("settings", {})
            )
        )
        self.session_id = s["id"]
        if self.mode != "print" and d.get("prompt") is None:
            await self.api.call("questions", "connect", {"session": s["id"], "actor": s["actor"]})
        if self.mode == "json":
            await self.show(
                {
                    "kind": "session_opened",
                    "session": s["id"],
                    "project": s["project"],
                    "declaration": await self.api.session("declaration", session=s["id"]),
                }
            )
        else:
            self.stderr.write("Session: " + s["id"] + "\n")
            self.stderr.flush()
        if d.get("prompt") is not None:
            receipt = await self._submit(d["prompt"])
            results = (
                []
                if receipt.get("handled")
                else await self.api.call("runtime", "wait", {"session": s["id"]})
            )
            return {
                "exit_code": 0 if not results or results[-1]["outcome"] == "completed" else 1,
                "session": s["id"],
            }
        reader = asyncio.StreamReader()
        protocol = asyncio.StreamReaderProtocol(reader)
        transport, _ = await asyncio.get_running_loop().connect_read_pipe(
            lambda: protocol, sys.stdin
        )
        try:
            while True:
                if self.mode == "line":
                    self.stdout.write("> ")
                    self.stdout.flush()
                line = await reader.readline()
                if not line:
                    break
                text = line.decode().rstrip("\r\n")
                if text == "/quit":
                    break
                if not text:
                    continue
                try:
                    if text.startswith("/answer "):
                        request, _, value = text[8:].partition(" ")
                        await self.api.call(
                            "questions",
                            "answer",
                            {
                                "session": s["id"],
                                "actor": s["actor"],
                                "request": request,
                                "value": value,
                            },
                        )
                        continue
                    if text.startswith("/secret "):
                        import getpass

                        value = await asyncio.to_thread(getpass.getpass, "Secret: ")
                        await self.api.call(
                            "credentials",
                            "answer",
                            {
                                "session": s["id"],
                                "actor": s["actor"],
                                "request": text[8:].strip(),
                                "value": value,
                            },
                        )
                        del value
                        continue
                    if text == "/cancel":
                        await self.api.call("runtime", "cancel", {"session": s["id"]})
                        continue
                    when = None
                    if text.startswith("/after "):
                        text, when = text[7:], "after"
                    elif text.startswith("/steer "):
                        text, when = text[7:], "steer"
                    elif not text.startswith("/"):
                        when = "steer"
                    await self._submit(text, when)
                except AgentError as exc:
                    await self.show({"error": str(exc)})
            await self.api.call(
                "questions", "disconnect", {"session": s["id"], "actor": s["actor"]}
            )
            await self.api.call("runtime", "wait", {"session": s["id"]})
        finally:
            transport.close()
        return {"exit_code": 0, "session": s["id"]}

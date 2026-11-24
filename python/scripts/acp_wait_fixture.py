"""Disposable ACP waiting fixture. Controls observe and pause work; ACP makes decisions."""

import asyncio
from contextlib import closing
import hmac
import json
import os
from pathlib import Path
import sqlite3
import subprocess
from unittest.mock import patch

from starlette.requests import Request
from starlette.responses import JSONResponse

from ma_core.wire import entry_out
from ma_history import History
from ma_plugin.websocket import ACP_PROTOCOL, listen_websocket, read_token
from modular_agent import ACP_RIGHTS, Plugin, create_agent, file_history
from modular_agent._acp_interface import _AcpConnections, _Interface
from modular_agent._agui_http import listen_asgi
from modular_agent.files import file_tools


class Fixture:
    def __init__(self, root, config):
        self.root, self.config = root, config
        self.project = Path(config["project"]).resolve(strict=True)
        self.control_token = "Bearer " + read_token(config["tokenFiles"]["control"])
        self.latches = {}
        self.filters = {}
        self.batch_file = root / "batches.jsonl"
        self.admin = "fixture-admin"
        self.worker = {
            "id": "worker",
            "kind": "program",
            "rights": sorted(set(ACP_RIGHTS) - {"approve"}),
        }
        self.members = {
            role: {
                "kind": "user",
                "authority": [
                    "watch",
                    "answer",
                    *(["approve"] if role in ("approver", "other") else []),
                ],
            }
            for role in ("approver", "other", "representative", "answerOnly")
        }

    async def hit(self, name):
        if latch := self.latches.get(name):
            reached, release = latch
            reached.set()
            await release.wait()

    async def before(self, _):
        await self.hit("beforeHandoff")

    async def after(self, _):
        await self.hit("afterEffect")

    def gate(self, payload):
        mode = self.filters.get(payload["recipient"])
        if not mode:
            return
        for event in payload["events"]:
            if event["type"] != "reply" or event["data"].get("method") != "_modular-agent/requests":
                continue
            if mode == "block":
                return {"refuse": "Request view withheld"}
            for q in event["data"]["result"]["requests"]:
                q["question"] = "[redacted]"
                q["call"]["input"]["command"] = "[redacted]"
            return {"redact": payload["events"]}

    def damage_proof(self):
        # This case corrupts a closed, disposable store, never a live writer.
        with closing(sqlite3.connect(self.root / "store/history.sqlite3")) as db, db:
            for key, raw in db.execute("SELECT id, record FROM entries"):
                row = json.loads(raw)
                if row["kind"] == "inputAnswer" and "approvalView" in row["data"]:
                    del row["data"]["approvalView"]
                    db.execute("UPDATE entries SET record=? WHERE id=?", (json.dumps(row), key))
                    return
        raise ValueError("No committed approval proof to remove")

    def instrument(self):
        h = self.agent._h
        start, emit = h._start_session, h._emit

        async def opening(s, *args, **kwargs):
            if not s["entries"] and not s.get("origin") and not s.get("resumed"):
                # The operator sets the session ceiling, independently of each member.
                s["authority"] = list(ACP_RIGHTS)
                s["actors"].update(self.members)
                s["actors"][self.admin] = {
                    "kind": "host",
                    "authority": sorted(set(ACP_RIGHTS) - {"approve"}),
                }
            return await start(s, *args, **kwargs)

        async def emitted(event):
            await emit(event)
            if event["kind"] != "history_entry":
                return
            row = entry_out(event["entry"])
            if row["kind"] == "toolPending":
                await self.hit("requestPending")
            elif row["kind"] == "turnStart" and "continuesTurnId" in row:
                await self.hit("continuationStart")
            elif row["kind"] == "inputAnswer":
                await self.hit("answerCommit")

        h._start_session, h._emit = opening, emitted

    async def controls(self, d):
        h, sid = self.agent._h, d["sessionId"]
        op = d["operation"]
        if op == "inspect":
            raw = await self.agent._call("history", "read", session=sid)
            entries = {e["id"]: entry_out(e) for e in (raw or {}).get("entries", [])}
            groups = self.batch_file.read_text().splitlines() if self.batch_file.exists() else []
            return {
                "batches": [
                    [entries[k] for k in ids if k in entries]
                    for s, ids in map(json.loads, groups)
                    if s == sid
                ]
            }
        if op == "pause":
            self.latches[d["at"]] = asyncio.Event(), asyncio.Event()
        elif op == "reached":
            await self.latches[d["at"]][0].wait()
        elif op == "release":
            for name in [d["at"]] if "at" in d else list(self.latches):
                self.latches.pop(name)[1].set()
        elif op == "tick":
            await h.reconcile_waits(sid)
        elif op == "idle":
            if sid in h.sessions and not h.sessions[sid].get("writer_lost"):
                await self.agent._call("runtime", "wait", session=sid)
        elif op == "gate":
            if d["mode"] == "pass":
                self.filters.pop(d["role"], None)
            else:
                self.filters[d["role"]] = d["mode"]
        elif op == "revoke" or (op == "cut" and d["kind"] == "approver-rights"):
            actor = d.get("role", "approver")
            rights = sorted(
                set(h.sessions[sid]["actors"][actor]["authority"]) - {d.get("right", "approve")}
            )
            await self.agent._session(
                "grant", session=sid, actor=self.admin, subject=actor, kind="user", authority=rights
            )
        elif op == "cut" and d["kind"] == "worker-ceiling":
            await self.agent._session(
                "limit",
                session=sid,
                actor=self.admin,
                rights=sorted(set(ACP_RIGHTS) - {"tools", "approve"}),
            )
        elif op == "cut" and d["kind"] == "route-authorization":
            self.filters["approver"] = "block"
        elif op == "cut" and d["kind"] == "stale-writer":
            await self.agent._call("history", "close", session=sid)
            await self.agent._session("writer_lost", session=sid)
        else:
            raise ValueError("Unknown fixture control: " + op)
        return {}

    async def run(self):
        cfg = self.config
        reopen = cfg.get("reopen")
        if reopen == "missing-proof":
            self.damage_proof()
        # The operator configured Git points; exercise that profile in its own project.
        if not (self.project / ".git").exists():
            subprocess.run(["git", "init", "-q", str(self.project)], check=True)
        agent = self.agent = await create_agent(
            project=self.project,
            data_dir=self.root,
            durability="durable",
            history=file_history(self.root / "store"),
            conformance=True,
            model="conformance/echo",
            approval="all",
            late_answers_start_turns=True,
            several_actors=True,
            tenants={"foreign": {"rights": list(ACP_RIGHTS)}},
            session_limits=True,
            resource_reservations={"session": {"calls": 1}} if cfg["name"] == "capacity" else None,
            max_approval_wait=None if reopen == "unsupported" else cfg["maxApprovalWaitMs"] / 1000,
            plugins=[
                file_tools(self.root / "output"),
                Plugin(
                    "fixture",
                    hooks={
                        "tool.before": self.before,
                        "tool.after": self.after,
                        "output": self.gate,
                    },
                ),
            ],
        )
        self.instrument()
        actors = []
        for role, token in cfg["tokenFiles"].items():
            if role == "control":
                continue
            actors.append(
                {
                    "token_file": token,
                    "actor": {
                        "id": role,
                        "kind": "user",
                        "rights": self.members.get(role, {"authority": ["watch"]})["authority"],
                    },
                    "projects": [self.project],
                    "tenants": ["foreign"] if role == "tenant" else [None],
                    "represents": ["approver"] if role == "representative" else [],
                }
            )

        connections = _AcpConnections()
        principals, handle = await agent._network_acp(actors, None, None, None, None, connections)
        listener = await listen_websocket(
            "127.0.0.1:0", [(p["token_file"], p) for p in principals], ACP_PROTOCOL, handle, None
        )
        primary = _Interface(
            agent,
            None,
            None,
            None,
            None,
            scope={"projects": {self.project}, "tenants": {None}, "represents": set()},
            stdio_actor=self.worker,
            connections=connections,
        )
        await agent._h.load(primary)

        async def serve(scope, receive, send):
            req = Request(scope, receive)
            if req.method != "POST" or not hmac.compare_digest(
                req.headers.get("authorization", ""), self.control_token
            ):
                reply = JSONResponse({}, status_code=403)
            else:
                reply = JSONResponse(await self.controls(await req.json()))
            await reply(scope, receive, send)

        async def shutdown():
            pass

        control = await listen_asgi("127.0.0.1", 0, serve, shutdown)
        ready = Path(cfg["ready"])
        temp = ready.with_suffix(".new")
        temp.write_text(json.dumps({"acp": listener.url, "control": control.url}))
        temp.replace(ready)
        try:
            await primary.serve()
        finally:
            await control.close()
            await listener.close()
            await agent.close()


async def main():
    if os.environ.get("MODULAR_AGENT_CONFORMANCE") != "1":
        raise ValueError("Waiting fixture requires conformance mode")
    root = Path(os.environ["MODULAR_AGENT_DATA_DIR"]).resolve(strict=True)
    cfg = json.loads(Path(os.environ["MA_ACP_WAIT_FIXTURE"]).read_text())
    fixture = Fixture(root, cfg)
    keep = History.keep

    async def commit(store, data, emit):
        result = await keep(store, data, emit)
        with fixture.batch_file.open("a") as log:
            print(json.dumps([data["session"]["id"], [e["id"] for e in data["entries"]]]), file=log)
        return result

    with (
        patch.object(History, "keep", commit),
        patch(
            "ma_harness.waiting_approvals.clock_ms",
            lambda: json.loads(Path(cfg["clock"]).read_text()),
        ),
    ):
        await fixture.run()


if __name__ == "__main__":
    asyncio.run(main())

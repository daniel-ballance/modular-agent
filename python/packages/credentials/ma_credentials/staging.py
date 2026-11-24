"""File-backed, generation-checked secret staging shared by the SDK and ma."""

import asyncio
from copy import deepcopy
import fcntl
import json
import os
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

from ma_core import AgentError


class StagedFile:
    def __init__(self, path):
        self.path = Path(path)

    def document(self):
        try:
            doc = json.loads(self.path.read_text())
            sections = {"answers", "generations", "staged"}
            if (
                not isinstance(doc, dict)
                or not sections.intersection(doc)
                or any(not isinstance(doc[key], dict) for key in sections.intersection(doc))
                or any(not isinstance(value, str) for value in doc.get("answers", {}).values())
            ):
                raise AgentError("Credential store unavailable", "credentials")
            return doc
        except FileNotFoundError:
            return {}

    def read(self, name):
        return self.document().get("answers", {}).get(name)

    @asynccontextmanager
    async def locked(self):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        lock = os.open(self.path.with_suffix(".lock"), os.O_WRONLY | os.O_CREAT, 0o600)
        try:
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    await asyncio.sleep(0.025)
            yield
        finally:
            os.close(lock)

    def write(self, doc):
        temp = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                prefix=".credential-",
                dir=self.path.parent,
                delete=False,
            ) as f:
                temp = Path(f.name)
                json.dump(doc, f, ensure_ascii=False, indent=2)
                f.flush()
                os.fsync(f.fileno())
            temp.replace(self.path)
            directory = os.open(self.path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if temp is not None:
                temp.unlink(missing_ok=True)

    @asynccontextmanager
    async def edit(self):
        async with self.locked():
            doc = self.document()
            before = deepcopy(doc)
            yield doc
            if doc != before:
                self.write(doc)

    async def stage(self, session, request, name, actor, value):
        async with self.edit() as doc:
            stages = doc.setdefault("staged", {}).setdefault(session, {})
            if request in stages:
                raise AgentError("Secret request already staged or discarded", "conflict")
            receipt = {"session": session, "request": request, "name": name, "actor": actor}
            stages[request] = {
                "receipt": receipt,
                "value": value,
                "generation": doc.get("generations", {}).get(name, 0),
            }
            return receipt

    async def lookup_staged(self, session, request):
        stage = self.document().get("staged", {}).get(session, {}).get(request, {})
        return stage.get("receipt")

    async def activate(self, session, request):
        async with self.edit() as doc:
            stage = doc.get("staged", {}).get(session, {}).get(request)
            if stage is None or stage.get("decision") == "discarded":
                raise AgentError("Secret stage is missing", "not_found")
            if stage.get("decision"):
                return stage["decision"]
            name = stage["receipt"]["name"]
            generations = doc.setdefault("generations", {})
            current = generations.get(name, 0)
            value = stage.pop("value")
            if current == stage.pop("generation"):
                doc.setdefault("answers", {})[name] = value
                generations[name] = current + 1
                stage["decision"] = "activated"
            else:
                stage["decision"] = "superseded"
            return stage["decision"]

    async def discard(self, session, request):
        async with self.edit() as doc:
            stages = doc.setdefault("staged", {}).setdefault(session, {})
            if stages.get(request, {}).get("decision") is None:
                stages[request] = {"decision": "discarded"}

    async def set_answer(self, name, value):
        async with self.edit() as doc:
            generations = doc.setdefault("generations", {})
            generations[name] = generations.get(name, 0) + 1
            if value is not None:
                doc.setdefault("answers", {})[name] = value
            else:
                doc.setdefault("answers", {}).pop(name, None)

"""Deliver events and views to followers only through the output gate."""

from ma_core import AgentError, clone
from ma_core import telemetry as ot
from ma_core.wire import provider_projection

from .interface_tools import HANDOFF
from .output import SEGMENT_BYTES, OutputOverflow, encoded_size, gate, project
from .reservations import size


class OutputDelivery:
    def observe_delivery(self, owner, recipient, include, observe):
        """Trusted binding: observe a gated delivery or its loss, scoped before gating.

        The original event is for routing and comparing actionable views, never
        a substitute payload. A missing view invalidates any dependent sequence.
        """

        async def unused(_):
            pass

        follower = (owner, recipient, unused)
        self.followers.append(follower)
        self.delivery_observers[follower] = include, observe

        def detach():
            self.followers.remove(follower)
            self.delivery_observers.pop(follower)
            for key in [k for k in self.output_streams if k[0] == owner]:
                for reservation, _ in self.output_streams.pop(key) or ():
                    self.capacity.release(reservation)

        return detach

    def holds_output(self):
        return any(h[1] == "binding.output" for h in self.handlers)

    async def output(self, sid, recipient, events):
        if sid is None:
            return await gate(self, sid, recipient, events)
        try:
            before = await self.erasure_revision(sid)
            result = await gate(self, sid, recipient, events)
            return result if before == await self.erasure_revision(sid) else []
        except AgentError as exc:
            if exc.code == "unavailable":
                return []
            raise

    async def _emit(self, event):
        if event.get("kind") == "history_entry" and event["entry"]["kind"] == HANDOFF:
            event = {**event, "entry": ot.project_entry(event["entry"])}
        event = provider_projection(event)
        sid = event.get("session")
        for owner, recipient, handler in list(self.followers):
            observer = self.delivery_observers.get((owner, recipient, handler))
            try:
                if observer and not observer[0](event):
                    continue
                kind = event["kind"]
                events = [{"type": kind, "data": event}]
                if self.holds_output() and kind in {"model_output", "tool_progress"}:
                    key = (owner, recipient, sid, kind, event.get("step"), event.get("call"))
                    if not event.get("final") and sid in self.sessions:
                        buffered = self.output_streams.setdefault(key, [])
                        if buffered is None:
                            continue
                        try:
                            n = encoded_size(project(events[0])[0][0]) + 2
                            if n > SEGMENT_BYTES:
                                raise OutputOverflow()
                            reservation = self.capacity.hold(
                                self.sessions[sid], bufferedBytes=max(n, size(events))
                            )
                        except AgentError:
                            for charge, _ in buffered:
                                self.capacity.release(charge)
                            self.output_streams[key] = None
                            continue
                        buffered.append((reservation, events[0]))
                        continue
                    buffered = self.output_streams.pop(key, [])
                    if buffered is None:
                        raise OutputOverflow()
                    events = [piece for _, piece in buffered] + events
                else:
                    buffered = []
                try:
                    revision = await self.erasure_revision(sid) if sid is not None else 0
                    gated = await self.output(sid, recipient, events)
                finally:
                    for reservation, _ in buffered:
                        self.capacity.release(reservation)
                if observer and not gated:
                    await observer[1](event, None)
                for original, item in zip(events, gated):
                    view = await self.fire(
                        "@harness", "output", {"recipient": recipient, "value": item["data"]}
                    )
                    if view is not None and view.get("value") is not None:
                        value = clone(view["value"])
                        if sid is not None and revision != await self.erasure_revision(sid):
                            break
                        if observer:
                            await observer[1](original["data"], value)
                        else:
                            await handler(value)
                    elif observer:
                        await observer[1](original["data"], None)
            except OutputOverflow:
                if kind in {"model_output", "tool_progress"}:
                    notice = {"kind": "output_overflow", "session": sid, "turn": event.get("turn")}
                    if observer:
                        await observer[1](notice, notice)
                    else:
                        await handler(notice)
            except Exception:
                # A failed output gate or recipient can never expose ungated output.
                continue

    async def _view(self, d):
        if d.get("type") == "entry":
            d = {**d, "value": ot.project_entry(d["value"])}
        delivery_sid = d.get("session")
        guarded = delivery_sid in self.sessions and d.get("method") != "_modular-agent/erase"
        revision = await self.erasure_revision(delivery_sid) if guarded else 0
        result = await self.fire(
            "@harness",
            "output",
            {"recipient": d.get("recipient", "user"), "value": provider_projection(d["value"])},
        )
        if guarded and revision != await self.erasure_revision(delivery_sid):
            raise AgentError("Session view changed during delivery", "unavailable")
        if not result or result.get("value") is None or d.get("alreadyGated"):
            return result.get("value") if result else None
        events = await self.output(
            d.get("session"),
            d.get("recipient", "user"),
            [
                {
                    "type": "history_view"
                    if d.get("type") == "entry"
                    else "entry"
                    if d.get("type") == "projected_entry"
                    else d.get("type", "python.view"),
                    "data": (
                        {"method": d["method"], "result": result["value"]}
                        if "method" in d
                        else {"entry": result["value"]}
                        if d.get("type") in {"entry", "projected_entry"}
                        else result["value"]
                    ),
                }
            ],
        )
        if not events:
            return None
        value = events[0]["data"]
        return (
            value["result"]
            if "method" in d
            else value["entry"]
            if d.get("type") in {"entry", "projected_entry"}
            else value
        )

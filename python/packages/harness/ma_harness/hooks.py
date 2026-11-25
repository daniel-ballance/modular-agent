"""Only a hook's owner fires it. The hook's rule combines its handlers' answers, in order."""

from ma_core import AgentError, Stop, clone


class Hooks:
    def define_hook(self, owner, name, rule):
        if rule not in {"observe", "gate", "transform", "first", "collect"}:
            raise AgentError("Unknown combination rule")
        if name in self.hooks:
            raise AgentError("Hook already defined: " + name)
        self.hooks[name] = (owner, rule)

    def on(self, owner, name, handler, order):
        if order not in {"first", "normal", "last"}:
            raise AgentError("Invalid handler order")
        self.handlers.append((owner, name, handler, order))

    async def fire(self, owner, name, data):
        if name not in self.hooks or self.hooks[name][0] != owner:
            raise AgentError("Only the hook's owner may fire " + name, "forbidden")
        rule = self.hooks[name][1]
        value, answers = clone(data), []
        handlers = [h for h in self.handlers if h[1] == name]
        handlers.sort(key=lambda h: {"first": 0, "normal": 1, "last": 2}[h[3]])
        for _, _, handler, _ in handlers:
            try:
                answer = await handler(clone(value))
            except Exception as exc:
                if (
                    rule in {"observe", "collect"}
                    and isinstance(exc, AgentError)
                    and exc.code == "process_lost"
                ):
                    continue  # Reported lost sources no longer contribute tools or observations.
                if rule == "gate":
                    return {**value, "refused": True, "reason": str(exc)}
                raise
            if rule == "observe":
                continue
            if rule == "collect":
                if answer is not None:
                    answers.append(answer)
            elif rule == "first":
                if answer is not None:
                    return answer
            elif isinstance(answer, Stop):
                return answer.value
            elif answer is not None:
                value = answer
            if rule == "gate" and (value.get("refused") or value.get("gate_checkpoint")):
                break
        if (
            name == "tool.before"
            and not value.get("gate_checkpoint")
            and (s := self.sessions.get(data["session"]))
            and (request := self.waiting_request(s, data["call"]["id"]))
        ):
            status, _ = await self.check_wait_dispatch(
                s["id"], data["turn"], data["step"], value["call"], value.get("definition")
            )
            if terminal := self.wait_state(self.sessions[s["id"]], request)[2]:
                return {
                    **value,
                    "wait_terminal": {
                        "status": terminal["data"].get("status", "not_started"),
                        "content": terminal["content"],
                    },
                }
            if status or value.get("pending"):
                return {
                    **value,
                    "refused": True,
                    "wait_status": status or "refused",
                    "reason": "Waiting approval does not authorize this call",
                }
        return answers if rule == "collect" else (None if rule == "first" else value)

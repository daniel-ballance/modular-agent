from modular_agent import Plugin, Registrar, ToolContext, serve, tool


@tool
async def refused(cx: ToolContext, why: str) -> str:
    """Refuse with the supplied reason."""
    raise cx.refuse(why)


def setup(r: Registrar) -> None:
    async def command(args, cx):
        return f"{cx.actor_id}: {args}"

    r.command("echo", "Echo the arguments", command)
    r.on("turn.before", lambda _: {"add": {"system": "From the hook"}})
    r.on("tool.after", lambda _: {"change": {"content": [{"type": "text", "text": "after"}]}})
    r.on("step.after", lambda _: {"continue": True})
    r.on("turn.end", lambda _: None)


def plugin() -> Plugin:
    return Plugin("test-plugin", tools=[refused], setup=setup)


if __name__ == "__main__":
    serve(plugin())

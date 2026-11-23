"""A tool inside the stock coder's composition, not an approval in the desk."""
import json
import os

from modular_agent import Plugin, ToolContext, serve, tool

# Only the approved invocation can use the file editor, and only with this input.
allowed = {}


async def guard(payload, ctx):
    call = payload["call"]
    if call["name"] in {"exec", "write", "edit"}:
        key = (ctx.session_id, call.get("parentCallId"))
        if call["name"] != "edit" or allowed.get(key) != call["input"]:
            return {"refuse": "Use apply_change to approve an edit and commit."}


@tool()
async def apply_change(old: str, new: str, ctx: ToolContext) -> str:
    """Replace one expression in limits.py and commit it in the coder's checkout."""
    args = {"old": old, "new": new}
    prompt = f"Allow apply_change {json.dumps(args, sort_keys=True)} in limits.py and commit?"
    # Rust currently checks the approval value against options as for a choice.
    answer = await ctx.ask({"kind": "approval", "question": prompt, "options": ["allow", "refuse"]},
                           wait=int(os.environ["DESK_APPROVAL_MS"]) / 1000)
    if answer.kind != "allow":
        raise ctx.refuse("The change was refused. No file was written.")
    edit = {"path": "limits.py", "edits": [{"oldText": old, "newText": new}]}
    key = (ctx.session_id, ctx.call_id)
    allowed[key] = edit
    try:
        result = await ctx.tools.call("edit", edit)
        if result.status != "completed":
            raise RuntimeError(result.text())
    finally:
        del allowed[key]
    commit = await ctx.environment.exec("git add -- limits.py && git commit -m 'Fix percentage bounds' -- limits.py")
    if commit["exit_code"] != 0:
        raise RuntimeError("Could not commit the approved edit")
    return "Committed the approved edit to limits.py."


if __name__ == "__main__":
    serve(Plugin("coder-changes", tools=[apply_change], hooks={"tool.before": guard}))

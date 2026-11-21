"""A stdio plugin. Project files are accessed only through the tool context."""

import asyncio
import os

from modular_agent import Plugin, ToolContext, serve, tool

NOTES = "notes.txt"


@tool()
async def add_note(note: str, ctx: ToolContext) -> str:
    """Append one line to the project notes. This write is not safe to repeat."""
    if not note.strip() or "\n" in note or "\r" in note or len(note) > 200:
        raise ctx.refuse("Use one nonempty line of at most 200 characters.")
    existing = await ctx.environment.read(NOTES)
    await ctx.environment.write(NOTES, existing + (note + "\n").encode())
    if os.environ.get("NOTES_DEMO_PAUSE_AFTER_WRITE") == "1":
        # Stay inside the call until the crash runner kills the agent.
        await asyncio.Event().wait()
    return f"Added: {note}"


@tool(read_only=True)
async def search_notes(query: str, ctx: ToolContext) -> str:
    """Find lines containing the given text, ignoring case."""
    notes = (await ctx.environment.read(NOTES)).decode()
    matches = [line for line in notes.splitlines() if query.casefold() in line.casefold()]
    return "\n".join(matches) if matches else "No matching notes."


if __name__ == "__main__":
    serve(Plugin("project-notes", tools=[add_note, search_notes]))

import asyncio

from modular_agent import Answer, Question, QuestionContext, ToolContext, tool
from modular_agent.testing import test_agent as make_test_agent


async def test_checks_approval_policy() -> None:
    for policy, read_only, has_handler, status, asks in [
        ("off", False, True, "completed", 0),
        ("ask", True, False, "completed", 0),
        ("ask", False, False, "refused", 0),
        ("ask", False, True, "completed", 1),
        ("all", True, True, "completed", 1),
        ("never", False, True, "refused", 0),
    ]:
        seen: list[Question] = []

        @tool(read_only=read_only)
        async def preview() -> str:
            """Preview a palette."""
            return "Preview ready."

        def approve(question: Question, _cx: QuestionContext) -> Answer:
            seen.append(question)
            return Answer("allow")

        script = [{"toolCalls": [{"name": "preview", "input": {}}]}, {"text": "Done."}]
        async with make_test_agent(
            approval=policy,
            on_question=approve if has_handler else None,
            tools=[preview],
            script=script,
        ) as agent:
            turn = await (await agent.session()).prompt("Preview a palette.")
            assert turn.tool_results()[0].status == status
            assert len(seen) == asks
            for question in seen:
                assert question.kind == "approval"
                assert isinstance(question.call, dict)
                assert question.call["name"] == "preview"
                assert question.call["input"] == {}


@tool(read_only=True)
async def choose_palette(cx: ToolContext) -> str:
    """Ask which palette to preview."""
    answer = await cx.ask(
        {"kind": "choice", "question": "Which palette?", "options": ["light", "dark"]}
    )
    if answer.kind != "value":
        raise cx.refuse("No palette selected.")
    return f"Selected {answer.value}."


async def test_answers_a_choice_from_the_ui() -> None:
    script = [{"toolCalls": [{"name": "choose_palette", "input": {}}]}, {"text": "Done."}]
    async with make_test_agent(
        approval="ask",
        on_question=lambda q, cx: "decline",
        tools=[choose_palette],
        script=script,
    ) as agent:
        session = await agent.session()
        shown: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        waiting: asyncio.Future[Answer] = asyncio.get_running_loop().create_future()

        async def show_in_ui(question: Question, _cx: QuestionContext) -> Answer:
            shown.set_result(question.id)
            return await waiting  # Stay present without returning an automatic decline.

        await session.on_question(show_in_ui)
        try:
            async with asyncio.timeout(5), asyncio.TaskGroup() as tasks:
                turn = tasks.create_task(session.prompt("Choose a palette."))
                opened_id = await shown
                [question] = [q for q in await session.questions() if q.id == opened_id]
                assert question.kind == "choice"
                assert question.options == ("light", "dark")
                # The app's click handler answers by id while the turn is waiting.
                await session.answer(question.id, {"value": "dark"})
            assert turn.result().tool_results()[0].text() == "Selected dark."
        finally:
            waiting.cancel()  # The UI already answered; don't send a second reply.

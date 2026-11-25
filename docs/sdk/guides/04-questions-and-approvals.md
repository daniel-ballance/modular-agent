# Questions and approvals

Let a tool ask the person using your app for a decision. Use the approval policy for permission to run a call, and a choice question for information a running tool needs. The examples use a scripted Provider and stand in for the UI with a click in the test. Put both blocks for your language in the same test file.

## Set an approval policy

Choose the [approval policy](../../contracts.md#approval-policy) when you build the agent. It becomes the default for new sessions.

| Policy | What the approval check does |
|---|---|
| `off` | Does not ask. Omitting the option instead leaves the approval plugin out altogether. |
| `ask` | Asks unless the trusted tool definition says the tool is read-only. A model's claim that a call is read-only is not enough. |
| `all` | Asks even for read-only calls. |
| `never` | Refuses every call without asking. |

No policy bypasses other [tool gates](../../contracts.md#tool-dispatch). When approval is required, show the exact tool name and input and ask the user to allow or decline that call. A handler makes the embedded actor present to answer. Under the default live-only rule, if there is no handler and no other eligible answerer who can see the exact call, the agent refuses it rather than running without consent or waiting for someone who cannot answer. See [The local actor](../concepts.md#the-local-actor) and [Security: Authority](../../security.md#authority).

The test changes the policy and the tool's read-only hint. Its agent-wide handler records the question and returns allow. That automatic answer is only for the test; in an app, return allow only after the user approves the call.

**Rust**

```rust
use std::time::Duration;

use modular_agent::{
    Answer, Approval, Ask, Question, QuestionKind, Result, Tool, ToolContext, ToolStatus,
    testing::test_agent,
};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::{mpsc, oneshot};

#[derive(Deserialize, JsonSchema)]
struct Empty {}

#[tokio::test]
async fn checks_approval_policy() -> Result<()> {
    use ToolStatus::{Completed, Refused};
    for (policy, read_only, has_handler, status, asks) in [
        (Approval::Off, false, true, Completed, 0),
        (Approval::Ask, true, false, Completed, 0),
        (Approval::Ask, false, false, Refused, 0),
        (Approval::Ask, false, true, Completed, 1),
        (Approval::All, true, true, Completed, 1),
        (Approval::Never, false, true, Refused, 0),
    ] {
        let tool = Tool::new("preview", "Preview a palette.");
        let tool = if read_only { tool.read_only() } else { tool };
        let mut builder = test_agent()
            .approval(policy)
            .tool(tool.run(|_: Empty, _| async { Ok("Preview ready.") }))
            .script(json!([
                {"toolCalls": [{"name": "preview", "input": {}}]},
                {"text": "Done."}
            ]));
        let (seen, mut questions) = mpsc::unbounded_channel::<Question>();
        if has_handler {
            builder = builder.on_question(move |question| {
                let _ = seen.send(question);
                std::future::ready(Answer::Allow)
            });
        }
        let agent = builder.build().await?;
        let turn = agent.session().await?.prompt("Preview a palette.").await?;
        assert_eq!(turn.tool_results()[0].status, status);
        let mut count = 0;
        while let Ok(question) = questions.try_recv() {
            assert_eq!(question.kind, QuestionKind::Approval);
            let call = question.call.unwrap();
            assert_eq!(call["name"], "preview");
            assert_eq!(call["input"], json!({}));
            count += 1;
        }
        assert_eq!(count, asks);
        agent.close().await?;
    }
    Ok(())
}
```

**TypeScript**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { tool, type Answer, type Question } from "@modular-agent/core";
import { testAgent } from "@modular-agent/core/testing";
import { z } from "zod";

test("checks approval policy", { timeout: 5000 }, async () => {
  for (const [approval, readOnly, hasHandler, status, asks] of [
    ["off", false, true, "completed", 0],
    ["ask", true, false, "completed", 0],
    ["ask", false, false, "refused", 0],
    ["ask", false, true, "completed", 1],
    ["all", true, true, "completed", 1],
    ["never", false, true, "refused", 0],
  ] as const) {
    const seen: Question[] = [];
    const agent = await testAgent({
      approval,
      tools: [tool({
        name: "preview", description: "Preview a palette.", readOnly,
        input: z.object({}), run: async () => "Preview ready.",
      })],
      onQuestion: hasHandler ? question => { seen.push(question); return "allow"; } : undefined,
      script: [{ toolCalls: [{ name: "preview", input: {} }] }, { text: "Done." }],
    });
    try {
      const turn = await (await agent.session()).prompt("Preview a palette.");
      assert.equal(turn.toolResults()[0].status, status);
      assert.deepEqual(seen.map(q => [q.kind, q.call?.name, q.call?.input]),
        Array.from({ length: asks }, () => ["approval", "preview", {}]));
    } finally {
      await agent.close();
    }
  }
});
```

**Go**

```go
package modular_test

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func TestChecksApprovalPolicy(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	for _, tc := range []struct {
		policy               modular.Approval
		readOnly, hasHandler bool
		status               modular.ToolStatus
		asks                 int
	}{
		{"off", false, true, modular.Completed, 0},
		{"ask", true, false, modular.Completed, 0},
		{"ask", false, false, modular.Refused, 0},
		{"ask", false, true, modular.Completed, 1},
		{"all", true, true, modular.Completed, 1},
		{"never", false, true, modular.Refused, 0},
	} {
		var hints []modular.ToolOption
		if tc.readOnly {
			hints = append(hints, modular.ReadOnly())
		}
		preview := modular.NewTool("preview", "Preview a palette.",
			func(context.Context, struct{}, *modular.ToolContext) (string, error) {
				return "Preview ready.", nil
			}, hints...)
		seen := make(chan modular.Question, 4)
		options := []modular.Option{
			modular.WithApproval(tc.policy), modular.WithTool(preview),
			modulartest.Script(`[
				{"toolCalls": [{"name": "preview", "input": {}}]},
				{"text": "Done."}
			]`),
		}
		if tc.hasHandler {
			options = append(options, modular.WithOnQuestion(
				func(_ context.Context, q modular.Question) (modular.Answer, error) {
					seen <- q
					return modular.Allow(), nil
				}))
		}
		agent := modulartest.Agent(t, options...)
		session, err := agent.Session(ctx)
		if err != nil {
			t.Fatal(err)
		}
		turn, err := session.Prompt(ctx, "Preview a palette.")
		if err != nil {
			t.Fatal(err)
		}
		results := turn.ToolResults()
		if len(results) != 1 || results[0].Status != tc.status || len(seen) != tc.asks {
			t.Fatalf("%+v: results %v, questions %d", tc, results, len(seen))
		}
		for range tc.asks {
			q := <-seen
			var input map[string]any
			if q.Kind != "approval" || q.Call == nil || q.Call.Name != "preview" ||
				json.Unmarshal(q.Call.Input, &input) != nil || input == nil || len(input) != 0 {
				t.Fatalf("not the expected approval: %+v", q)
			}
		}
	}
}
```

**Python**

```python
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
```

## Ask for a choice and answer from your UI

`choose_palette` is read-only, so it runs without an approval question under `ask`. It asks its own choice question with `ask` on the tool context and waits. If the user declines, the tool refuses rather than picking a palette for them.

A session handler overrides the agent handler. The examples show how to pass a question to a UI from a handler. The click can supply the handler's return value or call [`session.answer(id, answer)`](../api.md#questions) directly. If the handler only shows the question, keep it pending until the question settles; returning nothing early declines it.

An app can also start the turn without a handler, read open choice and text questions with `session.questions()`, and answer them by id. For live approvals, the embedded actor still needs a handler to count as present. Send a tagged decline to refuse a question; the text `declined` is an ordinary answer value.

**Rust**

```rust
fn choose_palette() -> Tool {
    Tool::new("choose_palette", "Ask which palette to preview.")
        .read_only()
        .run(|_: Empty, cx: ToolContext| async move {
            match cx
                .ask(Ask::choice("Which palette?", &["light", "dark"]))
                .await?
            {
                Answer::Value(value) => Ok(format!("Selected {value}.")),
                _ => Err(cx.refuse("No palette selected.")),
            }
        })
}

#[tokio::test]
async fn answers_a_choice_from_the_ui() -> Result<()> {
    let (show, mut ui) = mpsc::unbounded_channel();
    let agent = test_agent()
        .approval(Approval::Ask)
        .tool(choose_palette())
        .on_question(move |question| {
            let (reply, answer) = oneshot::channel();
            let _ = show.send((question, reply));
            async move { answer.await.unwrap_or(Answer::Declined { reason: None }) }
        })
        .script(json!([
            {"toolCalls": [{"name": "choose_palette", "input": {}}]},
            {"text": "Done."}
        ]))
        .build()
        .await?;
    let session = agent.session().await?;
    let click = async {
        let (question, reply) = ui.recv().await.unwrap();
        assert_eq!(question.session_id, session.id());
        assert_eq!(question.kind, QuestionKind::Choice);
        assert_eq!(question.options, ["light", "dark"]);
        reply.send(Answer::Value("dark".into())).unwrap();
    };
    let (turn, ()) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(session.prompt("Choose a palette."), click)
    })
    .await
    .expect("the question did not settle");
    assert_eq!(turn?.tool_results()[0].text(), "Selected dark.");
    agent.close().await
}
```

**TypeScript**

```ts
const choosePalette = tool({
  name: "choose_palette",
  description: "Ask which palette to preview.",
  readOnly: true,
  input: z.object({}),
  run: async (_, cx) => {
    const answer = await cx.ask({
      kind: "choice", question: "Which palette?", options: ["light", "dark"],
    });
    if (typeof answer === "object" && "value" in answer) return `Selected ${answer.value}.`;
    return cx.refuse("No palette selected.");
  },
});

test("answers a choice from the UI", { timeout: 5000 }, async () => {
  const agent = await testAgent({
    approval: "ask",
    onQuestion: () => "decline",
    tools: [choosePalette],
    script: [{ toolCalls: [{ name: "choose_palette", input: {} }] }, { text: "Done." }],
  });
  try {
    const session = await agent.session();
    let respond!: (answer: Answer) => void;
    const reply = new Promise<Answer>(resolve => { respond = resolve; });
    const shown = new Promise<Question>(resolve => {
      session.onQuestion(question => {
        resolve(question);
        return reply;
      });
    });

    const turn = session.prompt("Choose a palette.");
    const question = await Promise.race([
      shown,
      turn.then(() => { throw new Error("Turn ended without a question"); }),
    ]);
    try {
      assert.equal(question.sessionId, session.id);
      assert.equal(question.kind, "choice");
      assert.deepEqual(question.options, ["light", "dark"]);
    } finally {
      // The app's click handler settles the promise returned by onQuestion.
      respond({ value: "dark" });
    }
    assert.equal((await turn).toolResults()[0].text(), "Selected dark.");
  } finally {
    await agent.close();
  }
});
```

**Go**

```go
var choosePalette = modular.NewTool("choose_palette", "Ask which palette to preview.",
	func(ctx context.Context, _ struct{}, cx *modular.ToolContext) (string, error) {
		answer, err := cx.Ask(ctx, modular.Question{
			Kind: "choice", Question: "Which palette?", Options: []string{"light", "dark"},
		})
		if err != nil {
			return "", err
		}
		if answer.Declined {
			return "", cx.Refuse("No palette selected.")
		}
		return "Selected " + answer.Value + ".", nil
	}, modular.ReadOnly())

func TestAnswersAChoiceFromTheUI(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	agent := modulartest.Agent(t, modular.WithApproval("ask"), modular.WithTool(choosePalette),
		modular.WithOnQuestion(func(context.Context, modular.Question) (modular.Answer, error) {
			return modular.Decline("No UI for this session."), nil
		}),
		modulartest.Script(`[
			{"toolCalls": [{"name": "choose_palette", "input": {}}]},
			{"text": "Done."}
		]`))
	session, err := agent.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	shown := make(chan modular.Question, 1)
	reply := make(chan modular.Answer, 1)
	err = session.OnQuestion(ctx, func(ctx context.Context, q modular.Question) (modular.Answer, error) {
		shown <- q
		select {
		case answer := <-reply:
			return answer, nil
		case <-ctx.Done():
			return modular.Answer{}, ctx.Err()
		}
	})
	if err != nil {
		t.Fatal(err)
	}

	finished := make(chan error, 1)
	go func() {
		turn, err := session.Prompt(ctx, "Choose a palette.")
		if err == nil {
			results := turn.ToolResults()
			if len(results) != 1 || results[0].Text() != "Selected dark." {
				err = fmt.Errorf("unexpected result: %v", results)
			}
		}
		finished <- err
	}()
	select {
	case q := <-shown:
		if q.Kind != "choice" || !slices.Equal(q.Options, []string{"light", "dark"}) {
			t.Fatalf("unexpected question: %+v", q)
		}
		reply <- modular.Answer{Value: "dark"} // The app's click handler.
	case err := <-finished:
		t.Fatalf("turn ended without a question: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
}
```

**Python**

```python
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
```

Start the prompt without waiting for its result before you show the question. Otherwise the turn waits for the answer while the UI waits for the turn. In an app, clear the control when its question closes or the turn is cancelled; don't treat an old button click as consent for a new call. These examples answer while the turn is still running. Keeping a call open **after** a turn is a separate capability. Under [ADR 0034](../../adr/0034-approvals-that-wait.md), a pre-dispatch approval can do so only when the session opts in. See the [question rules](../../contracts.md#questions) and [Questions from a tool](../api.md#tools).

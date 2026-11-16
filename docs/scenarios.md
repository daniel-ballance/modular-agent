# Scenarios

**Status:** draft, revised 2026-11-16 after the [pressure test](pressure-test/synthesis.md).

Each scenario tells what happens in one situation, using only the parts in [Architecture](architecture.md) and the interactions in [Contracts](contracts.md). They test the description: if a scenario can't be told with what is there, something is missing. "Open" lists the gaps each one exposes.

All scenarios use the same agent unless they say otherwise. It is the Harness plus these plugins:
- **Interface:** a terminal UI, acting for one user
- **Runtime:** a transient Runtime
- **Provider:** one vendor's models, keeping no state and running no tools
- **Tool source:** built-in file and shell tools
- **Working environment:** the local machine
- **History store:** files on disk
- **Credential store:** stored API keys
- **Feature plugins:** model selection, system prompt, context management, approval

Scenarios 1–10 cover a single agent and user. Scenarios 11–17 were added after the pressure test to cover what it found.

## 1. A request that uses a tool

The user types "Read config.json and summarize it."

1. The terminal UI gives the input to the session, to be taken now. The input records the user as its actor, and starts an exchange.
2. At "input arrives", no plugin handles it as a command, so it goes on. The input is recorded in the history.
3. At "before a turn", the system prompt plugin adds the base instructions and the project's `AGENTS.md`.
4. The Harness asks the Runtime to run a turn. It gives the Runtime the input, the tool definitions, access to the model that model selection chose, and the session's limits.
5. Before the first step, context management decides what the model sees: everything, since the history is short.
6. The Runtime makes a model request. The response asks for the `read` tool with `config.json`. The terminal UI shows the response as it arrives, after the output gate.
7. After the step, no plugin ends the turn.
8. Before the tool call, the approval plugin sees that `read` is read-only, and allows it.
9. The Runtime asks for the tool call to be run. The Harness passes it to the file tools, which read the file from the working environment.
10. Before the second step, context management includes the tool call and its result.
11. The second model request returns the summary.
12. After the step, there are no tool calls left, so the turn ends as **completed**, with the summary as its result. The Runtime reports two steps, the new history entries and the usage. The history store keeps them, and the exchange ends.

**Must hold:** every entry is tied to its session, exchange, turn, step, tool call and actor. The Runtime never saw a credential or chose the model.

## 2. A tool call that needs approval

In the middle of a turn, the model asks to run `rm -rf build/`.

1. Before the tool call, the approval plugin sees a destructive call. The session's policy is "ask", so it opens an input request of kind approval, tied to the tool call. The request says the user may answer it, and that it can be answered now.
2. The terminal UI shows the request beside the pending tool call, so the user sees what the agent was doing. The turn waits.
3. The user chooses "allow". The approval plugin records the request and the answer, with the user as the actor, where the model doesn't see them, and allows the call.
4. The call runs, and the turn carries on.

**Variations:**
- The user refuses. The call ends as **refused**, with the reason as its result, and the model sees that.
- No Interface acting for someone who may answer is present. The call is **refused**: approval fails closed.
- The session's policy is "never ask". The call is refused at once, without asking.

## 3. A question nobody answers in time

The model calls a tool that asks the user which database to use. The user has walked away.

1. The tool opens an input request of kind choice, with a time limit, tied to the tool call.
2. The time limit passes. The transient Runtime can't wait through a restart, so it doesn't hold the turn open. The turn ends as **completed**, and its result lists the tool call as still open. The exchange is now waiting.
3. The input request now says it can be answered later, as the tool call's result. It has no deadline.
4. An hour later the user answers. The answer becomes the open call's one result, and the Harness starts a new turn in the same exchange so the agent can carry on from it.

**Variation:** with a durable Runtime that declares it can wait through a restart, the turn itself waits, and continues when the answer arrives.

**Open:** who sets the time limit ([open question](open-questions.md#waiting-for-an-answer)).

## 4. The user adds a message while the agent works

While a turn is running, the user types "use the staging config, not production".

1. The terminal UI gives the input to the session, to be taken in the running turn.
2. The Runtime declares that it can take input during a turn. It takes the input before its next model request, and the model sees it in the next step.

**Variations:**
- The user asks for it to be taken after the turn. It waits and starts a new turn once this one ends, in the same exchange.
- The user changes their mind and withdraws it before it is taken. It is handed back to the Interface with its content.
- A Runtime that can't take input during a turn: the turn is cancelled and restarted with the input included. Both turns belong to one exchange.

**Open:** which of these happens is the Runtime's choice or the user's ([open question](open-questions.md#input-during-a-turn)).

## 5. The user cancels

A turn is running a long shell command when the user presses Escape.

1. The terminal UI cancels the session's running turn.
2. The Runtime asks for the running tool call to be cancelled. The call ends as **cancelled**.
3. Any model request in progress is cancelled at the Provider.
4. Any open input request tied to the turn is closed as cancelled.
5. The turn ends as **cancelled**. Everything recorded so far stays in the history.

**Must hold:** every tool call ends with exactly one result.

**Open:** what happens to input queued for after the turn, and to jobs the turn started ([open question](open-questions.md#cancellation)).

## 6. The conversation outgrows the model's context

A long session is close to the model's context window.

1. Before the next step, context management sees the usage so far and the model's limits.
2. It uses the Provider to summarize the older part of the history.
3. It adds the summary to the history as an entry the model sees. Nothing is deleted: compaction changes the view, not the record.
4. It gives the Runtime a model context made of the summary and the recent history.

**Variations:**
- The model request fails because the context is too large. At "a model request failed", context management summarizes and asks for a retry.
- The Provider keeps its own conversation state. Context management tells it to discard that state, so its view matches the new summary.

## 7. The process stops during a tool call

The machine restarts while a shell command is running.

**With the transient Runtime:**
1. The session's history survives in the history store.
2. When the session is opened again, the interrupted turn is recorded as ended. The shell command's result is **outcome unknown**. A tool call that had been requested but not started is **not started**.
3. Nothing with an unknown outcome is run again automatically. The model sees the statuses in the next turn, and can decide what to do.
4. An input request that was open in the stopped process is shown as **no longer answerable**, unless it was already waiting past its turn.

**With a durable Runtime:**
1. The turn carries on after the restart, from where it was.
2. Work that had finished is not done again. That relies on the shell tool saying it is not safe to repeat, and on plugins naming the outside work they did.

**Without a history store:** the session was ephemeral. Nothing survives.

**Open:** what the history must record for a durable Runtime to do this ([open question](open-questions.md#transient-and-durable-runtimes)).

## 8. Handing a task to a subagent

The agent decides to have another agent review its change. A subagents plugin offers a "delegate" tool.

1. The model calls "delegate" with the task and a choice of model.
2. The subagents plugin starts a job: a child session, recorded as belonging to the parent. The child gets only the task, not the parent's history. Its authority is no more than the parent's.
3. The "delegate" call ends with a result saying the job has started. The parent's turn carries on, then ends. The exchange is waiting on the job.
4. The child asks a question. The input request names the parent agent as who may answer. The parent answers it itself, or passes it to its user, marked as coming from the child.
5. The child finishes. Its result is the job's report, which starts a parent turn in the same exchange.

## 9. Work starts with nobody present

A scheduling plugin gives the agent "check for dependency updates" every morning.

1. At the set time, the scheduler, as an actor of kind program, gives the input to a session, to be taken now. The agent has declared that it can start turns because a schedule fires.
2. The session's approval policy is "never ask", so no tool call waits on a user.
3. The turn runs as in scenario 1. Its result and history are there when the user next opens the session.

**Must hold:** nothing waits forever on a user who isn't there.

## 10. Changing the model mid-session

The user switches from one vendor's model to another's between turns.

1. The model selection plugin changes the session's model setting. The change is recorded, with the step from which it applies.
2. The next turn's Runtime is given access to the new model.
3. Context management decides what the new model sees, from the same history.
4. If the old Provider kept state, that state is simply no longer used. If the user switches back later, it may be stale, and the Provider is told to discard it.

**Open:** can the model change in the middle of a turn ([open question](open-questions.md#changing-the-model-mid-turn))?

## 11. Two people in one session

An owner shares a session with a colleague, who may watch and propose input but not approve anything. This agent declares that it supports several actors.

1. The colleague joins through a web UI. The session records a second actor, with authority to watch and propose.
2. The colleague proposes "also check the tests". Its input is recorded as proposed. The owner accepts it, and it is given to the session with both actors recorded.
3. The model asks to run a destructive command. The approval request says only the owner may answer it. The colleague's web UI shows it, but can't answer it.
4. A tool result contains a secret. At "before output reaches a recipient", the guardrail redacts it for the colleague's view only.

**Must hold:** authority only narrows. The colleague can't approve, even through another agent.

**Open:** how authority is granted, and what happens when two actors steer at once ([open question](open-questions.md#several-actors)).

## 12. The Provider runs a tool itself

The Provider declares that it can run web search on its own side.

1. Before the step, a plugin decides whether the Provider may run its own tools. The session's policy allows read-only Provider tools, so web search is allowed for this request.
2. The model response includes a web search call that the Provider already ran, with its results, and then an answer.
3. The Runtime records the search call and its result like any other, with the Provider as who started it. It does not ask for it to be run.
4. The approval plugin can't stop that call on its own: it could only allow or refuse Provider tools before the request.

**Must hold:** every tool call is recorded with exactly one result, wherever it ran.

**Variation:** if the request goes unanswered and is repeated, the search may run twice. The Provider declared that it runs tools, so the Runtime knows repeating the request isn't free of outside effects.

## 13. A voice conversation

A voice Interface and a Provider that offers live sessions.

1. The user opens a voice session. The Runtime opens a live session with the Provider, through its model access.
2. Audio flows both ways. The Provider decides when the user has finished speaking. Each stretch between turn-taking points is a step.
3. The model asks for a tool call mid-conversation. It goes through the Harness as usual, with the same checks.
4. The user interrupts the agent's reply. The live session handles the interruption. What was actually heard is recorded, not what was planned.
5. Audio as it streams is live only. The history keeps a transcript of each step, its tool calls and its usage.

**Open:** whether the whole voice session is one turn or several ([open question](open-questions.md#live-sessions)).

## 14. Rewinding to an earlier point

After three turns that went wrong, the user rewinds to just after the first one, files included.

1. The terminal UI asks to move the session to the entry after the first turn.
2. The Runtime, the Provider and the working environment each say whether they can rewind. The working environment returns the files to the point saved after the first turn. The Provider keeps no state, so it has nothing to rewind.
3. The session's current position moves. The move is recorded as a new entry. Nothing is deleted.
4. The view now leaves out the later turns, so the next turn's model doesn't see them.

**Variation:** the Provider keeps state and can't rewind it. It is told to discard its state, and the next request carries the whole model context. If a part can't do either, the rewind is refused before anything changes.

## 15. Erasing personal data

A user asks for their personal data to be deleted, and the deletion is required.

1. An actor with authority to erase asks for it through an Interface.
2. The history store erases the entries that hold the data, and the summaries and forks that copied it. It leaves erasure records in their place, without the erased content.
3. Plugins that exported the data, such as telemetry, are asked to erase their copies.
4. A Provider that kept conversation state is told to discard it.
5. The agent reports what it erased, and which copies were out of reach, such as output already sent to a recipient.

**Must hold:** deletion happens only through erasure or retention, and is itself recorded.

## 16. A background command

The model starts a dev server and wants to keep working while it runs.

1. The shell tool starts the server as a job, for the session, in the current exchange. The tool call ends with a result saying the job started.
2. The turn ends. The server keeps running. The terminal UI lists it as a job.
3. Ten minutes later, the server crashes. The job ends as **failed** and reports back. The report starts a new turn in the same exchange, so the model can look at the error.
4. The user closes the session. Any jobs still running are stopped.

**Open:** whether cancelling a turn also stops the jobs it started ([open question](open-questions.md#work-outside-a-turn)).

## 17. Driven by a host

A host such as T3 Code drives this agent, as it drives Pi today. The host is outside this system.

1. The host connects through an Interface, as an actor of kind host, with its own authority. It asks what the agent supports, and reads the declaration.
2. The host gives input with a key. The connection drops before the answer arrives. The host gives the same input again with the same key, and it is not taken twice.
3. The host reconnects and follows the session from the last point it saw.
4. An approval request opens. The host shows it in its own UI, and answers it for its user.
5. The host's user switches to another agent for a while, then comes back. The host gives this agent a summary of what the other agent did, as recorded input.
6. The host forks the session at an earlier point. This agent forks it, or refuses before anything changes.
7. The agent starts no turn the host didn't ask for, except where it declared it might, such as a job reporting back.

**Must hold:** the host never needs anything outside the Interface and the declaration.

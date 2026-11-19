# Testing

Each SDK ships a testing kit for developers, and runs a shared set of scenarios against itself and the other SDKs. Both work offline, with no real model and no credentials.

## The testing kit

Every SDK ships these in a `testing` module:

| Item | What it does |
|---|---|
| `scriptedProvider(script)` | A Provider with id `scripted` and one model, `scripted/script`, that answers from a [script](#the-model-script). |
| `memoryEnvironment(files?)` | A working environment that keeps files in memory. `exec` runs commands registered with `onExec(name, handler)` and raises `not_supported` for others. It declares `containment: "none"`. |
| `testAgent(options)` | `createAgent` with the scripted Provider and its model, a memory environment and `ephemeral` durability, unless the options say otherwise. |
| `answers(list)` | A question handler that answers in order from a list, and raises if a question arrives that the list did not expect. Each item is `"allow"`, `"decline"` or `{ "value": answer }`. |
| `overWire(plugin)` | The same plugin, served over the plugin binding through an in-memory pipe in the same process. A test can run any servable plugin both ways and compare. |
| `restart(agent)` | Drops the agent without shutting it down, as a crash would, and builds a new one over the same store and plugins. In-process only; the shared scenarios kill a real process. |

A developer tests a tool by building a `testAgent` with the tool and a script that calls it, sending a prompt and checking the PromptResult and the recorded ToolResult. The [guides](guides/README.md) show it.

### The model script

A script is a list of responses. Each response is an object:

| Field | Meaning |
|---|---|
| `text` | the answer's text |
| `reasoning` | readable reasoning |
| `toolCalls` | `[{ name, input }]`, requested in order |
| `error` | `{ kind, message }`: the attempt fails with this ModelError |
| `usage` | Usage to report; zero if absent |

For each request, the scripted Provider counts the assistant messages in `request.messages` and answers with the response at that index. The script is therefore stateless: a request repeated after a crash gets the same answer as the first time, and a turn that carries on after a restart picks up where it left off. A request past the end of the script fails with kind `other` and the message `script exhausted`.

The same format is used by the shared scenarios, so a developer's script and a scenario's are interchangeable.

## The shared scenarios

The scenarios are JSON files in [`conformance/sdk/scenarios/`](../../conformance/sdk/scenarios/). Each describes an agent, a model script and steps, and what must be true after each step. Every SDK has a runner for them.

### Running them

The runner runs each scenario in every applicable placement of the fixture plugins:

- `inProcess`: the fixtures in the agent's process;
- `process:<sdk>`: the fixtures served by an SDK's fixture program, for each of the four.

So a Rust agent runs every scenario with fixtures in process, then served from Rust, TypeScript, Go and Python. Every result MUST be the same. A scenario that uses an in-process-only feature lists `"placements": ["inProcess"]`.

For each run of a scenario in each placement, the runner creates a fresh, empty directory outside the agent's reach and supplies two things from it:

- the agent's `dataDir`, which survives a crash and is reused on reopen;
- the `counter` fixture's config `path`, an absolute path to its count file. A missing file counts as zero.

Steps that crash the agent run it as a separate process, in its own process group. A crash sends `SIGKILL` to the whole group, so served fixture plugins die with the agent, and the runner waits until every process in the group has exited before it reopens. Recovery then has nothing left running that could race it ([Working environment](../contracts.md#the-working-environment)).

### The fixture plugins

Every SDK implements these identically and serves them from a fixture program, `fixtures`, that takes the plugin names to serve as arguments. They are servable.

| Plugin | Registers | Behavior |
|---|---|---|
| `tide` | tool `tide`, input `{ harbour: string }`, read-only | Returns `High tide at <harbour> is 14:02.` |
| `counter` | tool `bump`, input `{ hold?: boolean, note?: string }`, not safe to repeat | Adds one to a count kept in the file named by its config `path`, then returns the new count as text. With `hold: true` it then waits until cancelled, so a crash lands after its effect. |
| `confirm` | tool `confirm`, input `{ question: string }` | Asks a `choice` question with options `yes` and `no` and returns the answer. |
| `gate` | hook `tool.before` | Refuses any call whose input, as JSON text, contains `forbidden`, with the reason `the gate refused it`. |

### The format

```json
{
  "scenario": "tool-call",
  "about": "A model calls a tool and answers with its result.",
  "rules": ["contracts.md#tool-dispatch"],
  "agent": { "durability": "ephemeral", "plugins": ["tide"] },
  "model": [
    { "toolCalls": [{ "name": "tide", "input": { "harbour": "Whitby" } }] },
    { "text": "High tide is at 14:02." }
  ],
  "steps": [
    { "prompt": "When is high tide at Whitby?",
      "expect": { "outcome": "completed", "text": "High tide is at 14:02.",
                  "toolResults": [{ "name": "tide", "status": "completed", "text": "High tide at Whitby is 14:02." }] } }
  ]
}
```

| Field | Meaning |
|---|---|
| `scenario` | a unique name, the file's name without `.json` |
| `about` | one sentence for people |
| `rules` | the rules it checks, as links relative to `docs/` |
| `agent` | `durability`, `plugins` (fixture names, in load order), `approval`, `answers` (for the [`answers` handler](#the-testing-kit), or absent for no handler), `settings` |
| `model` | the [model script](#the-model-script) |
| `placements` | optional; the placements it applies to, all by default |
| `steps` | in order |

A step is one of:

| Step | Does |
|---|---|
| `{ "prompt": text }` | `session.prompt(text)` and waits for the outcome |
| `{ "prompt": text, "crashWhen": { "record": kind } }` | sends the prompt and kills the agent's process once a record of that kind is committed |
| `{ "prompt": text, "crashWhen": { "count": n } }` | sends the prompt and kills the agent's process once the `counter` fixture's count reaches `n`, so the crash lands after the effect |
| `{ "reopen": true }` | starts the agent again over the same data and reopens the session; waits until it is idle |

and can have `expect`:

| Expectation | Holds when |
|---|---|
| `outcome` | the last turn's outcome kind matches |
| `text` | the last turn's result text is exactly this |
| `toolResults` | the last turn's tool results, in order, have these `name` and `status`, and `text` if given |
| `records` | these record kinds appear in the session's history in this order, not necessarily adjacent |
| `count` | the `counter` fixture's count is this number |
| `error` | the step itself raised this error code |

The runner MUST report each failed expectation with the scenario, placement, step and both values. It MUST NOT retry a failed scenario.

## Adding a scenario

A scenario belongs in the shared set when it checks behavior every SDK must share: a rule in the specification, a default in [Concepts](concepts.md#defaults), or a promise in [Placement](placement.md). Add the scenario first; each SDK then makes it pass. A scenario that needs a new step or expectation adds it here first.

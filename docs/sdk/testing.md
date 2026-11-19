# Testing

Each SDK ships a testing kit for developers, and runs a shared set of scenarios against itself and the other SDKs. Both work offline, with no real model and no credentials.

## The testing kit

Every SDK ships these in a `testing` module:

| Item | What it does |
|---|---|
| `scriptedProvider(script)` | A Provider with id `scripted` and one model, `scripted/script`, that answers from a [script](#the-model-script). |
| `memoryEnvironment(files?)` | A working environment that keeps files in memory. `exec` runs commands registered with `onExec(name, handler)` and raises `not_supported` for others. It declares `containment: "none"`. |
| `testAgent(options)` | `createAgent` with the scripted Provider and its model, a memory environment and `ephemeral` durability, unless the options say otherwise. |
| `answers(list)` | A question handler that answers in order from a list. Each item is `"allow"`, `"decline"` or `{ "value": answer }`. A question beyond the list is declined, because a handler's error is a decline, and is also recorded: the helper's check (`assertDone` or the language's equivalent) fails the test if any question went unexpected or any answer went unused. |
| `overWire(plugin)` | The same plugin, served over the plugin binding through an in-memory pipe in the same process. A test can run any servable plugin both ways and compare. |
| `restart(agent)` | Interrupts the agent's work without writing a graceful outcome or calling plugins' stop, releases its writer leases, and builds a new agent over the same store and in-process plugins. Reopen the sessions on the new agent. It simulates an interruption in one process; it does not show that a real process or its descendants would stop. The shared crash scenarios kill a real process for that. |

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

For each request, the scripted Provider counts the assistant messages in `request.messages`, the final request actually sent, so attempts left out of the context and responses removed by compaction do not count, and answers with the response at that index. The script is therefore stateless: a request repeated after a crash gets the same answer as the first time, and a turn that carries on after a restart picks up where it left off. A request past the end of the script fails with kind `other` and the message `script exhausted`.

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

### Finding the fixture programs

Each SDK lists its fixture program in `conformance/sdk/fixtures/<sdk>.json`:

```json
{
  "sdk": "rust",
  "build": "cd rust && mise exec -- cargo build -p sdk-scenarios --bin modular-agent-fixtures",
  "command": ["{repo}/rust/target/debug/modular-agent-fixtures"]
}
```

`command` is the argument vector that starts the program; the runner appends the fixture's name and passes the counter's `path` in the plugin's config. `{repo}` stands for the repository's absolute root. A program whose `{repo}` paths do not exist has not been built: the runner skips that placement and says how to build it, unless `MODULAR_AGENT_SDK_REQUIRE` names that SDK or is `all`, in which case it fails. The program starts with the plugin binding's minimal environment, so `command` uses an absolute path wherever `PATH` alone would not find the program or its dependencies. Each runner uses its own SDK's freshly built program for its own placement.

Steps that crash the agent run it as a separate process, in its own process group. A crash sends `SIGKILL` to the whole group, so served fixture plugins die with the agent, and the runner reaps its direct child and waits until no member of the group can still run before it reopens. A zombie awaiting reaping counts as exited. Recovery then has nothing left running that could race it ([Working environment](../contracts.md#the-working-environment)).

### The fixture plugins

Every SDK implements these identically and serves them from a fixture program, `fixtures`, that takes exactly one fixture name as its first argument and serves that plugin. They are servable.

| Plugin | Registers | Behavior |
|---|---|---|
| `tide` | tool `tide`, input `{ harbour: string }`, read-only | Returns `High tide at <harbour> is 14:02.` |
| `counter` | tool `bump`, input `{ hold?: boolean, note?: string }`, not safe to repeat | Adds one to a count kept in the file named by its config `path`, then returns the new count as text. With `hold: true` it then waits until cancelled, so a crash lands after its effect. |
| `confirm` | tool `confirm`, input `{ question: string }` | Asks a `choice` question with options `yes` and `no` and returns the answer. |
| `gate` | hook `tool.before` | Refuses any call whose input, as JSON text, contains `forbidden`, with the reason `the gate refused it`. |
| `quay` | tool `moor`, input `{ harbour: string }` | Refuses with the reason `the quay is closed`, through the tool context's `refuse`. |
| `pilot` | tool `pilot`, input `{ harbour: string }`; needs `tide` loaded too | Calls `tide` with the same harbour as a [nested call](../contracts.md#nested-calls), then returns `Pilot: ` followed by the nested result's text. |

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
| `toolResults` | the last turn's tool results, in order, have these `name` and `status`, `text` if given (exact), and `contains` if given (a substring, for diagnostics an SDK may word in its own way) |
| `records` | these record kinds appear in the session's history in this order, not necessarily adjacent |
| `count` | the `counter` fixture's count is this number |
| `error` | the step itself raised this error code |

The runner MUST report each failed expectation with the scenario, placement, step and both values. It MUST NOT retry a failed scenario.

## Adding a scenario

A scenario belongs in the shared set when it checks behavior every SDK must share: a rule in the specification, a default in [Concepts](concepts.md#defaults), or a promise in [Placement](placement.md). Add the scenario first; each SDK then makes it pass. A scenario that needs a new step or expectation adds it here first.

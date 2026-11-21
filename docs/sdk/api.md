# API

The shape of the API, in language-neutral terms. [Languages](languages.md) says how each language spells it. The [guides](guides/README.md) show it in use.

## Notation

- Types are `UpperCamelCase`; operations and fields are `lowerCamelCase`. Each language converts the case it needs, and only the case: `prompt` is `prompt` in every language, never `ask` or `run`.
- `op(a: Type, b?: Type) -> Result` describes an operation. `?` marks an optional argument. Operations that can wait are asynchronous in each language's own way.
- Data types not defined here are [shared data](../bindings/data.md) shapes, with the same field names. An SDK MUST serialize them with exactly the shared data names and rules.
- "Raises `code`" means the operation fails with an [error](#errors) of that code.

## Building an agent

`createAgent(options) -> Agent` builds and starts an agent. It loads every plugin, checks the composition and fails before returning if anything is wrong. Nothing runs until it succeeds.

| Option | Type | Default |
|---|---|---|
| `project` | path | the current directory |
| `dataDir` | path | none. Required when a part needs a local directory to keep state across restarts, or when `kept` or `durable` uses the default file history. The default local environment under `ephemeral` uses agent-owned scratch for disposable command bookkeeping. |
| `durability` | `ephemeral`, `kept` or `durable` | `ephemeral`; see [Durability](placement.md#durability) |
| `history` | a history store | chosen by `durability`: memory, or files under `dataDir` |
| `runtime` | a Runtime | chosen by `durability` |
| `environment` | a working environment | local, rooted at `project` |
| `credentials` | a credential store | environment variables. To answer a `secret` question, use a writable store that implements [secret staging](#the-other-parts), such as `fileCredentials(path)`. |
| `providers` | Providers | none |
| `tools` | tools | none |
| `plugins` | plugins, in load order | none |
| `processPlugins` | ordered list of `{ command: string[], env?: object, config?: object }` | none; see [Placement](placement.md#a-plugin-in-another-process) |
| `model` | ModelRef or `"provider/id"` | the only model offered, if exactly one; otherwise none |
| `settings` | default settings for new sessions, by [setting key](../bindings/data.md#setting-keys) | none |
| `approval` | `off`, `ask`, `all` or `never` | absent: no approval plugin. Any value loads the approval plugin and records that policy for new sessions; `off` means the plugin is loaded and its check does not ask ([Approval policy](../contracts.md#approval-policy)). |
| `onQuestion` | a question handler | none; see [Questions](#questions) |
| `servicePlugins` | ordered list of `{ url, tokenFile, config? }` | none; see [Placement](placement.md#services) |
| `pluginHost` | boolean | true if either plugin list is nonempty; otherwise false. A plugin host reads `MODULAR_AGENT_PLUGINS` after both lists. See [Placement](placement.md#a-plugin-in-another-process). |
| `severalActors` | boolean | false. When true, the agent declares `severalActors`, and `session.join`, `leave`, `as` and proposed input work. When false they raise `not_supported` for any actor but the local one, as the [ACP binding](../bindings/acp.md#several-actors) requires. |
| `sessionLimits` | boolean | false. When true, the agent declares `sessionLimits` and `session.setLimit` works; otherwise it raises `not_supported`. |
| `tenants` | map of tenant name to `{ rights, tokens? }`, the shape of `MODULAR_AGENT_TENANTS` | none. Given, the agent declares `tenants`, and `session({ tenant })` places a session in one ([Limits and tenants](../contracts.md#limits-and-tenants)). |
| `jobReportsStartTurns` | boolean | false: a job's report is parked until released ([Jobs](../contracts.md#jobs)) |

Each SDK provides constructors for the parts it ships: `transientRuntime()`, `durableRuntime()`, `memoryHistory()`, `fileHistory(dir)`, `httpHistory(url, tokenFile)`, `localEnvironment(root?)`, `environmentCredentials()` and `fileCredentials(path)`. `serve(plugin)` and `serveHistory(store, options)` are covered in [Placement](placement.md).

Each option that names a part is shorthand for a plugin that provides it. `providers`, `tools`, `environment` and the rest are added before `plugins`, in the order of this table, so an explicit plugin can [replace](#replacing-a-part) one of them.

`createAgent` raises `invalid_composition` for combinations the [durability rules](placement.md#durability) forbid. With `ephemeral`, an explicit persistent history store or a history service raises `invalid_composition` whose message names `kept`. The rule applies whether the store comes from `history` or a plugin registration.

`createAgent` also raises `invalid_composition` for `pluginHost: false` with a nonempty `processPlugins` or `servicePlugins` list, two plugins with the same name, or a [replacement](#replacing-a-part) the registration rules refuse. It raises `not_supported` for a plugin that needs something this agent cannot give. Failure to load, start, connect to, initialize or register a configured plugin fails the whole agent with `invalid_composition`: the SDK MUST NOT run without a configured part or substitute another for it ([Choosing plugins at start](../bindings/plugin.md#choosing-plugins-at-start)).

## The agent

| Operation | Returns |
|---|---|
| `session(options?)` | a new Session. Options: `settings`, `tenant`, `actors`. |
| `openSession(id)` | an existing Session, reopened. It installs interrupted work for recovery, as the Runtime declares, before admitting fresh work. An embedded agent MAY wait for the recovered work before returning; `serveAcp` MUST NOT, as [ACP](../bindings/acp.md#sessions) requires. |
| `sessions(filter?)` | stored sessions, without opening them or starting recovery: id, canonical project, selected model, title if any, last activity |
| `sessionInfo(id)` | one stored session's project, settings, creation time and last activity, without opening it or starting recovery |
| `declaration()` | what this agent supports, as a [Declaration](../contracts.md#declaration) |
| `models()` | the models its Providers offer, as ModelInfo |
| `serveAcp(options?)` | serves the agent over [ACP](../bindings/acp.md). On stdio it returns when the client disconnects. With `listen`, `actors` and optional `tls`, it returns a listener with `url` and `close()` once ready ([Placement](placement.md#the-whole-agent)). See composition options below. |
| `close()` | closes open sessions, stops plugins in reverse load order and releases what it holds |

On stdio, `serveAcp` accepts operator-supplied `projects`, `tenants`, `rights` (the optional connection ceiling) and `represents` (a list of actor IDs, empty if omitted). These constrain the configured stdio principal; they are not ACP request fields. `projects` lists exact canonical paths and `tenants` lists names or `null` for sessions without a tenant. An empty list denies that scope entirely. With no explicit lists, stdio uses the serving composition's project scope and the operator's tenant grants for the principal; by default those grants allow only sessions without a tenant. For a WebSocket listener, each `actors` entry binds a token file to an actor and optional `tenants`, `projects` and `represents` lists. Omitted `tenants` allows only sessions without a tenant; include `null` in a list to allow them. A project list matches exact canonical paths, not subdirectories. Omitted `projects` uses the serving composition's scope. An empty list permits nothing in its scope. The service computes the connection's rights by intersecting the token's rights with the actor's recorded grants at connection time, without rewriting those grants. See [The whole agent](placement.md#the-whole-agent) and the [WebSocket binding](../bindings/websocket.md#an-agent-service).

Without a composition factory, ACP serves only the Agent's configured project. A factory builds an Agent for a canonical project and can use the saved session's identity or metadata when reopening. The serving agent needs access to the saved session's history before choosing a composition. It MUST authorize the saved project and tenant before passing saved metadata to a factory or invoking project configuration callbacks. SDKs MUST reject malformed operator scope or representation configuration with `invalid_composition`, before serving. Project settings supply defaults for new sessions, not replacements on reopen. Keep trusted project MCP configuration separate from attaching client-supplied servers under the [host MCP policy](../contracts.md#mcp-servers). See [Languages](languages.md) for the factory and callback signatures.

An Agent is safe to use from several tasks at once. Sessions have separate work and history, but share [tenant and agent capacity](../contracts.md#resource-reservations).

### The declaration

`declaration()` returns every key of the [ACP declaration](../bindings/acp.md#the-declaration), computed from the parts the agent was built with. The SDK never guesses a key: each comes from a part's own declaration or from a choice in `createAgent`. Where support varies, the agent declares the more restrictive value. Most values are capabilities of the chosen parts, not constants:

| Key | Value |
|---|---|
| `continuesAfterRestart` | true under `durable`; false otherwise ([Durability](placement.md#durability)) |
| `waitingThroughRestart` | true only when the chosen durable Runtime and the host re-ask an interrupted in-turn question on recovery ([ACP](../bindings/acp.md#questions)); otherwise false |
| `queuedInputAfterRestart` | the policy the agent implements for queued input on reopen; `handedBack` with the shipped parts |
| `queuedJobReportsAfterRestart` | the policy the agent implements for queued job reports on reopen; omit when it equals `queuedInputAfterRestart`, which also supplies the fallback when absent |
| `portableSessions` | true under `kept` and `durable`, whose stores keep the shared format; false under `ephemeral` |
| `inputDuringTurn` | true: both Runtimes take steering |
| `forking` | true |
| `rewinding` | true only if the working environment declares `points` |
| `keepsStateAtProvider` | from the Providers' `keepsState`; false for those the SDK ships |
| `runsToolsAtProvider`, `liveSessions` | false: the SDK 0.1 Provider port cannot declare them ([Providers](#providers)) |
| `severalActors`, `sessionLimits`, `tenants` | from the options of the same names; false by default |
| `holdsOutput` | true when the agent guarantees whole-stream holding in the declared scope; otherwise false. Streams covered by a remote output gate require holding and a true declaration, as the [plugin binding](../bindings/plugin.md#the-host-asks-a-hook-handler) specifies. |
| `outputBypassesAgent` | false |
| `cancellingTurnCancelsJobs` | false |
| `pluginsDuringSession` | false |
| `erasure` | true only if the history store and the agent implement erasure and can enforce [pending erasure](../contracts.md#cross-session-coordination) across the declared scope. An HTTP history client uses the [pending-erasure registry profile](../bindings/history-http.md#pending-erasure-registry-profile-pendingerasure-1) when the service declares a supported version. Without one, the HTTP composition declares false, even if the service can erase. |
| `inputKeys` | true |
| `questionsOutlastTurns`, `lateAnswersStartTurns` | false unless the app enables both |
| `startsTurnsUnasked` | `jobReports` if `jobReportsStartTurns`; otherwise `never` |
| `movingWithUnfinishedWork` | `refused` |
| `mixedActorInput` | `refused` |
| `settingsDuringTurn` | `nextTurn` if the host records a change during a turn and applies it from the next; otherwise `refused` |
| `erasureDuringTurn` | `refused` |
| `resourceReservations` | The configured count ceilings from [Resource reservations](../contracts.md#resource-reservations). The SDK MUST make the bounds configurable by the operator. Project composition callbacks and project settings MUST NOT raise them. |
| `commandContainment` | the containment the working environment declares for the current platform. `strong` only where it confirms that every descendant of a command stops; `processGroup` where it contains only the command's process group. Never inferred from the environment's name. |
| `confinesFiles` | from the working environment. False for the local one: it resolves paths against the project but does not refuse ones that lead outside it. True for the testing kit's memory environment, which has no other files. |
| `nestedToolCalls` | true only if the host and the Runtime path both run nested calls in the chosen placement. For a served Runtime the host decides from its own Runtime bridge, which settles nested calls; the plugin binding's `RuntimeSupports` has no flag for it, and no private wire field may stand in for one. |

The host enforces both queue policies. An in-process Runtime can supply them; `RuntimeSupports` in the plugin binding does not negotiate either policy.

The [shared scenarios](testing.md#the-shared-scenarios) and the ACP kit check these values.

## Sessions and turns

| Operation | Returns |
|---|---|
| `id` | the session id |
| `prompt(input, options?)` | a PromptResult, once the turn that takes this input ends or the input is settled without a turn |
| `promptStream(input, options?)` | the events of that turn as a stream, ending with its `turnEnded` event, or at once if the input is settled without a turn |
| `send(input, timing, options?)` | an InputReceipt, without waiting for any turn. `timing` is `now`, `steer`, `after` or `propose` ([Input](../contracts.md#input)). |
| `proposals()` | with `severalActors`, the parked proposals this actor may see |
| `release(inputId, timing, options?)` | takes a proposal with timing `now`, `steer` or `after`, or hands it back with `declined: true`; returns an InputReceipt. Requires `input`. |
| `withdraw(inputId)` | hands a proposal back, for its proposer or an actor with `input`. A second settlement of the same proposal raises `conflict`. |
| `cancel()` | cancels the running turn; returns the inputs handed back |
| `settings()` / `setSetting(key, value)` | the current settings / records a change. During a turn the change applies from the next turn, or is refused with `busy`, as the agent declares `settingsDuringTurn`. |
| `history(options?)` | the recorded entries, in order, as this actor may see them: the gated view, not the raw record |
| `fork(entryId?)` | a new Session branching from that entry, or from the current position |
| `moveTo(entryId, options?)` | moves the current position; `rewind: true` also restores files where the environment can |
| `erase(entryIds)` | an ErasureReport: `{ erased, pending, outOfReach }` as in [ACP](../bindings/acp.md#extension-methods). Repeating authorized targets reports progress; it does not erase again. |
| `commands()` / `runCommand(line)` | the commands available / runs one |
| `callTool(name, input)` | a ToolResult; a direct call by this actor, through every gate |
| `events(fromEntry?)` | every event in the session this actor may see, from the start or a cursor, then live |
| `waitIdle()` | waits until the running turn and every input already admitted have finished, without admitting input or closing the session |
| `lastTurn()` | the latest settled turn as a PromptResult, or no value if no turn has settled. Does not admit input or wait for a running turn. |
| `close()` | closes the session; cancels its work as [Jobs](../contracts.md#jobs) says |

`input` is a string or Content. `options` carries `key`, for safe retries ([input admission](../contracts.md#input)), and `actor`, to act as an actor other than the local one.

`prompt` admits its input with timing `now`, as ACP's `session/prompt` does ([Input admission](../bindings/acp.md#input-admission)). When the session is idle, the input starts a turn. When a turn is running, the input queues a new turn and `prompt` waits for that one, not the running one. Only `send(input, "steer")`, where the agent declares `inputDuringTurn`, puts input into a running turn.

A **PromptResult** has:

| Field | Type |
|---|---|
| `inputId` | the admission's id |
| `disposition` | `turn`, or `handled` or `handedBack` for an input settled without a turn ([Prompts](../bindings/acp.md#prompts)). The fields below are present only for `turn`. |
| `outcome` | `completed`, `cancelled`, `failed` with `error`, or `limit` with `limit` |
| `text` | the final answer's text, empty if none |
| `value` | the structured result, if the turn asked for one |
| `openToolCalls` | calls left open past the turn, by id |
| `usage` | Usage for the turn |
| `turnId` | the turn's id |
| `toolResults()` | the recorded ToolResults of the calls the model made in this turn, in call order, each with its tool `name` and a `text()` helper that joins its text content. Nested calls are not listed; they are in the history. |

An input that a hook handles, or that is handed back before a turn takes it, returns its disposition and no outcome. A failed turn is an outcome, not an error. `prompt` raises only when the input itself is refused, or when the agent cannot settle the turn at all, as with `lost` when the session's writer is interrupted.

A structured result is requested with `options.result`, a JSON Schema 2020-12 schema. A Runtime whose Provider returns only text parses the final answer as one JSON value, without removing surrounding markup. It submits the candidate to [`turn.result`](../contracts.md#hook-execution); a missing, malformed or schema-invalid value is refused with recorded feedback and retried under the usual rules. On completion `value` is the checked JSON value, including JSON null when the schema allows it.

## Events

`events` and `promptStream` deliver [standard events](../contracts.md#event) as a tagged union. Each event has `type`, `time`, the ids it concerns and `data`. Where [shared data](../bindings/data.md#output-events) names an output event, the SDK uses that name and payload; the rest are named after the specification's events:

| Group | Event types |
|---|---|
| Session | `sessionStarted`, `sessionEnded`, `sessionInterrupted`, `actorJoined`, `actorLeft` |
| Input | `inputAccepted`, `inputWithdrawn`, `inputHandedBack` |
| Turns and steps | `turnStarted`, `turnEnded`, `stepStarted`, `stepEnded` |
| Model output | `text`, `reasoning`, `toolInput`, `audio` |
| Tools | `toolCall` (requested), `toolStarted`, `toolOutput` (progress), `toolResult` (ended) |
| Questions | `questionOpened`, `questionAnswered`, `questionClosed`, `questionNoLongerAnswerable` |
| Jobs | `jobStarted`, `jobProgress`, `jobEnded` |
| History | `entry`, `positionMoved`, `entriesErased` |
| Changes | `settingChanged`, `pluginLoaded`, `pluginReplaced`, `pluginUnloaded` |
| Plugins | the plugin's own type, which contains a dot |

The agent emits every standard event for the actions and states it supports ([Following a session](../contracts.md#following-a-session)). `questionNoLongerAnswerable` is distinct from `questionClosed`: the first says no eligible actor can answer any more, the second that the question has a recorded closure. `sessionInterrupted` says this agent stopped writing the session, with `data.reason` `commitFailed` or `writerLost`; it is live only, never recorded, and a `prompt` or `promptStream` waiting on the session fails with `lost`. Reopen the session to recover its work ([Recovery](../contracts.md#recovery-and-repeating-work)).

Every event passes the [output gate](../contracts.md#the-output-gate) for the receiving actor first. Live model output is never history; `entry` reports what was kept.

A slow reader never blocks the agent. The SDK bounds each stream. If a reader falls behind, its stream ends with an error of code `lost` whose `data.fromEntry` is the id of the last kept entry delivered to it, or null if none was. `events(fromEntry)` replays kept entries strictly after that id, or from the start for null, then follows live events. Live deltas and other live-only events are not replayed ([Following a session](../contracts.md#following-a-session)).

## Questions

A question handler receives a **Question** and returns an **Answer**:

```
onQuestion(question: Question, context) -> Answer
```

| Question field | |
|---|---|
| `id`, `sessionId`, `kind` | `kind` is `approval`, `choice`, `text`, `link` or `secret` |
| `question`, `details`, `options` | what to show |
| `call` | for an approval: the exact tool call, name and input |
| `deadline` | when it closes, if timed |

An Answer is `allow` (approval), a value (choice, text, link), a secret value (secret) or `decline` with an optional reason. A decline is a tagged answer, not a reserved string: a text answer of `declined` is a value. A handler that raises or returns nothing declines. A secret value goes only to the credential store. The asker receives only the stored name, after activation is confirmed and the terminal answer is committed. Staging alone does not answer the question ([Secrets](../contracts.md#secrets)).

The handler can be set on `createAgent` for every session or on one session with `session.onQuestion`, which takes precedence for that session. `session.questions()` lists open questions and `session.answer(questionId, answer)` answers one later, for apps that show questions in their own UI.

While a handler is registered, the local actor is present to answer. With none, [approvals are refused](concepts.md#the-local-actor).

## Actors and rights

An embedded agent has the local actor, `user`. An app that serves several people adds actors:

| Operation | |
|---|---|
| `session.join(actor, grantedBy?)` | adds an Actor (`id`, `kind`, `rights`) |
| `session.leave(actorId)` | removes one |
| `session.as(actorId)` | a view of the session that acts for that actor: `prompt`, `send`, `answer` and the rest record both the acting identity and that actor, and are checked against their shared effective rights ([Authority](../contracts.md#authority)) |
| `session.setLimit(rights?)` | the [session limit](../contracts.md#limits-and-tenants) |

Rights are the specification's named rights (`watch`, `propose`, `input`, `answer`, `approve`, `tools`, `cancel`, `settings`, `erase`, `grant`, `jobs`, `delegate`, `administer`). An operation without a required right raises `forbidden`, as ACP does.

Authority comes from the app, which is the operator here. An Interface such as ACP authenticates its own actors; the SDK MUST NOT take an actor id from a client's request as proof of identity ([Security](../security.md#trust-boundaries)). A token on a WebSocket connection also [limits scope and rights](#the-agent).

## Plugins

A **Plugin** has:

| Field | |
|---|---|
| `name` | unique in the agent; stable, because history records it |
| `replaces` | items of its own that replace an earlier plugin's, as `runtime`, `working-environment`, `provider:<id>`, `tool:<name>` or `command:<name>` |
| `config` | the plugin's settings when it runs in the agent's process; `{}` if none |
| `setup(registrar)` | registers what the plugin provides, once, at load |
| `stop()` | optional; releases what it holds |

`setup` receives a **Registrar** and registers items with it. It runs once, before any session opens; it does no work for a session. `registrar.config()` is the plugin's settings: its `config` in process, or the `config` the agent sends in `plugin/initialize` when the plugin is served. A served plugin's program starts before its settings arrive, so anything that depends on them is registered in `setup`, not when the plugin value is built.

| Registrar operation | Registers | Servable |
|---|---|---|
| `tool(tool)` / `tools(source)` | one tool, or a tool source whose list can change | yes |
| `provider(provider)` | a Provider | yes, for request and response |
| `environment(environment)` | the working environment | yes |
| `runtime(runtime)` | the Runtime | yes |
| `on(point, handler, order?)` | a hook handler at a [core hook point](#hooks) | yes, except the points and answers marked |
| `command(name, description, handler)` | a command | yes, unless it uses a model or asks questions |
| `jobs(owner)` | that this plugin owns jobs, and how to cancel and resume them | yes |
| `historyStore(store)` | the history store | no: it has its own [binding](../bindings/history-http.md) |
| `credentialStore(store)` / `configuration(source)` | those parts | no |
| `interface(interface)` | an Interface | no |
| `defineHook(name, rule)` | a hook point this plugin owns, for other plugins. `rule` is `observe`, `gate`, `transform`, `collect` or `firstAnswer` ([Hook execution](../contracts.md#hook-execution)). | no |

A plugin is **servable** when everything it registers, and every context member its code uses, can cross the plugin binding. The SDK can then [serve it](placement.md#a-plugin-in-another-process). Otherwise it is **in-process only**.

Registrations are visible to the SDK; calls a function makes at run time are not. So an item whose code uses an [in-process-only context member](#contexts), or a model-using command, MUST say so when it is registered, with its `inProcessOnly` flag. `serve` refuses a plugin with any in-process-only registration or flagged item. An item visible before the settings arrive is refused before stdio opens. One registered in `setup`, which needs the settings, is refused by answering `plugin/initialize` with `not_supported`, naming the item, and no registration; `setup` is never run twice to check in advance. It fails with `not_supported`, names the item, and never serves the rest without it. A served plugin that calls an in-process-only member without the flag gets `not_supported` from that call. The testing kit's [`overWire`](testing.md#the-testing-kit) runs a plugin's tests over the wire too, so an unflagged call fails a test rather than a deployment.

A tool, a Provider or a working environment passed directly to `createAgent` is wrapped in a plugin named after it.

### Replacing a part

A plugin replaces an earlier plugin's item by registering its own item of the same kind and name and listing it in `replaces`. If no earlier plugin has that item, the item is simply added. `durableRuntime()` lists `runtime`; a sandbox plugin lists `working-environment`. Following the [registration rules](../bindings/plugin.md#starting-the-handshake), `createAgent` raises `invalid_composition` when:

- a `replaces` entry names an item the plugin does not register itself, or appears twice;
- two plugins register the same item and the later one does not list it: an unlisted collision, including a second Runtime or working environment;
- a process plugin lists an item that another process plugin registered.

## Contexts

A plugin reaches the agent only through the context passed to the call it is serving. Each context carries the work's identity, its cancellation and what that work may ask. The last column says whether a served plugin can use the member; each "yes" is a request the [plugin binding allows](../bindings/plugin.md#authority).

| Member | Available to | Over the wire |
|---|---|---|
| `sessionId`, `actorId` and work ids, where the work has them | all | the ids in that method's envelope: a served Provider request carries `sessionId` but no actor or step id; `command/run` carries the session and actor ids but no step id |
| `cancelled`: the language's cancellation signal | all | yes |
| `log(message)`: operator diagnostics, never shown to the model | all | yes, on stderr |
| `emit(type, data)`: a custom event, with a type containing a dot | all | yes |
| `history(cursor?)`: pages of the session's raw record | tool, hook, command, job owner | yes |
| `progress(content)` | tool, job | yes |
| `refuse(reason)`: ends the call as `refused` | tool | yes |
| `ask(question, wait?)` | tool | yes |
| `ask(question, wait?)` | command | in process only |
| `requestModel(request: ModelRequest) -> AssistantMessage`: one [auxiliary model request](#commands) using the session's current model | command with `usesModel` | in process only |
| `environment`: the session's working environment, scoped to this call: `read` and `write` of bytes, `list`, and `exec(command, { timeout })` returning exit code, output and whether it timed out, with output as progress for a tool call. A command has no `toolCallId`, so its exec output comes back only in the result. Relative paths resolve against the session's project; an operation the environment lacks raises `not_supported`. | tool, command | yes; an ignore-aware file walk, where offered, is in process only |
| `tools.list()`, `tools.call(name, input)`: [nested calls](../contracts.md#nested-calls) | tool | yes |
| `jobs.start(kind, detail, key?)` | tool, command | yes |
| `jobs.unfinished()`, `jobs.resume(job)` | `session.start` hook of a job owner | yes |
| `credential()`: the credential for this Provider | Provider | yes |
| `credential(name)`: a named credential | tool, Provider | in process only |

`history` is the raw record a loaded plugin may read ([Authority](../bindings/plugin.md#authority)), not an actor's gated view. A context is valid only until its call settles; using it afterwards raises `invalid_request`. A plugin that needs to act later starts a [job](#jobs); a Job handle stays valid until its job ends.

## Tools

A **Tool** has a definition and a function:

| Definition field | Default |
|---|---|
| `name`, `description` | required |
| `input` | required: a schema, written in the language's usual way ([Languages](languages.md#schemas)). It is the ToolDefinition's `parameters`, JSON Schema 2020-12. |
| `output` | none. A schema for `value`, sent as the ToolDefinition's `returns`. When set, the agent checks every completed result against it. |
| `readOnly`, `destructive`, `openWorld`, `safeToRepeat` | the [shared defaults](../bindings/data.md#tools): false, true, true, false. Each hint is sent exactly as set; the SDK does not derive one from another. |
| `parallel` | false |
| `callers` | `model`, `ui` and `plugin` |
| `presentation` | none |
| `inProcessOnly` | false; see [Plugins](#plugins) |

`input` and `output` are the SDK's names for the definition's `parameters` and `returns`. On the wire, in history and in every ToolDefinition the SDK exposes, they are `parameters` and `returns`. In a serialized ToolDefinition the four hints are members of `hints`; `parallel` and `callers` are top-level fields. The SDK checks a call's input against `parameters` before the function runs. Invalid input ends the call `failed` with a readable reason. After `tool.after`, if the result is `completed` and `returns` is set, the host requires a `value` and validates it. A missing or invalid value is a result processing error. The host commits a minimal safe result with the confirmed status, reports the error separately and fails the enclosing operation without redispatching the tool ([Settlement](../contracts.md#settlement)).

The function receives the input, already checked against the schema and converted to the language's type, and a [tool context](#contexts). What it returns becomes the ToolResult:

| The function | Result status | Content |
|---|---|---|
| returns text | `completed` | that text |
| returns Content | `completed` | that content |
| returns a value, with `output` set | `completed` | `value` is the value; content is its JSON text unless the tool gives content too |
| returns a ToolOutput `{ status?, content, value? }` | as given: `completed`, `failed`, `refused` or `outcomeUnknown` | as given |
| calls `refuse(reason)` | `refused` | the reason, which the SDK may wrap in a fixed wording |
| raises an error | `failed` | the error's message, which the SDK may wrap in a fixed wording |
| stops because `cancelled` fired | `cancelled` | that the call was cancelled |

One SDK MUST word a given tool's result identically in process and served; different SDKs MAY word diagnostics differently, so programs branch on the status, not the text. Every result that is not `completed` MUST say what failed or may have happened ([Tool result](../bindings/data.md#tools)); the SDK supplies the wording where the tool gives none. `notStarted` is the agent's to report, not a tool's.

**Questions from a tool.** `ask(question)` opens a question and waits for its answer. It returns:

| Kind | Returns |
|---|---|
| `approval` | `allow`, or a decline |
| `choice`, `text`, `link` | the answer's value, or a decline |
| `secret` | the credential name the value was stored under, or a decline. Never the value ([Secrets](../contracts.md#secrets)). |

A decline carries the reason, including a system closure such as `timeLimit` or `noLongerAnswerable`. `ask(question, { wait, then: "leaveOpen" })` lets the call stay open past its turn if no answer comes in time. It is allowed only where the agent declares `questionsOutlastTurns` and `lateAnswersStartTurns`; otherwise it raises `not_supported`. When the wait ends unanswered, `ask` raises a `LeftOpen` signal. A tool that does not catch it ends, and the SDK replies pending. The tool runs again from the top when the answer comes, so it MUST ask the same questions in the same order and cause no effect before them; asking again returns the recorded answer ([Questions](../contracts.md#questions)).

**Nested calls.** `tools.call(name, input)` asks the agent to run another tool as a nested call. It passes that tool's own gates and approval and returns its ToolResult. A nested call is never left open: if a gate would leave it pending, it is settled `refused`. Each SDK documents its nesting depth and refuses a call beyond it ([Nested calls](../contracts.md#nested-calls)).

A tool's input may also be given as a JSON Schema object instead of a type, for example to wrap a tool defined elsewhere; the SDK keeps its names, descriptions and required-field order as given.

A **tool source** is a set of tools whose list can change, such as an MCP server's. It provides `tools(sessionId?) -> Tool[]` and calls `changed()` when the list changes.

## Providers

A **Provider** has:

| Member | |
|---|---|
| `id` | unique in the agent; the first half of every ModelRef it offers |
| `models() -> ModelInfo[]` | the full current catalog. In process, call `changed()` after updating it to tell subscribers to read it again. |
| `supports` | `keepsState` and `safeToRepeat` ([Provider support](../bindings/plugin.md#the-host-asks-a-provider)) |
| `available() -> boolean` | optional: whether it can take requests now, for example whether it has credentials |
| `request(model, request, context) -> AssistantMessage` | makes one model request |
| `discardState(sessionId)` | optional, for a Provider that keeps state |

The [plugin binding](../bindings/plugin.md#the-host-asks-a-provider) has no Provider catalog notification. Before preparing a step, the host queries the served Provider's catalog and readiness with `provider/models` and `provider/available`. Do not send a private catalog notification.

`request` reports output as it arrives with `context.piece(type, delta, toolCallId?)`, then returns the complete AssistantMessage.

A model failure after the request is admitted, including credentials the model service rejects, is an AssistantMessage with stop `failed` and a ModelError whose `kind` is `temporary`, `contextTooLarge`, `credentials`, `refused` or `other`. A Provider may raise the language's error carrying a ModelError instead; the SDK turns it into that AssistantMessage, in process and over the wire alike. The SDK refuses an unknown model before the request is admitted, with `invalid_request` at the embedded and plugin Provider boundaries; the ACP Interface refuses an unknown model setting with ACP's `invalid_params`. After admission, an error raised without a ModelError is recorded as a failed AssistantMessage with kind `other`; it never turns a settled model attempt into an input error.

A Provider may return opaque `providerData` in a response. The SDK keeps it in the record, bound to that Provider's identity, and sends it only in a later request to the same Provider; it never appears in output or in a history projection for anyone else ([Content](../bindings/data.md#content)).

The Provider gets its credential through `context.credential()`; it never receives one in configuration. `request` and `discardState` are the SDK 0.1 Provider port. A Provider may keep state per session, declared with `keepsState`; the agent may call `discardState` to invalidate it. The core also allows a Provider to run tools itself, hold a live session or answer late ([Model request and response](../contracts.md#model-request-and-response)), but this port does not expose those modes, and a Provider registered through it cannot declare them.

The `openai()` and `anthropic()` constructors make API-key Providers for the Responses and Messages APIs, respectively. Their catalogs and reasoning settings follow the [shared API-key model table](api-key-models.md).

## Hooks

`on(point, handler, order?)` registers a handler at a hook point. `order` is `first`, `normal` or `last`. Handlers combine by the [core rules](../contracts.md#hook-execution). Each point has a typed payload and a typed answer; returning nothing passes.

| Point | Kind | Payload | Answer |
|---|---|---|---|
| `plugin.load` | gate | the plugin about to load and its origin | `allow`, or `refuse(reason)` |
| `session.start` / `session.end` | observe | the session, and whether it was reopened | none |
| `input` | transform | the input, its actor and timing | `change(content)`, or `handle()` to take it without a turn; in process only, `handle({ command })` to run a command instead |
| `turn.before` | collect | the input starting the turn | `add({ system?, context? })` |
| `turn.start` / `turn.end` | observe | the turn; at the end its outcome and result | none |
| `step.before` | transform | the prepared ModelRequest and model limits; in process, also history and usage | `change(request)`: context, offered tools, settings; in process, also the Provider-tool allowance |
| `step.after` | gate | the step's recorded response | `continue`, or `end(reason)`: a gate refusal, which ends the turn `failed` |
| `tool.before` | gate | the call and its definition | `allow`, `refuse(reason)`, `change(input)`; in process only, `pending(question)` |
| `tool.after` | transform | the call and its result | `change({ content?, value? })`; on the wire, a full transform of the payload with every other field unchanged |
| `model.failed` | first answer | the request and its ModelError | `retry(request?)`, or `stop` |
| `turn.result` | gate | the result and the expected shape | `accept`, or `refuse(feedback)` |
| `provider.request` | transform | the ModelRequest a Provider is about to send | `change(request)` |
| `provider.response` | observe | the complete response | none |
| `output` | gate | events about to reach a recipient | `redact(events)`, or `block` |

**In process only:** `session.prepare`, which runs when a session opens and before recovery, so a plugin can install per-session resources that `session.end` releases; the session's project and the callable tool definitions in the `turn.before` payload, for prompt building (a snapshot that grants no authority); `session.join` and `session.leave`; `provider.piece`, for each piece of a Provider's response; `pending` as an answer to `tool.before`; `handle({ command })` on `input`; history and usage in the `step.before` payload; and every point a plugin defines with `defineHook`. The [plugin binding](../bindings/plugin.md#from-core-hooks-to-wire-hooks) carries none of these. A served handler that needs history reads it through its context.

`pending(question)` does not wait. It records the question and leaves the call pending under the [question rules](../contracts.md#questions); the call continues in a later turn once the question is answered.

**Changes stay within their point.** The agent checks every answer. A `step.before` or `provider.request` change may narrow the offered tools or change their order, but MUST NOT add a tool or widen a definition beyond what the turn and current authority allow. An `input` change may change only the content; a `tool.after` change only the result's content and value.

**When a handler fails**, by raising or giving an answer its point does not allow, the result depends on the point's kind ([Hook execution](../contracts.md#hook-execution)):

| Kind | A failed handler |
|---|---|
| observe | is reported, and the operation continues |
| gate | counts as a refusal |
| transform, collect, first answer | fails the operation, naming the handler |

For `output`, a refused redaction withholds the output from that recipient ([The output gate](../contracts.md#the-output-gate)).

## Commands

`command(name, description, handler)` registers a command. The handler receives the argument text and a command context, and returns text for the actor or nothing. A command never starts a turn. The context names the session, the invoking actor and the session's project. A served command learns the project from [`host/session`](../bindings/plugin.md#what-a-plugin-may-ask-the-host), since `command/run` carries only the session and actor ids; its working environment calls use that project, not the one given at `plugin/initialize`. A command that uses a model MUST set `usesModel` and `inProcessOnly` at registration. A command that asks questions also remains in-process only. The [plugin binding](../bindings/plugin.md#the-host-asks-a-command) cannot carry model-using commands; `serve` refuses them with `not_supported` under the [registration rules](#plugins).

A handler registered with `usesModel` may call `context.requestModel(request)` one or more times before the command settles. It supplies a [ModelRequest](../bindings/data.md#models), not a model id or a Provider. The agent uses the session's current model and its Provider. There is no unscoped access to a Provider.

The agent requires the invoking actor's current `input` right and applies the same dispatch, persistence and metering rules as for a turn. It checks limits and charges usage to the session and its tenant. Each request passes through `provider.request`, `provider.response` and, where available, `provider.piece`, at the same points as an ordinary Provider request. The agent records each auxiliary `modelRequest` and `response`, including reported usage, under the command's `stepId` without a `turnId`. Each response names its request entry in `sources`. The request starts no turn and does not count toward `maxSteps`. The agent does not dispatch tool calls from the reply or authorize the Provider to run them. It returns the calls in the AssistantMessage to the handler. The agent does not automatically restart the command ([Commands](../contracts.md#commands)).

## Jobs

A plugin that starts work outliving a turn registers a **job owner**:

| Member | |
|---|---|
| `cancel(job, context)` | stops the job and ends it |
| `resume(job, context)` | optional: takes up an unfinished job after a restart |

`context.jobs.start(kind, detail, key?)` records a job and returns a **Job** handle with `progress(content)` and `end(outcome, result?, report?)`. A Job handle stays valid until its job ends.

A job that ends with `report: true` puts its result into the session as input. It starts a turn only where the agent declares `startsTurnsUnasked: jobReports`, which `jobReportsStartTurns` sets. Otherwise the report is parked until an actor releases it ([Jobs](../contracts.md#jobs)).

When a session reopens, the SDK calls the owner's `resume` for each of its unfinished jobs from that plugin's `session.start` handling, before the hook is answered, as the [binding requires](../bindings/plugin.md#jobs). It does this in process and over the wire alike. A job the owner does not resume stays unfinished.

## The other parts

These are written rarely. Each is an interface a plugin implements. Its operations are the binding's methods for that part, with the binding's parameters and results; for parts with no binding, the [Interactions](../contracts.md#interactions) table.

| Part | Operations | Defined by |
|---|---|---|
| Working environment | `read`, `exists`, `write`, `exec`, `list` (optional), `savePoint`, `checkPoint`, `restorePoint`, `sessionEnded`, and its registration: `containment`, `platforms`, `points`, `confinesFiles` | [The host asks the working environment](../bindings/plugin.md#the-host-asks-the-working-environment). A missing file is `not_found`. An environment without `list` raises `not_supported` and the agent treats listing as absent. |
| History store | `create(sessionId, metadata)`, `acquire`, `renew`, `release`, `append`, `read`, `list`, `erase` | [History service](../bindings/history-http.md). `create` is the binding's `PUT` of session metadata, which omits `id`; `read` and `list` take the binding's cursor and limit. A store declares its lease TTL and whether it is persistent. An `acquire` refused because another writer holds the session raises `held` with `retryAfterMs`. An `append` skips an entry JSON-equal to one already kept under its id; a different entry under a kept id raises `conflict`. A store that can lose writer access, for example when renewal fails, tells the agent as soon as it knows, even with no write in progress, so the agent can [interrupt the session](../contracts.md#recovery-and-repeating-work) at once rather than at its next write. |
| Credential store | `read`, `stage`, `lookupStaged`, `activate`, `discard` | [Asking the credential store](../contracts.md#asking-the-credential-store) and [Secrets](../contracts.md#secrets) |
| Configuration | `settings(project)`, `trusted(project)` | [Configuration and trust](../contracts.md#configuration-and-trust) |
| Runtime | `declaration`, `runTurn`, `resumeTurn`, `continueOpenCalls` | [The host asks the Runtime](../bindings/plugin.md#the-host-asks-the-runtime). `resumeTurn` receives the interrupted checkpoint, including the last answered step and any committed `step.after` decision, exactly as the binding defines it. The context offers the [Runtime callbacks](../bindings/plugin.md#runtime-callbacks). |
| Interface | `start(agent)`, `stop()` | The only part given the whole Agent. It authenticates its own actors. |

## Errors

Every SDK error has a `code`, a `message` for people and optional `data`. Programs branch on `code` only.

The SDK has two surfaces, and each uses the codes of the binding it mirrors:

- **What an app calls**, the Agent and Session operations, uses the [ACP codes](../bindings/acp.md#errors), so `serveAcp` passes them through unchanged.
- **What a plugin's context calls**, and the errors a plugin raises to the agent, use the [plugin binding codes](../bindings/plugin.md#errors-and-connection-loss), so a plugin sees the same codes in process and served.

| Code | Surface | When |
|---|---|---|
| `invalid_params` | app | a malformed argument or invalid option value |
| `invalid_request` | plugin; app for JSON depth | bad arguments, an unauthorized or out-of-scope context call, a stale context, or an operation in the wrong state |
| `invalid_composition` | `createAgent` | parts that cannot work together; the SDK's own code |
| `forbidden` | app | the actor lacks a required right |
| `not_found` | both | a named session, entry, file, point, tool or question does not exist |
| `not_open` | app | the session is not open |
| `busy` | both | conflicts with current work, close or recovery (app), or no capacity for new work |
| `unavailable` | app | a required pending-erasure check or coordination could not be established |
| `held` | app | another writer holds the session's history; `data.retryAfterMs` says when to retry |
| `conflict` | app | an invalid transition, such as a proposal already released, or an entry that conflicts with a kept one |
| `cancelled` | both | the operation was cancelled |
| `not_supported` | both | this agent, part or placement does not support it |
| `turn_limit` | plugin | a limit stopped the work; `data.limit` names it |
| `unknown_handler` | plugin | no such registered handler at this hook |
| `withheld` | app | the output gate withheld the reply |
| `result_too_large`, `message_too_large` | both | a result or message did not fit its limit |
| `lost` | both | a part, connection or cleanup was lost; the outcome of the work may be unknown |
| `internal` | plugin | any other failure |

A refused tool call or a failed turn is not an error: it is a ToolResult status or a turn outcome.

## Data types

The SDK's data types are the [shared data](../bindings/data.md) shapes: Content and its parts, Message, ModelRef, ModelInfo, ModelRequest, AssistantMessage, ModelError, Usage, ToolDefinition, ToolCall, ToolResult, InputRequest, Answer, Actor, HistoryEntry, Outcome, Declaration and the rest. Each SDK MUST:

- use the shared field names, converting only their case where the language requires and serializing them unchanged;
- keep unknown fields and unknown content parts when it stores or relays a shape;
- represent each closed set of values, such as ToolStatus or a ModelError's kind, as the language's enumeration, with a way to keep an unknown value where shared data says to.

The types will be generated from shared data's JSON Schema once it has one.

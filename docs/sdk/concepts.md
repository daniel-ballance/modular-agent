# Concepts

What a developer sees, what stays hidden until they need it, and what an agent does with no configuration. The names are the [glossary's](../../GLOSSARY.md); the API uses them in each language's casing.

## What a developer sees

| Concept | What it is in the SDK | In the specification |
|---|---|---|
| **Agent** | The object a developer creates and talks to. It holds the parts and the sessions. | The Harness plus a chosen set of plugins |
| **Session** | A conversation with its history, settings and actors. Created, opened, forked and closed through the Agent. | [Session](../contracts.md#session) |
| **Turn** | What one input starts: model requests and tool calls until the agent has an answer. A developer waits for its outcome or follows its events. | [Turn input and turn outcome](../contracts.md#turn-input-and-turn-outcome) |
| **Event** | Something that happened, delivered to whoever follows the session. Typed; never changes what happened. | [Event](../contracts.md#event) |
| **Question** | Something the agent needs an actor to answer, such as an approval. The developer's code answers it. | [Input request and answer](../contracts.md#input-request-and-answer) |
| **Plugin** | A named bundle of parts and behavior added to an agent. | [Plugin](../../GLOSSARY.md) |
| **Tool** | A function the model or a plugin can call, with a name, a description and typed input. | [Tool definition](../contracts.md#tool-definition) and [tool source](../contracts.md#harness-and-tool-source) |
| **Provider** | Reaches models: lists them and makes requests. | [Runtime and Provider](../contracts.md#runtime-and-provider) |
| **Hook** | Code that runs at a named point, such as before a tool call, to watch, change or refuse. | [Hook points](../contracts.md#hook-points) |
| **Command** | A named operation an actor runs directly, such as `/compact`. | [Commands](../contracts.md#commands) |

These are enough to build an agent, add tools and write most plugins.

## What appears when it is needed

| Concept | When a developer meets it |
|---|---|
| **Working environment** | When a tool reads files or runs commands. It is in every tool's context. Replacing it, for a sandbox or a remote machine, is a plugin. |
| **History** | When reading what a session recorded. Entries use the [standard kinds](../bindings/data.md#standard-kinds). Writing a store is a plugin. |
| **Runtime** | When choosing durability. Writing one is rare and advanced. |
| **Interface** | When the agent should be driven from outside, over ACP or a terminal. |
| **Actor and rights** | When more than one person or program takes part in a session, or when the app needs to limit what someone can do. |
| **Job** | When a plugin starts work that outlives a turn, such as a subagent or a background command. |
| **Credential store** | When a Provider or tool needs a secret from somewhere other than an environment variable. |
| **Declaration** | When the app needs to know what this agent supports, for example whether it can continue a turn after a restart. |
| **Tenants, limits and the output gate** | When running agents for several customers or users with different rights. |

Every rule behind these concepts holds whether or not the developer has met it. Hiding a concept means choosing its safe default, not skipping its rules.

## Defaults

An agent built with nothing but a Provider behaves like this:

| Choice | Default | Why |
|---|---|---|
| Project | The process's current directory | Where a developer expects a tool to look |
| Durability | `ephemeral`: history in memory, transient Runtime | A library should not keep anything unasked. Command bookkeeping that the local environment needs goes in a scratch folder removed with the agent. See [Durability](placement.md#durability). |
| Working environment | Local, rooted at the project. Relative paths resolve against the project; it does not refuse paths that lead outside it, and declares `confinesFiles: false`. Commands get the containment its command supervisor provides on this platform, which it declares. Local does not mean sandboxed. | Every tool context has one; the declaration is honest about what it does not confine |
| Credential store | Environment variables, by the names each Provider documents | `OPENAI_API_KEY` works without setup |
| Approval | No approval plugin | The app chose its tools. Naming a policy loads the plugin and records that policy ([Approval policy](../contracts.md#approval-policy)). |
| Plugin host | No | An embedded agent does not start programs named in its environment unless the app enables plugin hosting or supplies process plugins or plugin services. See [Placement](placement.md#a-plugin-in-another-process). |
| Actors | One local actor, described below | |
| Questions | Answered by the app's handler if it registered one | See below |
| Model | None. The developer names one, or the agent uses the only model its Providers offer. | Picking a model silently would pick a cost |

### The local actor

Every session in an embedded agent has one actor the app speaks for:

- its id is `user` and its kind is `user`, the id the experiment's builds already used for the local person;
- it holds every right the deployment allows;
- it is present whenever the app has a question handler registered.

This keeps the specification's rule that an approval with no present, eligible answerer is [refused rather than left waiting](../contracts.md#approval-policy). This is the default. The proposed [waiting approval](api.md#questions) lets a kept session opt in to ending the turn with the call unstarted. The local actor can be present for the answer later. Other questions close as the [question rules](../contracts.md#questions) say.

An Interface, such as ACP, brings its own authenticated actors. An app with several users adds actors to sessions itself; see [Actors](api.md#actors-and-rights).

## What the SDK includes

Each SDK ships at least one implementation of every part the specification names, and every binding:

| Part | Implementations every SDK ships |
|---|---|
| Runtime | transient; durable |
| History store | memory; files; the history HTTP client; the history service |
| Working environment | local |
| Provider | OpenAI Responses API and Anthropic Messages API, by API key; a scripted Provider for tests |
| Tool sources | the file and command tools (`read`, `write`, `edit`, `exec`, `find`, `list`); MCP servers from configuration, skipping one that cannot start with a warning rather than failing the rest, and MCP servers an ACP client attaches to its session |
| Interfaces | ACP on stdio |
| Plugin binding | loading a plugin from another process; serving a plugin as a program |
| Credential store | environment variables; a file readable only by its owner |
| Configuration | settings files and project trust |
| Feature plugins | approval; questions; context compaction and its `/compact` command; model selection; subagents; guardrails |

**Not in the SDK** are product features the specification does not describe: Agent Skills, a code tool, subscription sign-in for Providers, a line-based CLI or terminal UI, and prompts tuned for a particular use. They belong to a [reference implementation](../../GLOSSARY.md), built on the SDK's public API like any other developer's agent.

The line is the specification. If a feature is a part or rule the specification names, the SDK has it. If not, a reference implementation does.

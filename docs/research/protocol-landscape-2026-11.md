# Protocol landscape, checked 2026-11-14

These are facts about the outside protocols, checked against primary sources (official specs, changelogs and spec repositories, partly through Context7) on 2026-11-14. The ACP section was added on 2026-11-16.

Under [ADR 0010](../adr/0010-describe-parts-not-wiring.md) we read these protocols for how they divide the work between parts, not as wiring we must match. These protocols change quickly, so recheck before relying on a detail. "Relevance" is our interpretation, not the source's.

## MCP (Model Context Protocol)

- **Current version: 2026-07-28**, released as final on 2026-07-28. `modelcontextprotocol.io/specification/latest` redirects to it.
- **Stateless core.** The `initialize` handshake and the `Mcp-Session-Id` header are gone. Each request carries its own protocol version, client information and capabilities in `_meta`. An optional `server/discover` call exists. Servers that need state across calls mint explicit handles and pass them as tool arguments.
- **Multi Round-Trip Requests (MRTR)** replace server-initiated elicitation, sampling and `roots/list`. The server answers `resultType: "input_required"` along with what it needs, and the client retries the original call with the answers in `inputResponses`.
- **Sampling, Roots and Logging are deprecated** (SEP-2577). They are guaranteed to keep working for at least twelve months.
- **Extensions framework:** an `extensions` field in the capabilities. Tasks moved out of the core into `io.modelcontextprotocol/tasks`, which uses polling via `tasks/get` and adds `tasks/update`.
- **Trace context:** conventions for `traceparent`, `tracestate` and `baggage` in `_meta` (SEP-414).
- Required `Mcp-Method` and `Mcp-Name` HTTP headers; cache hints (`ttlMs`, `cacheScope`) on list results; authorization hardening.
- **Relevance:** MCP is a driven adapter, one kind of tool source. Its move to stateless operation and MRTR is prior art for the "ended, then resumed" model of suspension. The `_meta` trace context is precedent for putting trace context on every message.
- Sources: <https://blog.modelcontextprotocol.io/posts/2026-07-28/>, <https://modelcontextprotocol.io/specification/2026-07-28/changelog>

## MCP Apps

- An **official MCP extension**, ID `io.modelcontextprotocol/ui`. The stable spec is dated 2026-01-26; a draft is in development.
- How it works: a tool's *definition* links to a UI resource through `_meta.ui.resourceUri` (a `ui://...` address). The host fetches that resource and renders it in a sandboxed iframe. The host passes tool data to the UI, and **the UI can call other tools through the host.** The tool still works for clients that only show text.
- Supported by ChatGPT, Claude, VS Code, Goose, Postman and others.
- **Relevance:** tool-definition metadata must survive the trip from the tool source to the Interface. UI-initiated tool calls happen outside any turn (open question [Tool calls outside a turn](../open-questions.md#tool-calls-outside-a-turn)).
- Source: <https://apps.extensions.modelcontextprotocol.io/api/>

## AG-UI (Agent-User Interaction Protocol)

- **1.0 is released**, the first version with a normative specification. The schema is the single source of truth, and SDKs are generated from it. There are HTTP and HTTP + Protobuf bindings.
- **Events:**
  - run lifecycle: `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`; `STEP_STARTED`, `STEP_FINISHED`
  - text messages: `TEXT_MESSAGE_*`
  - tool calls: `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`, `TOOL_CALL_RESULT`
  - state: `STATE_SNAPSHOT`, `STATE_DELTA`, `MESSAGES_SNAPSHOT`
  - activity: `ACTIVITY_SNAPSHOT`, `ACTIVITY_DELTA`
  - reasoning: `REASONING_*`, including `REASONING_ENCRYPTED_VALUE`
  - subagents: `SUBAGENT_STARTED`, `SUBAGENT_FINISHED`, `SUBAGENT_ERROR`
  - escape hatches: `RAW`, `CUSTOM`
- **Interrupts:** `RUN_FINISHED` carries an optional `outcome` (success, `interrupt` or `cancelled`). A later `RunAgentInput` answers the interrupt with `resume` entries (an interrupt ID, a status of resolved or cancelled, and a payload).
- **Frontend tools:** a run that stops on a frontend tool call finishes as a success, and may list the unanswered calls in `pendingToolCallIds`.
- **Unknown versus malformed:** a malformed known value is fatal. Unknown events are dropped, and unknown fields on a known event are stripped before application code sees them; open extension data, such as `CUSTOM` and `RAW` events, is kept ([processing](https://docs.ag-ui.com/spec/1.0/basic/processing.md), last modified 2026-09-17; corrected 2026-11-22 after the [round 2 pressure test](../pressure-test/round-2/rung-4-maximal.md) found the earlier wording wrong).
- Tool results can carry content parts. Token usage can appear on `RUN_FINISHED` and `RUN_ERROR`. The protocol version travels in-band. Capabilities can be declared, but the stream itself is authoritative.
- **Relevance:** the closest existing protocol to our Interface ↔ Harness boundary for UIs. Its thread, run and step map onto our session, turn and step, but AG-UI's "step" is not necessarily a model call.
- Sources: <https://docs.ag-ui.com/spec/1.0/changelog>, <https://github.com/ag-ui-protocol/ag-ui>

## A2A (Agent2Agent)

- **v1.0**, now under the Linux Foundation. v1.0 made breaking changes from v0.3: enum values are now `TASK_STATE_*` and `ROLE_*`, and stream events are wrapped as `statusUpdate` or `artifactUpdate`.
- **Task states:**
  - `SUBMITTED`, `WORKING`
  - terminal: `COMPLETED`, `FAILED`, `CANCELED`, `REJECTED`
  - "interrupted": `INPUT_REQUIRED`, `AUTH_REQUIRED`
- **Push notifications (webhooks):** the agent POSTs a `StreamResponse` (a task, message, status update or artifact update) to the configured URL with the configured authentication. Delivery is at least once, so clients should handle duplicates.
- **Agent Card:** name, description, skills, capabilities (streaming, push notifications, extensions by URI) and `supportedInterfaces`. Each interface pairs a URL with a `protocolBinding` (`JSONRPC`, `GRPC` or `HTTP+JSON`, open to others) and a `protocolVersion`.
- **Relevance:** A2A works on both sides. On the driving side, other agents call ours. On the driven side, another agent is a tool source. It also covers outbound webhooks. "Interrupted" task states are prior art for the "paused in place" model of suspension. Its pairing of each interface with a binding keeps what is exchanged separate from how it travels.
- Sources: <https://a2a-protocol.org/latest/specification/>, <https://a2a-protocol.org/latest/whats-new-v1/>

## ACP (Agent Client Protocol)

Checked 2026-11-16 against <https://agentclientprotocol.com> (its `llms.txt` index, the v1 and v2 protocol pages, the v2 draft announcement, and the RFDs named below).

- **What it is:** a protocol from Zed that connects a **Client** to a coding **Agent** through interactive sessions. The Client is usually an editor, but can be any UI, or another agent. It is modelled on LSP, using JSON-RPC 2.0, and the Client usually starts the Agent as a subprocess and talks over stdio. **v1 is stable. v2 was published as a draft on 2026-07-20.** The Rust and TypeScript SDKs reached 1.0 on 2026-06-25.
- **Not the same as** IBM BeeAI's "Agent Communication Protocol", which merged into A2A in 2025.
- **How the work is divided:**
  - The **Agent runs tool calls itself** and reports them to the Client.
  - The Client passes the user's MCP server settings to the Agent, which **connects to those MCP servers directly**.
  - The **Client owns the user and the environment.** It answers permission requests, can ask the user structured questions (elicitation), and can offer the Agent file system and terminal access.
- **Turn (v1):** `session/prompt` starts a turn. The Agent streams `session/update` notifications: message and reasoning chunks, tool calls and their status (`pending`, `in_progress`, `completed`, `failed`), plans, usage, compaction and notices. The turn ends with a stop reason: `end_turn`, `max_tokens`, `max_turn_requests`, `refusal` or `cancelled`.
- **Permission:** the Agent asks `session/request_permission` with options of four kinds: `allow_once`, `allow_always`, `reject_once` and `reject_always`. **The Agent stores remembered decisions and decides their scope.** The Client may answer automatically from user settings.
- **Cancellation:** the Client sends `session/cancel` and must answer any pending permission requests as cancelled. The Agent stops its work and ends the turn with the `cancelled` stop reason.
- **v2, "moving beyond the turn":**
  - A prompt's response now arrives when its message is accepted into the conversation, not when the work ends. This makes room for queueing, steering, and work the user did not start.
  - The Agent reports foreground state as `running`, `requires_action` (blocked on the user) or `idle`, with a stop reason.
  - Background work is session-owned work that runs independently of foreground work: tool calls, terminals and subagent sessions that outlive the foreground work. Each state update lists it, and each item can be cancelled on its own. A finished background task can start new foreground work. (This is from the background-work RFD, part of the v2 draft.)
  - Messages, tool calls, plans and terminals are entities with stable IDs, updated by patches and chunks.
  - Permission requests have their own title and an extensible subject, so they are no longer tied to a tool call.
- **RFDs (proposals) worth knowing:**
  - **Proxy chains:** components that sit between Client and Agent and intercept or transform messages, as an extension mechanism in front of the Agent. MCP is the matching mechanism behind it.
  - **Subagent sessions:** each child an Agent creates gets its own session ID. The parent can message the same child again after earlier work finishes.
  - **Configurable LLM providers:** a Client can list, set and disable the Agent's model providers (`providers/list`, `providers/set`, `providers/disable`).
- **Who uses it:** DeepSeek Harness serves ACP for automation and uses it to run subagents out of process (see the [DeepSeek Harness reference](deepseek-harness-reference.md#wire-protocols-and-subagents)).
- **Relevance:**
  - **An ACP Client is an Interface,** and our whole system plays ACP's Agent, so ACP's Agent covers our Harness and Runtime together. When our agent drives another agent through ACP, that agent is a tool source.
  - It is the closest outside model for an interactive Interface (open question [The agent from outside](../open-questions.md#the-agent-from-outside)). Its `requires_action` state is "paused in place" (open question [Waiting for the user](../open-questions.md#waiting-for-the-user)), and its background work bears on open question [Work outside a turn](../open-questions.md#work-outside-a-turn).
  - Its direct MCP connections are the opposite of routing every tool call through the Harness (open question [Direct tool access](../open-questions.md#direct-tool-access)).
  - Client-configured providers fit [ADR 0005](../adr/0005-provider-handles-from-the-harness.md): the Interface supplies provider settings, and the side that owns them makes the model calls.
- Sources: <https://agentclientprotocol.com/get-started/architecture>, <https://agentclientprotocol.com/get-started/related-protocols>, <https://agentclientprotocol.com/protocol/v1/overview>, <https://agentclientprotocol.com/protocol/v1/prompt-turn>, <https://agentclientprotocol.com/protocol/v1/tool-calls>, <https://agentclientprotocol.com/protocol/v2/overview>, <https://agentclientprotocol.com/protocol/v2/prompt-lifecycle>, <https://agentclientprotocol.com/announcements/acp-v2-draft>, <https://agentclientprotocol.com/rfds/v2/background-work>, <https://agentclientprotocol.com/rfds/proxy-chains>, <https://agentclientprotocol.com/rfds/subagents>, <https://agentclientprotocol.com/rfds/custom-llm-endpoint>

## A2UI (Agent-to-User Interface)

- A declarative UI format: the agent sends component descriptions and data, not executable code. **v0.9.1 is the current release; v1.0 is a release candidate**, adding client-to-server `actionResponse` and action IDs.
- v0.9 messages: `createSurface`, `updateComponents`, `updateDataModel` (JSON Pointer paths) and `deleteSurface`. Each carries a `version` field.
- It does not depend on a particular transport. Over A2A it travels as a data part typed `application/a2ui+json`; it also runs over AG-UI or WebSockets.
- **Relevance:** a content format carried inside messages, not a boundary of its own. The Runtime must pass it through intact.
- Source: <https://a2ui.org/>

## OpenTelemetry GenAI semantic conventions

- **Moved** to their own repository, `open-telemetry/semantic-conventions-genai`. The pages in the main semconv repository now only point there. **The status is still Development**, not stable.
- `gen_ai.operation.name` values include `chat`, `generate_content`, `text_completion`, `embeddings`, `retrieval`, `execute_tool`, `create_agent`, `invoke_agent` and `invoke_workflow`.
- The agent spans are create agent, invoke agent (client and internal), a **plan** span, and execute tool. `gen_ai.conversation.id` is described as "conversation (session, thread)". The repository also covers MCP conventions.
- **Relevance:** `invoke_agent`, `chat`, `execute_tool` and `conversation.id` map to turn, model attempt, tool call and session. See the [follow-up research](opentelemetry-genai.md) and the [proposed Harness instrumentation](../telemetry.md).
- Sources: <https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md>, <https://github.com/open-telemetry/semantic-conventions-genai>

## What these protocols have in common

- **Three nested levels of work** in each of them (see [how units of work line up](README.md#how-units-of-work-line-up)).
- **Messages are kept separate from bindings:** A2A's `protocolBinding`, AG-UI's two bindings, MCP's transports.
- **Suspension is built into the protocol** in A2A, ACP, AG-UI and MCP, but in two different models (open question [Waiting for the user](../open-questions.md#waiting-for-the-user)). A2A and ACP pause in place, while AG-UI and MCP end and resume.
- **Forward compatibility** comes from extensions identified by URI (A2A, MCP) and from dropping unknown content rather than failing (AG-UI), so anything without an AG-UI equivalent must travel in its extension events.
- **Moving away from hidden connection state:** MCP went stateless, and AG-UI resumes in a new run.
- **Work is outgrowing the turn:** ACP v2 separates accepting a prompt from finishing the work, and tracks background work at the session level.

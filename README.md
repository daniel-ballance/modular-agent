# Modular Agent

A description of an AI agent built from parts that can each be swapped out and studied on its own. A small **Harness** holds everything together, and every feature is a **plugin**, including the part that runs the agent loop.

The description says **what** the system does: its parts, what each is responsible for, what passes between them, and what must always hold. It does not say **how** they are built or wired. It should give enough detail to build the agent in one process, as separate processes talking over RPC, or as services over a network.

**Status:** a first implementation exists in `packages/`: TypeScript in one process, with the vanilla Pi plugin set, a durable Runtime that can be swapped in, subagents in a transient and a durable variant, a full-screen terminal UI, an ACP Interface that T3 Code can drive, plugins that run in other processes over JSON-RPC, and parts that run as HTTP services. See [Building it](docs/build-notes.md). Pi is the reference implementation. DeepSeek Harness, Pydantic AI and T3 Code are further prior art.

## Reading order

1. [Architecture](docs/architecture.md): purpose, goals, the parts and their responsibilities, and the guarantees.
2. [Contracts](docs/contracts.md): what passes between the parts, the answers each interaction can get, and the states things move through.
3. [Scenarios](docs/scenarios.md): the parts working together in seventeen situations, from a simple request to two people sharing a session and a host driving the agent.
4. [Status](docs/status.md): which claims the code proves, and which are still on paper.
5. [Open questions](docs/open-questions.md): what is still undecided, with the five worth deciding first.

## Reference

| File | What it holds |
|---|---|
| [GLOSSARY.md](GLOSSARY.md) | The vocabulary. Definitions only. |
| [docs/adr/](docs/adr/) | Decision records, with an index of which still stand. |
| [docs/examples/](docs/examples/) | Existing agents described in our terms. [Vanilla Pi](docs/examples/vanilla-pi.md), and [two durable agents](docs/examples/durable-agents.md): Pi Durable and Pydantic AI on a durable engine. |
| [docs/research/](docs/research/) | Notes on other systems and protocols, and a map of how each fills our parts. |
| [docs/pressure-test/](docs/pressure-test/) | The test of our assumptions against Pi, agent frameworks, T3 Code and an everything-at-once system, and what changed as a result. |

## Acceptance test

The description is good enough when all of these hold:
- Existing agents (Pi, DeepSeek Harness, Pydantic AI, Tau, PiG) can each be described in its terms.
- A transient Runtime and a durable Runtime both fit the same description.
- An agent in one process and one split across services could both follow it unchanged.
- A host such as T3 Code could drive it as it drives Pi today.
- Every scenario can be told using only the parts and guarantees it defines.
- A review finds nothing that would break a plugin or a host when one implementation is swapped for another.

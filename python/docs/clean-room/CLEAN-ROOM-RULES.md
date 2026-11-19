# Modular Agent in Python

This repository builds the agent described in `docs/` and `GLOSSARY.md`, in Python, with plugins that can run in other processes. It is one of three independent builds from the same description, made to find out whether the description is enough to build from. `ACCEPTANCE.md` says what to build. `PROGRESS.md` says where the work is. `GAPS.md` is the most important thing you write.

## The description is the spec

- Build from `docs/` and `GLOSSARY.md`. The description says what the parts do and what passes between them, not how. Every API, type, file format and protocol here is yours to design from it.
- Where the description is silent, ambiguous, contradictory or wrong for your build, decide, carry on, and log it in `GAPS.md`. Don't edit `docs/`: they are a frozen snapshot (`docs/SNAPSHOT`).
- Each gap entry gives: where in the docs; what was missing or unclear; what you chose; and whether two builds that chose differently would break a plugin or a host. That last question is the "swap test" (`docs/adr/0010-describe-parts-not-wiring.md`). If they would, the description needs to say more; if not, it rightly leaves it to the builder.

## Clean room

This build must not learn from the other builds of this description.
- **Don't read** `~/Code/modular-agent`, `~/Code/modular-agent-rs`, `~/Code/modular-agent-py` or `~/Code/modular-agent-go` (except this repository), or `~/.modular-agent`.
- **You may read** this repository; public documentation and the source of libraries you use; Pi and its packages in `~/Code/pi-packages` and `~/Code/_ref/pi`; and the other prior art in `~/Code/_ref` (T3 Code, Pydantic AI, DeepSeek Harness). The description is based on Pi, so reading Pi is fair.

## Models and keys

- **Inference for this build uses only: `claude-haiku-5-5` (Haiku 5.5), through the Claude Code signed in on this machine, driven by the Claude Agent SDK.** No other model, for any real run.
- There is no API key. The Provider reaches Claude through the local Claude Code login, as Pi's `claude-subscription` package does (`~/Code/pi-packages/packages/claude-subscription`: read its README first). Claude Code is only the transport. Its own tools, settings, hooks, memory and MCP servers are off; the agent's tools are offered to it with their exact schemas; a tool call ends the model request, and the agent's Runtime runs the tool. Because a Claude Code process keeps the conversation, this Provider keeps state: declare it, and make erasure, moving the position, forking and compacting start it again from what the agent sends.
- Never print a key, put it in a file in this repository, pass it on a command line, or commit it. Read it from its file at run time.
- Tests run offline, with a fake Provider. Keep real runs few and short.

## Binding: plugins in other processes

Any plugin can run in a process of its own, chosen when the agent starts, without changing the plugin. Design the protocol between processes yourself. Milestone 5 shows that:
- the whole test suite passes with the Runtimes, the file tools, the working environment and the MCP plugin each in its own process, and again in one process;
- a test runs with only the Harness in the test's process, the Provider included among the plugins moved, with streamed output crossing processes;
- cancelling a turn stops a `bash` command two processes away;
- when a plugin's process dies, calls waiting on it fail with a clear result, the turn carries on, and the Harness reports the problem;
- a real run works with the Provider, Runtime, tools and working environment each in its own process.

## Working rules

- Python 3.13 is pinned with mise in `mise.toml`. Use uv for the project and its dependencies, with a package per part, so a part can be swapped by installing a different package. Use the official `claude-agent-sdk`, ACP and MCP Python libraries.
- You may install whatever toolchains, libraries and dev tools the build needs.
- Commit to local git after each chunk of work, with a clear message. There is no remote.
- Keep `PROGRESS.md` current: the milestone status, how to build and run the tests, the real runs done, and what comes next. The next session starts from it with no other memory.
- Write docs in plain English. No em dashes.
- **Processes:** nothing else runs on this machine, but never kill by a pattern that could match your own shell (no `pkill -f`). Kill by PID. Tests must leave no processes behind.
- Stop at the end of the milestone you were given, and report as `ACCEPTANCE.md` says.

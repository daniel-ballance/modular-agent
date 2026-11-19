# Modular Agent in Go

This repository builds the agent described in `docs/` and `GLOSSARY.md`, in Go, with parts that run as services. It is one of three independent builds from the same description, made to find out whether the description is enough to build from. `ACCEPTANCE.md` says what to build. `PROGRESS.md` says where the work is. `GAPS.md` is the most important thing you write.

## The description is the spec

- Build from `docs/` and `GLOSSARY.md`. The description says what the parts do and what passes between them, not how. Every API, type, file format and protocol here is yours to design from it.
- Where the description is silent, ambiguous, contradictory or wrong for your build, decide, carry on, and log it in `GAPS.md`. Don't edit `docs/`: they are a frozen snapshot (`docs/SNAPSHOT`).
- Each gap entry gives: where in the docs; what was missing or unclear; what you chose; and whether two builds that chose differently would break a plugin or a host. That last question is the "swap test" (`docs/adr/0010-describe-parts-not-wiring.md`). If they would, the description needs to say more; if not, it rightly leaves it to the builder.

## Clean room

This build must not learn from the other builds of this description.
- **Don't read** `~/Code/modular-agent`, `~/Code/modular-agent-rs`, `~/Code/modular-agent-py` or `~/Code/modular-agent-go` (except this repository), or `~/.modular-agent`.
- **You may read** this repository; public documentation and the source of libraries you use; Pi and its packages in `~/Code/pi-packages` and `~/Code/_ref/pi`; and the other prior art in `~/Code/_ref` (T3 Code, Pydantic AI, DeepSeek Harness). The description is based on Pi, so reading Pi is fair.

## Models and keys

- **Inference for this build uses only: `claude-haiku-5-5` (Haiku 5.5), through the Anthropic API.** No other model, for any real run.
- The Anthropic API key is in `~/.config/modular-agent-experiment/anthropic.key`. Only the model gateway reads it (milestone 5); until then, the Provider in the agent does.
- Never print a key, put it in a file in this repository, pass it on a command line, or commit it. Read it from its file at run time.
- Tests run offline, with a fake Provider. Keep real runs few and short.

## Binding: parts as services

Some parts run as services, each in its own process with its own HTTP API that you design, and each requiring its callers to authenticate. In the agent, a plugin stands for each service and provides the usual capability. Milestone 5 shows that:
- **a history store service** serves several agents at once. A second agent can't write to a session another holds; once the first lets go, or dies, the second can. A request whose answer was lost can be sent again without harm: test it with a service that drops its answers after doing the work.
- **a working environment service** is a sandbox rooted at one folder. It refuses paths outside it, runs commands with live output, and stops a command when the agent that started it hangs up, cancels or dies.
- **a model gateway** holds the Anthropic key. An agent that uses it holds no credentials at all.
- **the agent is served over HTTP:** sessions, input, answers and cancelling, and events a client can follow, then pick up again after reconnecting without missing anything recorded. Input resent after a lost answer is taken once.
- a real run works across processes: the agent and every service separate, driven over HTTP.

## Working rules

- Go is pinned with mise in `mise.toml` (`mise exec -- go ...`). Use one module with a package per part, so a part can be swapped by using a different package. Use the official MCP Go SDK; for ACP, use a maintained Go library if one exists, or implement the protocol from its published schema.
- You may install whatever toolchains, libraries and dev tools the build needs.
- Commit to local git after each chunk of work, with a clear message. There is no remote.
- Keep `PROGRESS.md` current: the milestone status, how to build and run the tests, the real runs done, and what comes next. The next session starts from it with no other memory.
- Write docs in plain English. No em dashes.
- **Processes:** nothing else runs on this machine, but never kill by a pattern that could match your own shell (no `pkill -f`). Kill by PID. Tests must leave no processes behind.
- Stop at the end of the milestone you were given, and report as `ACCEPTANCE.md` says.

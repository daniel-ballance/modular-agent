# Contributing

## How work moves through the layers

The project has five layers, and each is made only from the layers below it ([ADR 0024](docs/adr/0024-five-layers.md)):

1. the specification (`docs/`, the kits in `conformance/`);
2. the SDK specification (`docs/sdk/`, the shared scenarios in `conformance/sdk/`);
3. the SDKs (`rust/`, `typescript/`, `go/`, `python/`);
4. the reference implementations (`docs/reference/`, each language's `ma`, the checks in `conformance/reference/`);
5. demonstrative implementations (none yet).

**A gap goes down a layer.** When code needs something the layer below does not give, change the lower layer first: the documents, then the code, then the code that found the gap. Do not work around a lower layer from above it. In practice:

- A change to what an agent or part must do starts in `docs/contracts.md`, `docs/security.md` or a binding, with a kit check where one can be written, and an ADR if it is hard to reverse.
- A change to the developer API starts in `docs/sdk/`, usually with a shared scenario in `conformance/sdk/scenarios/` that every SDK then passes, and a guide example that runs as a test.
- A change to `ma` starts in `docs/reference/standard-configuration.md`, with a reference check where the behavior can be seen from outside.
- The four SDKs are one SDK in four languages, and the four `ma` builds are one program. A change to one language is a change to all four, or a recorded gap in the others.

## Writing

The documents are plain, specific English: short sentences, one idea each, no marketing words. The capitalized keywords (MUST, SHOULD, MAY) have their [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) meanings and belong only in normative documents ([Conformance](docs/conformance.md#keywords)). Use the [glossary's](GLOSSARY.md) terms and avoid the words it lists under *Avoid*.

Decisions that are hard to reverse, surprising without context and the result of a real trade-off get an ADR in `docs/adr/`, with the next number, and a row in its index.

## Checking a change

There is no hosted CI. Run the checks locally before pushing:

```sh
scripts/check.sh --quick      # about 10 minutes: builds, lint, SDK tests, shared scenarios, reference checks
scripts/check.sh              # full run, about 70 minutes: every suite and the binding kits
scripts/check.sh go python    # only those languages; cross-language steps need all four
```

Each step writes its log to a folder the script names at the end. The checks need Linux with unprivileged user, PID and mount namespaces, [mise](https://mise.jdx.dev) (which pins Rust and Go), Node.js 22 or later, and [uv](https://docs.astral.sh/uv/) (which pins Python 3.13). Set `TMPDIR` to a folder on disk if `/tmp` is small; the script defaults to `~/.cache/ma-std-tmp`.

A coding agent's shell commands may run inside a systemd scope that ends with the agent's process; T3 Code does this. Ending the scope kills everything in it, including a check started with `nohup` or `setsid`. Start a long run as its own user unit instead, so it survives:

```sh
systemd-run --user --unit=ma-check --collect --same-dir \
  --setenv=PATH="$PATH" --setenv=TMPDIR="$HOME/.cache/ma-std-tmp" \
  -p StandardOutput=file:"$HOME/.cache/ma-std-tmp/check.log" -p StandardError=file:"$HOME/.cache/ma-std-tmp/check.log" \
  scripts/check.sh
systemctl --user is-active ma-check    # active while it runs
```

On an Apple silicon Mac, run `scripts/macos-check.sh` from a fresh clone in a native arm64 shell. It checks for mise, Node.js 22 or later, uv and the Xcode command line tools. It builds all four `ma` programs, including the Go Monty worker, then runs the language suites, reference checks and ACP kits. It needs no sudo. It uses a temporary home, removes it when the run ends and leaves the logs at the paths in its summary table.

What the full run covers:

| Check | What it shows |
|---|---|
| Each language's suites | The base build, its SDK and its `ma`, including the base builds' own kit runs |
| Shared scenarios, `MODULAR_AGENT_SDK_REQUIRE=all` | Every SDK's runner passes every scenario in process and served by every SDK |
| Reference checks, `MODULAR_AGENT_REF_REQUIRE=all` | All four `ma` builds behave as the standard configuration says |
| ACP kit and `scripts/websocket-kits.sh` | ACP on each `ma`, plus the direct WebSocket ACP and plugin checks, including separate-listener plugin isolation |
| `scripts/production-kits.sh` | ADR 0030 isolation, capacity and erasure over ACP on each `ma` and base agent; deployment isolation against two copies of each language's history service; the [pending-erasure registry profile](docs/bindings/history-http.md#pending-erasure-registry-profile-pendingerasure-1) across a service restart |
| `scripts/erasure-matrix.sh` | The ACP erasure checks with each language's agents on each other language's history service: 12 pairings, all through the registry profile |
| `scripts/check-links.mjs` | Every relative link and anchor in the Markdown resolves |

To run only the ADR 0030 kits for a built language, use `scripts/production-kits.sh rust` (or `typescript`, `go` or `python`). Use the builds from `scripts/check.sh`, including the Rust `history_service` example or Go `modular-service`, and install the kit dependencies with `npm ci --prefix conformance/acp` and `npm ci --prefix conformance/tools`. The runner uses disposable loopback listeners, tokens and stores. It checks ACP on stdio and over direct WebSocket listeners where available; Go's base agent serves ACP on stdio only. The full check runs this step for each selected language; `--quick` skips it.

A check that fails intermittently is a bug to fix, not to retry until it passes.

## Commits

Commit in small steps, each one passing the checks it touches. Write the message for a reader who was not there: what changed and why, and the checks you ran with their counts.

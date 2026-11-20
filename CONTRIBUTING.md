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
scripts/check.sh              # about 45 minutes: every suite, both Runtimes and bindings, the ACP kit on every ma
scripts/check.sh go python    # only those languages; cross-language steps need all four
```

Each step writes its log to a folder the script names at the end. The checks need Linux with unprivileged user, PID and mount namespaces, [mise](https://mise.jdx.dev) (which pins Rust and Go), Node.js 22 or later, and [uv](https://docs.astral.sh/uv/) (which pins Python 3.13). Set `TMPDIR` to a folder on disk if `/tmp` is small; the script defaults to `~/.cache/ma-std-tmp`.

What the full run covers:

| Check | What it shows |
|---|---|
| Each language's suites | The base build, its SDK and its `ma`, including the base builds' own kit runs |
| Shared scenarios, `MODULAR_AGENT_SDK_REQUIRE=all` | Every SDK's runner passes every scenario in process and served by every SDK |
| Reference checks, `MODULAR_AGENT_REF_REQUIRE=all` | All four `ma` builds behave as the standard configuration says |
| ACP kit against each `ma` | The four `ma` builds present the same agent over ACP |
| `scripts/check-links.mjs` | Every relative link and anchor in the Markdown resolves |

A check that fails intermittently is a bug to fix, not to retry until it passes.

## Commits

Commit in small steps, each one passing the checks it touches. Write the message for a reader who was not there: what changed and why, and the checks you ran with their counts.

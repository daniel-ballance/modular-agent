# Modular Agent

Work on the branch in the checkout you were given. Never commit to `main`.

## Map

- `rust/`, `typescript/`, `go/` and `python/` are one SDK and one `ma`, each in its own language.
- `conformance/` holds the kits that check a build against the specification.
- `docs/` is the specification. `GLOSSARY.md` is the vocabulary. `CONTRIBUTING.md` is how a change moves through the layers, how to write, and how the checks run.

## Work

Every change starts from an issue. Read it with `gh issue view N`. Work on one branch per issue. Open a pull request whose body says `Closes #N`. The operator merges it, so leave it open. `CONTRIBUTING.md` has the labels, milestones and pull request contents.

## Checks

`scripts/check.sh` is the gate. There is no hosted CI.

```sh
scripts/check.sh --quick
scripts/check.sh
scripts/check.sh go python
```

Leave `TMPDIR` and `CARGO_INCREMENTAL` unset. No suite needs an on-disk temp directory. The check scripts choose their own scratch directory. A suite run on its own uses the system temp directory.

# Modular Agent

Work on the branch in the checkout you were given. Never commit to `main`.

## Map

- `rust/`, `typescript/`, `go/` and `python/` are one SDK and one `ma`, each in its own language.
- `conformance/` holds the kits that check a build against the specification.
- `docs/` is the specification. `GLOSSARY.md` is the vocabulary. `CONTRIBUTING.md` is how a change moves through the layers, how to write, and how the checks run.

## Work

Open work lives only in GitHub Issues. Read `gh issue list` before you start. Every change starts from an issue. Read it with `gh issue view N`. Work on one branch per issue.

- A gap, finding or follow-up you find becomes an issue, with the `finding`, `layer:` and `lang:` labels that apply. It never becomes a README section, a TODO comment or a chat note.
- A decision that outlives your session goes into an issue comment, an ADR or the document it changes.
- Move the issue's Status on the GitHub Project: In progress when its branch exists, In review when its pull request is open.
- When you change a rule, a status or a user-facing string, find every other place that states it with `rg`. Change them in the same pull request, in all four languages. A language you cannot change there gets an issue with its `lang:` label.
- Open a pull request whose body says `Closes #N`. A reviewer who did not write it gives a verdict at its current head. Then the operator lands it, so leave it open.
- After your pull request merges, remove your worktree and local branch. GitHub deletes the remote branch.

`CONTRIBUTING.md` ("How work is tracked") has the detail: labels, review, moving the Status, pull request contents and the release checklist.

## Checks

`scripts/check.sh` is the gate. There is no hosted CI.

```sh
scripts/check.sh --quick
scripts/check.sh
scripts/check.sh go python
```

Leave `TMPDIR` and `CARGO_INCREMENTAL` unset. No suite needs an on-disk temp directory. The check scripts choose their own scratch directory. A suite run on its own uses the system temp directory.

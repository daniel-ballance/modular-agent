# Modular Agent

Work on the branch in the checkout you were given. Never commit to `main`.

## Map

- `rust/` and `typescript/` are one SDK and one `ma`, each in its own language, kept in lockstep ([ADR 0037](docs/adr/0037-two-languages.md)).
- `conformance/` holds the kits that check a build against the specification.
- `docs/` is the specification. `GLOSSARY.md` is the vocabulary. `CONTRIBUTING.md` is how a change moves through the layers, how to write, and how the checks run.

## Work

Open work lives only in GitHub Issues. Read `gh issue list` before you start. Every change starts from an issue. Read it with `gh issue view N`. Work on one branch per issue.

- Work in parallel only on files that no open pull request changes. If yours overlap one, wait for it to land or stack on it.
- `scripts/check.sh` and `scripts/stress.sh` wait for a free check slot on the machine by themselves. Leave `MA_CHECK_SLOTS` unset. Stop a run with `systemctl --user stop UNIT`.
- Delegates keep scratch and worktrees in their own subfolder of `~/.cache/ma-std-tmp/`, not `/tmp`, and delete only that subfolder before they report. Never delete the shared folder, `check-slot.sh` or `slots/`. Never run tests under `git rebase -x`, `git bisect run` or anything else that exports `GIT_DIR`.
- A gap, finding or follow-up that a user, a real repository or a real run can hit becomes an issue, with the `finding`, `layer:` and `lang:` labels that apply. It never becomes a README section, a TODO comment or a chat note. Search the open issues first and comment on a matching one instead of filing another. A finding that only contrived input reaches is a non-blocking note in the verdict, not an issue.
- Give every new issue a milestone: the current one only if its "Done when" needs the issue, otherwise the next one.
- A step that misses a deadline under machine load and passes when rerun alone goes on #154 as a comment, not a new issue. `CONTRIBUTING.md` ("Checking a change") says when such a rerun lets a pull request land.
- A decision that outlives your session goes into an issue comment, an ADR or the document it changes.
- Learn a lesson once. When a rule was broken, a review finding repeated or a run went wrong, write the lesson down before you finish: one line here if every agent needs it, the detail in `CONTRIBUTING.md`, or a check in `scripts/` when the rule is exact. An issue comment or chat note alone is lost to the next agent.
- Move the issue's Status on the GitHub Project: In progress when its branch exists, In review when its pull request is open.
- When you change a rule, a status or a user-facing string, find every other place that states it with `git grep -n`, which also reads `.github/`. Change them in the same pull request, in Rust and TypeScript. The languages you cannot change there get one issue with a `lang:` label for each.
- Open a pull request whose body says `Closes #N`. That keyword goes only in the pull request body; a closing keyword in a commit message fails the maintainability check. A reviewer who did not write it runs the agent check in `CONTRIBUTING.md` and posts a verdict naming its head SHA. A content-filter refusal is not a verdict. A pull request lands only with a passing verdict that covers the exact SHA given to `--match-head-commit`. The two exceptions are a wording-only push to lines already reviewed and a restack whose `git patch-id --stable` is unchanged. The operator lands it, so leave it open.
- When the parent of your stacked pull request lands, restack yours as "Working in parallel" in `CONTRIBUTING.md` says.
- After your pull request merges, remove your worktree and local branch. Keep the branch while a stacked pull request is built on it, until that child is restacked. GitHub deletes the remote branch.

`CONTRIBUTING.md` ("How work is tracked") has the detail: labels, review, landing, moving the Status, pull request contents, parallel work and the release checklist.

## Checks

`scripts/check.sh` is the gate. There is no hosted CI.

```sh
scripts/check.sh --quick
scripts/check.sh
scripts/check.sh rust
```

`--quick` runs only part of each language's tests; a change outside them runs the full lane for that language, as `CONTRIBUTING.md` ("Checking a change") says. Read each command's own exit code; a pipe hides it. A suite run on its own in a fresh worktree first needs the setup steps `scripts/check.sh` runs, such as `npm ci` in `conformance/acp`, `conformance/tools` and `conformance/telemetry`.

Leave `TMPDIR` and `CARGO_INCREMENTAL` unset. No suite needs an on-disk temp directory. The check scripts choose their own scratch directory. A suite run on its own uses the system temp directory.

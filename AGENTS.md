# Modular Agent

Work on the branch in the checkout you were given. Never commit to `main`.

## Map

- `rust/` and `typescript/` are one SDK and one `ma`, each in its own language, kept in lockstep ([ADR 0037](docs/adr/0037-two-languages.md)).
- `conformance/` holds the kits that check a build against the specification.
- `docs/` is the specification. `GLOSSARY.md` is the vocabulary. `CONTRIBUTING.md` is how a change moves through the layers, how to write, and how the checks run.

## Work

Open work lives only in GitHub Issues. Read `gh issue list` before you start. Every change starts from an issue. Read it with `gh issue view N`. Work on one branch per issue.

- Work in parallel only on files that no open pull request changes. If yours overlap one, wait for it to land or stack on it.
- When parallel work hits GitHub's GraphQL rate limit, use the REST commands in [Working in parallel](CONTRIBUTING.md#working-in-parallel).
- Install or rebuild the local `ma` from the permanent `main` checkout so its bin and sidecar links survive worktree cleanup.
- During #20, export traces to local Phoenix and audit session histories read-only as described in [Evaluating ma on real work](CONTRIBUTING.md#evaluating-ma-on-real-work).
- `scripts/check.sh` and `scripts/stress.sh` wait for a free check slot on the machine by themselves. Leave `MA_CHECK_SLOTS` unset. Stop a run with `systemctl --user stop UNIT`.
- Delegates keep scratch and worktrees in their own subfolder of `~/.cache/ma-std-tmp/`, not `/tmp`, and delete only that subfolder before they report. Never delete the shared folder, `check-slot.sh` or `slots/`. Never run tests under `git rebase -x`, `git bisect run` or anything else that exports `GIT_DIR`.
- A gap, finding or follow-up that a user, a real repository or a real run can hit becomes an issue, with the `finding`, `layer:` and `lang:` labels that apply. It never becomes a README section, a TODO comment or a chat note. Search the open issues first and comment on a matching one instead of filing another. A finding that only contrived input reaches is a non-blocking note in the verdict, not an issue.
- Give every new issue a milestone: the current one only if its "Done when" needs the issue, otherwise the next one.
- Reproduce a deadline missed under machine load before you blame the pull request: rerun the step alone, or A/B against `origin/main` under the same load. A miss alone, or at the head only, blocks the pull request without naming a cause. A pass alone, or the same miss at both, goes on #154 as a comment, not a new issue. Any other A/B outcome is inconclusive: note it on #154 and rerun alone. `CONTRIBUTING.md` ("Checking a change") says when a rerun lets a pull request land.
- A decision that outlives your session goes into an issue comment, an ADR or the document it changes.
- Learn a lesson once. When a rule was broken, a review finding repeated or a run went wrong, write the lesson down before you finish: one line here if every agent needs it, the detail in `CONTRIBUTING.md`, or a check in `scripts/` when the rule is exact. An issue comment or chat note alone is lost to the next agent.
- Move the issue's Status on the GitHub Project: In progress when its branch exists, In review when its pull request is open.
- When you change a rule, a status or a user-facing string, find every other place that states it with `git grep -n`, which also reads `.github/`. Change them in the same pull request, in Rust and TypeScript. The languages you cannot change there get one issue with a `lang:` label for each.
- Open a pull request whose body says `Closes #N` and holds the check summary table. Keep closing keywords and `WIP` out of commit messages.
- A reviewer who did not write the pull request runs the agent check and posts a verdict naming its head SHA. A content-filter refusal is not a verdict.
- Leave the pull request open for the operator to land with a passing verdict covering the exact SHA, subject to the exceptions under [Landing](CONTRIBUTING.md#how-work-is-tracked).
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

`scripts/check.sh [--quick] [--serial] [rust|typescript ...]` accepts only language lanes. For docs-only changes, run the five commands under [Checking a change](CONTRIBUTING.md#checking-a-change).

`--quick` runs only part of each language's tests; a change outside them runs the full lane for that language, as `CONTRIBUTING.md` ("Checking a change") says. Read each command's own exit code; a pipe hides it. A suite run on its own in a fresh worktree first needs the setup steps `scripts/check.sh` runs, such as `npm ci` in `conformance/acp`, `conformance/tools` and `conformance/telemetry`.

Leave `TMPDIR` and `CARGO_INCREMENTAL` unset. No suite needs an on-disk temp directory. The check scripts choose their own scratch directory. A suite run on its own uses the system temp directory.

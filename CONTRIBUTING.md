# Contributing

## How work is tracked

Every change starts from a GitHub issue. An issue is a bug, a change, or a finding: a gap that a higher layer found in a lower one.

- **Open work.** Issues are the only list of open work. When you find a gap, a finding or a follow-up that meets the bar under "What gets an issue", record it at once, even while you work on another: comment on the matching open issue, or open one. The next agent finds it with `gh issue list`, which shows no README section, TODO comment or chat note.
- **What gets an issue.** File what a user, a real repository or a real run can hit. First search the open issues (`gh issue list --search WORDS`) and comment on a match instead of filing a duplicate. One question asked of several languages is one issue with several `lang:` labels. A failure that only contrived input reaches, such as a file with CR-only line endings or a value nested thousands of levels deep, is a non-blocking note in the reviewer's verdict; #128 and #132 were closed for this. A repeated kind of failure gets one issue that collects the occurrences, as #154 does for deadlines missed under load.
- **Labels.** A `layer:` label gives the layer the work starts in. Each `lang:` label names a language the work or gap applies to; one issue carries a label for each language it covers. A `finding` label marks a gap that must go down a layer.
- **Milestones.** Each release has a milestone, starting with 0.4.0. Its description ends with "Done when" and a condition a reader can check. Every open issue has a milestone. A new issue goes into the current milestone only if that condition needs it, and otherwise into the next one. When a milestone's open count grows over a day of work, triage it before starting new work: fold duplicates, close as not planned what fails the bar above, and move what the condition does not need. On 2026-11-25, 0.4.0 had 45 open issues and no stated finish, and 22 more had no milestone. The trim moved 33 to 0.5.0, closed five as not planned or duplicates, and grouped ten deadline failures under #154 ([#25](https://github.com/daniel-ballance/modular-agent/issues/25)).
- **Project.** The "Modular Agent" GitHub Project shows each issue's status (Todo, In progress, In review, Done) and priority. Whoever works on an issue moves it to In progress when its branch exists and to In review when its pull request is open. The commands are below.
- **Lessons.** Learn a lesson once. When a rule was broken, a review finding repeated or a run went wrong, write it down before the session ends, where the next agent reads it: a line in `AGENTS.md` if every agent needs it, the detail in this file, or a check in `scripts/` when the rule is exact. Put it in the pull request that taught it, or open an issue and a follow-up pull request. An issue comment, a pull request comment or an agent's notes alone do not reach the next agent.
- **Decisions.** A decision that outlives your session goes where the next reader looks: a comment on the issue, an ADR when it meets the test under [Writing](#writing), or the document it changes. Chat and an agent's own notes end with the session.
- **One change, every place.** When you change a rule, a status word or a user-facing string, search for every other place that states it with `git grep -n`, which also reads `.github/`. Look in the documents, the READMEs, help text, tests and both languages. Change them in the same pull request. The languages you cannot change there get one issue with a `lang:` label for each ([ADR 0037](docs/adr/0037-two-languages.md)). Check adapter changes against the public SDK specification, including the connection handle and callback types.
- **Branch and pull request.** Work on one branch per issue. The pull request says `Closes #N` and lists the checks run, with their counts. Paste the final summary table of `scripts/check.sh` into the body. If you ran the docs-only commands, give each command, its wall time and its failures in the table. A delegate deletes its scratch folder and logs before it reports. Use the sections in [the template](.github/pull_request_template.md). `Closes #N` goes only in the pull request body. A squash merge copies every commit message into `main`, and GitHub closes an issue that a keyword there names, which is how #44 closed #13.
- **Review.** Every pull request gets a verdict from a reviewer who did not write it, from another model family when one is available. The reviewer posts the verdict on the pull request and names the head SHA it reviewed. Landing, below, says which heads a verdict covers. A reviewer that a provider's content filter refuses has given no verdict. Record the refusal on the pull request and start a replacement reviewer from another model family that did not write the pull request. The replacement reuses any check run already going at that head.
- **Review findings.** The author fixes a reviewer's one-line finding in place. A larger finding goes to a fresh owner, a new agent or a new issue, together with the finding. Before you push a fix for a finding, give it the reviewer's probe and the harder cases next to it that a user, a real repository or a real run can produce, such as larger or malformed input. Measure any cost a comment or the pull request body claims, such as "linear", and for a check script measure it under a capped heap such as `node --max-old-space-size=128`. #114's rounds 4 to 9 each found a new size or memory failure at the next head. A probe that only contrived input reaches, such as nesting thousands of levels deep, is a note in the verdict and does not block. After two failed review rounds on the same premise, test the premise and record the decision on the issue instead of patching again. #27 needed eleven rounds and ended by replacing its line readers with parsers. The decision also fixes the scope later rounds block on: no regression against the baselines it names, such as `main`, on input that meets the bar under "What gets an issue", and the findings it keeps. An edge case that `main` gets wrong too becomes its own issue if it meets the bar under "What gets an issue", and otherwise a note in the verdict, never another round ([#59](https://github.com/daniel-ballance/modular-agent/issues/59)).
- **Agent check.** Before the verdict, the reviewer runs `node scripts/docs-review.mjs` at the head; a stacked pull request adds `--base BRANCH`. It prints candidates: changed lines with a status word, with status wording beside a named or linked ADR, or naming open work that no issue in the section tracks, each with the ADRs its paragraph links and their status. It reads the committed head, so commit before running it. It picks lines by keyword. Candidates never fail the command; a usage or Git error exits 2. The reviewer judges each candidate for the two problems below and reports each problem as a blocking finding with its `file:line` and the fix. A candidate judged fine needs no comment. The verdict says that the agent check ran and how many candidates it judged.
  - **Stale status.** The line calls a decision proposed, draft or planned when its ADR is accepted, or calls something done or accepted that is not.
  - **Untracked open work.** The line names a gap, finding, TODO or follow-up that no issue tracks.
- **Landing.** The operator lands a pull request only with a passing verdict that covers the exact SHA given to `gh pr merge N --squash --match-head-commit SHA` or to the [REST merge command](#working-in-parallel). A verdict covers the head it names, with two exceptions: a push that only removes or rewords lines the verdict already reviewed, and a restack whose `git patch-id --stable` is unchanged ([Working in parallel](#working-in-parallel)). For either, the author posts both SHAs on the pull request, and the patch IDs for a restack. Any other push needs a new verdict. If `main` moved after the verdict and changed files the pull request also changes, merge `origin/main` into a scratch copy of the head and run the checks those files touch before landing. GitHub then deletes the remote branch. Remove your worktree and local branch with `git worktree remove PATH` and `git branch -D BRANCH`. A parent of a stacked pull request keeps its local branch until the child is restacked ([Working in parallel](#working-in-parallel)).

To move an issue on the Project, look up the IDs, then set the Status field:

```sh
ISSUE=26                                                           # your issue's number
gh project view 1 --owner daniel-ballance --format json --jq .id    # project ID
gh project item-list 1 --owner daniel-ballance --format json --limit 500 \
  --jq ".items[] | select(.content.number==$ISSUE) | .id"          # item ID of the issue
gh project field-list 1 --owner daniel-ballance --format json \
  --jq '.fields[] | select(.name=="Status")'                        # field and option IDs
gh project item-edit --project-id PROJECT_ID --id ITEM_ID \
  --field-id FIELD_ID --single-select-option-id OPTION_ID
```

### Working in parallel

Several agents work at once, each on its own issue.

- **One owner.** An issue has one owner, one branch in its own worktree and one pull request. Run `git fetch origin main` before branching. Create the worktree with `git worktree add ../BRANCH -b BRANCH origin/main` or check that a worktree supplied for the issue starts at the fetched commit.
- **Disjoint files.** Work runs at once only when it changes different files. Before starting a wave, compare the full expected file lists of the candidate issues against each other and against every open pull request (`gh pr diff N --name-only`). Include shared specifications, fixtures and generated files. If they overlap, run one after the other or stack the dependent change.
- **Stacking.** Branch from the parent's branch, open the pull request with `gh pr create --base PARENT_BRANCH` and write "Stacked on #N" in its body. The reviewer runs the agent check with `--base PARENT_BRANCH`.
- **Restacking.** After the parent squash-merges, move the child onto `main`. OLD_PARENT_HEAD is the parent's head that the child is built on.

  ```sh
  git fetch origin
  git diff OLD_PARENT_HEAD HEAD | git patch-id --stable    # before
  git rebase --onto origin/main OLD_PARENT_HEAD
  git diff origin/main HEAD | git patch-id --stable        # after
  git push --force-with-lease
  gh pr edit N --base main
  ```

  Post both SHAs and both patch IDs on the pull request. When another worktree already holds the branch locally, perform the restack or small fix in a detached scratch worktree and push with `git push --force-with-lease="refs/heads/BRANCH:OLD_SHA" origin HEAD:refs/heads/BRANCH`. [Landing](#how-work-is-tracked) says whether the verdict still covers the new head.
- **Machine load.** `scripts/check.sh` and `scripts/stress.sh` wait for a free check slot on the machine by themselves. Start a long run as a systemd user unit and stop it with `systemctl --user stop UNIT`. [Checking a change](#checking-a-change) has both.
- **Scratch and build artifacts.** A delegate puts its scratch files and worktrees in its own subfolder, `~/.cache/ma-std-tmp/UNIT/`, not in `/tmp`, and deletes only that subfolder before it reports. It also deletes `rust/target` in its temporary or isolated worktree before reporting; across a parallel session, 117 finished worktrees accumulated 4.8 TB logical (~1.5 TB physical) in `rust/target` and filled the root disk. Coordinators check `df -h /` before starting heavy parallel waves. Never delete `~/.cache/ma-std-tmp` itself, `check-slot.sh` or `slots/`, which other runs are using. `/tmp` is a shared tmpfs with a per-user quota; one reviewer's 41.7 GB left there made other agents' checks fail with `Disk quota exceeded`.
- **No exported `GIT_DIR`.** Never run tests under `git rebase -x`, `git bisect run` or anything else that exports `GIT_DIR`. Test fixtures that run Git inherit it and act on the shared repository; for #59 one set `core.bare=true` on it and moved `origin/main`.

Parallel agents can exhaust GitHub's GraphQL limit. Use `gh api` with the repository's REST endpoints for pull request reads, verdict comments and issue edits. Set `N` to the issue or pull request number for each command. `BODY_FILE` holds the comment text, and `MILESTONE_NUMBER` is the milestone's number in this repository.

```sh
repo=repos/daniel-ballance/modular-agent
gh api --paginate "$repo/pulls?state=open"
gh api "$repo/pulls/$N" --jq .head.sha
gh api --paginate "$repo/pulls/$N/files" --jq '.[].filename'
gh api -X POST "$repo/issues/$N/comments" -F body=@"$BODY_FILE"
gh api -X PATCH "$repo/issues/$N" -F milestone="$MILESTONE_NUMBER"
```

The operator can use the REST merge endpoint with the same landing rules. Set `HEAD_SHA` to the exact head covered by the passing verdict.

```sh
gh api -X PUT "$repo/pulls/$N/merge" -f merge_method=squash -f sha="$HEAD_SHA"
```

If the head changed, check whether the verdict covers the new SHA before trying again.

### Releases

A release gives both SDKs and `ma` one new version, named by its milestone. Steps 1 to 5 go in one release pull request.

1. Bump the version everywhere it is stated:
   - Rust: `version` in the workspace `rust/Cargo.toml`, and `rust/Cargo.lock`.
   - TypeScript: `version` in each `typescript/packages/*/package.json`, the exact versions those packages pin for each other, and `typescript/package-lock.json`.
   - The manifests and lock files under `demos/`, the status line in `README.md`, and the `ma --version` example in `.github/ISSUE_TEMPLATE/bug.yml`.

   Then search the tracked files for the old version with `git grep -n -F OLD`, which also reads `.github/`, and change each place that still gives it as current.
2. Update the status line at the top of `docs/sdk/README.md`. It gives the SDK specification's revision and what both SDKs pass.
3. Add a section for the release to `docs/status.md`, with the step counts of `scripts/check.sh` and `scripts/macos-check.sh` on the release commit.
4. Add a section for the release to `CHANGELOG.md`.
5. Run the docs-state check (#27). It fails on a version that drifted, an ADR index status that disagrees with its record, or a gap section without an issue.
6. After the operator lands the release pull request and tags its commit on `main` as `vX.Y.Z`, close the milestone. First move each issue still open in it to the next milestone with `gh issue edit N --milestone NEXT`. Then close it with `gh api -X PATCH repos/daniel-ballance/modular-agent/milestones/NUMBER -f state=closed`.

## How work moves through the layers

The project has five layers, and each is made only from the layers below it ([ADR 0024](docs/adr/0024-five-layers.md)):

1. the specification (`docs/`, the kits in `conformance/`);
2. the SDK specification (`docs/sdk/`, the shared scenarios in `conformance/sdk/`);
3. the SDKs (`rust/`, `typescript/`);
4. the reference implementations (`docs/reference/`, each language's `ma`, the checks in `conformance/reference/`);
5. demonstrative implementations (`demos/`: the project notes agent and the ops desk).

**A gap goes down a layer.** When code needs something the layer below does not give, change the lower layer first: the documents, then the code, then the code that found the gap. Do not work around a lower layer from above it. In practice:

- A change to what an agent or part must do starts in `docs/contracts.md`, `docs/security.md` or a binding, with a kit check where one can be written, and an ADR if it is hard to reverse.
- A change to the developer API starts in `docs/sdk/`, usually with a shared scenario in `conformance/sdk/scenarios/` that every SDK then passes, and a guide example that runs as a test.
- A change to `ma` starts in `docs/reference/standard-configuration.md`, with a reference check where the behavior can be seen from outside.
- The Rust and TypeScript SDKs are one SDK in two languages, and the two `ma` builds are one program. A change to one language is a change to both, or a recorded gap in the other ([ADR 0037](docs/adr/0037-two-languages.md)). Shared scenarios and reference checks run against both languages. Record a gap as one issue with the other language's `lang:` label.

**No backward compatibility before 1.0.** The project's owner is its only user. Change or remove a rule, field, option or API outright; do not keep an old spelling, alias, fallback, migration or "optional for older builds" form beside the new one. Interoperability with outside protocols and clients (ACP, AG-UI, OpenTelemetry, model APIs) is not backward compatibility and stays.

## Writing

The documents are plain, specific English: short sentences, one idea each, no marketing words. The capitalized keywords (MUST, SHOULD, MAY) have their [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) meanings and belong only in normative documents ([Conformance](docs/conformance.md#keywords)). Use the [glossary's](GLOSSARY.md) terms and avoid the words it lists under *Avoid*.

A sentence in the specification or the standard configuration states only what every build guarantees on every path, not only on the path you changed. A reviewer tests the sentence as well as the code. #131 promised that an answer sent once a question appears is always accepted, and Rust's `/tool` command broke that ([#134](https://github.com/daniel-ballance/modular-agent/issues/134)).

Decisions that are hard to reverse, surprising without context and the result of a real trade-off get an ADR in `docs/adr/`, with the next number, and a row in its index.

## Keeping the code maintainable

Keep one concern per module. Split a module by the rule each part enforces, not by line count.

Keep tracked source files at 1,000 lines or fewer. The docs lane runs `scripts/check-maintainability.mjs` to check this. Files listed in `scripts/maintainability-baseline.json` may exceed the limit up to their recorded counts. Lower an entry when its file shrinks. Remove the entry if the file is gone or fits the limit. Adding or raising an entry requires review. Explain why in the PR.

The docs lane runs `scripts/check-docs-state.mjs`, which checks three things. The setup step installs its parsers with `npm ci --silent --prefix scripts`. First, in tracked Markdown outside `docs/adr/`, `docs/research/`, `docs/pressure-test/` and `*/docs/clean-room/`, a heading that starts with Known gaps, Gaps, Findings or Remaining (alone, or ending in work or gaps), ends in gaps or findings, starts with Proposed and names text, or reads "Proposed, not yet written" must reference an issue before the next heading. The check follows CommonMark for both `#` and underlined (Setext) headings. Indented code blocks do not count as issue references. Other headings that list open work are not checked, but their work still belongs in an issue. Second, every record in `docs/adr/` must have a row in `docs/adr/README.md`, and each row must start its status with its record's status; a row for an accepted record may instead start with Historical. Third, the release at the top of `CHANGELOG.md` must match the versions in every tracked `Cargo.toml` and in each `typescript/packages/*/package.json` with its `@modular-agent/` pins. Its major.minor must match the SDK specification status. Lock files and the Node manifests under `demos/` are not checked; the release checklist covers them. Stale status prose and untracked open work are left to the reviewer's [agent check](#how-work-is-tracked).

Do not merge a commit into `main` if its subject starts with `WIP`, regardless of case, or if its message has a closing keyword such as `Fixes #12` ([Branch and pull request](#how-work-is-tracked)). `scripts/check-maintainability.mjs` fails on either in the commits that `main` does not have (`git log origin/main..HEAD`, or the local `main` when there is no `origin/main`). It reads GitHub's keywords (close, closes, closed, fix, fixes, fixed, resolve, resolves, resolved, in any case) followed by a whole `#N`, `OWNER/REPO#N` or issue URL; "fixed in #12" does not close an issue and passes.

Follow the split issues for the Harness modules over the limit: [TypeScript #8](https://github.com/daniel-ballance/modular-agent/issues/8) and [Rust #9](https://github.com/daniel-ballance/modular-agent/issues/9).

## Checking a change

There is no hosted CI. Run the checks locally before pushing:

```sh
scripts/check.sh --quick      # builds, lint, SDK tests and cross-language checks
scripts/check.sh              # every suite and the binding kits
scripts/check.sh rust         # only the Rust language lane, plus the docs lane
scripts/check.sh --serial     # one step at a time, in the original order
scripts/stress.sh 3           # three independent full checks at once, on three check slots
```

The syntax is `scripts/check.sh [--quick] [--serial] [rust|typescript ...]`. With no language argument, it runs both languages. The docs lane runs with either language and there is no `docs` argument. For a docs-only change outside `docs/reference/standard-configuration.md` (whose text blocks `conformance/reference/run.mjs` compares against `ma`, so changes there still run the reference checks or `scripts/check.sh`), run these commands from the repository root:

```sh
npm ci --silent --prefix scripts
node --test scripts/*.test.mjs
node scripts/check-docs-state.mjs
node scripts/check-maintainability.mjs
node scripts/check-links.mjs
```

`--quick` runs a subset of each language's tests: Rust's `modular-agent` and `standard` crates, and the root TypeScript suite once without the separate `MA_REMOTE=...` rerun. It also skips the telemetry, AG-UI, WebSocket and ADR 0030 kits, the ACP kit's groups other than stdio rights, and the erasure matrix. A change to code outside that subset, such as the Harness, a base agent, an interface, a plugin host or a history service, runs the full lane for each language it touches (`scripts/check.sh rust` or `scripts/check.sh typescript`) before review. At the four-language checkpoint, #130 passed `--quick` while 21 Go tests outside `./modular/...` failed.

After moving Rust tests between crates, run `mise exec -- cargo clippy --workspace --all-targets -- -D warnings` from `rust/` before starting the full check. Testing only the destination crate can miss stale imports in the source crate.

Each selected language runs in its own lane. A failing step does not stop that lane or the others. The shared scenarios, reference checks, both demos, telemetry peer placements and erasure matrix run only when both language lanes are selected. In a parallel run, they wait for both lanes. The erasure pairings also run together unless you pass `--serial`.

The script prints each finished step with its lane and elapsed time. It prints the wall time and log folder in the final summary. On the reference machine (32 logical CPUs), on 2026-11-26 at `main` 2e8c1f3, with no other check or test running (load average 1.0 at the start, 1.9 at the end), the full check passed all 44 steps in 19 minutes 19 seconds (1,159 s) in a fresh worktree with cold builds; the Rust build took 129 s. The quick check, run straight after in the same worktree with warm builds, passed all 24 steps in 6 minutes 14 seconds (374 s). An earlier attempt under the same conditions passed 42 of 44 steps: two TypeScript steps missed deadlines with only the check's own lanes running ([#154](https://github.com/daniel-ballance/modular-agent/issues/154)). Other work on the machine makes either run slower. Before the move to two languages ([ADR 0037](docs/adr/0037-two-languages.md)), the four-language full check took about 37 minutes (2,198 s, at 0.3.0 on 2026-11-25).

Several agents share one machine, so the check scripts limit how many check runs go at once. `scripts/check.sh` takes one check slot before its first step and holds it until it ends. `scripts/stress.sh N` takes N slots at once, because its runs must overlap, and refuses an N above the limit. Both read their arguments first, so `--help` and a wrong argument never wait. A run that finds too few free slots prints `check-slot: waiting for ...`, holds none while it waits, then prints `check-slot: took slot ...` when it starts. The slots are lock files in `~/.cache/ma-std-tmp/slots/`, shared by every worktree. `MA_CHECK_SLOTS` sets the number of slots, a decimal from 0 to 64, leading zeros allowed (default 3); `MA_CHECK_SLOTS=0` turns the limit off, for a machine with one user. One suite run on its own, such as `cargo test -p NAME`, takes no slot.

Start a long run as a systemd user unit, as shown below. Stopping or finishing the unit frees its slots. Stop it with `systemctl --user stop UNIT`, which stops all of its processes. Killing one process inside a run may leave its slot held until the rest of the run exits. The check steps and lanes, and `stress.sh`'s copy helpers and runs, close the slot files; short commands such as `mktemp` that run before them do not. That is hygiene, not a guarantee. `scripts/stress.sh` stops its runs when it gets SIGTERM, SIGINT or SIGHUP.

A check started inside a run that holds a slot (`MA_CHECK_SLOT_HELD` is set) uses that slot and never waits. A run there that wants more than one slot, such as `scripts/stress.sh 2` inside `check.sh` or a slot wrapper, exits 2 instead of waiting, even when `MA_CHECK_SLOTS` is 0 inside it, because two runs that each hold a slot and wait for another can wait on each other forever. Start `stress.sh` on its own. A wrapper that takes a slot and then starts a check hands the slot over. It exports `MA_CHECK_SLOT_HELD=1` and `MA_CHECK_SLOT_FD`, the number of the descriptor that holds the lock on a slot file, then execs the check. The check exits 2 if that descriptor is not open on a slot file, or if `flock` does not confirm that some process holds the file's lock. The steps then close that descriptor too.

A suite run on its own in a fresh worktree first needs the setup steps that `scripts/check.sh` runs: `npm ci` in `conformance/acp`, `conformance/tools` and `conformance/telemetry`, and the language's build step. Without them some tests fail on a missing package, which is not a failure of the change.

When adding checks to a conformance kit, find the tests that assert its summary count with `git grep -n 'checks passed'`. Update their expected totals and run the affected tests.

Before you blame a change for a failure, rule out the machine. `Disk quota exceeded`, `No space left on device`, a missing saved point or a missing build output can come from a full `/tmp`; check `quota -s` and `df -h /tmp` against the time of the failing step, and rerun once there is space. The rewind failures in #110 came from a full `/tmp`, not from the pull request they blocked, and #113's likely did too.

Heavy writes to the same disk can stall file system calls for seconds, so a step can miss deadlines that another step's writes caused. In #154, three Rust workspace test builds with full debug info each wrote 54 GB at once, `mkdtemp` and `fsync` took up to 8 s, and the TypeScript suite beside them timed out across seven files. `rust/Cargo.toml` therefore limits debug builds to line tables. Before you add debug info back, run `scripts/stress.sh 3` with it.

Use `scripts/stress.sh N [check.sh options]` to reproduce failures under load. It copies the tracked files as they are on disk, including uncommitted changes to tracked files. Each check builds from scratch and writes to its own scratch directory. Allow disk space for all the builds. The final table counts how many runs failed each step and lists their log paths. The script keeps the logs and removes the build trees. A check that fails intermittently is a bug to fix, not to retry until it passes. The one exception, while #154 is open, is below.

Deadlines missed under machine load are one bug, tracked in [#154](https://github.com/daniel-ballance/modular-agent/issues/154). When a step fails by missing a deadline, such as a timeout, while the machine is loaded, reproduce it before you blame the pull request. Rule out the disk as above and rerun that step alone. If the machine stays loaded, run it A/B instead: the same step at `origin/main` and at the head, at the same time, under the same load. One paired run cannot show what caused an intermittent miss, so each outcome below decides only what happens next.

- If the solo rerun fails, or the A/B misses a deadline at the head and passes at `origin/main`, the pull request is blocked, whatever the cause, until the step passes at the head.
- If the solo rerun passes, or the A/B misses the same deadline at both, add a comment to #154 with the step, the failing lines of its log, the load average, `quota -s`, `df -h /tmp` and the rerun's result; open no new issue. When the pull request does not change the code, tests or scripts that step runs, it may land. Otherwise run that step ten times in a row while another full check runs; one more failure fails the pull request.
- Any other A/B outcome is inconclusive: both pass, only `origin/main` misses, or the two miss different deadlines. Add it to #154 as above, then rerun the step alone at the head once the load drops, and follow the first two cases.

A failure that is not a missed deadline, such as a wrong reply, blocks until it is reproduced on `main` or fixed.

Each step has a 30-minute hang guard (`MA_CHECK_STEP_LIMIT`, in seconds). A step that reaches it is stopped with its processes and reported as failed; its log ends with `hang guard: stopped after`. The guard catches hangs; a step that is merely slow is a problem to find, not a reason to raise it.

The checks need Linux with unprivileged user, PID and mount namespaces, [mise](https://mise.jdx.dev) (which pins Rust), Node.js 22.12 or later, and Python 3 (`python3` for the demos and reference helpers). Leave `TMPDIR` and `CARGO_INCREMENTAL` unset. No suite needs an on-disk temp directory or a shared Cargo incremental setting. A full RAM-backed `/tmp` once filled and caused spurious failures; that is a size limit. `scripts/check.sh` sets `TMPDIR` for each run's steps to `$logs/tmp`. When `TMPDIR` is unset at entry, `$logs` is `~/.cache/ma-std-tmp/check-XXXXXX/`. The script removes `$logs/tmp` when the run ends and keeps the step `.log` files in `$logs`. This also removes any failing AG-UI case's fixture folder inside `$logs/tmp`; run the AG-UI kit on its own to keep that folder. A suite run on its own uses the caller's temp directory. Parallel worktrees keep separate Cargo target directories. A shared `CARGO_TARGET_DIR` would make those worktrees wait on one build lock.

A coding agent's shell commands may run inside a systemd scope that ends with the agent's process; T3 Code does this. Ending the scope kills everything in it, including a check started with `nohup` or `setsid`. Start a long run as its own user unit instead, so it survives:

```sh
mkdir -p "$HOME/.cache/ma-std-tmp"
systemd-run --user --unit=ma-check --collect --same-dir \
  --setenv=PATH="$PATH" \
  -p Delegate=yes -p StandardOutput=file:"$HOME/.cache/ma-std-tmp/check.log" -p StandardError=inherit \
  scripts/check.sh
systemctl --user is-active ma-check    # active while it runs
```

For a stress run, use a different unit name and log file and pass `scripts/stress.sh 3` instead of `scripts/check.sh`.

On an Apple silicon Mac, run `scripts/macos-check.sh` from a fresh clone in a native arm64 shell. It checks for mise, Node.js 22 or later and the Xcode command line tools. It builds both `ma` programs, then runs the language suites, reference checks and ACP kits. It needs no sudo. It uses a temporary home, removes it when the run ends and leaves the logs at the paths in its summary table.

What the full run covers:

| Check | What it shows |
|---|---|
| Each language's suites | The base build, its SDK and its `ma`, including the base builds' own kit runs |
| Shared scenarios, `MODULAR_AGENT_SDK_REQUIRE=all` | Every SDK's runner passes every scenario in process and served by every SDK |
| Reference checks, `MODULAR_AGENT_REF_REQUIRE=all` | Both `ma` builds behave as the standard configuration says |
| ACP kit and `scripts/websocket-kits.sh` | ACP on each `ma`, plus the direct WebSocket ACP and plugin checks, including separate-listener plugin isolation |
| `scripts/production-kits.sh` | ADR 0030 isolation, capacity and erasure over ACP on each `ma` and base agent; deployment isolation against two copies of each language's history service; the [pending-erasure registry profile](docs/bindings/history-http.md#pending-erasure-registry-profile-pendingerasure-1) across a service restart |
| `scripts/erasure-matrix.sh` | The ACP erasure checks with each language's agents on each other language's history service: two pairings, all through the registry profile |
| `scripts/check-links.mjs` | Every relative link and anchor in the Markdown resolves |

To run only the ADR 0030 kits for a built language, use `scripts/production-kits.sh rust` (or `typescript`). Use the builds from `scripts/check.sh`, including the Rust `history_service` example, and install the kit dependencies with `npm ci --prefix conformance/acp` and `npm ci --prefix conformance/tools`. The runner uses disposable loopback listeners, tokens and stores. It checks ACP on stdio and over direct WebSocket listeners. The full check runs this step for each selected language; `--quick` skips it.

To look at traces while working on [telemetry](docs/telemetry.md), run `scripts/phoenix.sh start`. It starts [Arize Phoenix](https://arize.com/docs/phoenix) in podman or docker on loopback, with authentication off, from a pinned image. Point an exporter at it with `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:6006` and `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`; its HTTP endpoint does not take JSON. Phoenix shows `invoke_agent`, `chat` and `execute_tool` spans as agent, model and tool steps, and groups them by `gen_ai.conversation.id`. Its span API (`/v1/projects/default/spans`) does not return resource attributes such as `service.name`; check those at an OTLP receiver. It runs as the systemd user unit `ma-phoenix` where one is available, so it outlives the shell that started it. `scripts/phoenix.sh stop` stops it and keeps its traces in the `ma-phoenix-data` volume; `scripts/phoenix.sh reset` also deletes them. To open it from another device on your tailnet without MagicDNS, forward the port with `tailscale serve --bg --tcp=6006 tcp://127.0.0.1:6006` and browse to `http://TAILSCALE-IP:6006`; raw TCP forwarding does not depend on the hostname the browser sends. The checks do not need it.

## Evaluating ma on real work

Install or rebuild the local `ma` from the permanent `main` checkout. Run `rust/scripts/install.sh` there for Rust, or build in its `typescript/` folder and run `npm link --workspace @modular-agent/ma` for TypeScript. The Rust installer links the Claude sidecar into the checkout. npm links the TypeScript bin to the workspace build. Deleting a temporary worktree breaks either link if it points there. Use the worktree's built binary or direct Node entry point to test a branch.

When evaluating `ma` on real work (see [#20](https://github.com/daniel-ballance/modular-agent/issues/20)), start Phoenix and set the trace-specific variables in the environment that launches `ma`:

```sh
scripts/phoenix.sh start
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:6006/v1/traces
export OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf
```

For `ma` launched by a host, set both variables in the host's launch configuration for `ma`. Query `http://127.0.0.1:6006/v1/projects/default/spans` for the same time window as the session history. After each wave of real `ma` runs (or roughly every 5–10 sessions outside waves), audit the session histories (Rust JSON files under `~/.local/state/modular-agent/rust/sessions/<id>.json` and TypeScript JSONL files under `~/.local/state/modular-agent/typescript/history/<project-folder>/<id>.jsonl`) and compare them with the spans. Use another harness or model and read history in place without reopening or changing sessions. Follow the [ma-meta-analysis skill](.agents/skills/ma-meta-analysis/SKILL.md) for measurements and issue filing.

## Commits

Commit in small steps, each one passing the checks it touches. Write the message for a reader who was not there: what changed and why, and the checks you ran with their counts. A check's own exit code decides whether it passed. A pipe reports its last command's status, so `node --test FILE | tail` exits 0 when the tests fail; run the check without a pipe, or with `set -o pipefail`.

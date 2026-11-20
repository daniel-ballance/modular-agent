//! Points kept in the project's git repository (docs/reference/standard-configuration.md#rewind-points).
//!
//! A point is a commit of the project's files: the tracked and untracked files git
//! does not ignore, as they are on disk. It is written with a private index, so the
//! person's own index, HEAD and branches are never touched, and kept under
//! `refs/modular-agent/points/<session>/<point>`, so it survives a restart and git
//! does not collect it. Restoring changes only those files; ignored files, such as
//! build output, stay as they are. Outside a git work tree there are no points.
use agent_api::*;
use std::{
    ffi::OsStr,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const AUTHOR: &str = "modular-agent";
const EMAIL: &str = "points@modular-agent.invalid";

struct Repo {
    /// The work tree's top folder; git runs here.
    top: PathBuf,
    /// The project, as a literal pathspec from the top.
    spec: String,
    project: PathBuf,
}

fn git<I, S>(top: &Path, args: I, index: Option<&Path>, input: Option<&[u8]>) -> Result<Vec<u8>>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(top)
        .args([
            "-c",
            "core.quotepath=false",
            "-c",
            "core.hooksPath=/dev/null",
        ])
        .args(args)
        // Inherited variables would point git at another repository or index.
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .env("GIT_AUTHOR_NAME", AUTHOR)
        .env("GIT_AUTHOR_EMAIL", EMAIL)
        .env("GIT_COMMITTER_NAME", AUTHOR)
        .env("GIT_COMMITTER_EMAIL", EMAIL)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(index) = index {
        command.env("GIT_INDEX_FILE", index);
    }
    let mut child = command.spawn()?;
    if let Some(input) = input {
        child.stdin.take().unwrap().write_all(input)?;
    }
    let output = child.wait_with_output()?;
    ensure!(
        output.status.success(),
        "git failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(output.stdout)
}

fn text(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).trim().to_owned()
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

fn repo(project: &Path) -> Option<Repo> {
    let project = project.canonicalize().ok()?;
    let out = git(
        &project,
        ["rev-parse", "--is-inside-work-tree", "--show-toplevel"],
        None,
        None,
    )
    .ok()?;
    let out = String::from_utf8(out).ok()?;
    let mut lines = out.lines();
    if lines.next()? != "true" {
        return None;
    }
    let top = PathBuf::from(lines.next()?).canonicalize().ok()?;
    let relative = project.strip_prefix(&top).ok()?.to_str()?.to_owned();
    let spec = format!(
        ":(literal){}",
        if relative.is_empty() { "." } else { &relative }
    );
    Some(Repo { top, spec, project })
}

/// Whether this project can have points: inside a git work tree, and not holding
/// the environment's own state, which a restore would overwrite.
pub fn available(project: &Path, state: &Path) -> bool {
    let Some(repo) = repo(project) else {
        return false;
    };
    match state.canonicalize() {
        Ok(state) => !state.starts_with(&repo.project),
        Err(_) => !state.starts_with(&repo.project),
    }
}

fn reference(session: &str, point: &str) -> Result<String> {
    ensure!(
        valid_name(session) && valid_name(point),
        "invalid session or point id"
    );
    Ok(format!("refs/modular-agent/points/{session}/{point}"))
}

/// The tree of the project's files as they are on disk, written with a private
/// index seeded from the real one so unchanged files are not hashed again.
fn snapshot(repo: &Repo, scratch: &Path) -> Result<String> {
    let index = scratch.join("index");
    let real = PathBuf::from(text(git(
        &repo.top,
        ["rev-parse", "--path-format=absolute", "--git-path", "index"],
        None,
        None,
    )?));
    if real.is_file() {
        std::fs::copy(&real, &index)?;
    }
    git(
        &repo.top,
        ["add", "-A", "--", repo.spec.as_str()],
        Some(&index),
        None,
    )?;
    Ok(text(git(&repo.top, ["write-tree"], Some(&index), None)?))
}

fn commit(repo: &Repo, tree: &str, session: &str) -> Result<String> {
    let message = format!(
        "modular-agent point\n\nsession: {session}\nproject: {}\n",
        repo.project.display()
    );
    Ok(text(git(
        &repo.top,
        ["commit-tree", tree],
        None,
        Some(message.as_bytes()),
    )?))
}

pub fn save(session: &str, project: &Path, state: &Path) -> Result<String> {
    let repo = repo(project).ok_or_else(|| anyhow!("the project is not in a git work tree"))?;
    ensure!(
        available(project, state),
        "environment state is inside the project"
    );
    let point = id();
    let name = reference(session, &point)?;
    let scratch = tempfile::tempdir()?;
    let tree = snapshot(&repo, scratch.path())?;
    let commit = commit(&repo, &tree, session)?;
    git(
        &repo.top,
        ["update-ref", name.as_str(), commit.as_str()],
        None,
        None,
    )?;
    Ok(point)
}

/// The point's commit, if it exists and was saved for this session and project.
fn find(repo: &Repo, session: &str, point: &str) -> Result<Option<String>> {
    let name = format!("{}^{{commit}}", reference(session, point)?);
    let Ok(commit) = git(
        &repo.top,
        ["rev-parse", "--verify", "-q", name.as_str()],
        None,
        None,
    ) else {
        return Ok(None);
    };
    let commit = text(commit);
    let body = String::from_utf8_lossy(&git(
        &repo.top,
        ["cat-file", "commit", commit.as_str()],
        None,
        None,
    )?)
    .into_owned();
    let line = format!("\nproject: {}\n", repo.project.display());
    Ok(body.contains(&line).then_some(commit))
}

pub fn check(session: &str, project: &Path, point: &str) -> Result<bool> {
    let Some(repo) = repo(project) else {
        return Ok(false);
    };
    Ok(find(&repo, session, point)?.is_some())
}

fn split(bytes: &[u8]) -> Vec<String> {
    bytes
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .map(|p| String::from_utf8_lossy(p).into_owned())
        .collect()
}

/// Make the project's files match `target`: remove those `current` has and
/// `target` lacks, then write every file of `target`. Ignored files are untouched.
fn apply(repo: &Repo, scratch: &Path, current: &str, target: &str) -> Result<()> {
    let added = split(&git(
        &repo.top,
        [
            "diff-tree",
            "-r",
            "-z",
            "--name-only",
            "--diff-filter=A",
            target,
            current,
            "--",
            repo.spec.as_str(),
        ],
        None,
        None,
    )?);
    for path in &added {
        let full = repo.top.join(path);
        match std::fs::symlink_metadata(&full) {
            Ok(meta) if !meta.is_dir() => std::fs::remove_file(&full)?,
            _ => (),
        }
        let mut parent = full.parent();
        while let Some(dir) = parent {
            if !dir.starts_with(&repo.project) || dir == repo.project {
                break;
            }
            if std::fs::remove_dir(dir).is_err() {
                break;
            }
            parent = dir.parent();
        }
    }
    let index = scratch.join("target");
    git(&repo.top, ["read-tree", target], Some(&index), None)?;
    let files = git(
        &repo.top,
        ["ls-files", "-z", "--", repo.spec.as_str()],
        Some(&index),
        None,
    )?;
    if !files.is_empty() {
        git(
            &repo.top,
            ["checkout-index", "-f", "-z", "--stdin"],
            Some(&index),
            Some(&files),
        )?;
    }
    Ok(())
}

pub fn restore(session: &str, project: &Path, point: &str) -> Result<()> {
    let repo = repo(project).ok_or_else(|| anyhow!("the project is not in a git work tree"))?;
    let saved = find(&repo, session, point)?.ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "unknown environment point")
    })?;
    let target = text(git(
        &repo.top,
        ["rev-parse", &format!("{saved}^{{tree}}")],
        None,
        None,
    )?);
    let scratch = tempfile::tempdir()?;
    let current = snapshot(&repo, scratch.path())?;
    // Keep the files as they were, so a failed restore can be put back.
    let recovery = format!("refs/modular-agent/recovery/{session}/{}", id());
    let kept = commit(&repo, &current, session)?;
    git(
        &repo.top,
        ["update-ref", recovery.as_str(), kept.as_str()],
        None,
        None,
    )?;
    match apply(&repo, scratch.path(), &current, &target) {
        Ok(()) => {
            let _ = git(
                &repo.top,
                ["update-ref", "-d", recovery.as_str()],
                None,
                None,
            );
            Ok(())
        }
        Err(error) => {
            let after = snapshot(&repo, scratch.path()).unwrap_or(target.clone());
            match apply(&repo, scratch.path(), &after, &current) {
                Ok(()) => {
                    let _ = git(
                        &repo.top,
                        ["update-ref", "-d", recovery.as_str()],
                        None,
                        None,
                    );
                    Err(error)
                }
                Err(rollback) => bail!(
                    "restore failed: {error:#}; rollback failed: {rollback:#}; the files before the restore are kept at {recovery}"
                ),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn run(dir: &Path, args: &[&str]) -> String {
        text(git(dir, args, None, None).unwrap())
    }
    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    fn read(path: &Path) -> Option<String> {
        fs::read_to_string(path).ok()
    }
    /// A repository with a committed file, a staged change, an untracked file and
    /// an ignored one. The state folder is outside it.
    fn repo_with_files() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let top = root.path().join("repo");
        let state = root.path().join("state");
        fs::create_dir_all(&state).unwrap();
        fs::create_dir_all(&top).unwrap();
        run(&top, &["init", "-q"]);
        write(&top.join(".gitignore"), "target/\n");
        write(&top.join("tracked.txt"), "one\n");
        run(&top, &["add", "-A"]);
        run(&top, &["commit", "-q", "-m", "first"]);
        write(&top.join("staged.txt"), "staged\n");
        run(&top, &["add", "staged.txt"]);
        write(&top.join("notes/untracked.txt"), "draft\n");
        write(&top.join("target/build.bin"), "old build\n");
        (root, top, state)
    }

    #[test]
    fn outside_git_there_are_no_points() {
        let root = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        assert!(!available(root.path(), state.path()));
        assert!(save("s1", root.path(), state.path()).is_err());
        assert!(!check("s1", root.path(), "p1").unwrap());
    }

    #[test]
    fn restore_brings_back_the_files_and_leaves_git_and_ignored_files_alone() {
        let (_root, top, state) = repo_with_files();
        assert!(available(&top, &state));
        let head = run(&top, &["rev-parse", "HEAD"]);
        let index = fs::read(top.join(".git/index")).unwrap();
        let point = save("s1", &top, &state).unwrap();

        write(&top.join("tracked.txt"), "changed\n");
        fs::remove_file(top.join("notes/untracked.txt")).unwrap();
        write(&top.join("new/created.txt"), "new\n");
        write(&top.join("target/build.bin"), "new build\n");

        restore("s1", &top, &point).unwrap();
        assert_eq!(read(&top.join("tracked.txt")).as_deref(), Some("one\n"));
        assert_eq!(read(&top.join("staged.txt")).as_deref(), Some("staged\n"));
        assert_eq!(
            read(&top.join("notes/untracked.txt")).as_deref(),
            Some("draft\n")
        );
        assert!(
            !top.join("new").exists(),
            "a file made after the point is removed, with its folder"
        );
        assert_eq!(
            read(&top.join("target/build.bin")).as_deref(),
            Some("new build\n"),
            "ignored files stay"
        );
        assert_eq!(run(&top, &["rev-parse", "HEAD"]), head, "HEAD is untouched");
        assert_eq!(
            fs::read(top.join(".git/index")).unwrap(),
            index,
            "the person's index is untouched"
        );
        assert_eq!(
            run(&top, &["rev-list", "--count", "HEAD"]),
            "1",
            "no commit on the branch"
        );
    }

    #[test]
    fn a_project_inside_a_repository_restores_only_its_own_files() {
        let (_root, top, state) = repo_with_files();
        let project = top.join("notes");
        let point = save("s1", &project, &state).unwrap();
        write(&project.join("untracked.txt"), "changed\n");
        write(&top.join("tracked.txt"), "outside change\n");
        restore("s1", &project, &point).unwrap();
        assert_eq!(
            read(&project.join("untracked.txt")).as_deref(),
            Some("draft\n")
        );
        assert_eq!(
            read(&top.join("tracked.txt")).as_deref(),
            Some("outside change\n")
        );
    }

    #[test]
    fn a_point_belongs_to_its_session_and_project_and_survives_gc() {
        let (_root, top, state) = repo_with_files();
        let point = save("s1", &top, &state).unwrap();
        run(&top, &["gc", "-q", "--prune=now"]);
        assert!(
            check("s1", &top, &point).unwrap(),
            "kept in the repository, so it survives a restart"
        );
        assert!(!check("s2", &top, &point).unwrap());
        assert!(!check("s1", &top.join("notes"), &point).unwrap());
        assert!(!check("s1", &top, "no-such-point").unwrap());
        assert!(save("../escape", &top, &state).is_err());
    }

    #[test]
    fn a_project_holding_the_state_folder_has_no_points() {
        let (_root, top, _) = repo_with_files();
        let state = top.join("state");
        fs::create_dir_all(&state).unwrap();
        assert!(!available(&top, &state));
        assert!(save("s1", &top, &state).is_err());
    }
}

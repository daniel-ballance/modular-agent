import subprocess

import pytest
from ma_core import AgentError
from ma_local.git_points import GitPoints


def git(top, *args):
    return subprocess.check_output(
        [
            "git",
            "-C",
            top,
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "-c",
            "commit.gpgSign=false",
            *args,
        ],
        text=True,
    ).strip()


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


@pytest.fixture
def repository(tmp_path):
    top, state = tmp_path / "repo", tmp_path / "state"
    top.mkdir()
    state.mkdir()
    git(top, "init", "-q")
    write(top / ".gitignore", "target/\n")
    write(top / "tracked.txt", "one\n")
    git(top, "add", "-A")
    git(top, "commit", "-qm", "first")
    write(top / "staged.txt", "staged\n")
    git(top, "add", "staged.txt")
    write(top / "notes/untracked.txt", "draft\n")
    write(top / "target/build.bin", "old build\n")
    return top, state, GitPoints(state)


def test_outside_git_there_are_no_points(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    points = GitPoints(tmp_path / "state")
    assert not points.keeps_points(project)
    with pytest.raises(AgentError, match="does not support"):
        points.save("s1", project)
    assert not points.exists("s1", project, "p1")


def test_restore_brings_back_files_without_changing_git_or_ignored_files(repository):
    top, _, points = repository
    assert points.keeps_points(top)
    head = git(top, "rev-parse", "HEAD")
    index = (top / ".git/index").read_bytes()
    point = points.save("s1", top)["point"]
    write(top / "tracked.txt", "changed\n")
    (top / "notes/untracked.txt").unlink()
    write(top / "new/created.txt", "new\n")
    write(top / "target/build.bin", "new build\n")

    points.restore("s1", top, point)
    assert (top / "tracked.txt").read_text() == "one\n"
    assert (top / "staged.txt").read_text() == "staged\n"
    assert (top / "notes/untracked.txt").read_text() == "draft\n"
    assert not (top / "new").exists()
    assert (top / "target/build.bin").read_text() == "new build\n"
    assert git(top, "rev-parse", "HEAD") == head
    assert (top / ".git/index").read_bytes() == index
    assert git(top, "rev-list", "--count", "HEAD") == "1"
    assert not git(top, "for-each-ref", "refs/modular-agent/recovery/")


def test_subfolder_points_save_and_restore_only_the_project(repository):
    top, _, points = repository
    project = top / "notes"
    point = points.save("s1", project)["point"]
    assert git(top, "ls-tree", "-r", "--name-only", f"refs/modular-agent/points/s1/{point}") == (
        "notes/untracked.txt"
    )
    write(project / "untracked.txt", "changed\n")
    write(top / "tracked.txt", "outside change\n")
    points.restore("s1", project, point)
    assert (project / "untracked.txt").read_text() == "draft\n"
    assert (top / "tracked.txt").read_text() == "outside change\n"


def test_point_belongs_to_session_and_project_and_survives_gc(repository):
    top, state, points = repository
    point = points.save("s1", top)["point"]
    git(top, "gc", "-q", "--prune=now")
    reopened = GitPoints(state)
    assert reopened.exists("s1", top, point)
    assert not reopened.exists("s2", top, point)
    assert not reopened.exists("s1", top / "notes", point)
    assert not reopened.exists("s1", top, "no-such-point")
    with pytest.raises(AgentError, match="Invalid session"):
        points.save("../escape", top)


def test_project_holding_state_has_no_points(repository):
    top, _, _ = repository
    state = top / "state"
    state.mkdir()
    points = GitPoints(state)
    assert not points.keeps_points(top)
    with pytest.raises(AgentError, match="does not support"):
        points.save("s1", top)


def test_restore_rolls_back_when_ignored_path_blocks_target(repository):
    top, _, points = repository
    point = points.save("s1", top)["point"]
    write(top / ".gitignore", "target/\nnotes/\n")
    write(top / "notes/untracked.txt", "now ignored\n")
    write(top / "new/created.txt", "new\n")
    with pytest.raises(AgentError, match="Cannot restore over"):
        points.restore("s1", top, point)
    assert (top / "notes/untracked.txt").read_text() == "now ignored\n"
    assert (top / "new/created.txt").read_text() == "new\n"
    assert not git(top, "for-each-ref", "refs/modular-agent/recovery/")

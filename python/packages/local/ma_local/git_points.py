"""Rewind points kept in the project's Git repository, using a private index."""

import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import NamedTuple

from ma_core import AgentError, identity


def _git(top, *args, index=None, data=None):
    env = os.environ.copy()
    for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"):
        env.pop(key, None)
    env.update(
        GIT_TERMINAL_PROMPT="0",
        LC_ALL="C",
        GIT_AUTHOR_NAME="modular-agent",
        GIT_AUTHOR_EMAIL="points@modular-agent.invalid",
        GIT_COMMITTER_NAME="modular-agent",
        GIT_COMMITTER_EMAIL="points@modular-agent.invalid",
    )
    if index is not None:
        env["GIT_INDEX_FILE"] = str(index)
    try:
        result = subprocess.run(
            [
                "git",
                "-C",
                top,
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "core.splitIndex=false",
                "-c",
                "core.fsmonitor=false",
                *args,
            ],
            capture_output=True,
            env=env,
            **({"input": data} if data is not None else {"stdin": subprocess.DEVNULL}),
        )
    except OSError as exc:
        raise AgentError(f"Could not run Git: {exc}") from exc
    if result.returncode:
        raise AgentError(f"git {args[0]} failed: {result.stderr.decode(errors='replace').strip()}")
    return result.stdout


class _Repo(NamedTuple):
    top: Path
    project: Path
    prefix: Path

    @property
    def spec(self):
        return f":(literal){self.prefix}"

    def git(self, *args, **kwargs):
        return _git(self.top, *args, **kwargs)

    def snapshot(self, scratch):
        index = scratch / "index"
        index.unlink(missing_ok=True)
        real = self.git("rev-parse", "--path-format=absolute", "--git-path", "index")
        try:
            shutil.copyfile(os.fsdecode(real.removesuffix(b"\n")), index)
        except FileNotFoundError:
            pass
        self.git("add", "-A", "--", self.spec, index=index)
        if self.prefix != Path("."):
            outside = self.git(
                "ls-files", "-z", "--", f":(exclude,literal){self.prefix}", index=index
            )
            if outside:
                self.git(
                    "update-index", "--force-remove", "-z", "--stdin", index=index, data=outside
                )
        return self.git("write-tree", index=index).decode().strip()

    def commit(self, tree, session):
        message = os.fsencode(
            f"modular-agent point\n\nsession: {session}\nproject: {self.project}\n"
        )
        return self.git("commit-tree", tree, data=message).decode().strip()

    def find(self, session, point):
        ref = _reference(session, point)
        if not ref:
            return None
        try:
            commit = self.git("rev-parse", "--verify", "-q", f"{ref}^{{commit}}").decode().strip()
        except AgentError:
            return None
        body = self.git("cat-file", "commit", commit)
        return commit if os.fsencode(f"\nproject: {self.project}\n") in body else None

    def apply(self, scratch, current, target):
        def added(before, after):
            names = self.git(
                "diff-tree",
                "-r",
                "-z",
                "--no-renames",
                "--name-only",
                "--diff-filter=A",
                before,
                after,
                "--",
                self.spec,
            )
            return (self.top / os.fsdecode(p) for p in names.split(b"\0") if p)

        for file in added(target, current):
            if file.is_symlink() or not file.is_dir():
                file.unlink(missing_ok=True)
            for parent in file.parents:
                if parent == self.project:
                    break
                try:
                    parent.rmdir()
                except OSError:
                    break
        # Checkout must not replace new ignored files or symlink ancestors.
        for file in added(current, target):
            for path in (file, *file.parents):
                if path == self.project:
                    break
                if path.is_symlink() or (path.exists() and (path == file or not path.is_dir())):
                    raise AgentError(f"Cannot restore over {path}")
        index = scratch / "target"
        self.git("read-tree", target, index=index)
        files = self.git("ls-files", "-z", "--", self.spec, index=index)
        if files:
            self.git("checkout-index", "-f", "-z", "--stdin", index=index, data=files)


def _reference(session, point):
    if all(isinstance(n, str) and re.fullmatch(r"[a-zA-Z0-9_-]+", n) for n in (session, point)):
        return f"refs/modular-agent/points/{session}/{point}"
    return None


class GitPoints:
    def __init__(self, state):
        self.state = Path(state)

    def _repo(self, project):
        try:
            project = Path(project).resolve(strict=True)
            if self.state.resolve().is_relative_to(project):
                return None
            out = _git(project, "rev-parse", "--is-inside-work-tree", "--show-toplevel")
            if not out.startswith(b"true\n"):
                return None
            top = Path(os.fsdecode(out[5:].removesuffix(b"\n"))).resolve(strict=True)
            return _Repo(top, project, project.relative_to(top))
        except (AgentError, OSError, ValueError):
            return None

    def keeps_points(self, project):
        return self._repo(project) is not None

    def save(self, session, project):
        repo = self._repo(project)
        if repo is None:
            raise AgentError("Project does not support Git rewind points", "not_supported")
        point = identity()
        ref = _reference(session, point)
        if ref is None:
            raise AgentError("Invalid session or point id", "invalid_request")
        try:
            with tempfile.TemporaryDirectory(prefix="ma-git-points-") as path:
                saved = repo.commit(repo.snapshot(Path(path)), session)
                repo.git("update-ref", ref, saved)
        except OSError as exc:
            raise AgentError(f"Could not save working environment: {exc}") from exc
        return {"point": point}

    def exists(self, session, project, point):
        repo = self._repo(project)
        return repo is not None and repo.find(session, point) is not None

    def restore(self, session, project, point):
        repo = self._repo(project)
        saved = repo.find(session, point) if repo else None
        if not saved:
            raise AgentError("Unknown saved point for this working environment", "not_found")
        target = repo.git("rev-parse", f"{saved}^{{tree}}").decode().strip()
        try:
            with tempfile.TemporaryDirectory(prefix="ma-git-points-") as path:
                scratch = Path(path)
                current = repo.snapshot(scratch)
                recovery = f"refs/modular-agent/recovery/{session}/{identity()}"
                repo.git("update-ref", recovery, repo.commit(current, session))

                def forget():
                    try:
                        repo.git("update-ref", "-d", recovery)
                    except AgentError:
                        pass

                try:
                    repo.apply(scratch, current, target)
                except (OSError, AgentError) as error:
                    try:
                        after = repo.snapshot(scratch)
                    except (OSError, AgentError):
                        after = target
                    try:
                        repo.apply(scratch, after, current)
                    except (OSError, AgentError) as rollback:
                        raise AgentError(
                            f"Restore failed: {error}; rollback failed: {rollback}; "
                            f"backup kept at {recovery}"
                        ) from rollback
                    forget()
                    raise
                forget()
        except OSError as exc:
            raise AgentError(f"Could not restore working environment: {exc}") from exc
        return {}

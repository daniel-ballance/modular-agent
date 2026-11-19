"""File-only snapshots owned by this working environment."""

import shutil
import tempfile
from pathlib import Path

from ma_core import AgentError, identity


class Points:
    def __init__(self, state):
        self.state = state.parent.resolve()
        self.saved = {}

    def save(self, session, project):
        root = Path(project).resolve()
        work = tempfile.TemporaryDirectory(prefix="ma-point-")
        try:
            shutil.copytree(root, Path(work.name) / "files", symlinks=True, ignore=self.ignore)
        except (OSError, shutil.Error) as exc:
            work.cleanup()
            raise AgentError("Could not save working environment: " + str(exc)) from exc
        point = identity()
        self.saved[point] = session, root, work
        return {"point": point}

    def ignore(self, folder, names):
        return [name for name in names if Path(folder, name) == self.state]

    def exists(self, session, project, point):
        saved = self.saved.get(point) if isinstance(point, str) else None
        return bool(
            saved
            and saved[:2] == (session, Path(project).resolve())
            and (Path(saved[2].name) / "files").is_dir()
        )

    def check(self, session, project, point):
        if not self.exists(session, project, point):
            raise AgentError("Unknown saved point for this working environment", "not_found")
        return self.saved[point]

    def restore(self, session, project, point):
        root = Path(project).resolve()
        saved = self.check(session, root, point)
        # Stage the replacement on the project's filesystem before touching any files.
        # Keep the project directory itself in place for clients holding its cwd.
        with tempfile.TemporaryDirectory(prefix=".ma-restore-", dir=root) as path:
            stage = Path(path)
            incoming, backup = stage / "new", stage / "old"
            shutil.copytree(Path(saved[2].name) / "files", incoming, symlinks=True)
            backup.mkdir()
            moved, installed = [], []
            try:
                for child in root.iterdir():
                    if child not in {stage, self.state}:
                        child.rename(backup / child.name)
                        moved.append(child.name)
                for child in incoming.iterdir():
                    child.rename(root / child.name)
                    installed.append(child.name)
            except OSError:
                for name in reversed(installed):
                    (root / name).rename(incoming / name)
                for name in reversed(moved):
                    (backup / name).rename(root / name)
                raise
        return {}

    def close(self, session):
        for point, (owner, _, work) in list(self.saved.items()):
            if owner == session:
                work.cleanup()
                del self.saved[point]
